"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tools = require("../knowledge-editor-tools");

function memoryStorage(start = {}) {
  const values = new Map(Object.entries(start));
  return { getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key,value) => values.set(key,String(value)), snapshot:() => Object.fromEntries(values) };
}
test("tabs persist without storing note content and reopen in the right order", () => {
  const storage = memoryStorage(), state = tools.workspace(storage);
  state.open("Проекты/План.md");
  state.open("Гараж/Ремонт.md");
  state.open("Проекты/План.md");
  assert.deepEqual(state.state.tabs, ["Проекты/План.md","Гараж/Ремонт.md"]);
  assert.deepEqual(state.state.recent, ["Проекты/План.md","Гараж/Ремонт.md"]);
  state.pin("Гараж/Ремонт.md");
  state.favorite("Проекты/План.md");
  const restored = tools.workspace(storage);
  assert.deepEqual(restored.state.pinned, ["Гараж/Ремонт.md"]);
  assert.deepEqual(restored.state.favorites, ["Проекты/План.md"]);
  assert.equal(JSON.stringify(storage.snapshot()).includes("Секретное содержимое"), false);
  restored.close("Проекты/План.md");
  assert.deepEqual(restored.state.tabs, ["Гараж/Ремонт.md"]);
  assert.deepEqual(restored.state.favorites, ["Проекты/План.md"]);
});
test("tabs enforce a limit and reject invalid paths or corrupt browser storage", () => {
  const storage = memoryStorage({"amayu.editor.tabs":"not-json",
    "amayu.editor.favorites":'["../bad.md","Важная.md","Важная.md"]'});
  const state = tools.workspace(storage);
  assert.deepEqual(state.state.tabs, []);
  assert.deepEqual(state.state.favorites, ["Важная.md"]);
  for(let i=0;i<12;i++) state.open("note-"+i+".md");
  assert.throws(() => state.open("one-more.md"), /12 вкладок/);
  assert.equal(state.state.tabs.length, 12);
  assert.throws(() => state.open("../secrets.md"));
});
test("move and delete reconcile tabs, favorites, pinned and recent", () => {
  const state = tools.workspace(memoryStorage());
  state.open("A/First.md"); state.open("A/B/Second.md"); state.open("Other.md");
  state.favorite("A/First.md"); state.pin("A/B/Second.md");
  state.changePath("A", "Notes", true);
  assert.deepEqual(state.state.tabs, ["Notes/First.md","Notes/B/Second.md","Other.md"]);
  assert.deepEqual(state.state.pinned, ["Notes/B/Second.md"]);
  state.changePath("Notes/First.md", "Notes/Renamed.md");
  assert.deepEqual(state.state.favorites, ["Notes/Renamed.md"]);
  state.reconcile(["Notes/Renamed.md","Other.md"]);
  assert.deepEqual(state.state.tabs, ["Notes/Renamed.md","Other.md"]);
  state.forget("Notes/Renamed.md");
  assert.deepEqual(state.state.favorites, []);
});
test("formatting safely wraps selection and maintains edit positions", () => {
  for (const [mode,prefix,suffix] of [
    ["bold","**","**"],["italic","*","*"],["wikilink","[[","]]"],
    ["code",String.fromCharCode(96),String.fromCharCode(96)]
  ]) {
    const result = tools.formatSelection("abc xyz",4,7,mode);
    assert.equal(result.content,"abc "+prefix+"xyz"+suffix);
    assert.equal(result.content.slice(result.start,result.end),"xyz");
  }
  const linked=tools.formatSelection("abc",0,3,"link");
  assert.equal(linked.content,"[abc](https://example.com)");
  assert.equal(linked.content.slice(linked.start,linked.end),"abc");
  assert.throws(()=>tools.formatSelection("abc",7,8,"bold"));
  assert.throws(()=>tools.formatSelection("abc",0,3,"unsupported"));
});
test("formatting headings, checklists and quotes works on multiple lines", () => {
  const result=tools.formatSelection("one\ntwo\nthree",1,7,"task");
  assert.equal(result.content,"- [ ] one\n- [ ] two\nthree");
  assert.equal(tools.formatSelection("A",0,0,"heading").content,"## A");
  assert.equal(tools.formatSelection("one",0,3,"quote").content,"> one");
  assert.equal(tools.formatSelection("one",0,3,"bullet").content,"- one");
});
test("workspace UI includes tab controls, favorites, pins, formatting and nested folder navigation", () => {
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const js=fs.readFileSync(path.join(__dirname,"..","knowledge.js"),"utf8");
  const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  for (const id of ["knowledge-open-tabs","knowledge-tab-close","knowledge-favorites",
    "knowledge-recent","knowledge-favorite","knowledge-pin","knowledge-breadcrumbs","knowledge-format-toolbar"]) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  for (const feature of ["function navigate(fn)","function closeTab(path)","function renderTabs()",
    "function renderTree()","function formatEditor(action)","function renderBreadcrumbs()"]) {
    assert.ok(js.includes(feature),feature);
  }
  assert.match(html,/knowledge-editor-tools\.js/);
  assert.match(server,/knowledge-editor-tools\.js/);
});
