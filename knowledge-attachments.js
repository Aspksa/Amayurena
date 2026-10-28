"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const notes=require("./knowledge-core");
const MAX_BYTES=5*1024*1024;
const MAX_FILES=800;
const EXTENSIONS=new Set(["png","jpg","jpeg","webp","pdf","txt","md","csv","xlsx","xls","docx"]);
function problem(message,status=400){return Object.assign(new Error(message),{status});}
function rootDir(root){
 fs.mkdirSync(root,{recursive:true});
 const stat=fs.lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw problem("Неверное хранилище вложений.");
 return root;
}
function validateId(id){
 if(typeof id!=="string"||!/^[a-f0-9-]{36}$/.test(id))throw problem("Неверный ID вложения.");
 return id;
}
function validateName(raw){
 if(typeof raw!=="string"||!raw.trim()||raw.length>120||raw.startsWith(".")||
   /[<>:"/\\|?*\u0000-\u001f]/.test(raw)||raw.endsWith(" ")||raw.endsWith("."))
   throw problem("Недопустимое имя вложения.");
 const ext=raw.split(".").pop().toLowerCase();
 if(!EXTENSIONS.has(ext))throw problem("Неподдерживаемый тип вложения.");
 return raw.trim();
}
function safeFile(file){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw problem("Недопустимый файл вложения.");
 return stat;
}
function digest(buffer){return crypto.createHash("sha256").update(buffer).digest("hex");}
function metaFile(root,id){return path.join(rootDir(root),validateId(id)+".json");}
function dataFile(root,id){return path.join(rootDir(root),validateId(id)+".bin");}
function save(root,noteRoot,notePath,name,data){
 const normalized=notes.normalizePath(notePath);
 notes.read(noteRoot,normalized);
 name=validateName(name);
 if(!Buffer.isBuffer(data)||data.length===0||data.length>MAX_BYTES)throw problem("Файл должен быть не больше 5 МиБ.",413);
 const existing=listAll(root);
 if(existing.length>=MAX_FILES)throw problem("Достигнут лимит вложений.",413);
 const id=crypto.randomUUID();
 const dataPath=dataFile(root,id),metaPath=metaFile(root,id);
 const record={id,notePath:normalized,name,bytes:data.length,sha256:digest(data),
   createdAt:new Date().toISOString(),trashId:null};
 try{
   fs.writeFileSync(dataPath,data,{flag:"wx",mode:0o600});
   fs.writeFileSync(metaPath,JSON.stringify(record),{flag:"wx",mode:0o600});
 }catch(e){
   if(fs.existsSync(dataPath))fs.unlinkSync(dataPath);
   if(fs.existsSync(metaPath))fs.unlinkSync(metaPath);
   throw e;
 }
 return {...record,sha256:undefined};
}
function listAll(root){
 rootDir(root);
 const files=fs.readdirSync(root).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name));
 if(files.length>MAX_FILES)throw problem("Слишком много вложений.",413);
 return files.map(name=>{
   const id=name.slice(0,-5),file=metaFile(root,id);
   safeFile(file);
   const raw=JSON.parse(fs.readFileSync(file,"utf8"));
   if(raw.id!==id||typeof raw.notePath!=="string"||typeof raw.name!=="string"||
     !Number.isInteger(raw.bytes)||raw.bytes<1||raw.bytes>MAX_BYTES||
     typeof raw.sha256!=="string"||!/^[a-f0-9]{64}$/.test(raw.sha256))
     throw problem("Метаданные вложений повреждены.");
   notes.normalizePath(raw.notePath);validateName(raw.name);
   return raw;
 });
}
function list(root,noteRoot,notePath){
 const normalized=notes.normalizePath(notePath);
 notes.read(noteRoot,normalized);
 return listAll(root).filter(item=>item.notePath===normalized&&!item.trashId)
   .map(({sha256,trashId,...meta})=>meta);
}
function open(root,id){
 const item=listAll(root).find(x=>x.id===validateId(id));
 if(!item||item.trashId)throw problem("Вложение не найдено.",404);
 const file=dataFile(root,id);
 if(!fs.existsSync(file))throw problem("Файл вложения не найден.",404);
 const stat=safeFile(file);
 if(stat.size!==item.bytes)throw problem("Нарушена целостность вложения.",409);
 const buffer=fs.readFileSync(file);
 if(digest(buffer)!==item.sha256)throw problem("Контрольная сумма вложения не совпадает.",409);
 return {name:item.name,bytes:buffer};
}
function updateRecords(root,fn){
 for(const record of listAll(root)){
   const changed=fn(record);
   if(!changed)continue;
   const file=metaFile(root,record.id),tmp=file+"."+crypto.randomUUID()+".tmp";
   try{
     fs.writeFileSync(tmp,JSON.stringify(record),{flag:"wx",mode:0o600});
     fs.renameSync(tmp,file);
   }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 }
}
function move(root,mapping){
 const lookup=new Map(mapping);
 updateRecords(root,item=>{
   if(item.trashId)return false;
   const next=lookup.get(item.notePath);
   if(!next)return false;
   item.notePath=notes.normalizePath(next);return true;
 });
}
function detach(root,notePath,trashId){
 const normalized=notes.normalizePath(notePath);
 if(typeof trashId!=="string"||trashId.length>100)throw problem("Недопустимый ID корзины.");
 updateRecords(root,item=>{
   if(item.notePath!==normalized||item.trashId)return false;
   item.trashId=trashId;return true;
 });
}
function reattach(root,trashId,notePath){
 const normalized=notes.normalizePath(notePath);
 updateRecords(root,item=>{
   if(item.trashId!==trashId)return false;
   item.notePath=normalized;item.trashId=null;return true;
 });
}
module.exports={MAX_BYTES,EXTENSIONS,validateName,validateId,save,list,open,move,detach,reattach,listAll};
