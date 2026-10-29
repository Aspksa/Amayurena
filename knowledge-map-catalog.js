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
function neighbors(root,requestPath,{limit=120}={}){
 if(!Number.isInteger(limit)||limit<2||limit>240)throw knowledge.problem("Недопустимый предел просмотра.");
 const path=knowledge.normalizePath(requestPath);
 const notes=knowledge.list(root).notes;
 const anchor=notes.find(n=>n.path===path);
 if(!anchor)throw knowledge.problem("Заметка для карты не найдена.",404);
 const byPath=new Map(notes.map(n=>[n.path.toLocaleLowerCase("ru"),n]));
 const byTitle=new Map();
 for(const n of notes){
   const key=n.title.toLocaleLowerCase("ru");
   if(!byTitle.has(key))byTitle.set(key,[]);
   byTitle.get(key).push(n);
 }
 const resolve=(raw,from)=>{
   const key=raw.trim().replace(/\.md$/i,"").toLocaleLowerCase("ru");
   const pref=from.folder?from.folder+"/":"";
   const exact=byPath.get(pref+key+".md")||byPath.get(key+".md");
   if(exact)return exact;
   const titles=byTitle.get(key)||[];
   return titles.length===1?titles[0]:null;
 };
 const related=new Map([[path,{note:anchor,incoming:0,outgoing:0}]]);
 const edges=[],known=new Set();
 for(const note of notes){
   if(note.path!==path && !note.links?.length)continue;
   for(const raw of note.links||[]){
     const target=resolve(raw,note);
     if(!target || (note.path!==path && target.path!==path))continue;
     if(note.path===target.path)continue;
     const key=note.path+"\u0000"+target.path;
     if(known.has(key))continue;
     known.add(key);
     edges.push({from:note.path,to:target.path,kind:"wiki",provenance:{
       source:note.path,reference:"[["+raw+"]]"}});
     const other=note.path===path?target:note;
     if(!related.has(other.path))related.set(other.path,{note:other,incoming:0,outgoing:0});
     const data=related.get(other.path);
     if(note.path===path)data.outgoing++;
     else data.incoming++;
   }
 }
 const entries=[...related.values()].filter(x=>x.note.path!==path);
 entries.sort((a,b)=>(b.incoming+b.outgoing)-(a.incoming+a.outgoing)||
   a.note.path.localeCompare(b.note.path,"ru"));
 const shown=[anchor,...entries.slice(0,limit-1).map(x=>x.note)];
 const shownKeys=new Set(shown.map(n=>n.path));
 return {
   focus:path,total:related.size,page:0,size:limit,pages:1,mode:"neighbors",
   nodes:shown.map(n=>({path:n.path,title:n.title,folder:n.folder,updatedAt:n.updatedAt})),
   links:edges.filter(e=>shownKeys.has(e.from)&&shownKeys.has(e.to)),
   counts:{incoming:edges.filter(e=>e.to===path).length,outgoing:edges.filter(e=>e.from===path).length},
   truncated:related.size>limit,
   clusters:[],note:"Прямые входящие и исходящие wiki-ссылки. Неоднозначные названия не считаются подтверждёнными связями."
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
module.exports={view,neighbors,timeline,normalizeFolder};
