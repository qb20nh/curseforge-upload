const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { upload, runAction } = require("../upload.js");
const { fixture, multipart, server } = require("./helpers.cjs");

const token = "multi-file-secret-for-local-tests";
const input = (file) => ({
  token,
  project_id: "123",
  game_endpoint: "MineCraft",
  file_path: file,
});

async function family(t) {
  const main = await fixture(t, "main mod.jar");
  const files = [main];
  for (const [name, bytes] of [
    ["sources mod.jar", Buffer.from([255, 0, 8, 13, 10])],
    ["evidence files.zip", Buffer.from("evidence\nwith binary \0")],
  ]) {
    const file = path.join(main.dir, name);
    await fs.writeFile(file, bytes);
    files.push({ file, bytes });
  }
  return {
    dir: main.dir,
    files,
    inputs: {
      ...input(main.file),
      additional_files: files.slice(1).map((entry) => entry.file).join("\n"),
    },
  };
}

function actionCore(inputs) {
  const events = [];
  return {
    events,
    getInput: (name) => inputs[name] || "",
    setSecret: (value) => events.push(["mask", value]),
    setOutput: (...args) => events.push(["output", ...args]),
    setFailed: (message) => events.push(["failed", message]),
    info: (message) => events.push(["info", message]),
    warning: (message) => events.push(["warning", message]),
  };
}

function outputs(core, name) {
  return core.events.filter((event) => event[0] === "output" && event[1] === name);
}

async function actionReceipt(core) {
  const emitted = outputs(core, "receipt");
  assert.ok(emitted.length > 0, "the receipt output must remain available");
  const file = emitted.at(-1)[2];
  assert.equal(typeof file, "string");
  assert.ok(file.length > 0);
  const text = await fs.readFile(file, "utf8");
  assert.equal(text.includes(token), false, "a receipt must not contain credentials");
  return { file, receipt: JSON.parse(text) };
}

function accept(_req, res, _record, count) {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: 100 + count }));
}

function parseUpload(record) {
  return multipart({ headers: record.headers }, record.body);
}

function isolateProxyEnvironment(t, values) {
  const isProxy = (name) => /^(https?_proxy|no_proxy|all_proxy)$/i.test(name);
  const original = Object.fromEntries(Object.entries(process.env).filter(([name]) => isProxy(name)));
  for (const name of Object.keys(process.env)) if (isProxy(name)) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const name of Object.keys(process.env)) if (isProxy(name)) delete process.env[name];
    Object.assign(process.env, original);
  });
}

test("one held main and sequential attachments preserve paths, bytes and metadata", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  const core = actionCore({
    ...f.inputs,
    display_name: "The main release",
    game_versions: "42,7",
    changelog: "A shared changelog\nSecond line",
    changelog_type: "text",
    release_type: "beta",
    relations: "fabric-api:requiredDependency",
  });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(outputs(core, "id"), [["output", "id", "101"]]);
  assert.equal(s.uploads.length, 3);
  const uploads = s.uploads.map(parseUpload);
  for (const [index, entry] of uploads.entries()) {
    assert.equal(entry.filename, path.basename(f.files[index].file));
    assert.deepEqual(entry.file, f.files[index].bytes);
    assert.equal(entry.metadata.changelog, "A shared changelog\nSecond line");
    assert.equal(entry.metadata.changelogType, "text");
    assert.equal(entry.metadata.releaseType, "beta");
    assert.deepEqual(entry.metadata.relations, {
      projects: [{ slug: "fabric-api", type: "requiredDependency" }],
    });
    if (index === 0) {
      assert.equal(entry.metadata.displayName, "The main release");
      assert.equal(entry.metadata.isMarkedForManualRelease, true);
      assert.deepEqual(entry.metadata.gameVersions, [42, 7]);
      assert.equal(Object.hasOwn(entry.metadata, "parentFileID"), false);
    } else {
      assert.equal(entry.metadata.displayName, path.basename(f.files[index].file));
      assert.equal(entry.metadata.parentFileID, 101);
      assert.equal(Object.hasOwn(entry.metadata, "gameVersions"), false);
    }
  }
  const { receipt } = await actionReceipt(core);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.projectID, 123);
  assert.equal(receipt.endpoint, "https://minecraft.curseforge.com");
  assert.equal(receipt.selectedParentID, null);
  assert.equal(receipt.parentID, 101);
  assert.equal(receipt.files.length, 3);
  for (const [index, entry] of receipt.files.entries()) {
    assert.equal(entry.path, f.files[index].file);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(f.files[index].bytes).digest("hex"));
    assert.deepEqual(entry.metadata, uploads[index].metadata);
    assert.equal(entry.id, 101 + index);
    assert.equal(entry.state, "accepted");
    assert.equal(entry.attempts, 1);
  }
  const log = core.events.filter((event) => ["info", "warning"].includes(event[0])).map((event) => event[1]).join("\n");
  assert.match(log, /complete/i);
  assert.match(log, /101/);
  assert.match(log, /dashboard|held|manual.*release/i);
  assert.equal(log.includes(token), false);
});

