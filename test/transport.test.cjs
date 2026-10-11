const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { uploadFile, requestJSON } = require("../transport.js");
const { fixture, multipart, server } = require("./helpers.cjs");

const token = "secret-token-for-transport-tests";
const url = new URL("https://minecraft.curseforge.com/api/projects/123/upload-file");

async function options(t, s, extra = {}) {
  const f = await fixture(t, "sources with spaces.jar");
  return {
    fetch: s.fetch,
    url,
    headers: { "X-Api-Token": token },
    blob: await fs.openAsBlob(f.file),
    file: f.file,
    metadata: { changelog: "shared", releaseType: "release", parentFileID: 42 },
    token,
    bytes: f.bytes,
    ...extra,
  };
}

function virtualTime() {
  let elapsed = 0;
  const delays = [];
  return {
    now: () => elapsed,
    wait: async (milliseconds) => {
      delays.push(milliseconds);
      elapsed += milliseconds;
    },
    advance: (milliseconds) => { elapsed += milliseconds; },
    delays,
  };
}

test("attachment retry uses fresh multipart with identical metadata and file bytes", async (t) => {
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      res.writeHead(count < 3 ? 400 : 201);
      res.end(JSON.stringify(count < 3 ? { errorCode: 1012 } : { id: "987" }));
    },
  });
  const clock = virtualTime();
  const attempts = [];
  const config = await options(t, s, {
    ...clock,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(await uploadFile(config), 987);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(clock.delays, [2000, 4000]);
  for (const request of s.uploads) {
    assert.equal(request.headers["x-api-token"], token);
    const fields = multipart({ headers: request.headers }, request.body);
    assert.equal(fields.filename, "sources with spaces.jar");
    assert.deepEqual(fields.file, config.bytes);
    assert.deepEqual(fields.metadata, config.metadata);
  }
  assert.equal(new Set(s.uploads.map((request) => request.headers["content-type"])).size, 3);
});

test("retryable rejection is saved before backoff and the next upload attempt", async (t) => {
  const state = await fixture(t, "attempt-state.json");
  const events = [];
  const s = await server(t, {
    respond: (_req, res, _record, count) => {
      events.push(`request:${count}`);
      res.writeHead(count === 1 ? 400 : 201);
      res.end(JSON.stringify(count === 1 ? { errorCode: 1012 } : { id: 987 }));
    },
  });
  const clock = virtualTime();
  const config = await options(t, s, {
    now: clock.now,
    onAttempt: async (attempt) => {
      await fs.promises.writeFile(state.file, JSON.stringify({ state: "uploading", attempt }));
      events.push(`attempt:${attempt}`);
    },
    onRetryableRejection: async (attempt) => {
      await new Promise((resolve) => setImmediate(resolve));
      await fs.promises.writeFile(state.file, JSON.stringify({ state: "pending", attempt }));
      events.push(`rejection-saved:${attempt}`);
    },
    wait: async (milliseconds) => {
      assert.deepEqual(JSON.parse(await fs.promises.readFile(state.file, "utf8")), {
        state: "pending", attempt: 1,
      });
      events.push(`wait:${milliseconds}`);
      await clock.wait(milliseconds);
    },
  });
  assert.equal(await uploadFile(config), 987);
  assert.deepEqual(events, [
    "attempt:1", "request:1", "rejection-saved:1", "wait:2000",
    "attempt:2", "request:2",
  ]);
});

test("retryable rejection save failure stops before waiting or another request", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end('{"errorCode":1012}');
    },
  });
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, {
    ...clock,
    onRetryableRejection: async () => {
      throw new Error(`receipt write failed ${token}`);
    },
  })), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    assert.equal(error.attempts, 1);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /record rejected upload attempt.*receipt write failed \[REDACTED\]/);
    return true;
  });
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(clock.delays, []);
});

