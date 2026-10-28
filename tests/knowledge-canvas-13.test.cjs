"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const advanced=require("../knowledge-advanced-core");
const layout=require("../knowledge-canvas-layout");
const {createServer}=require("../server");

function fixture(fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-canvas-13-"));
  try{return fn(path.join(dir,"boards"));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const card=(id,x=10,y=20)=>({id,type:"text",text:"Текст "+id,x,y});
const group=(id="group1")=>({id,label:"Мои идеи",tone:"blue",x:15,y:25,width:600,height:400});
test("old boards without groups reopen unchanged and can be upgraded",()=>fixture(root=>{
  const old=advanced.saveCanvas(root,"Старая",{
    nodes:[card("n1"),{id:"n2",type:"file",file:"Заметки/План.md",x:300,y:40}],
    edges:[{from:"n1",to:"n2"}]
  });
  assert.deepEqual(old.groups,[]);
  const loaded=advanced.readCanvas(root,"Старая");
  assert.equal(loaded.groups.length,0);
  assert.match(loaded.sha,/^[a-f0-9]{64}$/);
  assert.equal(loaded.nodes[1].file,"Заметки/План.md");
  loaded.groups=[group()];
  loaded.nodes[0].groupId="group1";
  const changed=advanced.saveCanvas(root,"Старая",loaded,loaded.sha);
  assert.equal(changed.groups.length,1);
  assert.equal(advanced.readCanvas(root,"Старая").nodes[0].groupId,"group1");
  assert.deepEqual(changed.edges,[{from:"n1",to:"n2"}]);
}));
test("Canvas guards update and delete against stale versions",()=>fixture(root=>{
  const initial=advanced.saveCanvas(root,"Доска",{nodes:[card("n1")],edges:[],groups:[]},null);
  assert.throws(()=>advanced.saveCanvas(root,"Доска",{nodes:[],edges:[],groups:[]},null),{status:409});
  assert.equal(advanced.readCanvas(root,"Доска").nodes.length,1);
  const newer=advanced.saveCanvas(root,"Доска",{nodes:[card("n1"),card("n2")],edges:[],groups:[]},initial.sha);
  assert.throws(()=>advanced.saveCanvas(root,"Доска",{nodes:[],edges:[],groups:[]},initial.sha),{status:409});
  assert.throws(()=>advanced.deleteCanvas(root,"Доска",initial.sha),{status:409});
  assert.equal(advanced.readCanvas(root,"Доска").nodes.length,2);
  assert.deepEqual(advanced.deleteCanvas(root,"Доска",newer.sha),{deleted:"Доска"});
  assert.throws(()=>advanced.saveCanvas(root,"Доска",{nodes:[],edges:[],groups:[]},newer.sha),{status:409});
}));
test("group validation rejects missing references, traversal and invalid dimensions",()=>fixture(root=>{
  assert.throws(()=>advanced.saveCanvas(root,"X",{nodes:[{...card("n1"),groupId:"ghost"}],edges:[],groups:[]}),{status:400});
  assert.throws(()=>advanced.saveCanvas(root,"X",{nodes:[],edges:[],groups:[{...group(),width:5000}]}),{status:400});
  assert.throws(()=>advanced.saveCanvas(root,"X",{nodes:[],edges:[],groups:[group(),group()]}),{status:400});
  assert.throws(()=>advanced.saveCanvas(root,"X",{nodes:[],edges:[],groups:[{...group(),tone:"javascript:evil"}]}),{status:400});
  assert.throws(()=>advanced.saveCanvas(root,"X",{nodes:[],edges:[],groups:Array.from({length:21},(_,i)=>group("g"+i))}),{status:413});
  assert.throws(()=>advanced.saveCanvas(root,"../bad",{nodes:[],edges:[],groups:[]}),{status:400});
}));
test("group-aware auto-layout is deterministic, bounded and preserves edges/content",()=>{
  const input={name:"Развитие",groups:[group("g")],
    nodes:[{...card("a",100,100),groupId:"g"},{...card("b",250,200),groupId:"g"},
      card("c",3000,2200),card("d",20,20)],
    edges:[{from:"a",to:"c"}]};
  const before=JSON.stringify(input);
  const a=layout.arrange(input),b=layout.arrange(input);
  assert.deepEqual(a,b);
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(a.edges,input.edges);
  for(const n of a.nodes){
    assert.ok(n.x>=0&&n.x<=3200);
    assert.ok(n.y>=0&&n.y<=2400);
  }
  for(const g of a.groups){
    assert.ok(g.x>=0&&g.x+g.width<=layout.WIDTH);
    assert.ok(g.y>=0&&g.y+g.height<=layout.HEIGHT);
  }
  assert.equal(a.nodes.find(n=>n.id==="a").groupId,"g");
  assert.equal(a.nodes.find(n=>n.id==="c").text,"Текст c");
});
test("zoom/clamped viewport and minimap coordinate math work for large boards",()=>{
  assert.equal(layout.zoom(.01),.35);
  assert.equal(layout.zoom(5),2);
  const position=layout.viewAt(1,2,300,200,700,500);
  assert.equal(position.zoom,2);
  assert.equal(position.left,950);
  assert.equal(position.top,650);
  const overview=layout.minimapRect(350,260,700,520,1);
  assert.equal(overview.x,20);
  assert.equal(overview.y,15);
  assert.equal(overview.width,40);
  assert.equal(overview.height,30);
});
test("HTTP API protects Canvas changes, preserves old boards and serves viewer helpers",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-canvas-http13-"));
  const server=createServer({env:{},knowledgeDirectory:path.join(root,"notes")});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  const post=async(body,origin)=>fetch(base+"/api/knowledge/canvas",{
    method:"POST",headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},body:JSON.stringify(body)
  });
  try{
    let r=await post({name:"Доска",board:{nodes:[card("x")],edges:[]},expectedSha:null});
    assert.equal(r.status,200);const first=await r.json();
    r=await post({name:"Доска",board:{nodes:[card("x"),card("y")],edges:[],groups:[group()]},expectedSha:first.sha});
    assert.equal(r.status,200);const second=await r.json();
    r=await post({name:"Доска",board:{nodes:[],edges:[]},expectedSha:first.sha});
    assert.equal(r.status,409);
    r=await fetch(base+"/api/knowledge/canvas?name="+encodeURIComponent("Доска"));
    assert.equal((await r.json()).nodes.length,2);
    r=await fetch(base+"/api/knowledge/canvas?name="+encodeURIComponent("Доска")+"&expectedSha="+first.sha,{method:"DELETE"});
    assert.equal(r.status,409);
    r=await post({name:"Доска",board:{nodes:[],edges:[]},expectedSha:second.sha},"https://other.example");
    assert.equal(r.status,403);
    r=await fetch(base+"/knowledge-canvas-layout.js");
    assert.equal(r.status,200);
    assert.match(await r.text(),/AmayurenaCanvasLayout/);
    r=await fetch(base+"/knowledge-advanced-core.js");
    assert.equal(r.status,404);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
test("Canvas toolbar includes zoom, grouping, minimap and layout actions",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const script=fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8");
  for(const id of ["knowledge-canvas-group","knowledge-canvas-layout","knowledge-canvas-minimap",
    "knowledge-canvas-zoom-in","knowledge-canvas-zoom-out","knowledge-canvas-zoom-fit",
    "knowledge-canvas-zoom-reset","knowledge-canvas-space","knowledge-canvas-groups"])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/knowledge-canvas-layout\.js/);
  assert.match(script,/async function flushCanvas\(\)/);
  assert.match(script,/expectedSha: canvas\.sha/);
  assert.match(script,/function navigateCanvas\(fn\)/);
});