test("existing parent makes every selected file an attachment and retains file_path id output", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  const core = actionCore({ ...f.inputs, parent_file_id: "777", display_name: "ignored main name", manual_release: "false" });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.deepEqual(outputs(core, "id"), [["output", "id", "101"]]);
  assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
  assert.equal(s.uploads.length, 3);
  for (const [index, request] of s.uploads.entries()) {
    const data = parseUpload(request);
    assert.equal(data.metadata.parentFileID, 777);
    assert.equal(data.metadata.displayName, path.basename(f.files[index].file));
    assert.equal(Object.hasOwn(data.metadata, "gameVersions"), false);
    assert.deepEqual(data.file, f.files[index].bytes);
  }
  const { receipt } = await actionReceipt(core);
  assert.equal(receipt.selectedParentID, 777);
  assert.equal(receipt.parentID, 777);
});

test("manual release auto preserves ordinary single-file publication behavior", async (t) => {
  const f = await fixture(t);
  const s = await server(t);
  const core = actionCore({ ...input(f.file), manual_release: "auto" });
  await runAction(core, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), [["output", "id", "987"]]);
  assert.equal(Object.hasOwn(parseUpload(s.uploads[0]).metadata, "isMarkedForManualRelease"), false);
});

for (const manual_release of ["auto", "true"])
  test(`new multi-file manual release ${manual_release} submits a held Boolean`, async (t) => {
    const f = await family(t);
    const s = await server(t, { respond: accept });
    assert.equal(await upload({ ...f.inputs, manual_release }, { fetch: s.fetch, receiptDirectory: f.dir }), "101");
    assert.equal(parseUpload(s.uploads[0]).metadata.isMarkedForManualRelease, true);
    assert.equal(s.uploads.length, 3);
  });

test("explicit false rejects a new multi-file release before catalog or upload requests", async (t) => {
  const f = await family(t);
  let calls = 0;
  await assert.rejects(upload({ ...f.inputs, manual_release: "false", game_versions: "Fabric" }, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  }), /manual_release.*false|false.*manual_release/i);
  assert.equal(calls, 0);
});

test("credential-bearing version labels fail preflight without requests or a receipt", async (t) => {
  const f = await family(t);
  const before = (await fs.readdir(f.dir)).sort();
  let calls = 0;
  const core = actionCore({ ...f.inputs, game_versions: `Fabric-${token}` });
  await runAction(core, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  });
  assert.equal(calls, 0);
  assert.deepEqual(core.events.filter((event) => event[0] === "output"), []);
  const failures = core.events.filter((event) => event[0] === "failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0][1].includes(token), false);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), before);
});

for (const invalid of ["missing", "directory", "duplicate", "path alias", "symlink alias"])
  test(`all files are preflighted: ${invalid} makes no requests`, async (t) => {
    const f = await family(t);
    let invalidPath;
    if (invalid === "missing") invalidPath = path.join(f.dir, "missing.jar");
    if (invalid === "directory") invalidPath = f.dir;
    if (invalid === "duplicate") invalidPath = f.files[0].file;
    if (invalid === "path alias") invalidPath = path.relative(process.cwd(), f.files[0].file);
    if (invalid === "symlink alias") {
      invalidPath = path.join(f.dir, "alias.jar");
      await fs.symlink(f.files[0].file, invalidPath);
    }
    let calls = 0;
    await assert.rejects(upload({
      ...f.inputs,
      additional_files: `${f.files[1].file}\n${invalidPath}`,
      game_versions: "Fabric",
    }, {
      fetch: () => { calls++; throw new Error("must not reach network"); },
      receiptDirectory: f.dir,
    }), /file|duplicate/i);
    assert.equal(calls, 0);
  });