for (const [timeoutMs, savingMs, expectedDelays] of [
  [1000, 1000, []],
  [2500, 1000, [1500]],
]) {
  test(`rejection persistence consumes the original ${timeoutMs}ms per-file deadline`, async (t) => {
    const s = await server(t, {
      respond: (_req, res) => {
        res.writeHead(400);
        res.end('{"errorCode":1012}');
      },
    });
    const clock = virtualTime();
    let rejections = 0;
    await assert.rejects(uploadFile(await options(t, s, {
      ...clock,
      timeoutMs,
      onRetryableRejection: async () => {
        rejections++;
        clock.advance(savingMs);
      },
    })), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.errorCode, 1012);
      assert.equal(error.uncertain, false);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /deadline/i);
      return true;
    });
    assert.equal(rejections, 1);
    assert.equal(s.uploads.length, 1);
    assert.deepEqual(clock.delays, expectedDelays);
  });
}

test("persistent attachment 1012 has seven requests and fixed bounded backoff", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ errorCode: 1012, errorMessage: "Parent unavailable" }));
    },
  });
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, clock)), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    assert.equal(error.attempts, 7);
    return true;
  });
  assert.equal(s.uploads.length, 7);
  assert.deepEqual(clock.delays, [2000, 4000, 8000, 16000, 30000, 30000]);
});

test("main-file 1012 is never retried", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end('{"errorCode":1012}');
    },
  });
  const clock = virtualTime();
  let rejections = 0;
  const config = await options(t, s, {
    ...clock,
    metadata: { releaseType: "release" },
    onRetryableRejection: () => { rejections++; },
  });
  await assert.rejects(uploadFile(config), (error) => {
    assert.equal(error.attempts, 1);
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    return true;
  });
  assert.equal(s.uploads.length, 1);
  assert.equal(rejections, 0);
  assert.deepEqual(clock.delays, []);
});

for (const [status, body, uncertain] of [
  [400, '{"errorCode":"1012"}', false],
  [400, '{"errorCode":1013,"errorMessage":"1012 Invalid parentFileID"}', false],
  [400, 'Invalid parentFileID: errorCode 1012', false],
  [400, '{"errorCode":1012', false],
  [401, '{"errorCode":1012}', false],
  [429, '{"errorCode":1012}', false],
  [500, '{"errorCode":1012}', true],
  [502, 'Bad gateway', true],
  [503, '', true],
  [599, '{"errorCode":1012}', true],
  [307, '{"errorCode":1012}', true],
  [200, '{"errorCode":1012}', true],
  [200, '{"id":0}', true],
  [200, '{"id":"1e3"}', true],
  [200, '{"id":9007199254740992}', true],
  [200, 'not JSON', true],
  [204, '', true],
]) {
  test(`never retry ${status} ${body}`, async (t) => {
    const s = await server(t, {
      respond: (_req, res) => {
        res.writeHead(status, { location: "/must-not-be-followed" });
        res.end(body);
      },
    });
    const clock = virtualTime();
    let rejections = 0;
    await assert.rejects(uploadFile(await options(t, s, {
      ...clock,
      onRetryableRejection: () => { rejections++; },
    })), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.uncertain, uncertain);
      assert.equal(error.attempts, 1);
      if (uncertain) assert.match(error.message, /uncertain.*check.*before retry/i);
      return true;
    });
    assert.equal(s.requests.length, 1);
    assert.equal(rejections, 0);
    assert.deepEqual(clock.delays, []);
  });
}

