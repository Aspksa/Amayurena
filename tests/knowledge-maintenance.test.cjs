"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const knowledge = require("../knowledge-core");
const advanced = require("../knowledge-advanced-core");
const care = require("../knowledge-maintenance");
const { createServer } = require("../server");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayu-maintenance-"));
  const spec = { notesRoot: path.join(root, "knowledge"), historyRoot: path.join(root, "history"),
    canvasRoot: path.join(root, "canvases"), trashRoot: path.join(root, "trash"),
    backupsRoot: path.join(root, "backups") };
  try { return run(spec, root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function httpFixture(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "amayu-maintenance-http-"));
  const server = createServer({ env: {}, knowledgeDirectory: path.join(temp, "knowledge"),
    knowledgeHistoryDirectory: path.join(temp, "history"),
    knowledgeCanvasDirectory: path.join(temp, "canvases"),
    knowledgeDataDirectory: temp });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
function post(base, uri, data) {
  return fetch(base + uri, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data) });
}
test("search scans entire Markdown text and returns context beyond the old 180-byte excerpts", () => fixture(spec => {
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "Длинная.md", "Старт\n" + "а".repeat(600) + "\nСекретный_Термин в конце");
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "Вторая.md", "Другая тема");
  const results = care.search(spec.notesRoot, "секретный_термин");
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].path, "Длинная.md");
  assert.match(results.results[0].snippet, /Секретный_Термин/);
  assert.throws(() => care.search(spec.notesRoot, "  "), { status: 400 });
}));
test("trash restores original content and never overwrites colliding notes", () => fixture(spec => {
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "Папка/План.md", "# Важное\nданные");
  const removed = care.trashNote(spec, "Папка/План.md");
  assert.equal(knowledge.list(spec.notesRoot).notes.length, 0);
  assert.equal(care.trashList(spec).length, 1);
  knowledge.create(spec.notesRoot, "Папка/План.md", "Новое содержимое");
  assert.throws(() => care.trashRestore(spec, removed.id), { status: 409 });
  assert.equal(knowledge.read(spec.notesRoot, "Папка/План.md").content, "Новое содержимое");
  knowledge.remove(spec.notesRoot, "Папка/План.md");
  care.trashRestore(spec, removed.id);
  assert.equal(knowledge.read(spec.notesRoot, "Папка/План.md").content, "# Важное\nданные");
  assert.equal(care.trashList(spec).length, 0);
  assert.throws(() => care.trashRestore(spec, "../../unsafe"), { status: 400 });
}));
test("rename moves a note, carries its history and updates explicit wiki and Canvas links", () => fixture(spec => {
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "Первое/Идея.md", "# версия1");
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "Первое/Идея.md", "# версия2");
  knowledge.create(spec.notesRoot, "Ссылки.md", "Связь: [[Первое/Идея|Идея]]");
  advanced.saveCanvas(spec.canvasRoot, "Мысли", {
    nodes: [{ id:"n1",type:"file",file:"Первое/Идея.md",x:10,y:10 }], edges: []
  });
  const response = care.renameNote(spec, "Первое/Идея.md", "Второе/План.md");
  assert.equal(response.to, "Второе/План.md");
  assert.equal(knowledge.read(spec.notesRoot, "Второе/План.md").content, "# версия2");
  assert.equal(advanced.history(spec.historyRoot, "Второе/План.md").length, 1);
  assert.equal(advanced.history(spec.historyRoot, "Первое/Идея.md").length, 0);
  assert.match(knowledge.read(spec.notesRoot, "Ссылки.md").content, /\[\[Второе\/План\|Идея\]\]/);
  assert.equal(advanced.readCanvas(spec.canvasRoot, "Мысли").nodes[0].file, "Второе/План.md");
  assert.throws(() => care.renameNote(spec,"Второе/План.md","Ссылки.md"), {status:409});
  assert.equal(knowledge.read(spec.notesRoot,"Второе/План.md").content,"# версия2");
}));
test("folder relocation preserves all nested notes, history and explicit links", () => fixture(spec => {
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "А/Подпапка/Первое.md", "Версия 1");
  advanced.saveNote(spec.notesRoot, spec.historyRoot, "А/Подпапка/Первое.md", "Версия 2");
  knowledge.create(spec.notesRoot, "Ссылка.md", "[[А/Подпапка/Первое]]");
  const result = care.moveFolder(spec,"А","Б");
  assert.equal(result.moved,1);
  assert.equal(knowledge.read(spec.notesRoot,"Б/Подпапка/Первое.md").content,"Версия 2");
  assert.equal(advanced.history(spec.historyRoot,"Б/Подпапка/Первое.md").length,1);
  assert.match(knowledge.read(spec.notesRoot,"Ссылка.md").content, /\[\[Б\/Подпапка\/Первое\]\]/);
  assert.throws(() => care.moveFolder(spec,"Б","Б/Внутри"), {status:400});
}));
test("snapshots cover all four stores, verify integrity, and restore exact content", () => fixture(spec => {
  knowledge.create(spec.notesRoot, "План.md", "Оригинал");
  advanced.saveNote(spec.notesRoot,spec.historyRoot,"План.md","Вторая версия");
  advanced.saveCanvas(spec.canvasRoot,"Доска",{nodes:[{id:"n",type:"text",text:"Связь",x:2,y:3}],edges:[]});
  care.trashNote(spec,"План.md");
  knowledge.create(spec.notesRoot,"Текущее.md","Сейчас");
  const before = care.backup(spec);
  assert.ok(before.count >= 4);
  const verified = care.verifyBackup(spec,before.id);
  assert.equal(verified.manifest.count,before.count);
  knowledge.create(spec.notesRoot,"Позднее.md","Изменения после копирования");
  care.trashRestore(spec,care.trashList(spec)[0].id);
  const restored = care.restoreBackup(spec,before.id);
  assert.equal(restored.restored,before.id);
  assert.equal(knowledge.read(spec.notesRoot,"Текущее.md").content,"Сейчас");
  assert.equal(knowledge.list(spec.notesRoot).notes.length,1);
  assert.equal(care.trashList(spec).length,1);
  assert.equal(advanced.listCanvases(spec.canvasRoot).length,1);
  assert.equal(advanced.history(spec.historyRoot,"План.md").length,2);
  assert.equal(care.backups(spec).length,1);
}));
test("tampered backups are rejected without modifying live data", () => fixture(spec => {
  knowledge.create(spec.notesRoot,"A.md","abc");
  const backup = care.backup(spec);
  fs.writeFileSync(path.join(spec.backupsRoot,backup.id,"knowledge","A.md"),"tampered");
  knowledge.save(spec.notesRoot,"A.md","changed");
  assert.throws(() => care.restoreBackup(spec,backup.id),{status:400});
  assert.equal(knowledge.read(spec.notesRoot,"A.md").content,"changed");
}));
test("API refuses stale autosave, supports full-text, trash and recovery, forbids foreign origins", async () => {
  await httpFixture(async base => {
    let response = await post(base,"/api/knowledge/note/create",{path:"A.md",content:"Start"});
    assert.equal(response.status,201);
    response = await fetch(base+"/api/knowledge/note?path=A.md");
    const original = await response.json();
    assert.equal(original.sha,care.sha("Start"));
    response = await post(base,"/api/knowledge/note",{path:"A.md",content:"First",expectedSha:original.sha});
    assert.equal(response.status,200);
    response = await post(base,"/api/knowledge/note",{path:"A.md",content:"Stale",expectedSha:original.sha});
    assert.equal(response.status,409);
    response = await fetch(base+"/api/knowledge/note?path=A.md");
    assert.equal((await response.json()).content,"First");
    response = await fetch(base+"/api/knowledge/search?q="+encodeURIComponent("first"));
    assert.equal((await response.json()).results[0].path,"A.md");
    response = await fetch(base+"/api/knowledge/note?path=A.md",{method:"DELETE"});
    assert.equal(response.status,200);
    response = await fetch(base+"/api/knowledge/trash");
    const trash = (await response.json()).items;
    assert.equal(trash.length,1);
    response = await post(base,"/api/knowledge/trash/restore",{id:trash[0].id});
    assert.equal(response.status,200);
    response = await post(base,"/api/knowledge/backup/create",{confirm:"CREATE_BACKUP"});
    assert.equal(response.status,201);
    response = await fetch(base+"/api/knowledge/backups");
    assert.equal((await response.json()).items.length,1);
    response = await fetch(base+"/api/knowledge/backup/create",{
      method:"POST",headers:{"Content-Type":"application/json","Origin":"https://outside.test"},
      body:JSON.stringify({confirm:"CREATE_BACKUP"})
    });
    assert.equal(response.status,403);
  });
});