for (const name of [" sources file.jar", " sources file.jar "]) {
  const unsupported = process.platform === "win32" && name.endsWith(" ");
  test(unsupported
    ? "Windows rejects unsupported trailing-space attachment paths before requests"
    : `additional paths preserve ${name.endsWith(" ") ? "leading and trailing" : "leading and internal"} filename spaces`, async (t) => {
    const f = await fixture(t);
    const extra = path.join(f.dir, name);
    const bytes = Buffer.from("exact filename");
    await fs.writeFile(extra, bytes);
    if (unsupported) {
      let calls = 0;
      await assert.rejects(upload({ ...input(f.file), additional_files: extra }, {
        fetch: () => { calls++; throw new Error("must not reach network"); },
        receiptDirectory: f.dir,
      }), /file|path/i);
      assert.equal(calls, 0);
      return;
    }
    const s = await server(t, { respond: accept });
    let receiptPath;
    assert.equal(await upload({ ...input(f.file), additional_files: extra }, {
      fetch: s.fetch,
      receiptDirectory: f.dir,
      onReceipt: (file) => { receiptPath = file; },
    }), "101");
    const data = parseUpload(s.uploads[1]);
    assert.equal(data.filename, name);
    assert.equal(data.metadata.displayName, name);
    assert.deepEqual(data.file, bytes);
    assert.equal(JSON.parse(await fs.readFile(receiptPath, "utf8")).files[1].path, extra);
  });
}

test("receipt is durable before each POST and records accepted IDs before the next file", async (t) => {
  const f = await family(t);
  const observed = [];
  let receiptPath;
  let serverError;
  const s = await server(t, {
    respond: async (_req, res, _record, count) => {
      try {
        assert.ok(receiptPath);
        observed.push(JSON.parse(await fs.readFile(receiptPath, "utf8")));
      } catch (error) {
        serverError = error;
      }
      res.writeHead(201);
      res.end(JSON.stringify({ id: 100 + count }));
    },
  });
  await upload(f.inputs, {
    fetch: s.fetch,
    receiptDirectory: f.dir,
    onReceipt: (file) => { receiptPath = file; },
  });
  assert.ifError(serverError);
  assert.equal(observed.length, 3);
  for (const [index, receipt] of observed.entries()) {
    assert.equal(receipt.files[index].state, "uploading");
    assert.equal(receipt.files[index].id, null);
    assert.equal(receipt.files[index].attempts, 1);
    for (let accepted = 0; accepted < index; accepted++) {
      assert.equal(receipt.files[accepted].state, "accepted");
      assert.equal(receipt.files[accepted].id, 101 + accepted);
    }
    for (let pending = index + 1; pending < receipt.files.length; pending++) {
      assert.equal(receipt.files[pending].state, "pending");
      assert.equal(receipt.files[pending].attempts, 0);
    }
    assert.equal(receipt.parentID, index === 0 ? null : 101);
  }
  const final = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.deepEqual(final.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
});

test("partial upload saves progress, emits no id, and resumes only the missing attachment", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 3 ? 400 : 201);
      res.end(JSON.stringify(count === 3 ? { errorCode: 999, errorMessage: "rejected" } : { id: 100 + count }));
    },
  });
  const first = actionCore(f.inputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.uploads.length, 3);
  assert.deepEqual(outputs(first, "id"), []);
  const failure = first.events.find((event) => event[0] === "failed");
  assert.ok(failure);
  const firstLog = first.events.filter((event) => ["info", "warning", "failed"].includes(event[0])).map((event) => event[1]).join("\n");
  assert.match(firstLog, /partial/i);
  assert.match(firstLog, /101/);
  assert.doesNotMatch(firstLog, /complete upload/i);
  const saved = await actionReceipt(first);
  assert.equal(saved.receipt.parentID, 101);
  assert.deepEqual(saved.receipt.files.map((file) => file.id), [101, 102, null]);
  assert.deepEqual(saved.receipt.files.map((file) => file.state), ["accepted", "accepted", "pending"]);
  assert.equal(saved.receipt.files[0].metadata.isMarkedForManualRelease, true);
  const resumed = actionCore({ ...f.inputs, receipt: saved.file });
  await runAction(resumed, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
  assert.equal(s.uploads.length, 4);
  const onlyNewUpload = parseUpload(s.uploads[3]);
  assert.equal(onlyNewUpload.filename, path.basename(f.files[2].file));
  assert.deepEqual(onlyNewUpload.file, f.files[2].bytes);
  assert.equal(onlyNewUpload.metadata.parentFileID, 101);
  const after = await actionReceipt(resumed);
  assert.equal(after.file, saved.file);
  assert.deepEqual(after.receipt.files.map((file) => file.id), [101, 102, 104]);
  assert.deepEqual(after.receipt.files.map((file) => file.attempts), [1, 1, 2]);
});

