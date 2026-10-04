const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, multipart, server } = require("./helpers.cjs");

async function run(t, values, base) {
  const f = await fixture(t, "github-output");
  await fs.writeFile(f.file, "");
  const bundle = path.join(f.dir, "dist");
  await fs.cp(path.join(__dirname, "../dist"), bundle, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("INPUT_")) delete env[key];
  Object.assign(env, {
    GITHUB_OUTPUT: f.file,
    GITHUB_ACTIONS: "true",
    TEST_HTTP_BASE: base,
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
  return { code, stdout, stderr, output: await fs.readFile(f.file, "utf8") };
}

test("bundled action child process: native upload and GitHub output file", async (t) => {
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
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /::add-mask::bundled-secret/);
  assert.match(result.output, /id<<[^\n]+\n987\n/);
  assert.equal(s.uploads.length, 1);
  const data = multipart({ headers: s.uploads[0].headers }, s.uploads[0].body);
  assert.deepEqual(data.file, f.bytes);
  assert.equal(data.filename, "primary mod.jar");
  assert.equal(s.uploads[0].headers["x-api-token"], "bundled-secret");
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
