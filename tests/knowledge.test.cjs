"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vault = require("../knowledge-core");
const { createServer } = require("../server");

function withVault(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-knowledge-"));
  try { return action(root); }
  finally { fs.rmSync(root, { force: true, recursive: true }); }
}

async function withServer(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-knowledge-http-"));
  const server = createServer({ env: {}, knowledgeDirectory: root });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await callback("http://127.0.0.1:" + server.address().port, root); }
  finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { force: true, recursive: true });
  }
}
async function post(base, uri, data) {
  return fetch(base + uri, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data) });
}

test("stores portable Markdown files and folders and reads them back", () => withVault(root => {
  vault.makeFolder(root, "Проекты/Amayurena");
  vault.save(root, "Проекты/Amayurena/План.md", "# План\n\n[[Идея]]");
  assert.equal(vault.read(root, "Проекты/Amayurena/План.md").content, "# План\n\n[[Идея]]");
  assert.ok(fs.existsSync(path.join(root, "Проекты", "Amayurena", "План.md")));
  const catalog = vault.list(root);
  assert.equal(catalog.notes.length, 1);
  assert.ok(catalog.folders.includes("Проекты/Amayurena"));
  assert.deepEqual(catalog.notes[0].links, ["Идея"]);
}));

test("builds directed knowledge graph and reports broken wikilinks", () => withVault(root => {
  vault.save(root, "Транспорт/Автомобиль.md", "# Авто\n[[ГСМ]]\n[[Неизвестно]]");
  vault.save(root, "Транспорт/ГСМ.md", "# Топливо\n[[Автомобиль|Машина]]");
  const graph = vault.graph(root);
  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.edges.some(edge => edge.from === "Транспорт/Автомобиль.md" && edge.to === "Транспорт/ГСМ.md"));
  assert.ok(graph.edges.some(edge => edge.from === "Транспорт/ГСМ.md" && edge.to === "Транспорт/Автомобиль.md"));
  assert.ok(graph.missing.some(item => item.target === "Неизвестно"));
}));

test("rejects traversal, hidden, device and non-Markdown filenames", () => withVault(root => {
  for (const p of ["../secret.md", "/outside.md", "folder/../../evil.md", "C:\\temp\\evil.md",
    ".hidden.md", "CON.md", "oops.txt", "name?.md", "x//a.md"]) {
    assert.throws(() => vault.save(root, p, "bad"), { status: 400 }, p);
  }
  assert.equal(vault.list(root).notes.length, 0);
}));

test("rejects symlink escape and oversize notes", () => withVault(root => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-outside-"));
  try {
    try { fs.symlinkSync(outside, path.join(root, "escape"), "dir"); }
    catch (error) { if (error.code === "EPERM" || error.code === "EACCES") return; throw error; }
    assert.throws(() => vault.save(root, "escape/hack.md", "x"), { status: 400 });
    assert.equal(fs.existsSync(path.join(outside, "hack.md")), false);
    assert.throws(() => vault.save(root, "too-big.md", "z".repeat(128 * 1024 + 1)), { status: 413 });
  } finally { fs.rmSync(outside, { force: true, recursive: true }); }
}));

test("deletes a note but preserves unrelated files", () => withVault(root => {
  vault.save(root, "A.md", "a");
  vault.save(root, "B.md", "b");
  assert.deepEqual(vault.remove(root, "A.md"), { deleted: "A.md" });
  assert.equal(vault.read(root, "B.md").content, "b");
  assert.throws(() => vault.read(root, "A.md"), { status: 404 });
}));

test("HTTP endpoints support create/list/read/graph/delete and validate requests", async () => {
  await withServer(async base => {
    let response = await post(base, "/api/knowledge/folder", { path: "Заметки" });
    assert.equal(response.status, 200);
    response = await post(base, "/api/knowledge/note", { path: "Заметки/Старт.md", content: "# Старт\n[[План]]" });
    assert.equal(response.status, 200);
    response = await post(base, "/api/knowledge/note", { path: "Заметки/План.md", content: "Связано." });
    assert.equal(response.status, 200);
    response = await fetch(base + "/api/knowledge");
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.notes.length, 2);
    response = await fetch(base + "/api/knowledge/note?path=" + encodeURIComponent("Заметки/Старт.md"));
    assert.equal((await response.json()).content, "# Старт\n[[План]]");
    response = await fetch(base + "/api/knowledge/graph");
    assert.ok((await response.json()).edges.some(e => e.to === "Заметки/План.md"));
    response = await fetch(base + "/api/knowledge/note?path=" + encodeURIComponent("../server.js"));
    assert.equal(response.status, 400);
    response = await post(base, "/api/knowledge/note", { path: "../bad.md", content: "x" });
    assert.equal(response.status, 400);
    response = await fetch(base + "/api/knowledge/note?path=" + encodeURIComponent("Заметки/План.md"), { method: "DELETE" });
    assert.equal(response.status, 200);
    response = await fetch(base + "/knowledge.js");
    assert.equal(response.status, 200);
    response = await fetch(base + "/knowledge.css");
    assert.equal(response.status, 200);
    response = await fetch(base + "/knowledge-core.js");
    assert.equal(response.status, 404);
    response = await fetch(base + "/data/knowledge/Заметки/Старт.md");
    assert.equal(response.status, 404);
  });
});

test("knowledge API inherits local-only request protection", async () => {
  await withServer(async base => {
    const response = await post(base, "/api/knowledge/note", { path: "one.md", content: "ok" });
    assert.equal(response.status, 200);
    const blocked = await fetch(base + "/api/knowledge", { headers: { Origin: "https://other.example" } });
    assert.equal(blocked.status, 403);
    const blockedWrite = await fetch(base + "/api/knowledge/note", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" },
      body: JSON.stringify({ path: "evil.md", content: "bad" })
    });
    assert.equal(blockedWrite.status, 403);
  });
});
