const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { runAction } = require("../upload.js");
const { fixture, server } = require("./helpers.cjs");

const token = "reporting-secret-for-local-tests";
let Summary;

async function setup(t, additional = true, name = "main report.jar") {
  Summary ||= (await import("@actions/core")).summary.constructor;
  const main = await fixture(t, name);
  const files = [main];
  if (additional) {
    const child = { file: path.join(main.dir, "sources report.jar"), bytes: Buffer.from("sources") };
    await fs.writeFile(child.file, child.bytes);
    files.push(child);
  }
  const summaryPath = path.join(main.dir, "step-summary.md");
  await fs.writeFile(summaryPath, "");
  const original = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  t.after(() => {
    if (original === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = original;
  });
  return {
    dir: main.dir,
    files,
    summaryPath,
    inputs: {
      token, project_id: "123", game_endpoint: "minecraft", file_path: main.file,
      ...(additional ? { additional_files: files[1].file } : {}),
    },
  };
}

function actionCore(inputs) {
  const events = [];
  return {
    events,
    summary: new Summary(),
    getInput: (name) => inputs[name] || "",
    setSecret: (value) => events.push(["mask", value]),
    setOutput: (...args) => events.push(["output", ...args]),
    setFailed: (value) => events.push(["failed", value]),
    info: (value) => events.push(["info", value]),
    warning: (value) => events.push(["warning", value]),
  };
}

function outputs(core, name) {
  return core.events.filter((event) => event[0] === "output" && event[1] === name);
}

function rows(html) {
  const tableRows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((match) =>
    [...match[1].matchAll(/<t[dh]>(.*?)<\/t[dh]>/gs)].map((cell) => cell[1]),
  );
  assert.deepEqual(tableRows[0], ["File", "ID", "Upload", "Moderation", "Publication"]);
  return tableRows.slice(1);
}

function accept(_req, res, _record, count) {
  res.writeHead(201);
  res.end(JSON.stringify({ id: 100 + count }));
}

for (const policy of [
  { label: "single omitted", additional: false, status: "unknown" },
  { label: "single auto", additional: false, manual: "auto", status: "unknown" },
  { label: "single false", additional: false, manual: "false", status: "unknown" },
  { label: "single true", additional: false, manual: "true", status: "held" },
  { label: "new family omitted", additional: true, status: "held" },
  { label: "new family auto", additional: true, manual: "auto", status: "held" },
  { label: "new family true", additional: true, manual: "true", status: "held" },
  { label: "existing parent auto", additional: true, parent: "777", manual: "auto", status: "unknown" },
  { label: "existing parent false", additional: true, parent: "777", manual: "false", status: "unknown" },
  { label: "existing parent true", additional: true, parent: "777", manual: "true", status: "held" },
])
  test(`runAction reports requested publication policy: ${policy.label}`, async (t) => {
    const f = await setup(t, policy.additional);
    const s = await server(t, { respond: accept });
    const core = actionCore({
      ...f.inputs,
      ...(policy.manual ? { manual_release: policy.manual } : {}),
      ...(policy.parent ? { parent_file_id: policy.parent } : {}),
    });
    await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
    assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
    assert.deepEqual(outputs(core, "id"), [["output", "id", "101"]]);
    assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", policy.status]]);
    assert.equal(s.requests.length, f.files.length);
    assert.ok(s.requests.every((request) => request.method === "POST" && request.url === "/api/projects/123/upload-file"));
    if (!policy.additional)
      assert.equal(core.events.find((event) => event[0] === "output")[1], "id");
    const html = await fs.readFile(f.summaryPath, "utf8");
    assert.deepEqual(rows(html), f.files.map((file, index) => [
      path.basename(file.file), String(101 + index), "accepted", "unknown",
      policy.manual === "true" || (!policy.parent && policy.additional && index === 0)
        ? "held (requested)" : "unknown",
    ]));
    assert.match(html, /Approval and public visibility are unverified/);
    assert.match(html, /Next action:.*dashboard/);
    if (policy.status === "held") assert.match(html, /only after the complete set is approved/);
    if (policy.parent) assert.match(html, /Existing parent ID: 777.*visibility is unverified/);
    assert.doesNotMatch(html, /Successfully published|confirmed public|pending approval/i);
  });

test("partial upload summary preserves accepted IDs and changes to held only after missing files resume", async (t) => {
  const f = await setup(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 2 ? 403 : 201);
      res.end(count === 2 ? `Rejected ${token}` : JSON.stringify({ id: 100 + count }));
    },
  });
  const first = actionCore(f.inputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.deepEqual(outputs(first, "id"), []);
  assert.deepEqual(outputs(first, "publication_status"), [["output", "publication_status", "unknown"]]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html), [
    ["main report.jar", "101", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "unknown", "pending", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action:.*resume only missing files.*saved receipt/);
  assert.equal(html.includes(token), false);
  assert.equal(first.events.find((event) => event[0] === "failed")[1].includes(token), false);
  const receiptPath = outputs(first, "receipt")[0][2];
  assert.equal((await fs.readFile(receiptPath, "utf8")).includes(token), false);
  await fs.writeFile(f.summaryPath, "");
  const resumed = actionCore({ ...f.inputs, receipt: receiptPath });
  await runAction(resumed, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.uploads.length, 3);
  assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
  assert.deepEqual(outputs(resumed, "publication_status"), [["output", "publication_status", "held"]]);
  assert.deepEqual(rows(await fs.readFile(f.summaryPath, "utf8")), [
    ["main report.jar", "101", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "103", "accepted", "unknown", "unknown"],
  ]);
});

