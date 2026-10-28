"use strict";
const knowledge=require("./knowledge-core");
const advanced=require("./knowledge-advanced-core");
function normalizeFolder(value){
 if(value===""||value===undefined||value===null)return "";
 return knowledge.normalizePath(value,true);
}
function view(root,{folder="",q="",page=0,size=120}={}){
 folder=normalizeFolder(folder);
 if(typeof q!=="string"||q.length>120)throw knowledge.problem("Недопустимый поиск.");
 if(!Number.isInteger(page)||page<0||page>500)throw knowledge.problem("Неверная страница.");
 if(!Number.isInteger(size)||size<1||size>240)throw knowledge.problem("Показывайте от 1 до 240 узлов.");
 const notes=knowledge.list(root).notes;
 const counts=new Map();
 for(const n of notes){
  const parts=n.folder.split("/").filter(Boolean);
  counts.set("",(counts.get("")||0)+1);
  let prefix="";
  for(const part of parts){
   prefix+=(prefix?"/":"")+part;
   counts.set(prefix,(counts.get(prefix)||0)+1);
  }
 }
 const search=q.trim().toLocaleLowerCase("ru");
 const found=notes.filter(n=>(!folder||n.folder===folder||n.folder.startsWith(folder+"/"))&&
  (!search||(n.path+" "+n.excerpt).toLocaleLowerCase("ru").includes(search)));
 const offset=page*size,pageNotes=found.slice(offset,offset+size);
 const byPath=new Map(notes.map(n=>[n.path.toLocaleLowerCase("ru"),n]));
 const titles=new Map();
 for(const n of notes){
  const name=n.title.toLocaleLowerCase("ru");
  if(!titles.has(name))titles.set(name,[]);
  titles.get(name).push(n);
 }
 const present=new Set(pageNotes.map(n=>n.path));
 const links=[];
 for(const n of pageNotes){
  for(const link of n.links){
   const normal=link.replace(/\.md$/i,"").toLocaleLowerCase("ru");
   const full=normal+".md";
   // Resolve exact paths first; ambiguous titles are not assumed to be links.
   let resolved=byPath.get((n.folder?n.folder+"/":"")+full)||byPath.get(full);
   if(!resolved && (titles.get(normal)||[]).length===1)resolved=titles.get(normal)[0];
   if(resolved && present.has(resolved.path))links.push({from:n.path,to:resolved.path,kind:"wiki"});
  }
 }
 return {
  total:found.length,page,size,pages:Math.ceil(found.length/size),
  nodes:pageNotes.map(n=>({path:n.path,title:n.title,folder:n.folder,updatedAt:n.updatedAt})),
  links,clusters:[...counts].filter(([name])=>name).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name,"ru")),
  note:"Это обзор всех заметок с постраничной отрисовкой, а не одновременный рендер всех узлов."
 };
}
function timeline(notesRoot,historyRoot,path){
 path=knowledge.normalizePath(path);
 const current=knowledge.read(notesRoot,path);
 const history=advanced.history(historyRoot,path).slice(0,20);
 const snapshots=history.map(h=>({at:h.at,id:h.id,content:advanced.readVersion(historyRoot,path,h.id).content})).reverse();
 snapshots.push({at:new Date().toISOString(),id:"current",content:current.content});
 const events=[];let prev=null;
 for(const snap of snapshots){
  const links=new Set(knowledge.references(snap.content));
  if(prev){
   const added=[...links].filter(x=>!prev.links.has(x));
   const removed=[...prev.links].filter(x=>!links.has(x));
   if(added.length||removed.length)events.push({at:snap.at,revision:snap.id,added,removed});
  }
  prev={links};
 }
 return {path,events,observed:snapshots.length,
  note:"Восстановлено из сохранённых версий Markdown; связи Canvas и изменения между незафиксированными версиями не учитываются."};
}
module.exports={view,timeline,normalizeFolder};
