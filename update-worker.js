"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const care=require("./knowledge-maintenance");
const core=require("./update-core");
const ROOT=__dirname;
const RELEASE_URL="https://api.github.com/repos/Aspksa/Amayurena/releases/latest";
function localVersion(root=ROOT){
 const file=path.join(root,"project-version.json");
 if(!fs.existsSync(file))return "0.0.0";
 const raw=JSON.parse(fs.readFileSync(file,"utf8"));
 core.version(raw.version);return raw.version;
}
async function latest(fetchImpl=fetch){
 let response;
 try{
   response=await fetchImpl(RELEASE_URL,{headers:{"Accept":"application/vnd.github+json",
     "User-Agent":"Amayurena-Portable-Updater","X-GitHub-Api-Version":"2022-11-28"},
     signal:AbortSignal.timeout(20000)});
 }catch(e){throw Error("Не удалось проверить GitHub: "+e.message);}
 if(response.status===404)return null;
 if(!response.ok)throw Error("Ошибка GitHub при проверке релиза: HTTP "+response.status);
 return response.json();
}
async function check(fetchImpl=fetch,root=ROOT){
 const current=localVersion(root),release=await latest(fetchImpl);
 if(!release)return {current,available:false,reason:"В репозитории пока нет опубликованных релизов."};
 const info=core.releaseAsset(release,current);
 return {current,latest:info.tag,available:info.available,
   ...(info.available?{size:info.size,digest:info.sha256}:{})};
}
function serverRunning(root=ROOT){
 const file=path.join(root,".updates","server.pid");
 if(!fs.existsSync(file))return false;
 const pid=Number(fs.readFileSync(file,"utf8").trim());
 if(!Number.isSafeInteger(pid)||pid<=0)return true;
 if(pid===process.pid)return false;
 try{process.kill(pid,0);return true;}
 catch(e){return e.code!=="ESRCH";}
}
async function download(asset,fetchImpl=fetch){
 const response=await fetchImpl(asset.url,{headers:{"User-Agent":"Amayurena-Portable-Updater"},
   redirect:"follow",signal:AbortSignal.timeout(65000)});
 if(!response.ok)throw Error("Не удалось скачать проверенный ZIP: HTTP "+response.status);
 if(Number(response.headers.get("content-length"))>core.MAX_ARCHIVE)throw Error("Архив слишком большой.");
 const body=Buffer.from(await response.arrayBuffer());
 if(body.length>core.MAX_ARCHIVE)throw Error("Размер архива превышает лимит.");
 if(core.sha(body)!==asset.sha256)throw Error("SHA-256 архива не совпал с контрольной суммой релиза.");
 return body;
}
function createDataBackup(root=ROOT){
 return care.backup({
   notesRoot:path.join(root,"data","knowledge"),
   historyRoot:path.join(root,"data","knowledge-history"),
   canvasRoot:path.join(root,"data","canvases"),
   basesRoot:path.join(root,"data","knowledge-bases"),
   trashRoot:path.join(root,"data","trash"),
   backupsRoot:path.join(root,"data","backups")
 });
}
async function update(fetchImpl=fetch,root=ROOT){
 if(serverRunning(root))throw Error("Сначала завершите работающий Amayurena.bat, затем повторите обновление.");
 const local=localVersion(root);
 const release=await latest(fetchImpl);
 if(!release)throw Error("В GitHub пока нет опубликованных релизов.");
 const info=core.releaseAsset(release,local);
 if(!info.available)return {updated:false,reason:"Текущая версия уже не старее последнего релиза."};
 const zip=await download(info,fetchImpl);
 const files=core.unpack(zip);
 core.verifyPackage(files,info.tag);
 // Both copies must be complete before any application code is replaced.
 const dataBackup=createDataBackup(root);
 const result=core.install(root,files,info.tag);
 return {...result,previous:local,dataBackup:dataBackup.id};
}
function restart(root=ROOT){
 if(process.platform!=="win32")return false;
 const bat=path.join(root,"Amayurena.bat");
 const cmd='start "" "'+bat.replace(/%/g,"%%")+'"';
 const child=spawn("cmd.exe",["/d","/s","/c",cmd],{detached:true,windowsHide:true,stdio:"ignore",cwd:root});
 child.on("error",()=>{});
 child.unref();
 return true;
}
async function main(){
 const action=process.argv[2]||"check";
 if(action==="recover"){
   const result=core.restore(ROOT);
   console.log(result.restored?"Исходные файлы восстановлены.":"Незавершённого обновления нет.");
   return;
 }
 if(action==="check"){
   const result=await check();
   console.log(result.available?"Доступно обновление "+result.latest+"; размер "+result.size+" байт.":
     (result.reason||"Установлена актуальная версия "+result.current));
   return;
 }
 if(action!=="install")throw Error("Используйте check, install или recover.");
 const previous=core.restore(ROOT);
 if(previous.restored)console.log("Незавершённое обновление отменено, исходные файлы восстановлены.");
 const result=await update();
 if(!result.updated && !result.installed){console.log(result.reason);return;}
 console.log("Проверено и установлено "+result.tag+"; резервная копия знаний: "+result.dataBackup);
 if(restart())console.log("Запуск новой версии Amayurena выполнен.");
}
if(require.main===module){
 main().catch(e=>{console.error("Ошибка обновления: "+e.message);process.exitCode=1;});
}
module.exports={localVersion,latest,check,download,serverRunning,createDataBackup,update,restart};
