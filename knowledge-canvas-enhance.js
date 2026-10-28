(function(root,factory){
"use strict";
const api=factory();
if(typeof module==="object"&&module.exports)module.exports=api;
if(root)root.AmayurenaCanvasEnhance=api;
})(typeof window!=="undefined"?window:null,function(){
"use strict";
const MAX_HISTORY=40,MAX_NODES=60;
function clone(x){return JSON.parse(JSON.stringify(x));}
function template(name){
 const base={nodes:[],edges:[],groups:[]};
 if(name==="blank")return base;
 if(name==="mind"){
  base.nodes=[{id:"root",type:"text",x:500,y:230,text:"Главная тема"},
   {id:"idea1",type:"text",x:160,y:550,text:"Идея 1"},
   {id:"idea2",type:"text",x:840,y:550,text:"Идея 2"}];
  base.edges=[{from:"root",to:"idea1"},{from:"root",to:"idea2"}];return base;
 }
 if(name==="kanban"){
  base.groups=[
   {id:"todo",label:"Запланировано",tone:"rose",x:70,y:140,width:500,height:760},
   {id:"doing",label:"В работе",tone:"gold",x:650,y:140,width:500,height:760},
   {id:"done",label:"Завершено",tone:"green",x:1230,y:140,width:500,height:760}
  ];
  base.nodes=[{id:"first",type:"text",x:120,y:220,groupId:"todo",text:"Первая задача"}];
  return base;
 }
 throw Error("Неизвестный шаблон Canvas.");
}
function timeline(board) {
 let states=[clone(board)],position=0;
 const current=()=>clone(states[position]);
 return {
  record(next){
   const raw=JSON.stringify(next);
   if(JSON.stringify(states[position])===raw)return false;
   states=states.slice(0,position+1);states.push(clone(next));
   if(states.length>MAX_HISTORY){states.shift();}position=states.length-1;
   return true;
  },
  undo(){
   if(position<=0)return null;position--;return current();
  },
  redo(){
   if(position>=states.length-1)return null;position++;return current();
  },
  canUndo(){return position>0;},canRedo(){return position<states.length-1;}
 };
}
function snap(value,step=25){
 if(!Number.isFinite(value)||!Number.isFinite(step)||step<=0)throw Error("Некорректная сетка.");
 return Math.round(value/step)*step;
}
function copySelected(board,selected,newId){
 const target=clone(board),ids=new Set(selected);
 const source=target.nodes.filter(n=>ids.has(n.id));
 if(!source.length)return {board:target,ids:[]};
 if(target.nodes.length+source.length>MAX_NODES)throw Error("На доске можно разместить до 60 карточек.");
 const mapping=new Map();
 const copies=source.map((n,i)=>{
   const id=newId(n.id,i);if(typeof id!=="string"||!/^[\w-]{1,64}$/.test(id)||target.nodes.some(v=>v.id===id)||[...mapping.values()].includes(id))
     throw Error("Неверный идентификатор новой карточки.");
   mapping.set(n.id,id);
   return {...n,id,x:Math.min(3200,n.x+30),y:Math.min(2400,n.y+30)};
 });
 target.nodes.push(...copies);
 for(const edge of board.edges){
  if(mapping.has(edge.from)&&mapping.has(edge.to)&&target.edges.length<120)
    target.edges.push({from:mapping.get(edge.from),to:mapping.get(edge.to)});
 }
 return {board:target,ids:copies.map(n=>n.id)};
}
return {clone,template,timeline,snap,copySelected,MAX_HISTORY};
});