const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { upload, runAction } = require("../upload.js");
const { fixture, multipart, server } = require("./helpers.cjs");
const token = "secret-token-for-local-tests";
const input = (file) => ({
  token,
  project_id: "123",
  game_endpoint: "MineCraft",
  file_path: file,
});

function actionCore(inputs) {
  const events = [];
  return {
    events,
    getInput: (name) => {
      events.push(["input", name]);
      return inputs[name] || "";
    },
    setSecret: (value) => events.push(["mask", value]),
    setOutput: (...args) => events.push(["output", ...args]),
    setFailed: (value) => events.push(["failed", value]),
  };
}

test("defaults, numeric versions, native multipart bytes and basename", async (t) => {
  const f = await fixture(t, "mod 파일.jar");
  const s = await server(t);
  assert.equal(
    await upload(
      { ...input(f.file), game_versions: " 42, 7,,42, " },
      { fetch: s.fetch },
    ),
    "987",
  );
  assert.equal(s.requests.length, 1);
  const r = s.uploads[0];
  assert.equal(r.url, "/api/projects/123/upload-file");
  assert.equal(r.headers["x-api-token"], token);
  const data = multipart({ headers: r.headers }, r.body);
  assert.equal(data.filename, "mod 파일.jar");
  assert.deepEqual(data.file, f.bytes);
  assert.deepEqual(data.metadata, {
    changelog: "",
    changelogType: "markdown",
    releaseType: "release",
    gameVersions: [42, 7],
  });
});

test("explicit metadata and relative path with spaces", async (t) => {
  const f = await fixture(t);
  const s = await server(t);
  const values = {
    ...input(path.relative(process.cwd(), f.file)),
    changelog: "A\nB",
    changelog_type: "html",
    display_name: "My mod",
    release_type: "beta",
    relations: " fabric-api:requiredDependency, lib:embeddedLibrary, ",
    game_versions: "42",
  };
  await upload(values, { fetch: s.fetch });
  assert.deepEqual(
    multipart({ headers: s.uploads[0].headers }, s.uploads[0].body).metadata,
    {
      changelog: "A\nB",
      changelogType: "html",
      releaseType: "beta",
      displayName: "My mod",
      gameVersions: [42],
      relations: {
        projects: [
          { slug: "fabric-api", type: "requiredDependency" },
          { slug: "lib", type: "embeddedLibrary" },
        ],
      },
    },
  );
});

const versions = [
  { id: 42, name: "1.20", slug: "1-20", gameVersionTypeID: 7 },
  { id: 43, name: "Fabric", slug: "fabric", gameVersionTypeID: 8 },
  { id: 44, name: "1.20", slug: "bukkit-1-20", gameVersionTypeID: 9 },
];
const types = [
  { id: 7, name: "Minecraft", slug: "minecraft" },
  { id: 8, name: "Loader", slug: "loader" },
];
for (const [selection, expected, catalogCount, typeCount] of [
  ["Fabric", [43], 1, 0],
  ["fabric", [43], 1, 0],
  ["Minecraft:1.20", [42], 1, 1],
  ["minecraft:1-20", [42], 1, 1],
  ["7:1.20", [42], 1, 0],
  ["7:42", [42], 1, 0],
  ["43, Minecraft:1.20,7:1-20,Fabric,", [43, 42], 1, 1],
])
  test(`version resolution: ${selection}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, { versions, types });
    await upload(
      { ...input(f.file), game_versions: selection },
      { fetch: s.fetch },
    );
    assert.equal(
      s.requests.filter((r) => r.url.endsWith("/versions")).length,
      catalogCount,
    );
    assert.equal(
      s.requests.filter((r) => r.url.endsWith("/version-types")).length,
      typeCount,
    );
    assert.deepEqual(
      multipart({ headers: s.uploads[0].headers }, s.uploads[0].body).metadata
        .gameVersions,
      expected,
    );
  });

for (const [selection, catalog, typeCatalog, message] of [
  ["missing", versions, types, /not found/i],
  ["1.20", versions, types, /ambiguous/i],
  ["Unknown:1.20", versions, types, /type.*not found/i],
  [
    "Minecraft:1.20",
    versions,
    [...types, { id: 99, name: "Minecraft", slug: "other" }],
    /type.*ambiguous/i,
  ],
  ["Minecraft:missing", versions, types, /not found/i],
])
  test(`reject unresolved version: ${selection}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, { versions: catalog, types: typeCatalog });
    await assert.rejects(
      upload(
        { ...input(f.file), game_versions: selection },
        { fetch: s.fetch },
      ),
      message,
    );
    assert.equal(s.uploads.length, 0);
  });

