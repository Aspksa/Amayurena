"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const canvas=require("../knowledge-canvas-enhance");
const vault=require("../knowledge-core");
const map=require("../knowledge-map-catalog");
const {createServer}=require("../server");

function fixture(run){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-graph-neighborhood-"));
  try{return run({base,notes:path.join(base,"knowledge")});}
  finally{fs.rmSync(base,{recursive:true,force:true});}
}
function note(root,path,body){return vault.create(root,path,body);}

test("multi-card translation preserves relative offsets and supports grid",()=>{
 const originals=[{id:"a",x:50,y:100},{id:"b",x:300,y:200}];
 const result=canvas.moveSelection(originals,"a",26,-20,25);
 assert.deepEqual(result,{dx:25,dy:-25,items:[
   {id:"a",x:75,y:75},{id:"b",x:325,y:175}
 ]});
 assert.deepEqual(originals,[{id:"a",x:50,y:100},{id:"b",x:300,y:200}]);
});
test("multi-card movement clamps the entire selection within bounds without distortion",()=>{
 const originals=[{id:"a",x:2990,y:2300},{id:"b",x:3200,y:2400}];
 const result=canvas.moveSelection(originals,"a",800,800);
 assert.equal(result.dx,0);
 assert.equal(result.dy,0);
 assert.equal(result.items[1].x,3200);
 assert.equal(result.items[1].y,2400);
 const returnTrip=canvas.moveSelection(originals,"a",-4000,-4000);
 assert.equal(returnTrip.dx,-2990);
 assert.equal(returnTrip.dy,-2300);
 assert.equal(returnTrip.items[1].x,210);
 assert.equal(returnTrip.items[1].y,100);
});
test("bulk movement refuses untrusted geometry and invalid selection IDs",()=>{
 const positions=[{id:"ok",x:10,y:15}];
 assert.throws(()=>canvas.moveSelection(positions,"missing",5,5),/отсутствует/);
 assert.throws(()=>canvas.moveSelection(positions,"ok",Infinity,5),/Некорректное/);
 assert.throws(()=>canvas.moveSelection(positions,"ok",2,2,300),/Некорректное/);
 assert.throws(()=>canvas.moveSelection([...positions,positions[0]],"ok",2,2),/Некорректные/);
});
test("graph discovers backlinks from beyond first 180 notes and across catalogue pages",()=>fixture(s=>{
 note(s.notes,"A.md","# A");
 for(let i=0;i<185;i++)note(s.notes,"Промежуточная/Тема"+String(i).padStart(3,"0")+".md","# Тема");
 note(s.notes,"Z.md","# Z\n[[A]]");
 const first=map.view(s.notes,{page:0,size:100});
 assert.ok(!first.nodes.some(n=>n.path==="Z.md"));
 const graph=map.neighbors(s.notes,"A.md");
 assert.equal(graph.mode,"neighbors");
 assert.equal(graph.focus,"A.md");
 assert.deepEqual(graph.counts,{incoming:1,outgoing:0});
 assert.deepEqual(graph.links.map(e=>[e.from,e.to]),[["Z.md","A.md"]]);
 assert.ok(graph.nodes.some(n=>n.path==="Z.md"));
 assert.equal(graph.links[0].provenance.reference,"[[A]]");
}));
test("graph resolves local relative wiki links and deduplicates repeated references",()=>fixture(s=>{
 note(s.notes,"Folder/Anchor.md","# Anchor\n[[Other]]\n[[Other]]");
 note(s.notes,"Folder/Other.md","# Other\n[[Anchor]]");
 const graph=map.neighbors(s.notes,"Folder/Anchor.md");
 assert.equal(graph.total,2);
 assert.equal(graph.counts.outgoing,1);
 assert.equal(graph.counts.incoming,1);
 assert.equal(graph.links.length,2);
 assert.equal(graph.links.find(x=>x.from==="Folder/Anchor.md").to,"Folder/Other.md");
}));
test("graph does not invent edges from ambiguous wiki titles",()=>fixture(s=>{
 note(s.notes,"A/Duplicate.md","# Duplicate");
 note(s.notes,"B/Duplicate.md","# Duplicate");
 note(s.notes,"Main.md","# Main\n[[Duplicate]]");
 const graph=map.neighbors(s.notes,"Main.md");
 assert.equal(graph.total,1);
 assert.equal(graph.links.length,0);
}));
test("graph limits displayed neighbors while retaining full directional counts",()=>fixture(s=>{
 note(s.notes,"Anchor.md","# Anchor");
 for(let i=0;i<12;i++)note(s.notes,"Others/Link"+i+".md","# Link\n[[Anchor]]");
 const graph=map.neighbors(s.notes,"Anchor.md",{limit:4});
 assert.equal(graph.nodes.length,4);
 assert.equal(graph.total,13);
 assert.equal(graph.links.length,3);
 assert.equal(graph.truncated,true);
 assert.equal(graph.counts.incoming,12);
 assert.throws(()=>map.neighbors(s.notes,"Anchor.md",{limit:500}));
 assert.throws(()=>map.neighbors(s.notes,"Missing.md"),{status:404});
}));
test("HTTP neighbors endpoint is bounded and not a file-write surface",async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-map-api24-"));
 const notes=path.join(base,"knowledge");
 note(notes,"Root.md","# Root\n[[Target]]");
 note(notes,"Target.md","# Target");
 const server=createServer({env:{},knowledgeDirectory:notes});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const addr="http://127.0.0.1:"+server.address().port;
 try{
   let r=await fetch(addr+"/api/knowledge/map/neighbors?path=Root.md");
   assert.equal(r.status,200);
   const result=await r.json();
   assert.equal(result.counts.outgoing,1);
   assert.equal(result.nodes.length,2);
   r=await fetch(addr+"/api/knowledge/map/neighbors?path=Root.md&limit=9999");
   assert.equal(r.status,400);
   r=await fetch(addr+"/api/knowledge/map/neighbors?path=Root.md",{
     headers:{Origin:"https://untrusted.example"}});
   assert.equal(r.status,403);
   r=await fetch(addr+"/api/knowledge/map/neighbors?path=../../.env");
   assert.equal(r.status,400);
 }finally{
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(base,{recursive:true,force:true});
 }
});
test("UI exposes neighbor navigation and bulk Canvas actions",()=>{
 const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 const advanced=fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8");
 const insights=fs.readFileSync(path.join(__dirname,"..","knowledge-insights.js"),"utf8");
 for(const id of ["knowledge-map-neighbors","knowledge-map-back","knowledge-canvas-delete-selected"])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(advanced,/canvasExtra\.moveSelection\(/);
 assert.match(advanced,/function deleteSelectedCanvas\(\)/);
 assert.match(advanced,/e\.key\.toLowerCase\(\)==="z"/);
 assert.match(insights,/\/api\/knowledge\/map\/neighbors/);
 assert.match(insights,/state\.neighborhood/);
});
