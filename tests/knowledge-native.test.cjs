"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildNote, TEMPLATES } = require("../knowledge-native");
const vault = require("../knowledge-core");
const { createServer } = require("../server");

test("native templates start from an empty knowledge vault and create user-owned content", () => {
  for (const template of Object.keys(TEMPLATES)) {
    const note = buildNote("Моя идея", "Проекты/2026", template);
    assert.equal(note.path, "Проекты/2026/Моя идея.md");
    assert.match(note.content, /# Моя идея/);
    if (template !== "blank") assert.match(note.content, /^---\n/);
    assert.doesNotMatch(note.content, /API_KEY|github\.com/i);
  }
  assert.equal(buildNote("Просто заметка.md", "", "blank").path, "Просто заметка.md");
  assert.equal(buildNote("Просто заметка", "", "blank").content, "# Просто заметка\n\n");
});

test("native note builder validates names and never permits path traversal", () => {
  for (const title of ["", "../секрет", "/секрет", "C:\\секрет", "CON", "..", ".hidden", "bad|name"]) {
    assert.throws(() => buildNote(title, "", "blank"), title);
  }
  assert.throws(() => buildNote("Новая", "../вне", "blank"));
  assert.throws(() => buildNote("Новая", "", "external"));
});

test("create-only storage never overwrites an existing note", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayu-native-create-"));
  try {
    const draft = buildNote("Исследование", "Мои заметки", "research");
    const created = vault.create(root, draft.path, draft.content);
    assert.equal(created.created, true);
    assert.equal(vault.read(root, draft.path).content, draft.content);
    assert.throws(() => vault.create(root, draft.path, "Потерять старый текст"), { status: 409 });
    assert.equal(vault.read(root, draft.path).content, draft.content);
    assert.throws(() => vault.create(root, "../secret.md", "bad"), { status: 400 });
    assert.throws(() => vault.create(root, "A.md", "a".repeat(128 * 1024 + 1)), { status: 413 });
    assert.equal(vault.list(root).notes.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new native-creation HTTP endpoint is local-only and refuses overwrites", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayu-native-http-"));
  const server = createServer({ env: {}, knowledgeDirectory: root });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const create = (draft, origin) => fetch(base + "/api/knowledge/note/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(draft)
  });
  try {
    const empty = await fetch(base + "/api/knowledge");
    assert.equal((await empty.json()).notes.length, 0);
    const draft = buildNote("План", "Мои проекты", "project");
    const blocked = await create(draft, "https://other.example");
    assert.equal(blocked.status, 403);
    const success = await create(draft);
    assert.equal(success.status, 201);
    assert.equal((await success.json()).created, true);
    const repeated = await create({ path: draft.path, content: "Обновление" });
    assert.equal(repeated.status, 409);
    assert.equal(vault.read(root, draft.path).content, draft.content);
    const assets = await fetch(base + "/knowledge-native.js");
    assert.equal(assets.status, 200);
    assert.match(await assets.text(), /AmayurenaNative/);
    const index = await fetch(base + "/");
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /knowledge-create-form/);
    assert.match(html, /knowledge-create-template/);
    assert.doesNotMatch(html, /knowledge-import-files|knowledge-import"/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