test("uncertain attachment summary names the file to reconcile without claiming a held release", async (t) => {
  const f = await setup(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 2 ? 500 : 201);
      res.end(count === 2 ? token : JSON.stringify({ id: 100 + count }));
    },
  });
  const core = actionCore(f.inputs);
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.deepEqual(outputs(core, "id"), []);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "unknown"]]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html), [
    ["main report.jar", "101", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "unknown", "uncertain", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Reconcile sources report.jar.*dashboard before resuming/);
  assert.equal(html.includes(token), false);
});

test("validation failure emits unknown status and an input correction summary without uploads", async (t) => {
  const f = await setup(t);
  const s = await server(t);
  // Invalid project input stops before filesystem checks, including on Windows.
  const core = actionCore({ ...f.inputs, project_id: "0", file_path: path.join(f.dir, "<img src=x onerror=evil>.jar") });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), [["output", "publication_status", "unknown"]]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.equal(rows(html)[0][0], "&lt;img src=x onerror=evil&gt;.jar");
  assert.doesNotMatch(html, /<img\b/);
  assert.deepEqual(rows(html).map((row) => row.slice(1)), [
    ["unknown", "not attempted", "unknown", "unknown"],
    ["unknown", "not attempted", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Fix the reported input error/);
});

async function legacyReceipt(f, childState = "pending") {
  const shared = { changelog: "", changelogType: "markdown", releaseType: "release" };
  const receipt = {
    version: 1, projectID: 123, endpoint: "https://minecraft.curseforge.com",
    selectedParentID: null, parentID: 701, versionSelection: ["42"],
    files: f.files.map((file, index) => ({
      path: file.file,
      sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
      metadata: index === 0
        ? { ...shared, gameVersions: [42], isMarkedForManualRelease: true }
        : { ...shared, displayName: path.basename(file.file), parentFileID: 701 },
      id: index === 0 ? 701 : childState === "accepted" ? 702 : null,
      state: index === 0 ? "accepted" : childState,
      attempts: index === 0 || childState !== "pending" ? 1 : 0,
    })),
  };
  const receiptPath = path.join(f.dir, "legacy-v1.json");
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  return { receiptPath, receipt };
}

test("legacy version-1 receipt resumes missing files and reports accepted IDs without claiming moderation", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f);
  const s = await server(t, {
    respond: (_req, res) => { res.writeHead(201); res.end('{"id":702}'); },
  });
  const inputs = { ...f.inputs, game_versions: "42", receipt: receiptPath };
  const core = actionCore(inputs);
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(outputs(core, "id"), [["output", "id", "701"]]);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "held"]]);
  const after = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(after.version, 1);
  assert.deepEqual(Object.keys(after).sort(), ["endpoint", "files", "parentID", "projectID", "selectedParentID", "version", "versionSelection"]);
  assert.deepEqual(rows(await fs.readFile(f.summaryPath, "utf8")), [
    ["main report.jar", "701", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "702", "accepted", "unknown", "unknown"],
  ]);
  await fs.writeFile(f.summaryPath, "");
  const complete = actionCore(inputs);
  await runAction(complete, { fetch: () => { throw new Error("must not reach network"); } });
  assert.deepEqual(outputs(complete, "id"), [["output", "id", "701"]]);
  assert.deepEqual(outputs(complete, "publication_status"), [["output", "publication_status", "held"]]);
  assert.equal(s.uploads.length, 1);
});

test("blocked legacy uncertain receipt retains validated accepted IDs in its summary", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f, "uncertain");
  const s = await server(t);
  const core = actionCore({ ...f.inputs, game_versions: "42", receipt: receiptPath });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(outputs(core, "id"), []);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "unknown"]]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html), [
    ["main report.jar", "701", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "unknown", "uncertain", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Reconcile sources report.jar.*dashboard before resuming/);
});

test("failure saving interrupted receipt conversion retains validated IDs and names the uncertain attachment", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f, "uploading");
  const before = await fs.readFile(receiptPath);
  t.mock.method(fs, "rename", async () => { throw new Error("simulated receipt conversion save failure"); });
  const s = await server(t);
  const core = actionCore({ ...f.inputs, game_versions: "42", receipt: receiptPath });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(outputs(core, "id"), []);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "unknown"]]);
  assert.deepEqual(await fs.readFile(receiptPath), before);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html), [
    ["main report.jar", "701", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "unknown", "uncertain", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Reconcile sources report.jar.*dashboard before resuming/);
});

