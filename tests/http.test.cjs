"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");
const http = require("node:http");

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
    const target = new URL(base);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: Number(target.port),
        path: "/api/status", method: "GET", headers: { Host: "badhost.test" } },
        res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
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

test("limits API request body to 128 KiB and returns 413", async () => {
  await withServer({ env: {} }, async base => {
    const response = await fetch(base + "/api/tools", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "text_statistics", args: { text: "a".repeat(140000) } })
    });
    assert.equal(response.status, 413);
  });
});

test("serves avatar scripts, styles and fallback art without exposing arbitrary files", async () => {
  await withServer({ env: {} }, async base => {
    for (const pathname of ["/avatar.js", "/avatar-assets.js", "/avatar.css", "/avatar-default.svg"]) {
      const response = await fetch(base + pathname);
      assert.equal(response.status, 200, pathname);
      assert.ok((await response.text()).length > 50);
    }
    assert.equal((await fetch(base + "/assets/avatars/pose-01.webp")).status, 404);
    assert.equal((await fetch(base + "/assets/avatars/../../server.js")).status, 404);
  });
});

test("installs ten avatar images via local ZIP upload and serves installed WebP", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { makeZip } = require("./helpers/zip-builder.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-api-avatar-"));
  try {
    await withServer({ env: {}, avatarDirectory: root }, async base => {
      const blocked = await fetch(base + "/api/avatar/install", {
        method: "POST", headers: { "Content-Type": "text/plain" }, body: "bad archive"
      });
      assert.equal(blocked.status, 415);
      const foreign = await fetch(base + "/api/avatar/install", {
        method: "POST", headers: { "Origin": "https://evil.test", "Content-Type": "application/zip" },
        body: makeZip()
      });
      assert.equal(foreign.status, 403);
      const response = await fetch(base + "/api/avatar/install", {
        method: "POST", headers: { "Content-Type": "application/zip" }, body: makeZip()
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { installed: 10, directory: "assets/avatars" });
      const image = await fetch(base + "/assets/avatars/pose-01.webp");
      assert.equal(image.status, 200);
      assert.ok(image.headers.get("content-type").includes("image/webp"));
      assert.ok((await image.arrayBuffer()).byteLength > 16);
      const wrong = await fetch(base + "/assets/avatars/pose-11.webp");
      assert.equal(wrong.status, 404);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("publishing requires confirmation and configured GitHub token", async () => {
  await withServer({ env: {} }, async base => {
    const status = await fetch(base + "/api/avatar/publish/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      installed: 0, configured: false, totalBytes: 0, unique: 0, duplicates: []
    });
    const wrongOrigin = await fetch(base + "/api/avatar/publish", {
      method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://evil.test" },
      body: JSON.stringify({ confirm: "PUBLISH_AVATARS" })
    });
    assert.equal(wrongOrigin.status, 403);
    const badConfirmation = await fetch(base + "/api/avatar/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(badConfirmation.status, 400);
    const missingToken = await fetch(base + "/api/avatar/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "PUBLISH_AVATARS" })
    });
    assert.equal(missingToken.status, 503);
  });
});

test("serves built-in AVIF sprite without requiring ZIP installation", async () => {
  await withServer({ env: {} }, async base => {
    const response = await fetch(base + "/assets/avatars/sprite.avif");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/avif");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, 19154);
    assert.equal(bytes.toString("ascii", 4, 12), "ftypavif");
  });
});