for (const failure of ["connection", "deadline", "success body deadline", "error body deadline", "truncated error"]) {
  test(`${failure} is uncertain and sends one request`, async (t) => {
    const s = await server(t, {
      respond: (req, res) => {
        if (failure === "connection") return req.socket.destroy();
        if (failure === "deadline") return;
        if (failure === "truncated error") {
          res.writeHead(400, { "content-length": 999 });
          res.write('{"errorCode":1012}');
          setImmediate(() => res.destroy());
          return;
        }
        res.writeHead(failure === "error body deadline" ? 400 : 200);
        res.write('{"errorCode":1012');
      },
    });
    const clock = virtualTime();
    await assert.rejects(uploadFile(await options(t, s, { ...clock, timeoutMs: 40 })), (error) => {
      assert.equal(error.uncertain, true);
      assert.equal(error.errorCode, null);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /uncertain.*check.*before retry/i);
      return true;
    });
    assert.equal(s.uploads.length, 1);
    assert.deepEqual(clock.delays, []);
  });
}

test("deadline expiration during backoff prevents another request", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end('{"errorCode":1012}');
    },
  });
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, { ...clock, timeoutMs: 1000 })), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    assert.equal(error.attempts, 1);
    assert.match(error.message, /deadline/i);
    return true;
  });
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(clock.delays, [1000]);
});

test("request time and backoff share the original per-file deadline", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end('{"errorCode":1012}');
    },
  });
  const clock = virtualTime();
  const fetch = async (...args) => {
    const response = await s.fetch(...args);
    clock.advance(500);
    return response;
  };
  await assert.rejects(uploadFile(await options(t, s, { ...clock, fetch, timeoutMs: 4000 })), (error) => {
    assert.equal(error.attempts, 2);
    assert.equal(error.uncertain, false);
    assert.match(error.message, /deadline/i);
    return true;
  });
  assert.equal(s.uploads.length, 2);
  assert.deepEqual(clock.delays, [2000, 1000]);
});

test("attempt persistence failure is certain and occurs before the request", async (t) => {
  const s = await server(t);
  await assert.rejects(uploadFile(await options(t, s, {
    onAttempt: () => { throw new Error(`receipt failure ${token}`); },
  })), (error) => {
    assert.equal(error.uncertain, false);
    assert.equal(error.attempts, 0);
    assert.equal(error.status, null);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /receipt failure \[REDACTED\]/);
    return true;
  });
  assert.equal(s.requests.length, 0);
});

test("deadline elapsed while saving an attempt prevents the request", async (t) => {
  const s = await server(t);
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, {
    ...clock,
    timeoutMs: 1000,
    onAttempt: () => clock.advance(1000),
  })), (error) => {
    assert.equal(error.uncertain, false);
    assert.equal(error.attempts, 0);
    return true;
  });
  assert.equal(s.requests.length, 0);
});

test("complete HTTP errors retain structured codes beyond the displayed excerpt and redact tokens", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ errorMessage: token + "한".repeat(5000), errorCode: 1012 }));
    },
  });
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, clock)), (error) => {
    assert.equal(error.errorCode, 1012);
    assert.equal(error.attempts, 7);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /\[REDACTED\]/);
    const displayed = error.message.split("): ")[1];
    assert.ok(Buffer.byteLength(displayed) <= 4096);
    return true;
  });
});

