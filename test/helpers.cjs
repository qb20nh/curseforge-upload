const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function fixture(
  t,
  name = "primary mod.jar",
  bytes = Buffer.from([0, 1, 2, 255, 13, 10]),
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-upload-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { dir, file, bytes };
}

function multipart(req, body) {
  const contentType = req.headers["content-type"];
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const boundary = contentType.split("boundary=")[1];
  const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
  const fields = {};
  for (const part of parts) {
    const start = part.indexOf("\r\n\r\n");
    assert.ok(start > 0);
    const headers = Buffer.from(part.slice(0, start), "latin1").toString(
      "utf8",
    );
    const name = /name="([^"]+)"/.exec(headers)[1];
    fields[name] = {
      headers,
      bytes: Buffer.from(part.slice(start + 4, -2), "latin1"),
    };
  }
  assert.deepEqual(Object.keys(fields).sort(), ["file", "metadata"]);
  return {
    file: fields.file.bytes,
    filename: /filename="([^"]+)"/.exec(fields.file.headers)[1],
    metadata: JSON.parse(fields.metadata.bytes.toString("utf8")),
  };
}

async function server(t, options = {}) {
  const requests = [];
  const uploads = [];
  const instance = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(record);
    if (req.method === "POST") uploads.push(record);
    if (options.respond)
      return options.respond(req, res, record, uploads.length);
    const body = req.url.endsWith("/version-types")
      ? options.types || []
      : req.url.endsWith("/versions")
        ? options.versions || []
        : { id: 987 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    instance.closeAllConnections();
    return new Promise((resolve) => instance.close(resolve));
  });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const fetch = (url, init) => {
    const target = new URL(url);
    assert.equal(target.protocol, "https:");
    assert.equal(target.hostname, "minecraft.curseforge.com");
    assert.equal(init.redirect, "manual");
    return globalThis.fetch(base + target.pathname, init);
  };
  return { base, fetch, requests, uploads };
}

module.exports = { fixture, multipart, server };