for (const changed of ["hash", "metadata", "project", "endpoint", "selected parent", "receipt parent"])
  test(`resume rejects changed ${changed} before requests, even when all files were accepted`, async (t) => {
    const f = await family(t);
    const s = await server(t, { respond: accept });
    const first = actionCore(f.inputs);
    await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
    const saved = await actionReceipt(first);
    const resumedInput = { ...f.inputs, receipt: saved.file };
    if (changed === "hash") await fs.appendFile(f.files[2].file, "changed");
    if (changed === "metadata") resumedInput.changelog = "changed";
    if (changed === "project") resumedInput.project_id = "456";
    if (changed === "endpoint") resumedInput.game_endpoint = "anothergame";
    if (changed === "selected parent") resumedInput.parent_file_id = "777";
    if (changed === "receipt parent") {
      saved.receipt.parentID = 999;
      await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
    }
    let calls = 0;
    await assert.rejects(upload(resumedInput, {
      fetch: () => { calls++; throw new Error("must not reach network"); },
      receiptDirectory: f.dir,
    }), /receipt|resume|mismatch|changed/i);
    assert.equal(calls, 0);
  });

test("a complete receipt reuses every accepted ID without requests", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  let receiptPath;
  await upload(f.inputs, { fetch: s.fetch, receiptDirectory: f.dir, onReceipt: (file) => { receiptPath = file; } });
  let calls = 0;
  assert.equal(await upload({ ...f.inputs, receipt: receiptPath }, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  }), "101");
  assert.equal(calls, 0);
});

test("named game versions resume from saved metadata and changed selections reject before catalog requests", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (req, res, _record, count) => {
      if (req.url.endsWith("/versions")) {
        res.writeHead(200);
        return res.end(JSON.stringify([
          { id: 42, name: "Fabric", slug: "fabric", gameVersionTypeID: 7 },
          { id: 43, name: "Forge", slug: "forge", gameVersionTypeID: 7 },
        ]));
      }
      res.writeHead(count === 3 ? 400 : 201);
      res.end(JSON.stringify(count === 3 ? { errorCode: 999 } : { id: 100 + count }));
    },
  });
  const initialInputs = { ...f.inputs, game_versions: "Fabric" };
  const first = actionCore(initialInputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  const saved = await actionReceipt(first);
  assert.equal(s.requests.filter((request) => request.url.endsWith("/versions")).length, 1);
  assert.equal(await upload({ ...initialInputs, receipt: saved.file }, { fetch: s.fetch, receiptDirectory: f.dir }), "101");
  assert.equal(s.uploads.length, 4);
  assert.equal(s.requests.filter((request) => request.url.endsWith("/versions")).length, 1);
  let calls = 0;
  await assert.rejects(upload({ ...initialInputs, game_versions: "Forge", receipt: saved.file }, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  }), /receipt|version.*match/i);
  assert.equal(calls, 0);
});

test("numeric versions cannot be replaced by changed metadata in a receipt", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  const initialInputs = { ...f.inputs, game_versions: "42" };
  const first = actionCore(initialInputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  const saved = await actionReceipt(first);
  saved.receipt.files[0].metadata.gameVersions = [43];
  await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
  let calls = 0;
  await assert.rejects(upload({ ...initialInputs, receipt: saved.file }, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  }), /receipt.*metadata|metadata.*match/i);
  assert.equal(calls, 0);
});

