"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { POSE_NAMES } = require("../avatar-package");
const { fakeWebp } = require("./helpers/zip-builder.cjs");
const { status, collectAvatars, publishAvatars, REPO } = require("../avatar-publisher");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-publisher-"));
  const directory = path.join(root, "assets", "avatars");
  fs.mkdirSync(directory, { recursive: true });
  for (const [i, name] of POSE_NAMES.entries()) fs.writeFileSync(path.join(directory, name), fakeWebp(i));
  return root;
}
test("reports installed count, distinct images and configuration safely", () => {
  const root = fixture();
  try {
    const report = status(root, { AMAYURENA_GITHUB_TOKEN: "secret" });
    assert.equal(report.installed, 10);
    assert.equal(report.unique, 10);
    assert.equal(report.configured, true);
    assert.equal(JSON.stringify(report).includes("secret"), false);
    fs.copyFileSync(path.join(root, "assets", "avatars", POSE_NAMES[0]),
      path.join(root, "assets", "avatars", POSE_NAMES[5]));
    const second = status(root, {});
    assert.equal(second.unique, 9);
    assert.equal(second.duplicates.length, 1);
    assert.equal(second.configured, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects missing, invalid or symbolic link images", async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "assets", "avatars", POSE_NAMES[2]), "bad");
    assert.throws(() => collectAvatars(root), /Недопустимый/);
    fs.writeFileSync(path.join(root, "assets", "avatars", POSE_NAMES[2]), fakeWebp(2));
    fs.unlinkSync(path.join(root, "assets", "avatars", POSE_NAMES[2]));
    assert.throws(() => collectAvatars(root), /Не найдено/);
    await assert.rejects(() => publishAvatars(root, { AMAYURENA_GITHUB_TOKEN: "secret" }, async () => {
      throw new Error("Should not upload invalid data");
    }), /Не найдено/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("refuses publishing without secret, and never returns secret in errors", async () => {
  const root = fixture();
  try {
    await assert.rejects(() => publishAvatars(root, {}), /Токен GitHub/);
    await assert.rejects(() => publishAvatars(root, { AMAYURENA_GITHUB_TOKEN: "secret" },
      async () => ({ ok: false, status: 403 })), error =>
      error.message.includes("права") && !error.message.includes("secret"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("creates PR through GitHub Git Data API with only ten allowed WebP paths", async () => {
  const root = fixture();
  try {
    const operations = [];
    const SHAS = {
      base: "a".repeat(40), baseTree: "b".repeat(40), blob: "c".repeat(40),
      tree: "d".repeat(40), commit: "e".repeat(40)
    };
    const fake = async (url, options) => {
      assert.ok(url.startsWith("https://api.github.com/repos/" + REPO));
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.equal(options.redirect, "error");
      const body = options.body && JSON.parse(options.body);
      operations.push({ url, method: options.method, body });
      if (url.endsWith("/git/ref/heads/main")) return { ok: true, json: async () => ({ object: { sha: SHAS.base } }) };
      if (url.endsWith("/git/commits/" + SHAS.base)) return { ok: true, json: async () => ({ tree: { sha: SHAS.baseTree } }) };
      if (url.endsWith("/git/blobs")) {
        assert.equal(body.encoding, "base64");
        assert.equal(Buffer.from(body.content, "base64").subarray(0,4).toString(), "RIFF");
        return { ok: true, json: async () => ({ sha: SHAS.blob }) };
      }
      if (url.endsWith("/git/trees")) {
        assert.equal(body.base_tree, SHAS.baseTree);
        assert.deepEqual(body.tree.map(x => x.path),
          POSE_NAMES.map(name => "assets/avatars/" + name));
        return { ok: true, json: async () => ({ sha: SHAS.tree }) };
      }
      if (url.endsWith("/git/commits")) {
        assert.deepEqual(body.parents, [SHAS.base]);
        return { ok: true, json: async () => ({ sha: SHAS.commit }) };
      }
      if (url.endsWith("/git/refs")) {
        assert.match(body.ref, /^refs\/heads\/avatar-images-/);
        assert.equal(body.sha, SHAS.commit);
        return { ok: true, json: async () => ({ ref: body.ref }) };
      }
      if (url.endsWith("/pulls")) {
        assert.equal(body.base, "main");
        assert.ok(body.head.startsWith("avatar-images-"));
        return { ok: true, json: async () => ({ html_url: "https://github.com/Aspksa/Amayurena/pull/99" }) };
      }
      throw new Error("Unexpected GitHub call " + url);
    };
    const report = await publishAvatars(root, { AMAYURENA_GITHUB_TOKEN: "test-token" }, fake, {
      now: new Date("2026-10-29T00:00:00Z"),
      randomBytes: () => Buffer.from("1234567890", "hex")
    });
    assert.equal(report.published, 10);
    assert.equal(report.unique, 10);
    assert.equal(report.pullRequest, "https://github.com/Aspksa/Amayurena/pull/99");
    assert.equal(operations.filter(x => x.url.endsWith("/git/blobs")).length, 10);
    assert.equal(operations.at(-1).url.endsWith("/pulls"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
