"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

async function withServer(options, callback) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await callback("http://127.0.0.1:" + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

test("serves application without exposing server files", async () => {
  await withServer({ env: {} }, async base => {
    const index = await fetch(base + "/");
    assert.equal(index.status, 200);
    assert.match(await index.text(), /agent-workspace/);
    const script = await fetch(base + "/workspace.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    const secret = await fetch(base + "/server-core.js");
    assert.equal(secret.status, 404);
    const status = await fetch(base + "/api/status");
    assert.deepEqual(await status.json(), { configured: false, model: "endpoint-selected" });
  });
});

test("blocks cross-origin requests and unsafe host", async () => {
  await withServer({ env: {} }, async base => {
    const request = await fetch(base + "/api/tools", {
      method: "POST", headers: { "Origin": "http://evil.test", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "current_time_utc", args: {} })
    });
    assert.equal(request.status, 403);
    const badHost = await fetch(base + "/api/status", { headers: { Host: "badhost.test" } });
    assert.equal(badHost.status, 403);
  });
});

test("local tools work without a paid model", async () => {
  await withServer({ env: {} }, async base => {
    const response = await fetch(base + "/api/tools", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "calculate", args: { operation: "add", a: 2, b: 5 } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { result: 7 } });
  });
});

test("chat returns clear configuration error when Cloud.ru is not configured", async () => {
  await withServer({ env: {} }, async base => {
    const response = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { name: "Тест", enabledTools: [] }, input: "Привет", mode: "chat", history: [] })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Cloud.ru/);
  });
});
