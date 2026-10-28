"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const helper=require("../chat-sessions");
const agents=require("../agents-core");
function memory(){
  const map=new Map();
  return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),dump:()=>Object.fromEntries(map)};
}
const message=(role,content)=>({role,content,at:"2026-10-29T10:00:00.000Z"});
test("dialog sessions create, append, select, search and remove with isolation",()=>{
  let d=helper.empty();
  d=helper.create(d,"Первый","chat_a");
  d=helper.append(d,"chat_a",[message("user","Топливо автомобиля"),message("assistant","Проверено")]);
  d=helper.create(d,"Второй","chat_b");
  d=helper.append(d,"chat_b",[message("user","Рисование")]);
  assert.equal(d.sessions.find(s=>s.id==="chat_a").messages.length,2);
  assert.equal(d.sessions.find(s=>s.id==="chat_b").messages.length,1);
  assert.equal(helper.find(d,"автомобиля").length,1);
  assert.equal(helper.find(d,"автомобиля")[0].id,"chat_a");
  d=helper.remove(d,"chat_b");
  assert.equal(d.current,"chat_a");
  assert.equal(d.sessions.length,1);
});
test("store reloads all sessions, migrates legacy data without deleting it",()=>{
 const storage=memory();
 storage.setItem("amayurena.workspace.v1.agent1",JSON.stringify({
  chat:[message("user","Историческое сообщение")],tasks:[{input:"a",reply:"b",at:"2026-10-29T10:00:00Z"}]}));
 const store=helper.store(storage,"agent1");
 const migrated=store.load();
 assert.equal(migrated.sessions[0].messages[0].content,"Историческое сообщение");
 assert.equal(migrated.tasks.length,1);
 store.save(migrated);
 assert.deepEqual(store.load().sessions,migrated.sessions);
 assert.ok(storage.getItem("amayurena.workspace.v1.agent1"));
});
test("invalid sessions, duplicate ids and corrupted messages are rejected",()=>{
 assert.throws(()=>helper.create(helper.empty(),"bad","../danger"));
 assert.throws(()=>helper.store(memory(),"../../agent"));
 const x=helper.create(helper.empty(),"first","one");
 assert.throws(()=>helper.create(x,"again","one"));
 assert.throws(()=>helper.append(x,"one",[message("system","no")]));
 assert.throws(()=>helper.normalize({sessions:[x.sessions[0],x.sessions[0]]}));
 const untrusted=JSON.parse(JSON.stringify(x));
 untrusted.sessions[0].messages=[{role:"assistant",content:"x".repeat(20000),at:"no"}];
 assert.equal(helper.normalize(untrusted).sessions[0].messages.length,0);
});
test("agent on/off is explicit and old backups default to enabled",()=>{
 const normalized=agents.normalizeAgent({name:"Мой агент",enabled:false});
 assert.equal(normalized.enabled,false);
 const older=agents.normalizeAgent({name:"Старый"});
 assert.equal(older.enabled,true);
 const restored=agents.parseBackup(agents.makeBackup([normalized,older]));
 assert.equal(restored[0].enabled,false);
 assert.equal(restored[1].enabled,true);
});
test("client wiring provides multi-session search, diagnostics, and manual cancellation",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 const workspace=fs.readFileSync(path.join(__dirname,"..","workspace.js"),"utf8");
 for(const id of ["workspace-chat-select","workspace-chat-search","workspace-new-chat",
   "workspace-delete-chat","workspace-rename-chat","workspace-chat-cancel","workspace-usage","agent-enabled"])
   assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(workspace,/AbortController/);
 assert.match(html,/chat-sessions\.js/);
});


test("execution journal is bounded and only records a fixed non-secret metadata schema",()=>{
 let book=helper.create(helper.empty(),"Диалог","a");
 book=helper.recordEvent(book,"chat_ok",{
   model:"test/model-1",elapsedMs:1350,inputTokens:25,outputTokens:64,
   content:"PRIVATE PROMPT",apiKey:"SECRET API KEY",token:"CREDENTIAL"
 });
 assert.equal(book.log.length,1);
 assert.equal(book.log[0].kind,"chat_ok");
 assert.equal(book.log[0].model,"test/model-1");
 assert.equal(book.log[0].inputTokens,25);
 assert.equal(book.log[0].elapsedMs,1350);
 assert.equal(JSON.stringify(book.log).includes("PRIVATE PROMPT"),false);
 assert.equal(JSON.stringify(book.log).includes("SECRET API KEY"),false);
 for(let i=0;i<120;i++)book=helper.recordEvent(book,"agent_disabled");
 assert.equal(book.log.length,100);
 assert.throws(()=>helper.recordEvent(book,"execute_arbitrary_code"));
 const persisted=helper.store(memory(),"agent1");
 persisted.save(book);
 assert.equal(persisted.load().log.length,100);
});
test("agent journaling UI uses sanitized stored events",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const workspace=fs.readFileSync(path.join(__dirname,"..","workspace.js"),"utf8");
 const app=fs.readFileSync(path.join(__dirname,"..","app.js"),"utf8");
 const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 assert.match(html,/id="workspace-execution-log"/);
 assert.match(workspace,/recordExecution\(mode==="chat"/);
 assert.match(workspace,/renderExecutionLog/);
 assert.match(app,/recordEvent\(book,enabled\?"agent_enabled":"agent_disabled"/);
});
