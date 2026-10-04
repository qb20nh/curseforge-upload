const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fixture, multipart } = require("./helpers.cjs");
const certPath = path.join(__dirname, "fixtures/localhost-cert.pem");

async function listen(instance, t) {
  const sockets = new Set();
  instance.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => instance.close(resolve));
  });
  return instance.address().port;
}

for (const [target, variable, bypass] of [
  ["source", "HTTPS_PROXY", false],
  ["bundle", "HTTP_PROXY", false],
  ["bundle", "https_proxy", false],
  ["bundle", "HTTPS_PROXY", true],
])
  test(`${target} honors ${variable}${bypass ? " with NO_PROXY bypass" : ""}`, async (t) => {
    const f = await fixture(t);
    const requests = [];
    const origin = https.createServer(
      {
        key: fs.readFileSync(
          path.join(__dirname, "fixtures/localhost-key.pem"),
        ),
        cert: fs.readFileSync(certPath),
      },
      async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        let body = { id: 987 };
        if (req.url.endsWith("/versions"))
          body = [{ id: 42, name: "1.20", slug: "1-20", gameVersionTypeID: 7 }];
        else if (req.url.endsWith("/version-types"))
          body = [{ id: 7, name: "Minecraft", slug: "minecraft" }];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
    );
    const originPort = await listen(origin, t);
    const tunnels = [];
    const proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url);
      assert.equal(req.url, `127.0.0.1:${originPort}`);
      assert.equal(req.headers["x-api-token"], undefined);
      const upstream = net.connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    const proxyPort = await listen(proxy, t);
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (
        /^(https?_proxy|no_proxy|all_proxy)$/i.test(name) ||
        name.startsWith("INPUT_")
      )
        delete env[name];
    }
    delete env.NODE_OPTIONS;
    Object.assign(env, {
      [variable]: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: bypass ? "127.0.0.1" : "",
      NODE_USE_ENV_PROXY: "0",
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      NODE_EXTRA_CA_CERTS: certPath,
      TEST_HTTP_BASE: `https://127.0.0.1:${originPort}`,
      TEST_OUTPUT_EOL: "",
      INPUT_TOKEN: "proxy-test-token",
      INPUT_PROJECT_ID: "123",
      INPUT_GAME_ENDPOINT: "minecraft",
      INPUT_FILE_PATH: f.file,
      INPUT_GAME_VERSIONS: "Minecraft:1.20",
      GITHUB_OUTPUT: path.join(f.dir, "output"),
    });
    fs.writeFileSync(env.GITHUB_OUTPUT, "");
    let entry = path.join(__dirname, "../curseforge-upload.js");
    if (target === "bundle") {
      const bundle = path.join(f.dir, "dist");
      fs.cpSync(path.join(__dirname, "../dist"), bundle, { recursive: true });
      entry = path.join(bundle, "index.js");
    }
    const child = spawn(
      process.execPath,
      [
        "--throw-deprecation",
        "--require",
        path.join(__dirname, "redirect-fetch.cjs"),
        entry,
      ],
      { env, cwd: f.dir, timeout: 10_000 },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, stdout + stderr);
    assert.equal(stderr, "");
    assert.equal(tunnels.length > 0, !bypass);
    assert.deepEqual(
      requests.map((req) => req.url),
      [
        "/api/game/versions",
        "/api/game/version-types",
        "/api/projects/123/upload-file",
      ],
    );
    for (const req of requests)
      assert.equal(req.headers["x-api-token"], "proxy-test-token");
    const upload = requests[2];
    const data = multipart({ headers: upload.headers }, upload.body);
    assert.deepEqual(data.file, f.bytes);
    assert.equal(data.filename, "primary mod.jar");
    assert.deepEqual(data.metadata.gameVersions, [42]);
    assert.match(
      fs.readFileSync(env.GITHUB_OUTPUT, "utf8"),
      /^id<<[^\r\n]+\r?\n987\r?\n/,
    );
  });
