(function(root,factory){
"use strict";
const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;
if(root)root.AmayurenaBasesMath=api;
})(typeof window!=="undefined"?window:null,function(){
"use strict";
const FIELD=/^[a-zA-Zа-яА-ЯёЁ][\wа-яА-ЯёЁ-]{0,39}$/;
const BANNED=new Set(["__proto__","prototype","constructor","title","folder","updatedAt"]);
function validateField(name){if(typeof name!=="string"||!FIELD.test(name)||BANNED.has(name))throw Error("Недопустимое поле формулы.");return name;}
function tokenize(text){
 if(typeof text!=="string"||text.length>180)throw Error("Формула слишком длинная.");
 const tokens=[];let at=0;
 const pattern=/\s*(\d+(?:\.\d+)?|[a-zA-Zа-яА-ЯёЁ][\wа-яА-ЯёЁ-]*|[()+*/-])/y;
 while(at<text.length){
  pattern.lastIndex=at;
  const hit=pattern.exec(text);
  if(!hit)throw Error("Формула содержит недопустимый символ.");
  tokens.push(hit[1]);at=pattern.lastIndex;
  if(tokens.length>65)throw Error("Слишком сложная формула.");
 }
 if(!tokens.length)throw Error("Пустая формула.");
 return tokens;
}
function evaluate(expression,fields){
 const tokens=tokenize(expression),state={i:0,depth:0};
 const isNum=t=>/^\d+(?:\.\d+)?$/.test(t||"");
 function primary(){
  if(++state.depth>15)throw Error("Превышена вложенность выражения.");
  const t=tokens[state.i++];
  let result;
  if(t==="("){result=add();if(tokens[state.i++]!==")")throw Error("Нет закрывающей скобки.");}
  else if(t==="-")result=-primary();
  else if(isNum(t))result=Number(t);
  else {
   validateField(t);
   const raw=fields&&Object.prototype.hasOwnProperty.call(fields,t)?fields[t]:undefined;
   if(raw===undefined||raw===null||raw==="")throw Error("Нет числового значения: "+t);
   if(typeof raw==="boolean")throw Error("Ожидалось число: "+t);
   const n=Number(raw);
   if(!Number.isFinite(n))throw Error("Ожидалось число: "+t);
   result=n;
  }
  state.depth--;return result;
 }
 function mul(){
  let v=primary();
  while(tokens[state.i]==="*"||tokens[state.i]==="/"){
   const op=tokens[state.i++],n=primary();
   if(op==="/"&&n===0)throw Error("Деление на ноль.");
   v=op==="*"?v*n:v/n;
   if(!Number.isFinite(v)||Math.abs(v)>1e12)throw Error("Число вне допустимых границ.");
  }
  return v;
 }
 function add(){
  let v=mul();
  while(tokens[state.i]==="+"||tokens[state.i]==="-"){
   const op=tokens[state.i++],n=mul();
   v=op==="+"?v+n:v-n;
   if(!Number.isFinite(v)||Math.abs(v)>1e12)throw Error("Число вне допустимых границ.");
  }
  return v;
 }
 const result=add();
 if(state.i!==tokens.length)throw Error("Недопустимое продолжение формулы.");
 return Number(result.toFixed(6));
}
function aggregate(rows,field){
 validateField(field);
 const values=rows.map(r=>r?.[field]).filter(v=>v!==null&&v!==undefined&&v!==""&&typeof v!=="boolean").map(Number).filter(Number.isFinite);
 if(!values.length)return {count:0,sum:0,average:null,min:null,max:null};
 const sum=values.reduce((a,b)=>a+b,0);
 return {count:values.length,sum:Number(sum.toFixed(6)),average:Number((sum/values.length).toFixed(6)),
   min:Math.min(...values),max:Math.max(...values)};
}
function match(value,query,operator="contains"){
 const a=String(value??""),b=String(query??"");
 if(!b)return true;
 if(operator==="contains")return a.toLocaleLowerCase("ru").includes(b.toLocaleLowerCase("ru"));
 if(operator==="eq")return a.toLocaleLowerCase("ru")===b.toLocaleLowerCase("ru");
 if(operator==="neq")return a.toLocaleLowerCase("ru")!==b.toLocaleLowerCase("ru");
 if(["gt","gte","lt","lte"].includes(operator)){
  const x=Number(a),y=Number(b);
  if(!a||!Number.isFinite(x)||!Number.isFinite(y))return false;
  return operator==="gt"?x>y:operator==="gte"?x>=y:operator==="lt"?x<y:x<=y;
 }
 throw Error("Недопустимое сравнение.");
}
function matchFilters(valueForField,config){
 if(typeof valueForField!=="function"||!config||typeof config!=="object")
   throw Error("Недопустимые условия фильтра.");
 const join=config.filterJoin||"and";
 if(!["and","or"].includes(join))throw Error("Неизвестная логика фильтра.");
 const rules=[
   {field:config.filterField,value:config.filterValue,op:config.filterOp||"contains"},
   {field:config.filterField2,value:config.filterValue2,op:config.filterOp2||"contains"}
 ].filter(rule=>typeof rule.value==="string"&&rule.value.trim().length>0);
 if(rules.some(rule=>typeof rule.field!=="string"||!rule.field))
   throw Error("Фильтр не содержит имени поля.");
 if(!rules.length)return true;
 const values=rules.map(rule=>match(valueForField(rule.field),rule.value,rule.op));
 return join==="or"?values.some(Boolean):values.every(Boolean);
}
return {evaluate,tokenize,aggregate,match,matchFilters,validateField};
});