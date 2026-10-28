(function(root,factory){
 "use strict";
 const api=factory();
 if(typeof module==="object"&&module.exports)module.exports=api;
 if(root)root.AmayurenaBasesCalendar=api;
})(typeof window!=="undefined"?window:null,function(){
 "use strict";
 function monthString(value){
   if(typeof value!=="string"||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))throw Error("Некорректный месяц.");
   return value;
 }
 function moveMonth(ym,delta){
   monthString(ym);
   if(!Number.isInteger(delta)||Math.abs(delta)>12)throw Error("Недопустимый переход.");
   const [y,m]=ym.split("-").map(Number);
   const date=new Date(Date.UTC(y,m-1+delta,1));
   return date.toISOString().slice(0,7);
 }
 function calendar(ym,rows,dateField){
   monthString(ym);
   if(!Array.isArray(rows)||rows.length>3000||typeof dateField!=="string"||
     dateField.length>40)throw Error("Некорректные данные календаря.");
   const [year,month]=ym.split("-").map(Number);
   const days=new Date(Date.UTC(year,month,0)).getUTCDate();
   const first=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7;
   const byDay=new Map();
   for(const row of rows){
     const raw=row?.properties?.[dateField]??row?.[dateField];
     if(typeof raw!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(raw)||
       !raw.startsWith(ym+"-"))continue;
     const day=Number(raw.slice(-2));
     if(day<1||day>days)continue;
     if(!byDay.has(day))byDay.set(day,[]);
     byDay.get(day).push(row);
   }
   const cells=[];
   const total=Math.ceil((first+days)/7)*7;
   for(let i=0;i<total;i++){
     const day=i-first+1,valid=day>=1&&day<=days;
     cells.push({day:valid?day:null,date:valid?ym+"-"+String(day).padStart(2,"0"):null,
       notes:valid?byDay.get(day)||[]:[]});
   }
   return {month:ym,field:dateField,weeks:Array.from({length:total/7},(_,i)=>cells.slice(i*7,i*7+7)),
     totalEntries:[...byDay.values()].reduce((n,a)=>n+a.length,0)};
 }
 return {monthString,moveMonth,calendar};
});