"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const tools = require("../knowledge-editor-tools");

function memoryStore() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}
class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.style = {};
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.classList = { toggle() {} };
  }
  append(...xs) { this.children.push(...xs); }
  replaceChildren(...xs) { this.children = xs; }
  addEventListener(name, cb) { this.listeners[name] = cb; }
  setAttribute(name,value) { this.attributes[name] = value; }
  focus() {}
  select() {}
  scrollIntoView() {}
  setSelectionRange(start,end) { this.selectionStart=start; this.selectionEnd=end; }
  get firstElementChild() { return this.children[0]; }
  click() { if (this.listeners.click) return this.listeners.click({target:this,preventDefault(){}}); }
}
function fakeApp({ delayed = false } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id,new Element(id));
    return elements.get(id);
  };
  const document = {
    getElementById: get, createElement: t => new Element(t),
    createTextNode: t => { const n=new Element("text"); n.textContent=t; return n; },
    createElementNS: (_ns,t) => new Element(t),
    querySelectorAll: () => [],
    addEventListener() {},
    hidden:false
  };
  const notes = new Map([["A.md","First"],["B.md","Second"]]);
  const store = memoryStore(), session = memoryStore();
  const win = { localStorage:store, AmayurenaEditorTools:tools,
    AmayurenaMarkdown:{ render(){} },
    AmayurenaKnowledgeAdvanced:{init(){},update(){},show(){}},
    addEventListener(){}, matchMedia:()=>({matches:false}) };
  let resolveSave = null, saveStarted = false;
  const hash = content => crypto.createHash("sha256").update(content).digest("hex");
  const json=(data,status=200) => ({ ok:status<400, status, json:async()=>data });
  const fetch=async (url, options={}) => {
    const method=options.method||"GET";
    if(url==="/api/knowledge") return json({notes:[...notes].map(([path,body])=>({
      path,title:path.slice(0,-3),folder:"",excerpt:body,updatedAt:new Date().toISOString()
    })),folders:[]});
    if(url==="/api/knowledge/graph") return json({nodes:[],edges:[],missing:[]});
    if(url.startsWith("/api/knowledge/note?")) {
      const path = new URL("http://localhost"+url).searchParams.get("path");
      const body = notes.get(path);
      return body===undefined ? json({error:"Заметка не найдена"},404) : json({path,content:body,sha:hash(body)});
    }
    if(url==="/api/knowledge/note" && method==="POST") {
      const data=JSON.parse(options.body);
      saveStarted = true;
      if (delayed) await new Promise(resolve=>{ resolveSave=resolve; });
      if (hash(notes.get(data.path))!==data.expectedSha) return json({error:"Конфликт сохранения"},409);
      notes.set(data.path,data.content);
      return json({path:data.path,sha:hash(data.content)});
    }
    throw Error("Unexpected fetch "+method+" "+url);
  };
  const context={document,window:win,localStorage:store,sessionStorage:session,fetch,
    URL,URLSearchParams,console,setTimeout,clearTimeout,confirm:()=>false,
    prompt:()=>null,location:{reload(){}},crypto,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","knowledge.js"),"utf8"),
    context,{filename:"knowledge.js"});
  function findNote(path) {
    function walk(node) {
      if (node.title===path && node.className.includes("knowledge-note")) return node;
      for (const ch of node.children||[]) {
        const found=walk(ch); if(found) return found;
      }
      return null;
    }
    return walk(get("knowledge-tree"));
  }
  return {get,notes,session,app:win.AmayurenaKnowledge,findNote,
    get saveStarted(){return saveStarted;},
    releaseSave(){ if(resolveSave)resolveSave(); },
    externalEdit(path,value){notes.set(path,value);}
  };
}
async function until(condition,label) {
  for(let i=0;i<100;i++){
    if(condition())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error("Timeout waiting for "+label);
}
test("tab switch waits for pending save and does not lose the earlier text",async()=>{
  const app=fakeApp({delayed:true});
  await app.app.open();
  app.findNote("A.md").click();
  await until(()=>app.get("knowledge-path").textContent==="A.md","open A");
  app.get("knowledge-editor").value="Updated first";
  app.get("knowledge-editor").listeners.input();
  app.findNote("B.md").click();
  await until(()=>app.saveStarted,"start save");
  assert.equal(app.get("knowledge-path").textContent,"A.md");
  assert.equal(app.notes.get("A.md"),"First");
  app.releaseSave();
  await until(()=>app.get("knowledge-path").textContent==="B.md","open B");
  assert.equal(app.notes.get("A.md"),"Updated first");
  assert.equal(app.get("knowledge-editor").value,"Second");
});
test("conflicting external edit blocks a tab change and preserves the draft",async()=>{
  const app=fakeApp();
  await app.app.open();
  app.findNote("A.md").click();
  await until(()=>app.get("knowledge-path").textContent==="A.md","open A");
  app.get("knowledge-editor").value="My unsaved change";
  app.get("knowledge-editor").listeners.input();
  app.externalEdit("A.md","External change");
  app.findNote("B.md").click();
  await until(()=>app.saveStarted,"attempt save");
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.get("knowledge-path").textContent,"A.md");
  assert.equal(app.get("knowledge-editor").value,"My unsaved change");
  assert.equal(app.notes.get("A.md"),"External change");
  assert.equal(app.session.getItem("amayurena.knowledge.draft.A.md"),"My unsaved change");
});
