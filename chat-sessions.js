(function(root,factory){
"use strict";
const api=factory();
if(typeof module==="object"&&module.exports)module.exports=api;
if(root)root.AmayurenaSessions=api;
})(typeof window!=="undefined"?window:null,function(){
"use strict";
const PREFIX="amayurena.sessions.v2.";
const LEGACY="amayurena.workspace.v1.";
const MAX_SESSIONS=30,MAX_MESSAGES=300,MAX_TASKS=30;
function validId(id){return typeof id==="string"&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);}
function clone(value){return JSON.parse(JSON.stringify(value));}
function validMessage(m){return m&&["user","assistant"].includes(m.role)&&typeof m.content==="string"&&m.content.length<=16000&&typeof m.at==="string"&&Number.isFinite(Date.parse(m.at));}
function safeSession(s){
 if(!s||typeof s!=="object"||!validId(s.id)||typeof s.title!=="string"||s.title.length>80||!Array.isArray(s.messages))throw Error("Повреждённый диалог.");
 return {id:s.id,title:s.title||"Диалог",createdAt:s.createdAt||new Date().toISOString(),
 messages:s.messages.filter(validMessage).slice(-MAX_MESSAGES)};
}
function empty(){return {current:"",sessions:[],tasks:[],log:[]};}
function normalize(raw){
 if(!raw||typeof raw!=="object"||!Array.isArray(raw.sessions))throw Error("Повреждённое хранилище диалогов.");
 const result=empty();
 result.sessions=raw.sessions.slice(0,MAX_SESSIONS).map(safeSession);
 if(new Set(result.sessions.map(s=>s.id)).size!==result.sessions.length)throw Error("Повторяющиеся диалоги.");
 result.current=result.sessions.some(s=>s.id===raw.current)?raw.current:(result.sessions[0]?.id||"");
 result.tasks=Array.isArray(raw.tasks)?raw.tasks.slice(-MAX_TASKS):[];
 result.log=Array.isArray(raw.log)?raw.log.filter(x=>x&&typeof x.at==="string"&&typeof x.kind==="string").slice(-100):[];
 return result;
}
function fromLegacy(raw){
 const v=empty();
 if(raw&&Array.isArray(raw.chat)&&raw.chat.length)v.sessions.push({id:"original",title:"Исходный диалог",createdAt:new Date().toISOString(),
 messages:raw.chat.filter(validMessage).slice(-MAX_MESSAGES)});
 v.current=v.sessions[0]?.id||"";
 v.tasks=Array.isArray(raw?.tasks)?raw.tasks.slice(-MAX_TASKS):[];
 return v;
}
function store(storage,agentId){
 if(!validId(agentId))throw Error("Недопустимый ID агента.");
 const key=PREFIX+agentId;
 function load(){
  const value=storage.getItem(key);
  if(value)return normalize(JSON.parse(value));
  const older=storage.getItem(LEGACY+agentId);
  return older?fromLegacy(JSON.parse(older)):empty();
 }
 function save(data){const value=normalize(data);storage.setItem(key,JSON.stringify(value));return value;}
 return {load,save,key};
}
function create(data,title,id){
 const v=normalize(data);
 if(v.sessions.length>=MAX_SESSIONS)throw Error("Не больше 30 диалогов на агента.");
 if(!validId(id)||v.sessions.some(s=>s.id===id))throw Error("Некорректный идентификатор диалога.");
 const name=typeof title==="string"?title.trim().slice(0,80):"";
 v.sessions.unshift({id,title:name||"Новый диалог",createdAt:new Date().toISOString(),messages:[]});
 v.current=id;return v;
}
function remove(data,id){
 const v=normalize(data);v.sessions=v.sessions.filter(s=>s.id!==id);
 if(v.current===id)v.current=v.sessions[0]?.id||"";
 return v;
}
function append(data,id,messages){
 const v=normalize(data),s=v.sessions.find(s=>s.id===id);
 if(!s)throw Error("Диалог не найден.");
 if(!Array.isArray(messages)||messages.some(m=>!validMessage(m)))throw Error("Некорректное сообщение.");
 s.messages.push(...messages.map(m=>({role:m.role,content:m.content,at:m.at})));
 s.messages=s.messages.slice(-MAX_MESSAGES);
 if(s.title==="Новый диалог"){const first=s.messages.find(x=>x.role==="user");if(first)s.title=first.content.slice(0,65);}
 return v;
}
const KINDS=new Set(["agent_enabled","agent_disabled","chat_ok","chat_error","task_ok","task_error","tool_ok","tool_error","chat_cancel"]);
function recordEvent(data,kind,details={}){
 if(!KINDS.has(kind))throw Error("Неизвестный тип события.");
 const base=normalize(data);
 const at=new Date().toISOString();
 const safe={kind,at};
 if(typeof details.model==="string")safe.model=details.model.slice(0,120).replace(/[^\w.\/:+-]/g,"");
 if(Number.isFinite(details.elapsedMs))safe.elapsedMs=Math.max(0,Math.min(600000,Math.round(details.elapsedMs)));
 if(Number.isSafeInteger(details.inputTokens)&&details.inputTokens>=0)safe.inputTokens=details.inputTokens;
 if(Number.isSafeInteger(details.outputTokens)&&details.outputTokens>=0)safe.outputTokens=details.outputTokens;
 if(typeof details.tool==="string")safe.tool=details.tool.slice(0,50).replace(/[^\w-]/g,"");
 base.log.push(safe);
 base.log=base.log.slice(-100);
 return base;
}
function find(data,query){
 const q=String(query||"").trim().toLocaleLowerCase("ru");
 return normalize(data).sessions.map(s=>({...s,messages:q?s.messages.filter(m=>m.content.toLocaleLowerCase("ru").includes(q)):s.messages}))
  .filter(s=>!q||s.title.toLocaleLowerCase("ru").includes(q)||s.messages.length);
}
return {PREFIX,MAX_SESSIONS,MAX_MESSAGES,empty,normalize,store,create,remove,append,find,fromLegacy,recordEvent};
});