test("failure saving an accepted main reports its known ID and requires reconciliation before resume", async (t) => {
  const f = await setup(t);
  const s = await server(t, { respond: accept });
  const core = actionCore(f.inputs);
  await runAction(core, {
    receiptDirectory: f.dir,
    fetch: async (...args) => {
      const response = await s.fetch(...args);
      t.mock.method(fs, "rename", async () => { throw new Error("simulated accepted-ID save failure"); });
      return response;
    },
  });
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(outputs(core, "id"), []);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "unknown"]]);
  const receiptPath = outputs(core, "receipt")[0][2];
  const saved = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(saved.files[0].state, "uploading");
  assert.equal(saved.files[0].id, null);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html), [
    ["main report.jar", "101", "accepted", "unknown", "held (requested)"],
    ["sources report.jar", "unknown", "pending", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Reconcile main report.jar \(ID 101\).*dashboard before resuming/);
});

test("receipt identity mismatch cannot supply accepted IDs or upload state to the summary", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f, "accepted");
  await fs.appendFile(f.files[1].file, "changed");
  const s = await server(t);
  const core = actionCore({ ...f.inputs, game_versions: "42", receipt: receiptPath });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(outputs(core, "id"), []);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "unknown"]]);
  assert.deepEqual(rows(await fs.readFile(f.summaryPath, "utf8")).map((row) => row.slice(1)), [
    ["unknown", "unknown", "unknown", "unknown"],
    ["unknown", "unknown", "unknown", "unknown"],
  ]);
});

test("local preflight failure preserves a supplied receipt without trusting its IDs or states", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f, "accepted");
  await fs.unlink(f.files[1].file);
  const s = await server(t);
  const core = actionCore({ ...f.inputs, game_versions: "42", receipt: receiptPath });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), [
    ["output", "receipt", receiptPath], ["output", "publication_status", "unknown"],
  ]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.deepEqual(rows(html).map((row) => row.slice(1)), [
    ["unknown", "unknown", "unknown", "unknown"],
    ["unknown", "unknown", "unknown", "unknown"],
  ]);
  assert.match(html, /Next action: Fix.*validate the saved receipt.*dashboard/);
});

test("credential-bearing receipt path is omitted from outputs and redacted in the summary", async (t) => {
  const f = await setup(t);
  const { receiptPath } = await legacyReceipt(f, "accepted");
  const unsafePath = path.join(f.dir, `${token}.json`);
  await fs.rename(receiptPath, unsafePath);
  const s = await server(t);
  const core = actionCore({ ...f.inputs, game_versions: "42", receipt: unsafePath });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), [["output", "publication_status", "unknown"]]);
  assert.equal(core.events.find((event) => event[0] === "failed")[1].includes(token), false);
  assert.equal((await fs.readFile(f.summaryPath, "utf8")).includes(token), false);
});

test("summary escapes filename HTML and redacts credentials without dumping metadata", async (t) => {
  const f = await setup(t, false, `mod ${token} & 'quoted'.jar`);
  const s = await server(t);
  const core = actionCore({ ...f.inputs, manual_release: "true", changelog: `<secret>${token}</secret>` });
  await runAction(core, { fetch: s.fetch });
  assert.deepEqual(outputs(core, "id"), [["output", "id", "987"]]);
  const html = await fs.readFile(f.summaryPath, "utf8");
  assert.equal(html.includes(token), false);
  assert.equal(html.includes("<secret>"), false);
  assert.equal(html.includes("X-Api-Token"), false);
  assert.equal(rows(html)[0][0], "mod [REDACTED] &amp; &#39;quoted&#39;.jar");
});

test("summary write failure warns without losing successful id or publication status", async (t) => {
  const f = await setup(t, false);
  const s = await server(t);
  const core = actionCore({ ...f.inputs, manual_release: "true" });
  t.mock.method(core.summary, "write", async () => { throw new Error(`write failed ${token}`); });
  await runAction(core, { fetch: s.fetch });
  assert.deepEqual(outputs(core, "id"), [["output", "id", "987"]]);
  assert.deepEqual(outputs(core, "publication_status"), [["output", "publication_status", "held"]]);
  assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
  const warnings = core.events.filter((event) => event[0] === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1], /Could not write.*job summary/);
  assert.equal(warnings[0][1].includes(token), false);
});

test("missing summary environment preserves action outputs without touching the summary writer", async (t) => {
  const f = await setup(t, false);
  delete process.env.GITHUB_STEP_SUMMARY;
  const s = await server(t);
  const core = actionCore(f.inputs);
  const addRaw = t.mock.method(core.summary, "addRaw", () => { throw new Error("must not write summary"); });
  await runAction(core, { fetch: s.fetch });
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), [
    ["output", "id", "987"], ["output", "publication_status", "unknown"],
  ]);
  assert.equal(addRaw.mock.callCount(), 0);
  assert.equal(await fs.readFile(f.summaryPath, "utf8"), "");
});