for (const [key, value] of [
  ["token", ""],
  ["project_id", ""],
  ["project_id", "0"],
  ["project_id", "-1"],
  ["project_id", "1.5"],
  ["project_id", "1e3"],
  ["project_id", "9007199254740992"],
  ["parent_file_id", "0"],
  ["parent_file_id", "-2"],
  ["game_endpoint", ""],
  ["game_endpoint", "evil.com"],
  ["game_endpoint", "x/y"],
  ["game_endpoint", "-bad"],
  ["game_endpoint", "a".repeat(64)],
  ["release_type", "stable"],
  ["changelog_type", "json"],
  ["relations", "slug"],
  ["relations", ":tool"],
  ["relations", "slug:"],
  ["relations", "slug:unknown"],
  ["relations", "a:b:c"],
  ["game_versions", "0"],
  ["game_versions", "9007199254740992"],
  ["game_versions", "-42"],
  ["game_versions", "a:"],
  ["game_versions", ":b"],
  ["game_versions", "a:b:c"],
])
  test(`local validation rejects ${key}=${value}`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const core = actionCore({ ...input(f.file), [key]: value });
    await runAction(core, {
      fetch: () => {
        calls++;
        throw Error("must not reach network");
      },
    });
    assert.equal(calls, 0);
    assert.equal(core.events.filter((e) => e[0] === "output").length, 0);
    assert.equal(core.events.filter((e) => e[0] === "failed").length, 1);
  });

test("parent and versions conflict is rejected before requests", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    upload(
      { ...input(f.file), parent_file_id: "987", game_versions: "42" },
      {
        fetch: () => {
          calls++;
        },
      },
    ),
    /parent_file_id.*game_versions/i,
  );
  assert.equal(calls, 0);
});
for (const kind of ["missing", "directory", "unreadable"])
  test(
    `reject ${kind} upload file`,
    {
      skip:
        kind === "unreadable" &&
        (process.platform === "win32" || process.geteuid?.() === 0),
    },
    async (t) => {
      const f = await fixture(t);
      let calls = 0;
      if (kind === "unreadable") {
        await fs.chmod(f.file, 0);
      }
      const file =
        kind === "missing"
          ? path.join(f.dir, "absent.jar")
          : kind === "directory"
            ? f.dir
            : f.file;
      await assert.rejects(
        upload(input(file), {
          fetch: () => {
            calls++;
          },
        }),
        /file/i,
      );
      assert.equal(calls, 0);
    },
  );

test("parent mod then separate sources JAR and evidence ZIP", async (t) => {
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(201);
      res.end(JSON.stringify({ id: String(100 + count) }));
    },
  });
  const parent = await fixture(t, "mod.jar");
  const id = await upload(
    { ...input(parent.file), game_versions: "42" },
    { fetch: s.fetch },
  );
  assert.equal(id, "101");
  for (const name of ["mod-sources.jar", "evidence.zip"]) {
    const f = await fixture(t, name);
    await upload({ ...input(f.file), parent_file_id: id }, { fetch: s.fetch });
  }
  assert.equal(s.uploads.length, 3);
  for (const req of s.uploads.slice(1)) {
    const data = multipart({ headers: req.headers }, req.body);
    assert.equal(data.metadata.parentFileID, 101);
    assert.equal(Object.hasOwn(data.metadata, "gameVersions"), false);
  }
});

test("mask token before reading remaining inputs; output a string", async (t) => {
  const f = await fixture(t);
  const s = await server(t);
  const core = actionCore(input(f.file));
  await runAction(core, { fetch: s.fetch });
  assert.deepEqual(core.events.slice(0, 2), [
    ["input", "token"],
    ["mask", token],
  ]);
  assert.deepEqual(
    core.events.filter((e) => e[0] === "output"),
    [["output", "id", "987"]],
  );
});