test("multi-file attachment retries preserve bytes and metadata and record one accepted ID", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      const retry = count === 2 || count === 3;
      res.writeHead(retry ? 400 : 201);
      res.end(JSON.stringify(retry ? { errorCode: 1012, errorMessage: `Invalid parent: ${token}` } : { id: 100 + count }));
    },
  });
  let elapsed = 0;
  const delays = [];
  let receiptPath;
  const beforeRequests = [];
  const core = actionCore(f.inputs);
  await runAction(core, {
    fetch: async (...args) => {
      beforeRequests.push(JSON.parse(await fs.readFile(receiptPath, "utf8")));
      return s.fetch(...args);
    },
    receiptDirectory: f.dir,
    onReceipt: (file) => { receiptPath = file; },
    now: () => elapsed,
    wait: async (milliseconds) => { delays.push(milliseconds); elapsed += milliseconds; },
  });
  assert.equal(core.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(outputs(core, "id"), [["output", "id", "101"]]);
  assert.equal(s.uploads.length, 5);
  assert.deepEqual(delays, [2000, 4000]);
  for (const [index, snapshot] of beforeRequests.slice(1, 4).entries()) {
    assert.equal(snapshot.files[0].state, "accepted");
    assert.equal(snapshot.files[0].id, 101);
    assert.equal(snapshot.files[1].state, "uploading");
    assert.equal(snapshot.files[1].attempts, index + 1);
    assert.equal(snapshot.files[1].id, null);
  }
  const repeated = s.uploads.slice(1, 4).map(parseUpload);
  for (const data of repeated) {
    assert.equal(data.filename, path.basename(f.files[1].file));
    assert.deepEqual(data.file, f.files[1].bytes);
    assert.deepEqual(data.metadata, repeated[0].metadata);
    assert.equal(data.metadata.parentFileID, 101);
  }
  const saved = await actionReceipt(core);
  assert.deepEqual(saved.receipt.files.map((file) => file.id), [101, 104, 105]);
  assert.deepEqual(saved.receipt.files.map((file) => file.attempts), [1, 3, 1]);
  const log = core.events.filter((event) => event[0] === "info").map((event) => event[1]).join("\n");
  assert.match(log, /retry.*attachment/i);
  assert.match(log, /parent unavailable or invalid/i);
  assert.match(log, /retry attempts: 2/i);
  assert.equal(log.includes(token), false);
});

test("interrupted backoff after a definite parent rejection resumes from a durable pending snapshot", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 2 ? 400 : 201);
      res.end(JSON.stringify(count === 2 ? { errorCode: 1012 } : { id: 100 + count }));
    },
  });
  let receiptPath;
  const interrupted = path.join(f.dir, "interrupted-receipt.json");
  const first = actionCore(f.inputs);
  await runAction(first, {
    fetch: s.fetch,
    receiptDirectory: f.dir,
    onReceipt: (file) => { receiptPath = file; },
    wait: async () => {
      // Preserve exactly what a terminated process would leave during backoff.
      await fs.copyFile(receiptPath, interrupted);
      throw new Error("simulated interruption during retry backoff");
    },
  });
  assert.equal(s.uploads.length, 2);
  assert.deepEqual(outputs(first, "id"), []);
  const snapshot = JSON.parse(await fs.readFile(interrupted, "utf8"));
  assert.equal(snapshot.parentID, 101);
  assert.deepEqual(snapshot.files.map((file) => file.state), ["accepted", "pending", "pending"]);
  assert.deepEqual(snapshot.files.map((file) => file.attempts), [1, 1, 0]);
  const resumed = actionCore({ ...f.inputs, receipt: interrupted });
  await runAction(resumed, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
  assert.equal(s.uploads.length, 4);
  assert.deepEqual(s.uploads.slice(2).map((record) => parseUpload(record).filename), f.files.slice(1).map((file) => path.basename(file.file)));
  const saved = await actionReceipt(resumed);
  assert.deepEqual(saved.receipt.files.map((file) => file.id), [101, 103, 104]);
});

