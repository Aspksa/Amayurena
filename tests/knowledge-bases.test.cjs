"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const bases=require("../knowledge-bases-core");
const notes=require("../knowledge-core");
const advanced=require("../knowledge-advanced-core");
const maintenance=require("../knowledge-maintenance");
const {createServer}=require("../server");

function fixture(fn) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-bases-"));
  const spec={
    notesRoot:path.join(base,"knowledge"),historyRoot:path.join(base,"history"),
    canvasRoot:path.join(base,"canvases"),trashRoot:path.join(base,"trash"),
    basesRoot:path.join(base,"knowledge-bases"),backupsRoot:path.join(base,"backups")
  };
  try { return fn(spec); } finally { fs.rmSync(base,{recursive:true,force:true}); }
}
async function withServer(fn) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-bases-http-"));
  const spec={
    knowledgeDirectory:path.join(base,"knowledge"),
    knowledgeHistoryDirectory:path.join(base,"history"),
    knowledgeCanvasDirectory:path.join(base,"canvases"),
    knowledgeBasesDirectory:path.join(base,"bases"),
    knowledgeDataDirectory:base,env:{}
  };
  const server=createServer(spec);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {await fn("http://127.0.0.1:"+server.address().port);}
  finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(base,{recursive:true,force:true});}
}
function post(base,url,body,origin) {
  return fetch(base+url,{method:"POST",headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
}
test("typed property writing preserves body and previous fields with snapshot history",()=>fixture(spec=>{
  const body="---\nstatus: Черновик\npriority: 2\n---\n# План\n\n[[Связь]]\n";
  notes.save(spec.notesRoot,"Проект/План.md",body);
  const sha=bases.digest(body);
  const updated=bases.patchProperty(spec.notesRoot,spec.historyRoot,"Проект/План.md","priority","number",5,sha);
  assert.equal(updated.type,"number");
  const current=notes.read(spec.notesRoot,"Проект/План.md").content;
  assert.match(current,/priority: 5/);
  assert.match(current,/status: Черновик/);
  assert.match(current,/# План\n\n\[\[Связь\]\]/);
  assert.equal(advanced.history(spec.historyRoot,"Проект/План.md").length,1);
  assert.equal(advanced.readVersion(spec.historyRoot,"Проект/План.md",
    advanced.history(spec.historyRoot,"Проект/План.md")[0].id).content,body);
  assert.throws(()=>bases.patchProperty(spec.notesRoot,spec.historyRoot,"Проект/План.md",
    "priority","number",7,sha),{status:409});
  assert.equal(notes.read(spec.notesRoot,"Проект/План.md").content,current);
}));
test("property types produce correct frontmatter including dates, checkboxes, arrays, quotes",()=>fixture(spec=>{
  notes.save(spec.notesRoot,"Виды.md","# Исходный текст\n");
  for (const [key,type,value] of [
    ["due","date","2026-12-31"],["done","checkbox",true],
    ["tags","tags",["идеи","важно"]],["price","number",12.5],
    ["status","select","В работе"],["comment","text",'Цитата "внутри" и : символ']
  ]) {
    const original=notes.read(spec.notesRoot,"Виды.md").content;
    bases.patchProperty(spec.notesRoot,spec.historyRoot,"Виды.md",key,type,value,bases.digest(original));
  }
  const actual=notes.read(spec.notesRoot,"Виды.md").content;
  assert.match(actual,/# Исходный текст/);
  const props=advanced.properties(actual);
  assert.equal(props.due,"2026-12-31");
  assert.equal(props.done,"true");
  assert.deepEqual(props.tags,["идеи","важно"]);
  assert.equal(props.price,"12.5");
  assert.equal(props.status,"В работе");
  assert.equal(props.comment,'Цитата "внутри" и : символ');
  assert.throws(()=>bases.formatValue("date","2026-02-30"),{status:400});
  assert.throws(()=>bases.formatValue("number",Infinity),{status:400});
  assert.throws(()=>bases.formatValue("tags",["tag,bad"]),{status:400});
  assert.throws(()=>bases.safeField("__proto__"),{status:400});
}));
test("frontmatter edit preserves Windows CRLF and rejects corrupt or repeated properties",()=>{
  const result=bases.frontmatterEdit("---\r\nstatus: old\r\n---\r\n# File\r\n","status",'"new"');
  assert.equal(result,"---\r\nstatus: \"new\"\r\n---\r\n# File\r\n");
  assert.throws(()=>bases.frontmatterEdit("---\nstatus: a\nstatus: b\n---\nBody","status","x"),{status:400});
  assert.throws(()=>bases.frontmatterEdit("---\nno closing yaml","status","x"),{status:400});
});
test("view settings save with optimistic version and reject untrusted schema",()=>fixture(spec=>{
  const first=bases.loadSettings(spec.basesRoot);
  assert.deepEqual(first.views,[]);
  assert.equal(first.types.constructor,Object);
  const saved=bases.saveSettings(spec.basesRoot,{
    types:{priority:"number",done:"checkbox"},
    views:[{id:"projects",name:"Активные проекты",layout:"cards",sort:"priority",direction:"desc",
      group:"done",filterField:"priority",filterValue:"1"}]
  },first.sha);
  assert.equal(saved.views.length,1);
  assert.equal(bases.loadSettings(spec.basesRoot).views[0].name,"Активные проекты");
  assert.throws(()=>bases.saveSettings(spec.basesRoot,{types:{},views:[]},first.sha),{status:409});
  assert.throws(()=>bases.validateSettings({types:{"__proto__":"text"},views:[{id:"q",name:"X",layout:"evil"}]}),{status:400});
  assert.throws(()=>bases.validateSettings({types:{status:"script"},views:[]}),{status:400});
}));
test("backup includes Bases metadata, restoration recovers views and notes",()=>fixture(spec=>{
  notes.save(spec.notesRoot,"План.md","---\npriority: 10\n---\n# План");
  const empty=bases.loadSettings(spec.basesRoot);
  bases.saveSettings(spec.basesRoot,{types:{priority:"number"},views:[]},empty.sha);
  const copy=maintenance.backup(spec);
  const info=maintenance.verifyBackup(spec,copy.id);
  assert.ok(info.manifest.volumes.includes("bases"));
  assert.ok(info.manifest.files.some(f=>f.path==="bases/views.json"));
  const now=bases.loadSettings(spec.basesRoot);
  bases.saveSettings(spec.basesRoot,{types:{done:"checkbox"},views:[]},now.sha);
  notes.save(spec.notesRoot,"План.md","# Другая версия");
  maintenance.restoreBackup(spec,copy.id);
  assert.equal(bases.loadSettings(spec.basesRoot).types.priority,"number");
  assert.equal(notes.read(spec.notesRoot,"План.md").content,"---\npriority: 10\n---\n# План");
}));
test("HTTP editing, saved views and conflict protection; cross-origin requests blocked",async()=>{
  await withServer(async base=>{
    let r=await post(base,"/api/knowledge/note/create",{path:"A.md",content:"# A"});
    assert.equal(r.status,201);
    r=await fetch(base+"/api/knowledge/note?path=A.md");
    const record=await r.json();
    r=await post(base,"/api/knowledge/bases/property",
      {path:"A.md",key:"priority",type:"number",value:2,expectedSha:record.sha});
    assert.equal(r.status,200);
    r=await post(base,"/api/knowledge/bases/property",
      {path:"A.md",key:"priority",type:"number",value:3,expectedSha:record.sha});
    assert.equal(r.status,409);
    r=await fetch(base+"/api/knowledge/bases");
    const table=await r.json();
    assert.equal(table.rows[0].properties.priority,"2");
    assert.equal(table.rows[0].sha,bases.digest("---\npriority: 2\n---\n# A"));
    r=await post(base,"/api/knowledge/bases/property",
      {path:"A.md",key:"priority",type:"number",value:9,expectedSha:record.sha});
    assert.equal(r.status,409);
    r=await fetch(base+"/api/knowledge/bases");
    assert.equal((await r.json()).rows[0].properties.priority,"2");
    r=await fetch(base+"/api/knowledge/bases/settings");
    const settings=await r.json();
    r=await post(base,"/api/knowledge/bases/settings",{
      expectedSha:settings.sha,settings:{types:{priority:"number"},views:[]}
    });
    assert.equal(r.status,200);
    r=await post(base,"/api/knowledge/bases/settings",{
      expectedSha:settings.sha,settings:{types:{priority:"text"},views:[]}
    });
    assert.equal(r.status,409);
    r=await post(base,"/api/knowledge/bases/property",
      {path:"A.md",key:"secret",type:"text",value:"bad",expectedSha:record.sha},"https://bad.example");
    assert.equal(r.status,403);
    r=await fetch(base+"/knowledge-bases-core.js");
    assert.equal(r.status,404);
  });
});
