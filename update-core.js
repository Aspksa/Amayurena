"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const zlib=require("node:zlib");
const MAX_ARCHIVE=45*1024*1024,MAX_UNPACKED=110*1024*1024,MAX_FILES=2500;
function problem(message){return new Error(message);}
function version(value){
 const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value||"");
 if(!m)throw problem("Неподдерживаемая версия: "+value);
 return m.slice(1).map(Number);
}
function compare(a,b){
 const left=version(a),right=version(b);
 for(let i=0;i<3;i++)if(left[i]!==right[i])return Math.sign(left[i]-right[i]);
 return 0;
}
function releaseAsset(data,current){
 if(!data||typeof data!=="object"||data.draft||data.prerelease||
   typeof data.tag_name!=="string"||!Array.isArray(data.assets))
   throw problem("GitHub не вернул проверенный стабильный релиз.");
 const tag=data.tag_name;
 version(tag);
 const result={tag,available:compare(tag,current)>0};
 if(!result.available)return result;
 const asset=data.assets.find(a=>a.name==="Amayurena-update.zip");
 if(!asset||!Number.isInteger(asset.size)||asset.size<=0||asset.size>MAX_ARCHIVE||
  typeof asset.digest!=="string"||!/^sha256:[a-f0-9]{64}$/i.test(asset.digest)||
  typeof asset.browser_download_url!=="string"||
  !new RegExp("^https://github\\.com/Aspksa/Amayurena/releases/download/v?\\d+\\.\\d+\\.\\d+/Amayurena-update\\.zip$").test(asset.browser_download_url))
   throw problem("В релизе нет архива с проверяемой контрольной суммой SHA-256.");
 return {...result,url:asset.browser_download_url,sha256:asset.digest.slice(7).toLowerCase(),size:asset.size};
}
function safePath(name){
 if(typeof name!=="string"||!name||name.length>250||name.includes("\\")||name.includes("\u0000")||
   name.startsWith("/")||name.includes("//")||name.includes(":")||
   name.split("/").some(s=>s==="."||s===".."||s.startsWith(".")||s.endsWith(".")||s.endsWith(" ")))
   throw problem("Недопустимое имя файла в ZIP.");
 const allowedRoot=/^[a-zA-Z0-9_-]+\.(js|css|bat|md|json|svg)$/i.test(name);
 const allowedAssets=/^assets\/avatars\/[a-zA-Z0-9_-]+\.(webp|avif|svg|png)$/i.test(name);
 if(!allowedRoot&&!allowedAssets)throw problem("Архив содержит недопустимый файл: "+name);
 return name;
}
function sha(data){return crypto.createHash("sha256").update(data).digest("hex");}
const crcTable=Array.from({length:256},(_,i)=>{
 let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;
 return c>>>0;
});
function crc32(buffer){
 let crc=0xffffffff;
 for(const b of buffer)crc=crcTable[(crc^b)&255]^(crc>>>8);
 return (crc^0xffffffff)>>>0;
}
function unpack(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length>MAX_ARCHIVE||buffer.length<22)
   throw problem("Архив превышает лимит или повреждён.");
 let end=-1;
 for(let i=buffer.length-22;i>=Math.max(0,buffer.length-66000);i--){
   if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
 }
 if(end<0)throw problem("Не найдена центральная директория ZIP.");
 const count=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),
   offset=buffer.readUInt32LE(end+16);
 if(count<=0||count>MAX_FILES||count===65535||offset+size>end||buffer.readUInt16LE(end+8)!==count||
   buffer.readUInt16LE(end+4)!==0||buffer.readUInt16LE(end+6)!==0)
   throw problem("Недопустимая структура ZIP.");
 const files=new Map(),seen=new Set();
 let pos=offset,total=0;
 for(let i=0;i<count;i++){
   if(pos+46>buffer.length||buffer.readUInt32LE(pos)!==0x02014b50)throw problem("Повреждённый заголовок ZIP.");
   const flags=buffer.readUInt16LE(pos+8),method=buffer.readUInt16LE(pos+10),
     check=buffer.readUInt32LE(pos+16),compressed=buffer.readUInt32LE(pos+20),
     uncompressed=buffer.readUInt32LE(pos+24),nameLen=buffer.readUInt16LE(pos+28),
     extraLen=buffer.readUInt16LE(pos+30),commentLen=buffer.readUInt16LE(pos+32),
     external=buffer.readUInt32LE(pos+38),local=buffer.readUInt32LE(pos+42);
   if(flags&1||![0,8].includes(method)||nameLen===0||
     compressed>MAX_ARCHIVE||uncompressed>10*1024*1024||
     (external>>>16&0xf000)===0xa000)
     throw problem("Недопустимое или зашифрованное содержимое ZIP.");
   const nameStart=pos+46,nameEnd=nameStart+nameLen;
   if(nameEnd+extraLen+commentLen>buffer.length)throw problem("ZIP обрезан.");
   const filename=buffer.subarray(nameStart,nameEnd).toString("utf8");
   pos=nameEnd+extraLen+commentLen;
   if(filename.endsWith("/"))continue;
   const name=safePath(filename),fold=name.toLowerCase();
   if(seen.has(fold))throw problem("Повторяющееся имя файла в ZIP.");
   seen.add(fold);
   if(local+30>buffer.length||buffer.readUInt32LE(local)!==0x04034b50)throw problem("Нет заголовка файла ZIP.");
   const lName=buffer.readUInt16LE(local+26),lExtra=buffer.readUInt16LE(local+28);
   const dataOffset=local+30+lName+lExtra;
   if(dataOffset+compressed>buffer.length)throw problem("ZIP повреждён.");
   const packed=buffer.subarray(dataOffset,dataOffset+compressed);
   const body=method===0?packed:zlib.inflateRawSync(packed,{maxOutputLength:10*1024*1024+1});
   if(body.length!==uncompressed||crc32(body)!==check)throw problem("ZIP не прошёл проверку CRC32.");
   total+=body.length;
   if(total>MAX_UNPACKED)throw problem("Распакованный архив превышает допустимый объём.");
   files.set(name,Buffer.from(body));
 }
 for(const required of ["project-version.json","server.js","index.html","Amayurena.bat","update-worker.js"])
   if(!files.has(required))throw problem("В обновлении отсутствует обязательный файл: "+required);
 return files;
}
function verifyPackage(files,tag){
 const manifest=JSON.parse(files.get("project-version.json").toString("utf8"));
 if(typeof manifest.version!=="string"||compare(tag,manifest.version)!==0)
   throw problem("Версия архива не соответствует релизу GitHub.");
 return manifest;
}
function atomicReplace(filename,content){
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 const temp=filename+".new-"+crypto.randomUUID();
 try{
   fs.writeFileSync(temp,content,{flag:"wx",mode:0o600});
   fs.renameSync(temp,filename);
 }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function writeJson(filename,value){atomicReplace(filename,Buffer.from(JSON.stringify(value,null,2),"utf8"));}
function restore(root){
 const journalFile=path.join(root,".updates","recovery.json");
 if(!fs.existsSync(journalFile))return {restored:false};
 const j=JSON.parse(fs.readFileSync(journalFile,"utf8"));
 if(!Array.isArray(j.files)||typeof j.backup!=="string"||!/^backup-[a-z0-9-]+$/.test(j.backup))
   throw problem("Повреждён журнал отката. Автоматическое восстановление прекращено.");
 const backup=path.join(root,".updates","backups",j.backup);
 for(const item of j.files){
   const rel=safePath(item.name),dest=path.join(root,...rel.split("/"));
   if(item.existed){
     const backed=path.join(backup,...rel.split("/"));
     if(!fs.existsSync(backed))throw problem("Не найдена резервная копия файла "+rel);
     atomicReplace(dest,fs.readFileSync(backed));
   } else if(fs.existsSync(dest))fs.unlinkSync(dest);
 }
 fs.unlinkSync(journalFile);
 return {restored:true,count:j.files.length};
}
function install(root,files,tag){
 verifyPackage(files,tag);
 const updates=path.join(root,".updates"),backups=path.join(updates,"backups");
 fs.mkdirSync(backups,{recursive:true});
 const journalFile=path.join(updates,"recovery.json");
 if(fs.existsSync(journalFile))throw problem("Обнаружен незавершённый предыдущий откат.");
 const id="backup-"+Date.now().toString(36)+"-"+crypto.randomUUID().slice(0,8);
 const folder=path.join(backups,id);
 const records=[];
 fs.mkdirSync(folder);
 for(const [name] of files){
   const rel=safePath(name),dest=path.join(root,...rel.split("/"));
   const existed=fs.existsSync(dest);
   if(existed){
     const stat=fs.lstatSync(dest);
     if(!stat.isFile()||stat.isSymbolicLink())throw problem("Недопустимая замена файла: "+rel);
     const save=path.join(folder,...rel.split("/"));
     fs.mkdirSync(path.dirname(save),{recursive:true});
     fs.copyFileSync(dest,save);
   }
   records.push({name:rel,existed});
 }
 writeJson(journalFile,{tag,backup:id,files:records});
 try{
   for(const [name,content] of files)atomicReplace(path.join(root,...name.split("/")),content);
   fs.unlinkSync(journalFile);
   return {installed:true,tag,backup:id,count:records.length};
 }catch(e){
   try{restore(root);}
   catch(recovery){throw problem("Обновление не завершено: "+e.message+"; восстановление требует ручной проверки: "+recovery.message);}
   throw e;
 }
}
module.exports={MAX_ARCHIVE,compare,version,releaseAsset,safePath,sha,crc32,unpack,verifyPackage,atomicReplace,restore,install};