for (const variable of ["HTTP_PROXY", "HTTPS_PROXY"])
  for (const versions of ["", "42"])
    test(`invalid ${variable} with ${versions ? "numeric" : "omitted"} versions leaves an unattempted receipt and resumes after correction`, async (t) => {
      const f = await family(t);
      const s = await server(t, { respond: accept });
      isolateProxyEnvironment(t, { [variable]: `http://user:${token}@[invalid` });
      const realFetch = globalThis.fetch;
      const fetchSpy = t.mock.method(globalThis, "fetch", (url, init) => {
        assert.ok(init.dispatcher, "default transport must construct its real proxy dispatcher");
        const { dispatcher, ...request } = init;
        return realFetch(s.base + new URL(url).pathname, request);
      });
      const inputs = { ...f.inputs, game_versions: versions };
      const first = actionCore(inputs);
      await runAction(first, { receiptDirectory: f.dir });
      assert.equal(fetchSpy.mock.callCount(), 0);
      assert.equal(s.requests.length, 0);
      assert.deepEqual(outputs(first, "id"), []);
      const failures = first.events.filter((event) => event[0] === "failed");
      assert.equal(failures.length, 1);
      assert.match(failures[0][1], /Invalid HTTP_PROXY\/HTTPS_PROXY configuration/);
      assert.equal(failures[0][1].includes(token), false);
      const saved = await actionReceipt(first);
      assert.deepEqual(saved.receipt.files.map((file) => file.state), ["pending", "pending", "pending"]);
      assert.deepEqual(saved.receipt.files.map((file) => file.attempts), [0, 0, 0]);
      assert.deepEqual(saved.receipt.files.map((file) => file.id), [null, null, null]);
      delete process.env[variable];
      const resumed = actionCore({ ...inputs, receipt: saved.file });
      await runAction(resumed, { receiptDirectory: f.dir });
      assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
      assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
      assert.equal(fetchSpy.mock.callCount(), 3);
      const after = await actionReceipt(resumed);
      assert.deepEqual(after.receipt.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
      assert.deepEqual(after.receipt.files.map((file) => file.id), [101, 102, 103]);
      assert.deepEqual(after.receipt.files.map((file) => file.attempts), [1, 1, 1]);
    });

test("an explicit fetch override ignores invalid proxy configuration", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  isolateProxyEnvironment(t, { HTTP_PROXY: "http://[invalid", HTTPS_PROXY: "http://[invalid" });
  assert.equal(await upload(f.inputs, { fetch: s.fetch, receiptDirectory: f.dir }), "101");
  assert.equal(s.uploads.length, 3);
});

test("fully accepted receipt needs no proxy initialization or fetch", async (t) => {
  const f = await family(t);
  const s = await server(t, { respond: accept });
  const first = actionCore(f.inputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  const saved = await actionReceipt(first);
  isolateProxyEnvironment(t, { HTTP_PROXY: "http://[invalid", HTTPS_PROXY: "http://[invalid" });
  const fetchSpy = t.mock.method(globalThis, "fetch", () => { throw new Error("must not reach network"); });
  const resumed = actionCore({ ...f.inputs, receipt: saved.file });
  await runAction(resumed, { receiptDirectory: f.dir });
  assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
  assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
  assert.equal(fetchSpy.mock.callCount(), 0);
  assert.equal(s.uploads.length, 3);
});

test("persistent parent rejection saves pending files and resumes without repeating the held main", async (t) => {
  const f = await family(t);
  let rejectParent = true;
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      const reject = count > 1 && rejectParent;
      res.writeHead(reject ? 400 : 201);
      res.end(JSON.stringify(reject ? { errorCode: 1012, errorMessage: `Invalid parent: ${token}` } : { id: 100 + count }));
    },
  });
  let elapsed = 0;
  const delays = [];
  const options = {
    fetch: s.fetch,
    receiptDirectory: f.dir,
    now: () => elapsed,
    wait: async (milliseconds) => { delays.push(milliseconds); elapsed += milliseconds; },
  };
  const first = actionCore(f.inputs);
  await runAction(first, options);
  assert.equal(s.uploads.length, 8);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.deepEqual(outputs(first, "id"), []);
  const failure = first.events.find((event) => event[0] === "failed")[1];
  assert.match(failure, /1012/);
  assert.match(failure, /partial/i);
  assert.match(failure, /retry attempts: 6/i);
  assert.equal(failure.includes(token), false);
  const saved = await actionReceipt(first);
  assert.equal(saved.receipt.parentID, 101);
  assert.equal(saved.receipt.files[0].metadata.isMarkedForManualRelease, true);
  assert.deepEqual(saved.receipt.files.map((file) => file.state), ["accepted", "pending", "pending"]);
  assert.deepEqual(saved.receipt.files.map((file) => file.attempts), [1, 7, 0]);
  rejectParent = false;
  const resumed = actionCore({ ...f.inputs, receipt: saved.file });
  await runAction(resumed, options);
  assert.deepEqual(outputs(resumed, "id"), [["output", "id", "101"]]);
  assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
  assert.equal(s.uploads.length, 10);
  assert.equal(s.uploads.map(parseUpload).filter((data) => data.filename === path.basename(f.files[0].file)).length, 1);
  const after = await actionReceipt(resumed);
  assert.deepEqual(after.receipt.files.map((file) => file.id), [101, 109, 110]);
  assert.deepEqual(after.receipt.files.map((file) => file.attempts), [1, 8, 1]);
});

