(function(){
"use strict";
const check=document.getElementById("update-check");
const install=document.getElementById("update-install");
const status=document.getElementById("update-status");
let latest=null,checking=false;
async function json(url,options){
 const r=await fetch(url,options);
 let body;
 try{body=await r.json();}catch(_){throw Error("Сервер не вернул JSON.");}
 if(!r.ok)throw Error(body.error||"HTTP "+r.status);
 return body;
}
async function inspect(){
 if(checking)return;
 checking=true;check.disabled=true;install.hidden=true;latest=null;
 status.textContent="Проверка официальных релизов GitHub…";
 try{
   const data=await json("/api/update/check");
   if(data.available&&data.digest){
     latest=data.latest;
     install.hidden=false;
     status.textContent="Доступна версия "+data.latest+" (проверка SHA-256 обязательна).";
   }else status.textContent=data.reason||"Установлена актуальная версия "+data.current+".";
 }catch(e){status.textContent=e.message+" Для ручной проверки используйте Amayurena-Update.bat.";}
 finally{checking=false;check.disabled=false;}
}
async function apply(){
 if(!latest)return;
 if(!confirm("Проверить и установить версию "+latest+" из официального GitHub Releases? "+
   "Amayurena сохранит локальную резервную копию данных, завершит сервер и перезапустит приложение. "+
   "Установка доступна только для релиза с контрольной суммой SHA-256."))return;
 install.disabled=true;check.disabled=true;
 status.textContent="Подготовка безопасного запуска установщика…";
 try{
   const result=await json("/api/update/install",{method:"POST",
     headers:{"Content-Type":"application/json"},
     body:JSON.stringify({confirm:"INSTALL_VERIFIED_RELEASE"})});
   status.textContent=result.message+
     " После перезапуска проверьте установленную версию. Если установка прервётся, выполните Amayurena-Update.bat.";
 }catch(e){
   status.textContent="Установка не началась: "+e.message;
   install.disabled=false;check.disabled=false;
 }
}
check.addEventListener("click",()=>{void inspect();});
install.addEventListener("click",()=>{void apply();});
if(location.protocol==="http:"||location.protocol==="https:")void inspect();
})();
