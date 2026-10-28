"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const attachments=require("../knowledge-attachments");
const care=require("../knowledge-maintenance");
const notes=require("../knowledge-core");
const {createServer}=require("../server");
function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-attach-"));
 const spec={notesRoot:path.join(root,"knowledge"),historyRoot:path.join(root,"history"),
 canvasRoot:path.join(root,"canvas"),basesRoot:path.join(root,"bases"),
 trashRoot:path.join(root,"trash"),attachmentsRoot:path.join(root,"attachments"),
 backupsRoot:path.join(root,"backups")};
 try{return fn(spec,root);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test("attachments are tied to existing notes, with no overwrite and SHA256 on open",()=>fixture(s=>{
 notes.create(s.notesRoot,"Проекты/План.md","# Важно");
 const raw=Buffer.from("Локальный файл");
 const result=attachments.save(s.attachmentsRoot,s.notesRoot,"Проекты/План.md","смета.txt",raw);
 assert.equal(attachments.list(s.attachmentsRoot,s.notesRoot,"Проекты/План.md").length,1);
 assert.deepEqual(attachments.open(s.attachmentsRoot,result.id).bytes,raw);
 const data=path.join(s.attachmentsRoot,result.id+".bin");
 fs.writeFileSync(data,"Повреждённая копия");
 assert.throws(()=>attachments.open(s.attachmentsRoot,result.id),{status:409});
 assert.throws(()=>attachments.save(s.attachmentsRoot,s.notesRoot,"Missing.md","x.txt",raw),{status:404});
}));
test("reject executable formats, path traversal, empty and oversized files",()=>fixture(s=>{
 notes.create(s.notesRoot,"A.md","# A");
 for(const bad of ["../evil.txt","tool.exe",".env","a/b.txt","CON.exe","script.js"]){
   assert.throws(()=>attachments.save(s.attachmentsRoot,s.notesRoot,"A.md",bad,Buffer.from("x")));
 }
 assert.throws(()=>attachments.save(s.attachmentsRoot,s.notesRoot,"A.md","file.pdf",Buffer.alloc(0)));
 assert.throws(()=>attachments.save(s.attachmentsRoot,s.notesRoot,"A.md","file.pdf",Buffer.alloc(5*1024*1024+1)),{status:413});
 assert.throws(()=>attachments.open(s.attachmentsRoot,"../bad"));
}));
test("folder moves, trash deletion, restore, and backup recover attachment metadata and bytes",()=>fixture(s=>{
 notes.create(s.notesRoot,"Папка/Важная.md","# Важно");
 const saved=attachments.save(s.attachmentsRoot,s.notesRoot,"Папка/Важная.md","образец.csv",Buffer.from("1,2,3"));
 care.moveFolder(s,"Папка","Архив");
 assert.equal(attachments.list(s.attachmentsRoot,s.notesRoot,"Архив/Важная.md").length,1);
 care.renameNote(s,"Архив/Важная.md","Архив/Готовая.md");
 assert.equal(attachments.list(s.attachmentsRoot,s.notesRoot,"Архив/Готовая.md")[0].id,saved.id);
 const b=care.backup(s);
 assert.ok(care.verifyBackup(s,b.id).manifest.volumes.includes("attachments"));
 const trash=care.trashNote(s,"Архив/Готовая.md");
 assert.throws(()=>attachments.open(s.attachmentsRoot,saved.id),{status:404});
 care.trashRestore(s,trash.id);
 assert.deepEqual(attachments.open(s.attachmentsRoot,saved.id).bytes,Buffer.from("1,2,3"));
 const next=attachments.save(s.attachmentsRoot,s.notesRoot,"Архив/Готовая.md","другой.txt",Buffer.from("NEW"));
 assert.equal(attachments.list(s.attachmentsRoot,s.notesRoot,"Архив/Готовая.md").length,2);
 care.restoreBackup(s,b.id);
 assert.equal(attachments.list(s.attachmentsRoot,s.notesRoot,"Архив/Готовая.md").length,1);
 assert.deepEqual(attachments.open(s.attachmentsRoot,saved.id).bytes,Buffer.from("1,2,3"));
 assert.throws(()=>attachments.open(s.attachmentsRoot,next.id),{status:404});
}));
test("HTTP local binary upload and force-download headers protect user files",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-attach-http-"));
 const server=createServer({env:{},knowledgeDirectory:path.join(root,"notes"),
 knowledgeHistoryDirectory:path.join(root,"history"),knowledgeCanvasDirectory:path.join(root,"canvas"),
 knowledgeAttachmentsDirectory:path.join(root,"attachments"),knowledgeDataDirectory:root});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+server.address().port;
 try{
   notes.create(path.join(root,"notes"),"Новый.md","# Тест");
   let r=await fetch(base+"/api/knowledge/attachment?path="+encodeURIComponent("Новый.md")+"&name="+encodeURIComponent("фото.png"),{
     method:"POST",headers:{"Content-Type":"application/octet-stream"},
     body:Buffer.from("test bytes")});
   assert.equal(r.status,201);
   const entry=await r.json();
   assert.ok(entry.id);
   r=await fetch(base+"/api/knowledge/attachments?path="+encodeURIComponent("Новый.md"));
   assert.equal((await r.json()).items.length,1);
   r=await fetch(base+"/api/knowledge/attachment?id="+entry.id);
   assert.equal(r.status,200);
   assert.equal(r.headers.get("content-type"),"application/octet-stream");
   assert.match(r.headers.get("content-disposition"),/^attachment;/);
   assert.equal(Buffer.from(await r.arrayBuffer()).toString(),"test bytes");
   r=await fetch(base+"/api/knowledge/attachment?path="+encodeURIComponent("Новый.md")+"&name=a.txt",{
    method:"POST",headers:{"Content-Type":"application/octet-stream",Origin:"https://unsafe.example"},body:"evil"});
   assert.equal(r.status,403);
   r=await fetch(base+"/api/knowledge/attachment?path="+encodeURIComponent("Новый.md")+"&name=a.js",{
    method:"POST",headers:{"Content-Type":"application/octet-stream"},body:"evil"});
   assert.equal(r.status,400);
   r=await fetch(base+"/api/knowledge/attachment?path="+encodeURIComponent("Новый.md")+"&name=big.txt",{
    method:"POST",headers:{"Content-Type":"application/octet-stream"},body:Buffer.alloc(5*1024*1024+1)});
   assert.equal(r.status,413);
   r=await fetch(base+"/knowledge-attachments.js");
   assert.equal(r.status,404);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
test("existing four and five-volume snapshots remain restorable",()=>fixture(s=>{
 notes.create(s.notesRoot,"A.md","# original");
 const b=care.backup(s);
 const directory=path.join(s.backupsRoot,b.id);
 let manifest=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));
 for(const v of ["attachments","bases"]){
   manifest.volumes=manifest.volumes.filter(x=>x!==v);
   manifest.files=manifest.files.filter(x=>!x.path.startsWith(v+"/"));
   fs.rmSync(path.join(directory,v),{recursive:true,force:true});
 }
 manifest.count=manifest.files.length;
 manifest.bytes=manifest.files.reduce((acc,f)=>acc+f.bytes,0);
 fs.writeFileSync(path.join(directory,"manifest.json"),JSON.stringify(manifest));
 notes.save(s.notesRoot,"A.md","# changed");
 care.restoreBackup(s,b.id);
 assert.equal(notes.read(s.notesRoot,"A.md").content,"# original");
}));
