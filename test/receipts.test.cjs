const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { prepareReceipt, readReceipt } = require("../receipts.js");
const { fixture } = require("./helpers.cjs");

async function receiptFixture(t, selectedParentID = null) {
  const f = await fixture(t);
  const child = path.join(f.dir, "sources with spaces.jar");
  await fs.writeFile(child, "sources");
  const shared = { changelog: "notes", changelogType: "markdown", releaseType: "release" };
  const config = {
    projectID: 123,
    endpoint: "https://minecraft.curseforge.com",
    selectedParentID,
    versionSelection: selectedParentID ? [] : ["Fabric", "1.20"],
    receiptDirectory: f.dir,
    files: [
      {
        path: f.file,
        sha256: "a".repeat(64),
        blob: new Blob([f.bytes]),
        metadata: selectedParentID
          ? { ...shared, parentFileID: selectedParentID }
          : { ...shared, gameVersions: [42, 43], isMarkedForManualRelease: true },
      },
      {
        path: child,
        sha256: "b".repeat(64),
        metadata: { ...shared, displayName: path.basename(child), parentFileID: selectedParentID },
      },
    ],
  };
  const receipt = await prepareReceipt(config);
  return { ...f, config, receipt };
}

function acceptParent(receipt, id = 900) {
  receipt.data.parentID = id;
  Object.assign(receipt.data.files[0], { id, state: "accepted", attempts: 1 });
  receipt.data.files[1].metadata.parentFileID = id;
}

test("fresh receipt is private, durable JSON with exact paths and no credentials", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  assert.equal(path.basename(receipt.path), "receipt.json");
  assert.deepEqual(await readReceipt(receipt.path), receipt.data);
  assert.equal(receipt.data.files[1].path, config.files[1].path);
  assert.deepEqual(receipt.data.files.map((file) => [file.id, file.state, file.attempts]), [
    [null, "pending", 0],
    [null, "pending", 0],
  ]);
  assert.deepEqual(Object.keys(receipt.data).sort(), [
    "endpoint", "files", "parentID", "projectID", "selectedParentID", "version", "versionSelection",
  ]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(receipt.path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(receipt.path))).mode & 0o777, 0o700);
  }
});

test("accepted parent and child persist and resume with accepted IDs", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  acceptParent(receipt);
  Object.assign(receipt.data.files[1], { id: 901, state: "accepted", attempts: 3 });
  await receipt.save();
  assert.equal(config.files[1].metadata.parentFileID, null);
  const resumed = await prepareReceipt({ ...config, receipt: receipt.path });
  assert.equal(resumed.data.parentID, 900);
  assert.deepEqual(resumed.data.files.map((file) => file.id), [900, 901]);
  assert.equal(resumed.data.files[1].attempts, 3);
});

test("pending attachment after a definite rejection remains resumable", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  acceptParent(receipt);
  receipt.data.files[1].attempts = 4;
  await receipt.save();
  const resumed = await prepareReceipt({ ...config, receipt: receipt.path });
  assert.equal(resumed.data.files[1].state, "pending");
  assert.equal(resumed.data.files[1].attempts, 4);
});

test("manually accepted uncertain main derives and persists its children's parent", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  Object.assign(receipt.data.files[0], { state: "uncertain", attempts: 1 });
  await receipt.save();
  const data = await readReceipt(receipt.path);
  Object.assign(data.files[0], { state: "accepted", id: 900 });
  await fs.writeFile(receipt.path, JSON.stringify(data));
  const resumed = await prepareReceipt({ ...config, receipt: receipt.path });
  assert.equal(resumed.data.parentID, 900);
  assert.equal(resumed.data.files[1].metadata.parentFileID, 900);
  assert.equal((await readReceipt(receipt.path)).parentID, 900);
});

for (const state of ["uploading", "uncertain"])
  test(`${state} requires dashboard reconciliation; coherent manual edits permit resume`, async (t) => {
    const { config, receipt } = await receiptFixture(t);
    acceptParent(receipt);
    Object.assign(receipt.data.files[1], { state, attempts: 1 });
    await receipt.save();
    const suppliedPath = `${path.dirname(receipt.path)}${path.sep}.${path.sep}${path.basename(receipt.path)}`;
    let errorReceiptPath;
    await assert.rejects(prepareReceipt({ ...config, receipt: suppliedPath }), (error) => {
      assert.match(error.message, /manually reconcile/);
      assert.equal(typeof error.receiptPath, "string");
      errorReceiptPath = error.receiptPath;
      return true;
    });
    assert.equal(await fs.realpath(errorReceiptPath), await fs.realpath(receipt.path));
    assert.equal((await readReceipt(receipt.path)).files[1].state, "uncertain");
    Object.assign(receipt.data.files[1], { id: 901, state: "accepted" });
    await receipt.save();
    assert.equal((await prepareReceipt({ ...config, receipt: receipt.path })).data.files[1].id, 901);
  });

