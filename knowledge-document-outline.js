(function(root,factory){
"use strict";const value=factory();
if(typeof module==="object"&&module.exports)module.exports=value;
if(root)root.AmayurenaOutline=value;
})(typeof window!=="undefined"?window:null,function(){
"use strict";
function analyze(content){
 if(typeof content!=="string")throw Error("Неизвестный текст заметки.");
 const lines=content.replace(/\r\n/g,"\n").split("\n");
 const headings=[], seen=new Map();
 let fenced=false,fenceChar="",fenceSize=0,offset=0;
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  const fence=/^\s{0,3}(\x60{3,}|~{3,})/.exec(line);
  if(fence){
    if(!fenced){fenced=true;fenceChar=fence[1][0];fenceSize=fence[1].length;}
    else if(fence[1][0]===fenceChar&&fence[1].length>=fenceSize)fenced=false;
    offset+=line.length+1;continue;
  }
  if(!fenced){
    const hit=/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if(hit){
      const label=hit[2].trim();
      if(label){
        const raw=label.toLocaleLowerCase("ru").normalize("NFKC")
          .replace(/[^\p{L}\p{N}\s-]/gu,"").trim().replace(/\s+/g,"-").slice(0,100)||"раздел";
        const count=seen.get(raw)||0;seen.set(raw,count+1);
        headings.push({level:hit[1].length,title:label,line:index+1,offset,slug:count?raw+"-"+(count+1):raw});
      }
    }
  }
  offset+=line.length+1;
 }
 return {headings,lineCount:lines.length};
}
function lineOffset(content,line){
 if(!Number.isInteger(line)||line<1)throw Error("Неверная строка.");
 const lines=content.replace(/\r\n/g,"\n").split("\n");
 return lines.slice(0,line-1).reduce((total,text)=>total+text.length+1,0);
}
function progressToPixels(ratio,scrollHeight,clientHeight){
 return Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0))*Math.max(0,scrollHeight-clientHeight);
}
return {analyze,lineOffset,progressToPixels};
});