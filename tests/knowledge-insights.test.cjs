"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const knowledge=require("../knowledge-core");
const advanced=require("../knowledge-advanced-core");
const insights=require("../knowledge-insights-core");
const {createServer}=require("../server");

function fixture(fn){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-map14-"));
  const spec={notes:path.join(base,"knowledge"),history:path.join(base,"history"),canvas:path.join(base,"canvas")};
  try{return fn(spec);}finally{fs.rmSync(base,{recursive:true,force:true});}
}
function seed(s){
  const a="---\ntags: [авто, ремонт]\nstatus: Планируется\n---\n# Обслуживание двигателя\nТопливо ремонт автомобиля двигатель диагностика обслуживание.";
  const b="---\ntags: [авто, ремонт]\nstatus: Выполнено\n---\n# Ремонт двигателя\nТопливо ремонт автомобиля двигатель диагностика обслуживание.";
  const c="# Несвязанная тема\nРисование цветочная композиция акварель галерея живопись.";
  knowledge.create(s.notes,"Гараж/Двигатель.md",a);
  knowledge.create(s.notes,"Гараж/Ремонт.md",b);
  knowledge.create(s.notes,"Искусство.md",c);
  return {a,b,c};
}
test("source-grounded analysis combines Markdown, Bases properties, Canvas references and history",()=>fixture(s=>{
  seed(s);
  advanced.saveNote(s.notes,s.history,"Гараж/Двигатель.md",
    knowledge.read(s.notes,"Гараж/Двигатель.md").content+"\nДополнение");
  advanced.saveCanvas(s.canvas,"Автосервис",{
    nodes:[{id:"n1",type:"file",file:"Гараж/Двигатель.md",x:10,y:15},
      {id:"n2",type:"file",file:"Искусство.md",x:280,y:60}],
    edges:[{from:"n1",to:"n2"}]
  });
  const data=insights.analyze(s.notes,s.canvas,s.history);
  assert.equal(data.counts.analyzed,3);
  assert.equal(data.counts.canvas,1);
  assert.equal(data.counts.boards,1);
  assert.equal(data.counts.explicit,0);
  assert.ok(data.suggestions.some(x=>x.from==="Гараж/Двигатель.md"&&x.to==="Гараж/Ремонт.md"));
  const item=data.nodes.find(n=>n.path==="Гараж/Двигатель.md");
  assert.ok(item.canvasBoards.includes("Автосервис"));
  assert.equal(item.historyCount,1);
  assert.ok(item.propertyKeys.includes("status"));
  assert.ok(item.tags.includes("авто"));
  assert.ok(data.disagreements.some(d=>d.field==="status"));
  assert.equal(knowledge.read(s.notes,"Гараж/Двигатель.md").content.includes("[[Гараж/Ремонт]]"),false);
  assert.match(data.method,/не ИИ/);
}));
test("explicit Markdown links have exact provenance, and existing links suppress speculative proposals",()=>fixture(s=>{
  seed(s);
  const text=knowledge.read(s.notes,"Гараж/Двигатель.md").content+"\n[[Гараж/Ремонт]]";
  knowledge.save(s.notes,"Гараж/Двигатель.md",text);
  const data=insights.analyze(s.notes,s.canvas,s.history);
  const edge=data.links.find(x=>x.kind==="wiki"&&x.from==="Гараж/Двигатель.md");
  assert.equal(edge.to,"Гараж/Ремонт.md");
  assert.equal(edge.provenance.source,"Гараж/Двигатель.md");
  assert.equal(edge.provenance.reference,"[[Гараж/Ремонт]]");
  assert.equal(data.suggestions.some(x=>x.from==="Гараж/Двигатель.md"&&x.to==="Гараж/Ремонт.md"),false);
  assert.deepEqual(data.nodes.filter(n=>n.title==="Искусство").map(n=>n.path),["Искусство.md"]);
}));
test("broken and ambiguous references are reported, not silently assigned to unrelated notes",()=>fixture(s=>{
  knowledge.create(s.notes,"Folder1/Повтор.md","# Общая заметка");
  knowledge.create(s.notes,"Folder2/Повтор.md","# Другая заметка");
  knowledge.create(s.notes,"Main.md","[[Повтор]] и [[Несуществующая]]");
  const data=insights.analyze(s.notes,s.canvas,s.history);
  assert.equal(data.links.length,0);
  assert.ok(data.missing.some(x=>x.reference==="Повтор"&&x.from==="Main.md"));
  assert.ok(data.missing.some(x=>x.reference==="Несуществующая"));
}));
test("notes outside analysis limit are not mislabeled as missing links",()=>fixture(s=>{
  for(let i=0;i<181;i++)knowledge.create(s.notes,
    "Тема "+String(i).padStart(3,"0")+".md","# Тема "+i);
  knowledge.save(s.notes,"Тема 000.md","# Первая тема\n[[Тема 180]]");
  const data=insights.analyze(s.notes,s.canvas,s.history);
  assert.equal(data.truncated,true);
  assert.ok(data.outside.some(e=>e.from==="Тема 000.md"&&e.to==="Тема 180.md"));
  assert.equal(data.missing.some(e=>e.reference==="Тема 180"),false);
});
test("approve suggestion adds one valid wiki-link and saves original note in history",()=>fixture(s=>{
  seed(s);
  const from="Гараж/Двигатель.md",to="Гараж/Ремонт.md";
  const first=knowledge.read(s.notes,from).content;
  const result=insights.accept(s.notes,s.history,s.canvas,{from,to,expectedSha:insights.sha(first),targetSha:insights.sha(knowledge.read(s.notes,to).content)});
  assert.equal(result.saved,true);
  assert.match(knowledge.read(s.notes,from).content,/\[\[Гараж\/Ремонт\]\]/);
  const versions=advanced.history(s.history,from);
  assert.equal(versions.length,1);
  assert.equal(advanced.readVersion(s.history,from,versions[0].id).content,first);
  assert.throws(()=>insights.accept(s.notes,s.history,s.canvas,{from,to,expectedSha:insights.sha(first),targetSha:insights.sha(knowledge.read(s.notes,to).content)}),{status:409});
  assert.equal(advanced.history(s.history,from).length,1);
}));
test("stale approvals, unknown and self links are rejected without modifying notes",()=>fixture(s=>{
  const {a}=seed(s);
  const from="Гараж/Двигатель.md";
  const stale=insights.sha(a);
  knowledge.save(s.notes,from,a+"\nИзменение другого окна");
  const latest=knowledge.read(s.notes,from).content;
  assert.throws(()=>insights.accept(s.notes,s.history,s.canvas,{
    from,to:"Гараж/Ремонт.md",expectedSha:stale,targetSha:insights.sha(knowledge.read(s.notes,"Гараж/Ремонт.md").content)}),{status:409});
  assert.throws(()=>insights.accept(s.notes,s.history,s.canvas,{
    from,to:from,expectedSha:insights.sha(latest),targetSha:insights.sha(latest)}),{status:400});
  assert.throws(()=>insights.accept(s.notes,s.history,s.canvas,{
    from,to:"../unknown.md",expectedSha:insights.sha(latest),targetSha:insights.sha(latest)}),{status:400});
  assert.equal(knowledge.read(s.notes,from).content,latest);
}));
test("approval rejects a changed target note even if source remains unchanged",()=>fixture(s=>{
  seed(s);
  const from="Гараж/Двигатель.md",to="Гараж/Ремонт.md";
  const source=knowledge.read(s.notes,from).content;
  const oldTarget=knowledge.read(s.notes,to).content;
  knowledge.save(s.notes,to,oldTarget+"\nНовый факт от другого редактора.");
  assert.throws(()=>insights.accept(s.notes,s.history,s.canvas,{
    from,to,expectedSha:insights.sha(source),targetSha:insights.sha(oldTarget)
  }),{status:409});
  assert.equal(knowledge.read(s.notes,from).content,source);
  assert.equal(advanced.history(s.history,from).length,0);
}));
test("empty vault and bounded analysis remain deterministic with no writes",()=>fixture(s=>{
  const empty=insights.analyze(s.notes,s.canvas,s.history);
  assert.deepEqual(empty.nodes,[]);
  assert.deepEqual(empty.suggestions,[]);
  for(let i=0;i<183;i++){
    const name="Заметка "+String(i).padStart(3,"0")+".md";
    knowledge.create(s.notes,name,"# "+name+"\nОдин непохожий тематический текст.");
  }
  const data=insights.analyze(s.notes,s.canvas,s.history);
  assert.equal(data.nodes.length,180);
  assert.equal(data.counts.total,183);
  assert.equal(data.truncated,true);
}));
test("HTTP endpoints are local only and do not expose core sources",async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-map-http14-"));
  const server=createServer({env:{},knowledgeDirectory:path.join(base,"knowledge"),
    knowledgeHistoryDirectory:path.join(base,"history"),knowledgeCanvasDirectory:path.join(base,"canvas")});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+server.address().port;
  const post=(url,body,from)=>fetch(origin+url,{
    method:"POST",headers:{"Content-Type":"application/json",...(from?{Origin:from}:{})},
    body:JSON.stringify(body)
  });
  try{
    const root=path.join(base,"knowledge"),canvas=path.join(base,"canvas");
    seed({notes:root});
    let r=await fetch(origin+"/api/knowledge/insights");assert.equal(r.status,200);
    const data=await r.json(),candidate=data.suggestions[0];
    assert.ok(candidate);
    r=await post("/api/knowledge/insights/accept",{
      from:candidate.from,to:candidate.to,expectedSha:candidate.sourceSha,targetSha:candidate.targetSha
    },"https://external.example");
    assert.equal(r.status,403);
    r=await post("/api/knowledge/insights/accept",{
      from:candidate.from,to:candidate.to,expectedSha:candidate.sourceSha,targetSha:candidate.targetSha
    });
    assert.equal(r.status,200);
    r=await fetch(origin+"/api/knowledge/insights");
    assert.equal((await r.json()).counts.explicit,1);
    r=await fetch(origin+"/knowledge-insights.js");assert.equal(r.status,200);
    r=await fetch(origin+"/knowledge-insights-core.js");assert.equal(r.status,404);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(base,{recursive:true,force:true});
  }
});
test("UI exposes a separate living-map mode and source review controls",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const advancedJs=fs.readFileSync(path.join(__dirname,"..","knowledge-advanced.js"),"utf8");
  for(const id of ["knowledge-insights-tab","knowledge-insights-panel","knowledge-insights-graph",
    "knowledge-insights-suggestions","knowledge-insights-detail-body","knowledge-insights-refresh"])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(advancedJs,/mode !== "insights"/);
  assert.match(html,/knowledge-insights\.js/);
});
