"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const advanced = require("../knowledge-advanced-core");
const notes = require("../knowledge-core");
const { createServer } = require("../server");

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-advanced-"));
  const n = path.join(temp, "notes"), h = path.join(temp, "history"), c = path.join(temp, "boards");
  try { return fn(n, h, c); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
async function withServer(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-advanced-http-"));
  const server = createServer({ env: {}, knowledgeDirectory: path.join(tmp, "notes") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await fn("http://127.0.0.1:" + server.address().port); }
  finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function jsonPost(base, route, data) {
  return fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data) });
}

test("keeps previous revisions and allows reversible restoration without losing current text", () => fixture((root, history) => {
  advanced.saveNote(root, history, "Ветка/Тема.md", "# Первая");
  assert.equal(advanced.history(history, "Ветка/Тема.md").length, 0);
  advanced.saveNote(root, history, "Ветка/Тема.md", "# Вторая");
  const versions = advanced.history(history, "Ветка/Тема.md");
  assert.equal(versions.length, 1);
  assert.equal(advanced.readVersion(history, "Ветка/Тема.md", versions[0].id).content, "# Первая");
  advanced.restoreNote(root, history, "Ветка/Тема.md", versions[0].id);
  assert.equal(notes.read(root, "Ветка/Тема.md").content, "# Первая");
  assert.equal(advanced.history(history, "Ветка/Тема.md").length, 2);
  advanced.deleteNote(root, history, "Ветка/Тема.md");
  assert.equal(notes.list(root).notes.length, 0);
  const afterDelete = advanced.history(history, "Ветка/Тема.md");
  advanced.restoreNote(root, history, "Ветка/Тема.md", afterDelete[0].id);
  assert.equal(notes.read(root, "Ветка/Тема.md").content, "# Первая");
}));

test("history only tracks actual updates and refuses malicious version id", () => fixture((root, history) => {
  advanced.saveNote(root, history, "A.md", "x");
  assert.deepEqual(advanced.saveNote(root, history, "A.md", "x"), { path: "A.md", unchanged: true });
  assert.equal(advanced.history(history, "A.md").length, 0);
  assert.throws(() => advanced.readVersion(history, "A.md", "../../secrets"), { status: 400 });
  assert.throws(() => advanced.saveNote(root, history, "A.md", "a".repeat(128 * 1024 + 1)), { status: 413 });
  assert.equal(notes.read(root, "A.md").content, "x");
}));

test("stores Canvas boards with text cards, file cards and directed links", () => fixture((root, history, boards) => {
  const board = advanced.saveCanvas(boards, "Идеи", {
    nodes: [{ id: "n1", type: "text", text: "Проверить идеи", x: 22, y: 46 },
      { id: "n2", type: "file", file: "Темы/Анализ.md", x: 385, y: 90 }],
    edges: [{ from: "n1", to: "n2" }]
  });
  assert.equal(board.nodes.length, 2);
  assert.deepEqual(advanced.readCanvas(boards, "Идеи").edges, [{ from: "n1", to: "n2" }]);
  assert.equal(advanced.listCanvases(boards).length, 1);
  assert.deepEqual(advanced.deleteCanvas(boards, "Идеи"), { deleted: "Идеи" });
  assert.equal(advanced.listCanvases(boards).length, 0);
}));

test("Canvas rejects traversal, invalid link endpoints, duplicate IDs and oversized cards", () => fixture((root, history, boards) => {
  const card = { id: "a", type: "text", text: "abc", x: 10, y: 15 };
  assert.throws(() => advanced.saveCanvas(boards, "../outside", { nodes: [card], edges: [] }), { status: 400 });
  assert.throws(() => advanced.saveCanvas(boards, "test", { nodes: [card, card], edges: [] }), { status: 400 });
  assert.throws(() => advanced.saveCanvas(boards, "test", { nodes: [card], edges: [{ from: "a", to: "z" }] }), { status: 400 });
  assert.throws(() => advanced.saveCanvas(boards, "test", {
    nodes: [{ ...card, text: "x".repeat(2501) }], edges: []
  }), { status: 400 });
}));

test("frontmatter fields build a read-only property index for Bases", () => fixture(root => {
  notes.save(root, "Гараж/ТО.md", "---\nstatus: Проверено\npriority: 2\ntags: [авто, ремонт]\n---\n# План");
  notes.save(root, "Гараж/Пусто.md", "# Нет данных");
  const result = advanced.bases(root);
  assert.equal(result.rows.length, 2);
  assert.ok(result.columns.includes("status"));
  const row = result.rows.find(item => item.title === "ТО");
  assert.equal(row.properties.status, "Проверено");
  assert.deepEqual(row.properties.tags, ["авто", "ремонт"]);
  assert.equal(advanced.properties("---\n__proto__: hacked\n---\n").__proto__, undefined);
}));

test("HTTP Canvas, Bases and History API work and block cross-origin writes", async () => {
  await withServer(async base => {
    let r = await jsonPost(base, "/api/knowledge/note", { path: "Автомобили.md", content: "---\nstatus: idea\n---\n# Один" });
    assert.equal(r.status, 200);
    r = await jsonPost(base, "/api/knowledge/note", { path: "Автомобили.md", content: "---\nstatus: ready\n---\n# Два" });
    assert.equal(r.status, 200);
    r = await fetch(base + "/api/knowledge/history?path=" + encodeURIComponent("Автомобили.md"));
    assert.equal(r.status, 200);
    const versions = (await r.json()).versions;
    assert.equal(versions.length, 1);
    r = await fetch(base + "/api/knowledge/history/version?path=" + encodeURIComponent("Автомобили.md") + "&id=" + versions[0].id);
    assert.match((await r.json()).content, /Один/);
    r = await fetch(base + "/api/knowledge/bases");
    const bases = await r.json();
    assert.equal(bases.rows[0].properties.status, "ready");
    r = await jsonPost(base, "/api/knowledge/canvas", {
      name: "План", board: { nodes: [{ id: "x", type: "text", text: "Старт", x: 1, y: 2 }], edges: [] }
    });
    assert.equal(r.status, 200);
    r = await fetch(base + "/api/knowledge/canvases");
    assert.equal((await r.json()).boards.length, 1);
    r = await jsonPost(base, "/api/knowledge/history/restore", { path: "Автомобили.md", id: versions[0].id });
    assert.equal(r.status, 200);
    r = await fetch(base + "/api/knowledge/note?path=" + encodeURIComponent("Автомобили.md"));
    assert.match((await r.json()).content, /Один/);
    r = await fetch(base + "/api/knowledge/canvas?name=../secret");
    assert.equal(r.status, 400);
    r = await fetch(base + "/api/knowledge/canvas", {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "evil", board: { nodes: [], edges: [] } })
    });
    assert.equal(r.status, 403);
    for (const asset of ["/knowledge-markdown.js", "/knowledge-advanced.js", "/knowledge-advanced.css"]) {
      r = await fetch(base + asset); assert.equal(r.status, 200, asset);
    }
    r = await fetch(base + "/knowledge-advanced-core.js");
    assert.equal(r.status, 404);
  });
});