test("uncertain main requires reconciliation and accepted ID supplies the parent for pending attachments", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(201);
      res.end(count === 1 ? "not JSON" : JSON.stringify({ id: 100 + count }));
    },
  });
  const first = actionCore(f.inputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(outputs(first, "id"), []);
  const saved = await actionReceipt(first);
  assert.equal(saved.receipt.parentID, null);
  assert.deepEqual(saved.receipt.files.map((file) => file.state), ["uncertain", "pending", "pending"]);
  assert.equal(saved.receipt.files[1].metadata.parentFileID, null);
  let calls = 0;
  await assert.rejects(upload({ ...f.inputs, receipt: saved.file }, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  }), /uncertain|reconcil/i);
  assert.equal(calls, 0);
  saved.receipt.files[0].state = "accepted";
  saved.receipt.files[0].id = 501;
  await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
  assert.equal(await upload({ ...f.inputs, receipt: saved.file }, { fetch: s.fetch, receiptDirectory: f.dir }), "501");
  assert.equal(s.uploads.length, 3);
  for (const request of s.uploads.slice(1)) {
    const metadata = parseUpload(request).metadata;
    assert.equal(metadata.parentFileID, 501);
  }
  const after = JSON.parse(await fs.readFile(saved.file, "utf8"));
  assert.equal(after.parentID, 501);
  assert.deepEqual(after.files.map((file) => file.id), [501, 102, 103]);
  assert.deepEqual(after.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
});