for (const [status, body, uncertain] of [
  [200, '{"id":42}', false],
  [201, '{"id":"43"}', false],
  [204, "", true],
  [200, "not json", true],
  [200, "{}", true],
  [200, '{"id":0}', true],
  [200, '{"id":1.5}', true],
  [200, '{"id":"1e3"}', true],
  [200, '{"id":9007199254740992}', true],
  [401, "unauthorized", false],
  [429, "rate limited", false],
  [500, "server error", false],
  [302, "redirect", false],
])
  test(`upload response ${status} ${body}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, {
      respond: (_req, res) => {
        res.writeHead(
          status,
          status === 302
            ? { location: "http://127.0.0.1:1/should-not-be-followed" }
            : {},
        );
        res.end(body);
      },
    });
    const core = actionCore(input(f.file));
    await runAction(core, { fetch: s.fetch });
    assert.equal(s.uploads.length, 1);
    const failures = core.events.filter((e) => e[0] === "failed");
    if ((status === 200 && body === '{"id":42}') || status === 201) {
      assert.equal(failures.length, 0);
      assert.equal(
        core.events.find((e) => e[0] === "output")[2],
        String(JSON.parse(body).id),
      );
    } else {
      assert.equal(failures.length, 1);
      assert.match(failures[0][1], /upload/i);
      if (status !== 302)
        assert.match(failures[0][1], new RegExp(String(status)));
      assert.equal(
        core.events.some((e) => e[0] === "output"),
        false,
      );
      if (uncertain)
        assert.match(failures[0][1], /uncertain.*check.*before retry/i);
    }
  });

for (const failure of ["connection", "deadline", "body deadline"])
  test(`one POST and no output after ${failure}`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, {
      respond: (req, res) => {
        if (failure === "connection") req.socket.destroy();
        else if (failure === "body deadline") {
          res.writeHead(200);
          res.write("{");
        }
      },
    });
    const core = actionCore(input(f.file));
    await runAction(core, { fetch: s.fetch, uploadTimeoutMs: 100 });
    assert.equal(s.uploads.length, 1);
    assert.equal(
      core.events.some((e) => e[0] === "output"),
      false,
    );
    assert.match(
      core.events.find((e) => e[0] === "failed")[1],
      /uncertain.*check.*before retry/i,
    );
  });

test("bounded and token-redacted HTTP failure text", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(403);
      res.end(token + "\n" + "x".repeat(4080) + token + "x".repeat(9000));
    },
  });
  const core = actionCore(input(f.file));
  await runAction(core, { fetch: s.fetch });
  const message = core.events.find((e) => e[0] === "failed")[1];
  assert.equal(message.includes(token), false);
  assert.match(message, /403/);
  assert.ok(Buffer.byteLength(message) < 4300);
});

for (const kind of [
  "http",
  "invalid JSON",
  "invalid catalog",
  "deadline",
  "connection",
])
  test(`catalog ${kind} prevents uploads`, async (t) => {
    const f = await fixture(t);
    const s = await server(t, {
      respond: (req, res) => {
        if (kind === "connection") return req.socket.destroy();
        if (kind === "deadline") return;
        res.writeHead(kind === "http" ? 503 : 200);
        res.end(
          kind === "invalid JSON"
            ? "oops"
            : kind === "invalid catalog"
              ? "{}"
              : "[]",
        );
      },
    });
    const core = actionCore({ ...input(f.file), game_versions: "Fabric" });
    await runAction(core, { fetch: s.fetch, catalogTimeoutMs: 100 });
    assert.equal(s.uploads.length, 0);
    assert.equal(core.events.filter((e) => e[0] === "failed").length, 1);
    assert.equal(
      core.events.some((e) => e[0] === "output"),
      false,
    );
  });

test("namespaced version ambiguity stops before upload", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    versions: [
      ...versions,
      { id: 45, name: "1.20", slug: "another", gameVersionTypeID: 7 },
    ],
    types,
  });
  await assert.rejects(
    upload(
      { ...input(f.file), game_versions: "Minecraft:1.20" },
      { fetch: s.fetch },
    ),
    /ambiguous/,
  );
  assert.equal(s.uploads.length, 0);
});

test("redirect never reaches another path or leaks the header", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(307, { location: "/redirected" });
      res.end("redirect");
    },
  });
  await assert.rejects(
    upload(input(f.file), { fetch: s.fetch }),
    /Upload.*HTTP 307/,
  );
  assert.equal(s.requests.length, 1);
});

test("catalog redirect is rejected with its HTTP status", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(302, { location: "/other" });
      res.end("redirect");
    },
  });
  await assert.rejects(
    upload({ ...input(f.file), game_versions: "Fabric" }, { fetch: s.fetch }),
    /Version catalog.*HTTP 302/,
  );
  assert.equal(s.requests.length, 1);
  assert.equal(s.uploads.length, 0);
});

test("type catalog failure reports the operation and prevents upload", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    respond: (req, res) => {
      res.writeHead(req.url.endsWith("version-types") ? 401 : 200);
      res.end(
        req.url.endsWith("version-types") ? "denied" : JSON.stringify(versions),
      );
    },
  });
  await assert.rejects(
    upload(
      { ...input(f.file), game_versions: "Minecraft:1.20" },
      { fetch: s.fetch },
    ),
    /Version type catalog.*HTTP 401/,
  );
  assert.equal(s.uploads.length, 0);
});

test("Unicode failure excerpts obey the 4 KiB byte limit", async (t) => {
  const f = await fixture(t);
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end("한".repeat(5000));
    },
  });
  await assert.rejects(upload(input(f.file), { fetch: s.fetch }), (error) => {
    const excerpt = error.message.split("): ")[1];
    assert.ok(Buffer.byteLength(excerpt) <= 4096);
    return true;
  });
});
