"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const canvas=require("../knowledge-canvas-enhance");
const math=require("../knowledge-bases-math");
const bases=require("../knowledge-bases-core");
const vault=require("../knowledge-core");
const advanced=require("../knowledge-advanced-core");
const catalog=require("../knowledge-map-catalog");
const {createServer}=require("../server");
function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-next-"));
 try{return fn({root,notes:path.join(root,"notes"),history:path.join(root,"history"),
   canvases:path.join(root,"canvases"),bases:path.join(root,"bases")});}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
const node=(id)=>({id,type:"text",x:100,y:100,text:"Текст"});
test("Canvas timeline undo/redo drops abandoned futures and retains immutable snapshots",()=>{
 const start={nodes:[node("a")],edges:[],groups:[]};
 const t=canvas.timeline(start);
 const next=canvas.clone(start);next.nodes[0].text="Новая идея";
 assert.equal(t.record(next),true);
 next.nodes[0].text="Изменено вне истории";
 assert.equal(t.undo().nodes[0].text,"Текст");
 assert.equal(t.redo().nodes[0].text,"Новая идея");
 t.undo();
 const newer=canvas.clone(start);newer.nodes.push(node("b"));
 t.record(newer);
 assert.equal(t.canRedo(),false);
 assert.equal(t.undo().nodes.length,1);
});
test("Canvas templates, duplication and grid stay bounded",()=>{
 for(const name of ["blank","mind","kanban"]) {
  const board=canvas.template(name);
  assert.ok(Array.isArray(board.nodes)&&Array.isArray(board.groups));
 }
 assert.throws(()=>canvas.template("from-net"));
 assert.equal(canvas.snap(63),75);
 const board=canvas.template("mind");
 const out=canvas.copySelected(board,["root","idea1"],(id)=>"new_"+id);
 assert.equal(out.ids.length,2);
 assert.equal(out.board.nodes.length,5);
 assert.equal(out.board.edges.length,3);
 assert.equal(board.nodes.length,3);
 assert.throws(()=>canvas.copySelected(board,["root","idea1"],()=>"collision"));
 const full={nodes:Array.from({length:60},(_,i)=>node("n"+i)),groups:[],edges:[]};
 assert.throws(()=>canvas.copySelected(full,["n1"],(id)=>"new_"+id));
});
test("arithmetic engine parses only bounded expressions and disallows JS invocation",()=>{
 assert.equal(math.evaluate("price * count + 3",{price:20,count:2}),43);
 assert.equal(math.evaluate("(price + 10) / count",{price:20,count:2}),15);
 assert.equal(math.evaluate("3 - (10 / 2)",{}),-2);
 for(const evil of ["process.exit(0)","constructor","this","2**8","price;alert(1)","2/0"]){
  assert.throws(()=>math.evaluate(evil,{price:1}));
 }
 assert.throws(()=>math.evaluate("10 / b",{b:0}));
 assert.throws(()=>math.evaluate("unknown",{}));
});
test("aggregate and comparison operators use exact numeric filters",()=>{
 assert.deepEqual(math.aggregate([{a:"2"},{a:"4"},{a:"no"},{a:null}],"a"),
  {count:2,sum:6,average:3,min:2,max:4});
 assert.equal(math.match("50","20","gt"),true);
 assert.equal(math.match("15","20","gte"),false);
 assert.equal(math.match("Привет мир","МИР","contains"),true);
 assert.equal(math.match("10","10","eq"),true);
 assert.throws(()=>math.match("a","b","script"));
});
test("Bases view metadata persists expressions, filters and calendar mode",()=>fixture(s=>{
 const init=bases.loadSettings(s.bases);
 const doc={types:{price:"number",count:"number"},
  formulas:{total:"price * count"},
  views:[{id:"calendar",name:"Задачи по датам",layout:"calendar",sort:"due",
    direction:"asc",group:"due",filterField:"total",filterValue:"10",filterOp:"gte"}]};
 const saved=bases.saveSettings(s.bases,doc,init.sha);
 assert.equal(saved.formulas.total,"price * count");
 assert.equal(saved.views[0].layout,"calendar");
 assert.equal(saved.views[0].filterOp,"gte");
 assert.equal(bases.loadSettings(s.bases).formulas.total,"price * count");
 assert.throws(()=>bases.saveSettings(s.bases,doc,init.sha),{status:409});
 assert.throws(()=>bases.validateSettings({...doc,formulas:{bad:"process.exit(1)"}}));
 assert.throws(()=>bases.validateSettings({...doc,formulas:{price:"1+1"}}));
}));
test("full-vault catalogue browses more than 180 notes with folder clusters and pagination",()=>fixture(s=>{
 for(let i=0;i<253;i++)vault.create(s.notes,"Группа/Запись"+String(i).padStart(3,"0")+".md","# Текст "+i);
 vault.save(s.notes,"Группа/Запись000.md","[[Группа/Запись001]]");
 const first=catalog.view(s.notes,{folder:"Группа",page:0,size:120});
 assert.equal(first.total,253);
 assert.equal(first.nodes.length,120);
 assert.equal(first.pages,3);
 assert.equal(first.links.length,1);
 const third=catalog.view(s.notes,{folder:"Группа",page:2,size:120});
 assert.equal(third.nodes.length,13);
 assert.ok(first.clusters.some(c=>c.name==="Группа"&&c.count===253));
 assert.throws(()=>catalog.view(s.notes,{page:0,size:300}));
}));
test("wiki-link timeline derives added/removed edges from note history without changing files",()=>fixture(s=>{
 vault.create(s.notes,"Start.md","# Note");
 advanced.saveNote(s.notes,s.history,"Start.md","# Note\n[[First]]");
 advanced.saveNote(s.notes,s.history,"Start.md","# Note\n[[Second]]");
 const now=vault.read(s.notes,"Start.md").content;
 const result=catalog.timeline(s.notes,s.history,"Start.md");
 assert.ok(result.events.some(e=>e.added.includes("First")));
 assert.ok(result.events.some(e=>e.added.includes("Second")&&e.removed.includes("First")));
 assert.equal(vault.read(s.notes,"Start.md").content,now);
}));
test("new routes return bounded catalog and revision timeline and preserve origin checks",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-next-http-"));
 const server=createServer({knowledgeDirectory:path.join(root,"notes"),knowledgeHistoryDirectory:path.join(root,"history"),env:{}});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+server.address().port;
 try{
  vault.create(path.join(root,"notes"),"A.md","# A");
  let r=await fetch(origin+"/api/knowledge/map/catalog?page=0&size=200");
  assert.equal(r.status,200);assert.equal((await r.json()).total,1);
  r=await fetch(origin+"/api/knowledge/map/timeline?path=A.md");
  assert.equal(r.status,200);assert.equal((await r.json()).events.length,0);
  r=await fetch(origin+"/api/knowledge/map/catalog?size=10000");
  assert.equal(r.status,400);
  r=await fetch(origin+"/knowledge-bases-math.js");
  assert.equal(r.status,200);
  r=await fetch(origin+"/knowledge-bases-core.js");
  assert.equal(r.status,404);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
 }
});
