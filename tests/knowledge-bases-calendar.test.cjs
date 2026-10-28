"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const calendar=require("../knowledge-bases-calendar");
const bases=require("../knowledge-bases-core");
const vault=require("../knowledge-core");
const advanced=require("../knowledge-advanced-core");
const {createServer}=require("../server");
function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-bases-links-"));
 const spec={root,notes:path.join(root,"notes"),history:path.join(root,"history")};
 try{return fn(spec);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test("monthly calendar aligns weekdays, leap-year dates and limits",()=>{
 const items=[{path:"A.md",properties:{due:"2028-02-29"}},{path:"B.md",properties:{due:"2028-02-01"}},
 {path:"C.md",properties:{due:"2028-03-01"}},{path:"D.md",properties:{due:"2028-02-29"}}];
 const data=calendar.calendar("2028-02",items,"due");
 assert.equal(data.totalEntries,3);
 assert.equal(data.weeks[0][0].day,null);
 assert.equal(data.weeks[0][1].day,1);
 assert.equal(data.weeks.flat().find(c=>c.day===29).notes.length,2);
 assert.equal(calendar.moveMonth("2028-12",1),"2029-01");
 assert.equal(calendar.moveMonth("2028-01",-1),"2027-12");
 assert.throws(()=>calendar.calendar("2028-13",items,"due"));
 assert.throws(()=>calendar.calendar("2028-02",Array(4000).fill({}),"due"));
});
test("typed relations persist valid wiki links with history, reject missing paths and conflicts",()=>fixture(s=>{
 vault.create(s.notes,"A.md","# Plan");
 vault.create(s.notes,"Folder/Target.md","# Task");
 const original=vault.read(s.notes,"A.md").content;
 const applied=bases.patchProperty(s.notes,s.history,"A.md","related","relation","Folder/Target.md",bases.digest(original));
 assert.equal(applied.type,"relation");
 const text=vault.read(s.notes,"A.md").content;
 assert.match(text,/related: "\[\[Folder\/Target\]\]"/);
 assert.equal(advanced.properties(text).related,"[[Folder/Target]]");
 const history=advanced.history(s.history,"A.md");
 assert.equal(history.length,1);
 assert.equal(advanced.readVersion(s.history,"A.md",history[0].id).content,original);
 assert.throws(()=>bases.patchProperty(s.notes,s.history,"A.md","related","relation","Folder/Missing.md",bases.digest(text)),{status:404});
 assert.throws(()=>bases.patchProperty(s.notes,s.history,"A.md","related","relation","Folder/Target.md",bases.digest(original)),{status:409});
 assert.throws(()=>bases.patchProperty(s.notes,s.history,"A.md","related","relation","../bad.md",bases.digest(text)));
}));
test("existing formatted relation can be normalized safely",()=>{
 assert.equal(bases.formatValue("relation","[[Garage/Plan]]"),'"[[Garage/Plan]]"');
 assert.equal(bases.formatValue("relation","Garage/Plan.md"),'"[[Garage/Plan]]"');
 assert.throws(()=>bases.formatValue("relation","[[../secret]]"));
 assert.throws(()=>bases.formatValue("relation",123));
});
test("HTTP relation edits, date calendar asset, and origin checks",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-bases-cal-http-"));
 const server=createServer({env:{},knowledgeDirectory:path.join(root,"notes"),
   knowledgeHistoryDirectory:path.join(root,"history"),knowledgeDataDirectory:root});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+server.address().port;
 try{
  vault.create(path.join(root,"notes"),"A.md","# Main");
  vault.create(path.join(root,"notes"),"B.md","# Related");
  const record=await(await fetch(base+"/api/knowledge/note?path=A.md")).json();
  let r=await fetch(base+"/api/knowledge/bases/property",{method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({path:"A.md",key:"related",type:"relation",value:"B.md",expectedSha:record.sha})});
  assert.equal(r.status,200);
  r=await fetch(base+"/api/knowledge/bases");
  assert.equal((await r.json()).rows.find(row=>row.path==="A.md").properties.related,"[[B]]");
  r=await fetch(base+"/knowledge-bases-calendar.js");assert.equal(r.status,200);
  r=await fetch(base+"/api/knowledge/bases/property",{method:"POST",
   headers:{"Content-Type":"application/json",Origin:"https://forbidden.example"},
   body:JSON.stringify({path:"A.md",key:"related",type:"relation",value:"B.md",expectedSha:record.sha})});
  assert.equal(r.status,403);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
test("UI contains a real monthly calendar grid and linked-record action",()=>{
 const src=fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8");
 const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 for(const id of ["knowledge-bases-calendar-month","knowledge-bases-calendar-field","knowledge-bases-calendar-prev","knowledge-bases-calendar-next"])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(src,/function renderCalendarGrid/);
 assert.match(src,/knowledge-bases-relation-open/);
});
