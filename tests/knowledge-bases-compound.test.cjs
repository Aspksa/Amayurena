"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const math=require("../knowledge-bases-math");
const bases=require("../knowledge-bases-core");
const {createServer}=require("../server");
const oldView={
  id:"old",name:"Традиционный вид",layout:"table",
  sort:"title",direction:"asc",group:"",
  filterField:"status",filterValue:"В работе",filterOp:"eq"
};
function withSettings(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-filters-"));
  try{return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test("two conditions support both AND and OR without evaluating code",()=>{
 const row={status:"В работе",priority:"4",amount:"100"};
 const value=field=>row[field]??"";
 const conditions={filterField:"status",filterValue:"В работе",filterOp:"eq",
   filterField2:"priority",filterValue2:"3",filterOp2:"gte",filterJoin:"and"};
 assert.equal(math.matchFilters(value,conditions),true);
 assert.equal(math.matchFilters(value,{...conditions,filterValue2:"5"}),false);
 assert.equal(math.matchFilters(value,{...conditions,filterValue2:"5",filterJoin:"or"}),true);
 assert.equal(math.matchFilters(value,{...conditions,filterValue:"Готово",filterJoin:"or"}),true);
 assert.equal(math.matchFilters(value,{...conditions,filterValue:"Готово",filterValue2:"5",filterJoin:"or"}),false);
});
test("empty second filter is neutral even with OR; empty primary matches only second",()=>{
 const row={status:"Готово",priority:"7"};
 const value=field=>row[field]??"";
 assert.equal(math.matchFilters(value,{
   filterField:"status",filterValue:"В работе",filterOp:"eq",
   filterField2:"priority",filterValue2:"",filterOp2:"eq",filterJoin:"or"}),false);
 assert.equal(math.matchFilters(value,{
   filterField:"status",filterValue:"",filterOp:"eq",
   filterField2:"priority",filterValue2:"7",filterOp2:"eq",filterJoin:"and"}),true);
 assert.equal(math.matchFilters(value,{filterValue:"",filterValue2:"",filterJoin:"or"}),true);
 assert.throws(()=>math.matchFilters(value,{filterJoin:"function(){}"}),/логика/);
 assert.throws(()=>math.matchFilters(value,{filterField:"",filterValue:"X"}),/имени поля/);
});
test("saved views with compound rules survive round trip; legacy views gain safe defaults",()=>withSettings(root=>{
 const first=bases.loadSettings(root);
 const previous=bases.saveSettings(root,{types:{},formulas:{},views:[oldView]},first.sha);
 assert.equal(previous.views[0].filterJoin,"and");
 assert.equal(previous.views[0].filterField2,"");
 assert.equal(previous.views[0].filterValue2,"");
 const newer=bases.saveSettings(root,{types:{priority:"number"},formulas:{},
   views:[{...oldView,filterField2:"priority",filterValue2:"2",filterOp2:"gte",filterJoin:"or"}]},previous.sha);
 assert.equal(newer.views[0].filterJoin,"or");
 assert.equal(newer.views[0].filterField2,"priority");
 assert.equal(bases.loadSettings(root).views[0].filterValue2,"2");
 assert.throws(()=>bases.saveSettings(root,{types:{},formulas:{},views:[oldView]},previous.sha),{status:409});
}));
test("malformed second filters are rejected by server validation",()=>{
 const settings={types:{},views:[oldView],formulas:{}};
 for(const bad of [
   {filterField2:"__proto__",filterValue2:"1"},
   {filterField2:"unknown",filterValue2:"1",filterOp2:"exec"},
   {filterField2:"priority",filterValue2:"1",filterJoin:"eval"},
   {filterField2:"priority",filterValue2:"x".repeat(121)},
   {filterField2:"",filterValue2:"abc"},
   {filterField2:"constructor",filterValue2:"5"}
 ]){
   assert.throws(()=>bases.validateSettings({...settings,views:[{...oldView,...bad}]}),{status:400});
 }
});
test("HTTP settings API keeps both rules without changing the underlying notes",async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-filters-http-"));
 const server=createServer({env:{},knowledgeDirectory:path.join(tmp,"notes")});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+server.address().port;
 try{
   let r=await fetch(origin+"/api/knowledge/bases/settings");
   assert.equal(r.status,200);
   const start=await r.json();
   const view={...oldView,filterField2:"priority",filterValue2:"3",filterOp2:"gte",filterJoin:"and"};
   r=await fetch(origin+"/api/knowledge/bases/settings",{method:"POST",
     headers:{"Content-Type":"application/json"},body:JSON.stringify({
       expectedSha:start.sha,settings:{types:{priority:"number"},views:[view],formulas:{}}
     })});
   assert.equal(r.status,200);
   const saved=await r.json();
   assert.equal(saved.views[0].filterField2,"priority");
   r=await fetch(origin+"/api/knowledge/bases/settings");
   assert.equal((await r.json()).views[0].filterJoin,"and");
   r=await fetch(origin+"/api/knowledge/bases/settings",{method:"POST",
     headers:{"Content-Type":"application/json",Origin:"https://other.invalid"},
     body:JSON.stringify({expectedSha:saved.sha,settings:{types:{},views:[],formulas:{}}})});
   assert.equal(r.status,403);
 }finally{
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(tmp,{recursive:true,force:true});
 }
});
test("UI renders second rule in all view layouts and saves it as part of named views",()=>{
 const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 const code=fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8");
 for(const id of ["knowledge-bases-property2","knowledge-bases-value2",
   "knowledge-bases-filter-op2","knowledge-bases-filter-join"]){
   assert.ok(html.includes('id="'+id+'"'),id);
   assert.ok(code.includes('$(\"'+id+'\")'),id);
 }
 assert.match(code,/basesMath\.matchFilters/);
 assert.match(code,/function formView\(\)/);
 assert.match(code,/function applyView\(view\)/);
});