for (const [label, edit] of [
  ["project", (data) => { data.projectID = 124; }],
  ["endpoint", (data) => { data.endpoint = "https://other.curseforge.com"; }],
  ["selected parent", (data) => { data.selectedParentID = 500; }],
  ["parent identity", (data) => { data.parentID = 902; }],
  ["version selection", (data) => { data.versionSelection = ["Fabric", "1.21"]; }],
  ["hash", (data) => { data.files[1].sha256 = "c".repeat(64); }],
  ["exact path", (data) => { data.files[1].path = path.resolve(data.files[1].path, ".."); }],
  ["metadata", (data) => { data.files[1].metadata.changelog = "changed"; }],
  ["metadata parent", (data) => { data.files[1].metadata.parentFileID = 902; }],
  ["schema version", (data) => { data.version = 2; }],
  ["unknown field", (data) => { data.error = "secret"; }],
  ["invalid ID", (data) => { data.files[0].id = "900"; }],
  ["invalid state", (data) => { data.files[1].state = "failed"; }],
  ["invalid attempts", (data) => { data.files[1].attempts = -1; }],
  ["duplicate IDs", (data) => { Object.assign(data.files[1], { id: 900, state: "accepted" }); }],
  ["pending with ID", (data) => { data.files[1].id = 901; }],
])
  test(`resume rejects changed or invalid ${label}`, async (t) => {
    const { config, receipt } = await receiptFixture(t);
    acceptParent(receipt);
    await receipt.save();
    const data = await readReceipt(receipt.path);
    edit(data);
    await fs.writeFile(receipt.path, JSON.stringify(data));
    await assert.rejects(prepareReceipt({ ...config, receipt: receipt.path }), /Invalid upload receipt/);
  });

test("accepted child cannot precede accepted new parent", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  const data = await readReceipt(receipt.path);
  Object.assign(data.files[1], { id: 901, state: "accepted", attempts: 1 });
  await fs.writeFile(receipt.path, JSON.stringify(data));
  await assert.rejects(prepareReceipt({ ...config, receipt: receipt.path }), /requires an accepted main file/);
});

test("existing parent is retained and cannot also be an accepted child", async (t) => {
  const { config, receipt } = await receiptFixture(t, 900);
  assert.equal(receipt.data.parentID, 900);
  Object.assign(receipt.data.files[0], { id: 901, state: "accepted", attempts: 1 });
  await receipt.save();
  assert.equal((await prepareReceipt({ ...config, receipt: receipt.path })).data.files[0].id, 901);
  receipt.data.files[1].state = "accepted";
  receipt.data.files[1].id = 900;
  await assert.rejects(receipt.save(), /must be unique/);
});

test("rename failure preserves old receipt and removes temporary file", async (t) => {
  const { receipt } = await receiptFixture(t);
  const before = await fs.readFile(receipt.path);
  acceptParent(receipt);
  t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
  });
  await assert.rejects(receipt.save(), /simulated rename failure/);
  assert.deepEqual(await fs.readFile(receipt.path), before);
  assert.deepEqual(await fs.readdir(path.dirname(receipt.path)), ["receipt.json"]);
});

test("receipt aliases of selected files are rejected without overwriting upload bytes", async (t) => {
  const { config, receipt } = await receiptFixture(t);
  await fs.unlink(config.files[0].path);
  await fs.link(receipt.path, config.files[0].path);
  const before = await fs.readFile(config.files[0].path);
  await assert.rejects(prepareReceipt({ ...config, receipt: receipt.path }), /selected upload file/);
  await assert.rejects(receipt.save(), /selected upload file/);
  assert.deepEqual(await fs.readFile(config.files[0].path), before);
});

test("invalid JSON and oversize receipts expose the supplied receipt path", async (t) => {
  const f = await fixture(t);
  for (const contents of ["not json secret-token", " ".repeat(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.file, contents);
    await assert.rejects(readReceipt(f.file), (error) => {
      assert.equal(error.receiptPath, f.file);
      assert.ok(!error.message.includes("secret-token"));
      return true;
    });
  }
});