for (const failedIndex of [0, 1])
  test(`HTTP 500 after storing ${failedIndex === 0 ? "main" : "attachment"} blocks resume until accepted-ID reconciliation`, async (t) => {
    const f = await family(t);
    const stored = new Map();
    const s = await server(t, {
      respond: (_req, res, record, count) => {
        const id = 700 + count;
        stored.set(id, parseUpload(record));
        const failed = count === failedIndex + 1;
        res.writeHead(failed ? 500 : 201);
        res.end(JSON.stringify(failed ? { errorMessage: "Failed after storing the file" } : { id }));
      },
    });
    const first = actionCore(f.inputs);
    await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
    assert.deepEqual(outputs(first, "id"), []);
    assert.equal(first.events.filter((event) => event[0] === "failed").length, 1);
    assert.equal(s.uploads.length, failedIndex + 1);
    assert.equal(stored.size, failedIndex + 1);
    const saved = await actionReceipt(first);
    assert.equal(saved.receipt.files[failedIndex].state, "uncertain");
    assert.equal(saved.receipt.files[failedIndex].id, null);
    assert.equal(saved.receipt.parentID, failedIndex === 0 ? null : 701);
    const blocked = actionCore({ ...f.inputs, receipt: saved.file });
    await runAction(blocked, { fetch: s.fetch, receiptDirectory: f.dir });
    assert.deepEqual(outputs(blocked, "id"), []);
    assert.match(blocked.events.find((event) => event[0] === "failed")[1], /uncertain|reconcil/i);
    assert.equal(s.uploads.length, failedIndex + 1);
    assert.equal(stored.size, failedIndex + 1);
    Object.assign(saved.receipt.files[failedIndex], { state: "accepted", id: 701 + failedIndex });
    await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
    const resumed = actionCore({ ...f.inputs, receipt: saved.file });
    await runAction(resumed, { fetch: s.fetch, receiptDirectory: f.dir });
    assert.equal(resumed.events.filter((event) => event[0] === "failed").length, 0);
    assert.deepEqual(outputs(resumed, "id"), [["output", "id", "701"]]);
    assert.equal(s.uploads.length, 3);
    assert.equal(stored.size, 3);
    assert.deepEqual([...stored.values()].map((file) => file.filename), f.files.map((file) => path.basename(file.file)));
    const after = await actionReceipt(resumed);
    assert.deepEqual(after.receipt.files.map((file) => file.id), [701, 702, 703]);
    assert.deepEqual(after.receipt.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
  });

for (const reconcile of ["none", "pending", "accepted"])
  test(`uncertain attachment requires dashboard reconciliation: ${reconcile}`, async (t) => {
    const f = await family(t);
    const s = await server(t, {
      respond: (_req, res, _record, count) => {
        res.writeHead(201);
        res.end(count === 2 ? "{\"id\":0}" : JSON.stringify({ id: 100 + count }));
      },
    });
    const first = actionCore(f.inputs);
    await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
    assert.equal(s.uploads.length, 2);
    assert.deepEqual(outputs(first, "id"), []);
    const saved = await actionReceipt(first);
    assert.deepEqual(saved.receipt.files.map((file) => file.state), ["accepted", "uncertain", "pending"]);
    assert.equal(saved.receipt.files[1].id, null);
    assert.match(first.events.find((event) => event[0] === "failed")[1], /uncertain.*check|dashboard/i);
    if (reconcile === "none") {
      let calls = 0;
      await assert.rejects(upload({ ...f.inputs, receipt: saved.file }, {
        fetch: () => { calls++; throw new Error("must not reach network"); },
        receiptDirectory: f.dir,
      }), /uncertain|reconcil/i);
      assert.equal(calls, 0);
    } else {
      saved.receipt.files[1].state = reconcile;
      saved.receipt.files[1].id = reconcile === "accepted" ? 303 : null;
      await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
      assert.equal(await upload({ ...f.inputs, receipt: saved.file }, { fetch: s.fetch, receiptDirectory: f.dir }), "101");
      assert.equal(s.uploads.length, reconcile === "accepted" ? 3 : 4);
      const after = JSON.parse(await fs.readFile(saved.file, "utf8"));
      assert.deepEqual(after.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
      if (reconcile === "accepted") {
        assert.equal(after.files[1].id, 303);
        assert.equal(parseUpload(s.uploads[2]).filename, path.basename(f.files[2].file));
      }
      for (const request of s.uploads.slice(2)) assert.equal(parseUpload(request).metadata.parentFileID, 101);
    }
  });

test("an interrupted uploading receipt becomes uncertain and makes no requests", async (t) => {
  const f = await family(t);
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 3 ? 400 : 201);
      res.end(JSON.stringify(count === 3 ? { errorCode: 999 } : { id: 100 + count }));
    },
  });
  const first = actionCore(f.inputs);
  await runAction(first, { fetch: s.fetch, receiptDirectory: f.dir });
  const saved = await actionReceipt(first);
  saved.receipt.files[2].state = "uploading";
  await fs.writeFile(saved.file, JSON.stringify(saved.receipt));
  let calls = 0;
  const resumed = actionCore({ ...f.inputs, receipt: saved.file });
  await runAction(resumed, {
    fetch: () => { calls++; throw new Error("must not reach network"); },
    receiptDirectory: f.dir,
  });
  assert.equal(calls, 0);
  assert.deepEqual(outputs(resumed, "id"), []);
  assert.match(resumed.events.find((event) => event[0] === "failed")[1], /uncertain|reconcil/i);
  const after = await actionReceipt(resumed);
  assert.equal(after.receipt.files[2].state, "uncertain");
});