test("token crossing the excerpt limit is redacted before display truncation", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(403);
      res.end("x".repeat(4085) + token + "x".repeat(5000));
    },
  });
  await assert.rejects(uploadFile(await options(t, s)), (error) => {
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(token.slice(0, 10)), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

for (const status of [200, 400]) {
  test(`oversized ${status} response is uncertain and never retried`, async (t) => {
    const s = await server(t, {
      respond: (_req, res) => {
        res.writeHead(status);
        res.end(JSON.stringify({ id: 42, errorCode: 1012, message: "x".repeat(1024 * 1024) }));
      },
    });
    const clock = virtualTime();
    await assert.rejects(uploadFile(await options(t, s, clock)), (error) => {
      assert.equal(error.uncertain, true);
      assert.equal(error.errorCode, null);
      assert.equal(error.attempts, 1);
      assert.ok(Buffer.byteLength(error.message) < 4300);
      return true;
    });
    assert.equal(s.requests.length, 1);
    assert.deepEqual(clock.delays, []);
  });
}

test("catalog requests retain JSON/status API and do not report upload uncertainty", async (t) => {
  const s = await server(t, {
    respond: (req, res) => {
      res.writeHead(req.url.endsWith("/versions") ? 200 : 307, { location: "/other" });
      res.end(req.url.endsWith("/versions") ? '[{"id":42}]' : token);
    },
  });
  const result = await requestJSON(s.fetch, new URL("/api/game/versions", url), {}, "Catalog", token, 1000);
  assert.deepEqual(result, { data: [{ id: 42 }], status: 200 });
  await assert.rejects(requestJSON(s.fetch, new URL("/api/game/version-types", url), {}, "Catalog", token, 1000), (error) => {
    assert.equal(error.status, 307);
    assert.equal(error.uncertain, false);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(s.requests.length, 2);
  assert.equal(s.uploads.length, 0);
});

test("catalog server errors retain their status without upload uncertainty", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(500);
      res.end(JSON.stringify({ errorCode: 1012, errorMessage: token }));
    },
  });
  await assert.rejects(requestJSON(s.fetch, new URL("/api/game/versions", url), {}, "Catalog", token, 1000), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(s.requests.length, 1);
  assert.equal(s.uploads.length, 0);
});

test("successful UTF-8 JSON with a byte-order mark remains supported", async (t) => {
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(200);
      res.end('\uFEFF{"id":42}');
    },
  });
  assert.equal(await uploadFile(await options(t, s)), 42);
  assert.equal(s.uploads.length, 1);
});

test("a complete JSON failure at the internal byte limit retains its numeric code", async (t) => {
  const prefix = '{"errorCode":1012,"message":"';
  const suffix = '"}';
  const s = await server(t, {
    respond: (_req, res) => {
      res.writeHead(400);
      res.end(prefix + "x".repeat(1024 * 1024 - prefix.length - suffix.length) + suffix);
    },
  });
  await assert.rejects(requestJSON(s.fetch, url, {}, "Catalog", token, 1000), (error) => {
    assert.equal(error.errorCode, 1012);
    assert.equal(error.uncertain, false);
    assert.ok(Buffer.byteLength(error.message) < 4200);
    return true;
  });
  assert.equal(s.requests.length, 1);
});

test("connection error credentials are redacted without retrying", async (t) => {
  const s = await server(t);
  let calls = 0;
  const clock = virtualTime();
  await assert.rejects(uploadFile(await options(t, s, {
    ...clock,
    fetch: () => {
      calls++;
      throw new Error(`connection failed ${token}`);
    },
  })), (error) => {
    assert.equal(error.uncertain, true);
    assert.equal(error.attempts, 1);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(clock.delays, []);
});

for (const status of [200, 400]) {
  test(`invalid UTF-8 ${status} JSON is never accepted or retried`, async (t) => {
    const s = await server(t, {
      respond: (_req, res) => {
        res.writeHead(status);
        res.end(Buffer.concat([
          Buffer.from('{"id":42,"errorCode":1012,"message":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]));
      },
    });
    const clock = virtualTime();
    await assert.rejects(uploadFile(await options(t, s, clock)), (error) => {
      assert.equal(error.errorCode, null);
      assert.equal(error.uncertain, status === 200);
      assert.equal(error.attempts, 1);
      return true;
    });
    assert.equal(s.uploads.length, 1);
    assert.deepEqual(clock.delays, []);
  });
}

for (const status of [200, 400]) {
  test(`a fetch ignoring abort cannot accept or retry a late ${status} response`, async (t) => {
    const s = await server(t);
    let calls = 0;
    const clock = virtualTime();
    await assert.rejects(uploadFile(await options(t, s, {
      ...clock,
      timeoutMs: 5,
      fetch: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response('{"id":42,"errorCode":1012}', { status });
      },
    })), (error) => {
      assert.equal(error.uncertain, true);
      assert.equal(error.errorCode, null);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /deadline/i);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(clock.delays, []);
  });
}
