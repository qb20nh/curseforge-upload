const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, multipart, server } = require("./helpers.cjs");

function outputs(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    if (!match) continue;
    const value = [];
    while (++index < lines.length && lines[index] !== match[2])
      value.push(lines[index]);
    assert.ok(index < lines.length, "GitHub output delimiter must be complete");
    values[match[1]] = value.join("\n");
  }
  return values;
}

async function run(t, values, base, outputEOL = "") {
  const f = await fixture(t, "github-output");
  await fs.writeFile(f.file, "");
  const bundle = path.join(f.dir, "dist");
  await fs.cp(path.join(__dirname, "../dist"), bundle, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("INPUT_") ||
      /^(https?_proxy|no_proxy|all_proxy)$/i.test(key)
    )
      delete env[key];
  Object.assign(env, {
    GITHUB_OUTPUT: f.file,
    GITHUB_ACTIONS: "true",
    TEST_HTTP_BASE: base,
    TEST_OUTPUT_EOL: outputEOL,
  });
  for (const [key, value] of Object.entries(values))
    env["INPUT_" + key.toUpperCase()] = value;
  const child = spawn(
    process.execPath,
    [
      "--throw-deprecation",
      "--require",
      path.join(__dirname, "redirect-fetch.cjs"),
      path.join(bundle, "index.js"),
    ],
    { env, cwd: f.dir },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const output = await fs.readFile(f.file, "utf8");
  const parsed = outputs(output);
  if (parsed.receipt && !values.receipt)
    t.after(() => fs.rm(path.dirname(parsed.receipt), { recursive: true, force: true }));
  return { code, stdout, stderr, output, outputs: parsed };
}

for (const outputEOL of ["", "\r\n"])
  test(`bundled action child process: native upload and GitHub output file (${outputEOL ? "CRLF" : "native"})`, async (t) => {
    const f = await fixture(t);
    const s = await server(t);
    const result = await run(
      t,
      {
        token: "bundled-secret",
        project_id: "123",
        game_endpoint: "minecraft",
        file_path: f.file,
        game_versions: "42",
      },
      s.base,
      outputEOL,
    );
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /::add-mask::bundled-secret/);
    const outputLines = result.output.split(/\r?\n/);
    assert.match(outputLines[0], /^id<<\S+$/);
    assert.deepEqual(outputLines.slice(1), [
      "987",
      outputLines[0].slice("id<<".length),
      "",
    ]);
    assert.equal(s.uploads.length, 1);
    const data = multipart(
      { headers: s.uploads[0].headers },
      s.uploads[0].body,
    );
    assert.deepEqual(data.file, f.bytes);
    assert.equal(data.filename, "primary mod.jar");
    assert.equal(s.uploads[0].headers["x-api-token"], "bundled-secret");
  });

