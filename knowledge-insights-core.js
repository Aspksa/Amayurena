"use strict";
const crypto=require("node:crypto");
const knowledge=require("./knowledge-core");
const advanced=require("./knowledge-advanced-core");
const MAX_ANALYZED=180;
const STOP=new Set(("и в во на по для из от до за при со без как что это его ее она они был была были есть все или не но да же уже ещё еще "+
"the and for with from into this that are was were have has you your about notes note проект задача план идея заметка заметки").split(/\s+/));
const PRIVATE_FIELDS=new Set(["password","secret","token","apikey","api_key","key","пароль","ключ"]);
const MAX_PAIRS=60;
function sha(text){return crypto.createHash("sha256").update(text).digest("hex");}
function problem(message,status=400){return Object.assign(new Error(message),{status});}
function words(text){
  return (String(text).normalize("NFKC").toLocaleLowerCase("ru").match(/[\p{L}\p{N}]{4,}/gu)||[])
    .filter(w=>!STOP.has(w)&&w.length<45&&!/^\d+$/.test(w));
}
function shared(a,b){return [...a].filter(w=>b.has(w)).sort((x,y)=>x.localeCompare(y,"ru"));}
function resolveLink(link,from,notes,byTitle){
  const norm=link.trim().replace(/\.md$/i,"").toLocaleLowerCase("ru");
  const directory=from.folder?from.folder+"/":"";
  for(const candidate of [directory+norm+".md",norm+".md"]){
    const found=notes.find(n=>n.path.toLocaleLowerCase("ru")===candidate);
    if(found)return found;
  }
  const choices=byTitle.get(norm)||[];
  return choices.length===1?choices[0]:null;
}
function collect(notesRoot,canvasRoot){
  const index=knowledge.list(notesRoot);
  const selected=index.notes.slice(0,MAX_ANALYZED);
  const items=selected.map(n=>{
    const content=knowledge.read(notesRoot,n.path).content;
    const props=advanced.properties(content);
    const tags=Array.isArray(props.tags)?props.tags:[];
    const body=content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,"");
    return {...n,content,props,tags,sha:sha(content),
      tokens:new Set(words(n.title+" "+n.title+" "+body.slice(0,10000)+" "+tags.join(" ")))};
  });
  const byTitle=new Map();
  for(const item of index.notes){
    const name=item.title.toLocaleLowerCase("ru");
    if(!byTitle.has(name))byTitle.set(name,[]);
    byTitle.get(name).push(item);
  }
  const explicit=[],broken=[],outside=[],edgeKeys=new Set();
  const notePaths=new Set(items.map(n=>n.path));
  for(const item of items)for(const ref of knowledge.references(item.content)){
    const target=resolveLink(ref,item,index.notes,byTitle);
    if(target && notePaths.has(target.path)){
      const key=item.path+"\u0000"+target.path;
      if(!edgeKeys.has(key)){edgeKeys.add(key);explicit.push({from:item.path,to:target.path,kind:"wiki",
        provenance:{source:item.path,reference:"[["+ref+"]]"}});
      }
    }else if(target) outside.push({from:item.path,to:target.path});
    else broken.push({from:item.path,reference:ref});
  }
  let boards=[],canvasEdges=[],canvasReferences=[];
  boards=advanced.listCanvases(canvasRoot);
  for(const b of boards){
    const board=advanced.readCanvas(canvasRoot,b.name);
    const map=new Map(board.nodes.filter(n=>n.type==="file").map(n=>[n.id,n.file]));
    for(const card of board.nodes.filter(n=>n.type==="file"&&notePaths.has(n.file))){
      canvasReferences.push({board:b.name,note:card.file,cardId:card.id});
    }
    for(const edge of board.edges){
      const from=map.get(edge.from),to=map.get(edge.to);
      if(from&&to&&from!==to&&notePaths.has(from)&&notePaths.has(to)){
        const key=from+"\u0000"+to+"\u0000"+b.name;
        if(!canvasEdges.some(x=>x.from+"\u0000"+x.to+"\u0000"+x.board===key)){
          canvasEdges.push({from,to,board:b.name,kind:"canvas",
            provenance:{board:b.name,fromCard:edge.from,toCard:edge.to}});
        }
      }
    }
  }
  return {items,explicit,broken,outside,canvasEdges,canvasReferences,boardCount:boards.length,
    totalNotes:index.notes.length,analyzedNotes:items.length,truncated:index.notes.length>items.length};
}
function similarity(a,b){
  const intersection=shared(a.tokens,b.tokens);
  if(intersection.length<2)return null;
  const union=a.tokens.size+b.tokens.size-intersection.length;
  const score=Math.min(.99,(union?intersection.length/union:0)+
    Math.min(shared(new Set(a.tags.map(t=>t.toLocaleLowerCase("ru"))),new Set(b.tags.map(t=>t.toLocaleLowerCase("ru")))).length,3)*.14);
  const tags=shared(new Set(a.tags.map(t=>t.toLocaleLowerCase("ru"))),new Set(b.tags.map(t=>t.toLocaleLowerCase("ru"))));
  if(score<.14)return null;
  return {score:Number(score.toFixed(3)),terms:intersection.slice(0,7),tags:tags.slice(0,5)};
}
function analyze(notesRoot,canvasRoot,historyRoot){
  const data=collect(notesRoot,canvasRoot);
  const connected=new Set([...data.explicit,...data.canvasEdges].map(e=>[e.from,e.to].sort().join("\u0000")));
  const suggestions=[],disagreements=[];
  const {items}=data;
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
    const a=items[i],b=items[j],match=similarity(a,b);
    if(!match)continue;
    const key=[a.path,b.path].sort().join("\u0000");
    if(!connected.has(key)) suggestions.push({from:a.path,to:b.path,score:match.score,
      sharedTerms:match.terms,sharedTags:match.tags,sourceSha:a.sha,targetSha:b.sha,
      reason:"Общие слова и метки, без подтверждённой связи"});
    if(match.score>=.2){
      const overlap=Object.keys(a.props).filter(k=>Object.hasOwn(b.props,k)&&!PRIVATE_FIELDS.has(k.toLowerCase())&&
        !["tags","type"].includes(k)&&String(a.props[k])!==String(b.props[k]));
      for(const k of overlap.slice(0,2))disagreements.push({from:a.path,to:b.path,field:k,
        note:"Различающиеся свойства: не доказательство противоречия."});
    }
  }
  suggestions.sort((a,b)=>b.score-a.score||a.from.localeCompare(b.from,"ru")||a.to.localeCompare(b.to,"ru"));
  disagreements.sort((a,b)=>a.from.localeCompare(b.from,"ru")||a.field.localeCompare(b.field,"ru"));
  const nodes=items.map(n=>({path:n.path,title:n.title,folder:n.folder,updatedAt:n.updatedAt,sha:n.sha,
    propertyKeys:Object.keys(n.props).filter(k=>!PRIVATE_FIELDS.has(k.toLowerCase())).slice(0,20),
    tags:n.tags.slice(0,15),historyCount:advanced.history(historyRoot,n.path).length,
    canvasBoards:[...new Set(data.canvasReferences.filter(v=>v.note===n.path).map(v=>v.board))]}));
  return {nodes,links:[...data.explicit,...data.canvasEdges],suggestions:suggestions.slice(0,MAX_PAIRS),
    disagreements:disagreements.slice(0,40),missing:data.broken.slice(0,80),outside:data.outside.slice(0,30),
    counts:{total:data.totalNotes,analyzed:data.analyzedNotes,explicit:data.explicit.length,
      canvas:data.canvasEdges.length,boards:data.boardCount,proposed:suggestions.length,
      differences:disagreements.length},truncated:data.truncated,
    method:"Локальная эвристика: пересечение значимых слов и меток; не ИИ и не проверка истинности."};
}
function accept(notesRoot,historyRoot,canvasRoot,request){
  if(!request||typeof request!=="object")throw problem("Неверный запрос.");
  const from=knowledge.normalizePath(request.from),to=knowledge.normalizePath(request.to);
  if(from===to)throw problem("Нельзя связать заметку саму с собой.");
  if(typeof request.expectedSha!=="string"||!/^[a-f0-9]{64}$/.test(request.expectedSha))
    throw problem("Не указана версия исходной заметки.");
  if(typeof request.targetSha!=="string"||!/^[a-f0-9]{64}$/.test(request.targetSha))
    throw problem("Не указана версия целевой заметки.");
  const source=knowledge.read(notesRoot,from),target=knowledge.read(notesRoot,to);
  if(sha(source.content)!==request.expectedSha)throw problem("Исходная заметка изменилась. Обновите карту.",409);
  if(sha(target.content)!==request.targetSha)throw problem("Целевая заметка изменилась. Обновите карту.",409);
  const info=analyze(notesRoot,canvasRoot,historyRoot);
  const found=info.suggestions.find(s=>s.from===from&&s.to===to);
  if(!found||found.sourceSha!==request.expectedSha||found.targetSha!==sha(target.content))
    throw problem("Предложение более не актуально. Обновите карту.",409);
  const next=source.content.replace(/\s*$/,"")+"\n\n[["+to.replace(/\.md$/i,"")+"]]\n";
  const saved=advanced.saveNote(notesRoot,historyRoot,from,next);
  return {from,to,sha:sha(next),saved:true,path:saved.path};
}
module.exports={words,similarity,analyze,accept,sha,resolveLink,MAX_ANALYZED};
