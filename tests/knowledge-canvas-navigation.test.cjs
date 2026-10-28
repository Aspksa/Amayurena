"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const layout=require("../knowledge-canvas-layout");

class Element {
  constructor(tag="div") {
    this.tag=tag;this.children=[];this.listeners={};this.style={};this.dataset={};
    this.value="";this.textContent="";this.hidden=false;this.attributes={};
    this.clientWidth=800;this.clientHeight=540;this.scrollLeft=0;this.scrollTop=0;
    this.classList={toggle(){}};
  }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  removeEventListener(name,fn){if(this.listeners[name]===fn)delete this.listeners[name];}
  setAttribute(name,value){this.attributes[name]=value;}
  querySelector(selector){return selector===".knowledge-canvas-surface"?new Element("surface"):null;}
  get firstElementChild(){return this.children[0];}
  focus(){}
  setPointerCapture(){}
  hasPointerCapture(){return true;}
  releasePointerCapture(){}
  getBoundingClientRect(){return {left:0,top:0,width:200,height:150};}
  click(){return this.listeners.click?.({currentTarget:this,target:this,preventDefault(){}});}
  change(value){this.value=value;return this.listeners.change?.({target:this});}
}
function setup({delay=false}={}) {
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id))elements.set(id,new Element(id));
    return elements.get(id);
  };
  const storage=new Map();
  const window={
    AmayurenaCanvasLayout:layout,
    addEventListener(){},
    localStorage:{setItem:(key,value)=>storage.set(key,String(value)),getItem:key=>storage.get(key)||null}
  };
  const document={
    getElementById:get,createElement:tag=>new Element(tag),
    createElementNS:(_ns,tag)=>new Element(tag),
    querySelectorAll:()=>[]
  };
  const boards=new Map([
    ["A",{name:"A",nodes:[],edges:[],groups:[],sha:"a".repeat(64)}],
    ["B",{name:"B",nodes:[],edges:[],groups:[],sha:"b".repeat(64)}]
  ]);
  let started=false,resolveSave=null,remaining=delay;
  const json=(value,status=200)=>({ok:status<400,status,json:async()=>value});
  const fetch=async (url,options={})=>{
    const method=options.method||"GET";
    if(url==="/api/knowledge/canvases")return json({boards:[...boards.keys()].map(name=>({name}))});
    if(url.startsWith("/api/knowledge/canvas?")&&method==="GET"){
      const name=new URL("http://localhost"+url).searchParams.get("name");
      return boards.has(name)?json(JSON.parse(JSON.stringify(boards.get(name)))):json({error:"missing"},404);
    }
    if(url==="/api/knowledge/canvas"&&method==="POST"){
      const req=JSON.parse(options.body);
      started=true;
      if(remaining) {remaining=false;await new Promise(resolve=>{resolveSave=resolve;});}
      const old=boards.get(req.name);
      if((old?.sha||null)!==req.expectedSha)return json({error:"Conflict"},409);
      const newSha="c".repeat(64);
      boards.set(req.name,{...req.board,name:req.name,sha:newSha});
      return json({...req.board,name:req.name,sha:newSha});
    }
    throw Error("Unexpected "+method+" "+url);
  };
  const context={window,document,fetch,localStorage:window.localStorage,
    setTimeout,clearTimeout,console,URL,Date,prompt:()=> "Новая идея",confirm:()=>true,Math};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8"),context,
    {filename:"knowledge-advanced.js"});
  window.AmayurenaKnowledgeAdvanced.init({onNoteOpen:async()=>{},beforeRestore:async()=>{},onReload:async()=>{}});
  return {get,boards,api:window.AmayurenaKnowledgeAdvanced,
    get started(){return started;},
    release(){resolveSave?.();},
    externalChange(){boards.get("A").sha="d".repeat(64);}
  };
}
async function until(check,description){
  for(let i=0;i<150;i++){
    if(check())return;
    await new Promise(resolve=>setTimeout(resolve,4));
  }
  throw Error("Timed out: "+description);
}
test("board switch waits for pending save, then switches without losing new card",async()=>{
  const app=setup({delay:true});
  app.api.show("canvas");
  await until(()=>app.get("knowledge-canvas-status").textContent.includes("загружена"),"open A");
  assert.equal(app.get("knowledge-canvas-select").value,"A");
  app.get("knowledge-canvas-text").click();
  app.get("knowledge-canvas-select").change("B");
  await until(()=>app.started,"saving A");
  assert.equal(app.boards.get("A").nodes.length,0);
  assert.equal(app.get("knowledge-canvas-nodes").children.length,1);
  app.release();
  await until(()=>app.get("knowledge-canvas-status").textContent.includes("«B» загружена"),"open B");
  assert.equal(app.boards.get("A").nodes.length,1);
  assert.equal(app.boards.get("A").nodes[0].text,"Новая идея");
  assert.equal(app.boards.get("B").nodes.length,0);
});
test("a conflicting save blocks navigation and leaves the unsaved board visible",async()=>{
  const app=setup();
  app.api.show("canvas");
  await until(()=>app.get("knowledge-canvas-status").textContent.includes("загружена"),"open A");
  app.get("knowledge-canvas-text").click();
  app.externalChange();
  app.get("knowledge-canvas-select").change("B");
  await until(()=>app.get("knowledge-canvas-status").textContent.includes("Операция отменена"),"blocked switch");
  assert.equal(app.get("knowledge-canvas-select").value,"A");
  assert.equal(app.boards.get("A").nodes.length,0);
  assert.equal(app.get("knowledge-canvas-nodes").children.length,1);
  assert.match(app.get("knowledge-canvas-status").textContent,/Несохранённая доска/);
});