for (const manualRelease of [undefined, "auto", "true", "false"])
  test(`bundled single-file manual_release ${manualRelease ?? "omitted"}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t);
    const result = await run(t, {
      token: "bundled-secret",
      project_id: "123",
      game_endpoint: "minecraft",
      file_path: f.file,
      ...(manualRelease === undefined ? {} : { manual_release: manualRelease }),
    }, s.base);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.deepEqual(result.outputs, { id: "987" });
    const data = multipart({ headers: s.uploads[0].headers }, s.uploads[0].body);
    if (manualRelease === "true" || manualRelease === "false") {
      assert.equal(data.metadata.isMarkedForManualRelease, manualRelease === "true");
      assert.equal(typeof data.metadata.isMarkedForManualRelease, "boolean");
    } else {
      assert.equal(Object.hasOwn(data.metadata, "isMarkedForManualRelease"), false);
    }
  });

for (const unsafe of ["manual false", "duplicate", "missing attachment", "invalid manual value"])
  test(`bundled validation stops before requests: ${unsafe}`, async (t) => {
    const main = await fixture(t);
    const attachment = await fixture(t, "sources.jar");
    const s = await server(t);
    const result = await run(t, {
      token: "bundled-secret",
      project_id: "123",
      game_endpoint: "minecraft",
      file_path: main.file,
      additional_files: unsafe === "duplicate"
        ? main.file
        : unsafe === "missing attachment"
          ? path.join(attachment.dir, "absent.jar")
          : attachment.file,
      ...(unsafe === "manual false" ? { manual_release: "false" } : {}),
      ...(unsafe === "invalid manual value" ? { manual_release: "yes" } : {}),
    }, s.base);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(s.requests.length, 0);
    assert.deepEqual(result.outputs, {});
    assert.equal((result.stdout.match(/::error::/g) || []).length, 1);
  });

for (const manualRelease of ["auto", "true"])
  test(`bundled multi-file ${manualRelease} holds the main and reports complete upload`, async (t) => {
    const files = [
      await fixture(t, "main with spaces.jar", Buffer.from("main bytes")),
      await fixture(t, "sources with spaces.jar", Buffer.from("sources bytes")),
      await fixture(t, "evidence.zip", Buffer.from("evidence bytes")),
    ];
    const s = await server(t, {
      respond: (_req, res, _record, count) => {
        res.writeHead(201);
        res.end(JSON.stringify({ id: 100 + count }));
      },
    });
    const result = await run(t, {
      token: "bundled-secret",
      project_id: "123",
      game_endpoint: "minecraft",
      file_path: files[0].file,
      additional_files: files.slice(1).map((file) => file.file).join("\n"),
      game_versions: "42",
      display_name: "Main display name",
      changelog: "shared changelog",
      manual_release: manualRelease,
    }, s.base);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.outputs.id, "101");
    assert.ok(path.isAbsolute(result.outputs.receipt));
    assert.equal(s.uploads.length, 3);
    for (const [index, request] of s.uploads.entries()) {
      const data = multipart({ headers: request.headers }, request.body);
      assert.deepEqual(data.file, files[index].bytes);
      assert.equal(data.filename, path.basename(files[index].file));
      assert.equal(data.metadata.changelog, "shared changelog");
      if (index === 0) {
        assert.equal(data.metadata.displayName, "Main display name");
        assert.equal(data.metadata.isMarkedForManualRelease, true);
        assert.deepEqual(data.metadata.gameVersions, [42]);
        assert.equal(Object.hasOwn(data.metadata, "parentFileID"), false);
      } else {
        assert.equal(data.metadata.displayName, path.basename(files[index].file));
        assert.equal(data.metadata.parentFileID, 101);
        assert.equal(Object.hasOwn(data.metadata, "gameVersions"), false);
      }
    }
    const receiptText = await fs.readFile(result.outputs.receipt, "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.parentID, 101);
    assert.deepEqual(receipt.files.map((file) => file.id), [101, 102, 103]);
    assert.deepEqual(receipt.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
    assert.equal(receiptText.includes("bundled-secret"), false);
    assert.match(result.stdout, /Complete upload.*parent ID: 101/);
    assert.match(result.stdout, /held for manual release/);
  });

test("bundled partial failure exposes receipt without id and resume uploads only the missing attachment", async (t) => {
  const files = [
    await fixture(t, "main.jar", Buffer.from("main bytes")),
    await fixture(t, "sources.jar", Buffer.from("sources bytes")),
    await fixture(t, "evidence with spaces.zip", Buffer.from("evidence bytes")),
  ];
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count === 3 ? 403 : 201);
      res.end(count === 3 ? "Rejected bundled-secret" : JSON.stringify({ id: 100 + count }));
    },
  });
  const values = {
    token: "bundled-secret",
    project_id: "123",
    game_endpoint: "minecraft",
    file_path: files[0].file,
    additional_files: files.slice(1).map((file) => file.file).join("\n"),
    game_versions: "42",
  };
  const partial = await run(t, values, s.base);
  assert.equal(partial.code, 1, partial.stderr);
  assert.deepEqual(Object.keys(partial.outputs), ["receipt"]);
  assert.equal(s.uploads.length, 3);
  const saved = JSON.parse(await fs.readFile(partial.outputs.receipt, "utf8"));
  assert.equal(saved.parentID, 101);
  assert.deepEqual(saved.files.map((file) => file.state), ["accepted", "accepted", "pending"]);
  assert.deepEqual(saved.files.map((file) => file.id), [101, 102, null]);
  assert.equal(saved.files[0].metadata.isMarkedForManualRelease, true);
  assert.match(partial.stdout, /Partial upload.*parent ID: 101/);
  assert.doesNotMatch(partial.stdout, /Complete upload/);
  const errors = partial.stdout.split("\n").filter((line) => line.startsWith("::error::"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes("bundled-secret"), false);
  const resumed = await run(t, { ...values, receipt: partial.outputs.receipt }, s.base);
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.deepEqual(resumed.outputs, { receipt: partial.outputs.receipt, id: "101" });
  assert.equal(s.uploads.length, 4);
  const missing = multipart({ headers: s.uploads[3].headers }, s.uploads[3].body);
  assert.equal(missing.filename, "evidence with spaces.zip");
  assert.deepEqual(missing.file, files[2].bytes);
  assert.equal(missing.metadata.parentFileID, 101);
  const completed = JSON.parse(await fs.readFile(resumed.outputs.receipt, "utf8"));
  assert.deepEqual(completed.files.map((file) => file.id), [101, 102, 104]);
  assert.deepEqual(completed.files.map((file) => file.state), ["accepted", "accepted", "accepted"]);
  assert.match(resumed.stdout, /Complete upload/);
});

for (const failure of [
  "invalid input",
  "invalid response",
  "authorization",
  "redirect",
  "connection",
])
  test(`bundled action fails once without output: ${failure}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, {
      respond: (req, res) => {
        if (failure === "connection") return req.socket.destroy();
        res.writeHead(
          failure === "authorization"
            ? 401
            : failure === "redirect"
              ? 302
              : 200,
          failure === "redirect" ? { location: "/other" } : {},
        );
        res.end(failure === "authorization" ? "bundled-secret" : "{}");
      },
    });
    const result = await run(
      t,
      {
        token: "bundled-secret",
        project_id: failure === "invalid input" ? "0" : "123",
        game_endpoint: "minecraft",
        file_path: f.file,
      },
      s.base,
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.output, "");
    assert.equal(s.uploads.length, failure === "invalid input" ? 0 : 1);
    assert.equal((result.stdout.match(/::error::/g) || []).length, 1);
    const errors = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("::error::"))
      .join("\n");
    assert.equal(errors.includes("bundled-secret"), false);
    assert.equal(result.stderr, "");
  });
