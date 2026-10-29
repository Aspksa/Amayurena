(function(){
  "use strict";
  const $=id=>document.getElementById(id);
  const state={data:null,catalog:null,neighborhood:false,page:0,folder:"",selected:"",request:0,catalogRequest:0,timelineRequest:0};
  const svgNS="http://www.w3.org/2000/svg";
  const node=(tag,cls,text)=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=text;
    return el;
  };
  const svg=(tag,attrs,parent)=>{
    const el=document.createElementNS(svgNS,tag);
    for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));
    parent.append(el);return el;
  };
  function status(value,bad=false){
    $("knowledge-insights-status").textContent=value;
    $("knowledge-insights-status").dataset.error=String(bad);
  }
  function open(path){
    if(window.AmayurenaKnowledge?.openNote)void window.AmayurenaKnowledge.openNote(path);
  }
  async function fetchJson(url,options){
    const response=await fetch(url,options);
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"HTTP "+response.status);
    return data;
  }
  function stat(label,value){
    const box=node("div","knowledge-insights-stat");
    box.append(node("strong","",String(value)),node("span","",label));return box;
  }
  function stats(){
    const data=state.data,target=$("knowledge-insights-stats");
    target.replaceChildren();
    for(const [label,value] of [
      ["Заметок",data.counts.analyzed],["Markdown-связей",data.counts.explicit],
      ["Связей Canvas",data.counts.canvas],["Предложений",data.counts.proposed],
      ["Проверить свойства",data.counts.differences]
    ])target.append(stat(label,value));
  }
  function rowButton(label,path){
    const b=node("button","knowledge-insights-note-link",label);b.type="button";
    b.title=path;b.addEventListener("click",()=>open(path));return b;
  }
  function lineDetails(link){
    if(link.kind==="wiki")return "Ссылка в "+link.provenance.source+": "+link.provenance.reference;
    return "Доска "+link.board+", карточки "+link.provenance.fromCard+" → "+link.provenance.toCard;
  }
  function noteDetails(path){
    const data=state.data,selected=data?.nodes.find(n=>n.path===path)||state.catalog?.nodes.find(n=>n.path===path);
    const target=$("knowledge-insights-detail-body");
    target.replaceChildren();
    if(!selected){$("knowledge-insights-detail-title").textContent="Выберите заметку";return;}
    $("knowledge-insights-detail-title").textContent=selected.title;
    const meta=node("div","knowledge-insights-meta");
    meta.append(node("p","","Источник: "+selected.path),
      node("p","","Изменено: "+new Date(selected.updatedAt).toLocaleString("ru-RU")),
      node("p","","Предыдущих версий: "+(selected.historyCount??"загрузите историю")),
      node("p","","Поля Bases: "+((selected.propertyKeys||[]).join(", ")||"не указаны")),
      node("p","","Метки: "+((selected.tags||[]).join(", ")||"нет")),
      node("p","","Доски: "+((selected.canvasBoards||[]).join(", ")||"нет")));
    target.append(meta,rowButton("Открыть заметку",selected.path));
    void showTimeline(path);
    const links=[...data.links,...(state.catalog?.links||[])].filter(l=>l.from===path||l.to===path);
    target.append(node("h5","","Подтверждённые связи ("+links.length+")"));
    if(!links.length)target.append(node("p","knowledge-insights-small","Пока нет сохранённых связей."));
    for(const l of links.slice(0,20)){
      const other=l.from===path?l.to:l.from;
      const item=node("div","knowledge-insights-relation");
      item.append(rowButton(other,other),node("small","",lineDetails(l)));
      target.append(item);
    }
    const proposed=data.suggestions.filter(s=>s.from===path||s.to===path);
    target.append(node("h5","","Предложенные связи ("+proposed.length+")"));
    for(const s of proposed.slice(0,12)){
      const other=s.from===path?s.to:s.from;
      const item=node("div","knowledge-insights-relation");
      item.append(rowButton(other,other),node("small","","Общие слова: "+s.sharedTerms.join(", ")));
      target.append(item);
    }
  }
  async function showTimeline(path){
    const target=$("knowledge-map-timeline"),token=++state.timelineRequest;
    target.replaceChildren(node("p","knowledge-insights-small","Читаю историю связей Markdown…"));
    try{
      const data=await fetchJson("/api/knowledge/map/timeline?path="+encodeURIComponent(path));
      if(token!==state.timelineRequest||state.selected!==path)return;
      target.replaceChildren(node("h5","","Хронология wiki-ссылок"));
      if(!data.events.length)target.append(node("p","knowledge-insights-small","Зафиксированных изменений связей нет."));
      for(const entry of data.events.slice(-20).reverse()){
        const div=node("div","knowledge-insights-relation");
        div.append(node("strong","",new Date(entry.at).toLocaleString("ru-RU")),
          node("small","","Добавлено: "+(entry.added.join(", ")||"—")+
            " · удалено: "+(entry.removed.join(", ")||"—")));
        target.append(div);
      }
      target.append(node("p","knowledge-insights-small",data.note));
    }catch(e){if(token===state.timelineRequest)target.replaceChildren(
      node("p","knowledge-insights-small","История недоступна: "+e.message));}
  }
  async function loadNeighbors(path){
    if(!path){status("Выберите заметку на карте.",true);return;}
    const token=++state.catalogRequest;
    status("Ищу входящие и исходящие wiki-ссылки по всем заметкам…");
    try{
      const graph=await fetchJson("/api/knowledge/map/neighbors?path="+encodeURIComponent(path)+"&limit=120");
      if(token!==state.catalogRequest)return;
      state.catalog=graph;
      state.neighborhood=true;
      state.selected=path;
      $("knowledge-map-folder").disabled=true;
      $("knowledge-map-prev").disabled=true;
      $("knowledge-map-next").disabled=true;
      $("knowledge-map-back").hidden=false;
      $("knowledge-map-page").textContent="Окружение заметки";
      $("knowledge-map-count").textContent=graph.counts.incoming+" входящих · "+graph.counts.outgoing+" исходящих";
      renderMap();noteDetails(path);
    }catch(e){if(token===state.catalogRequest)status("Связи недоступны: "+e.message,true);}
  }
  async function loadCatalog(){
    const token=++state.catalogRequest;
    const params=new URLSearchParams({
      folder:state.folder,q:$("knowledge-insights-search").value.trim(),
      page:String(state.page),size:"120"
    });
    try{
      const catalog=await fetchJson("/api/knowledge/map/catalog?"+params.toString());
      if(token!==state.catalogRequest)return;
      state.catalog=catalog;
      state.neighborhood=false;
      $("knowledge-map-folder").disabled=false;
      $("knowledge-map-back").hidden=true;
      const picker=$("knowledge-map-folder"),selected=state.folder;
      picker.replaceChildren();
      const first=node("option","","Все папки");first.value="";picker.append(first);
      for(const cluster of catalog.clusters){
        const opt=node("option","",cluster.name+" ("+cluster.count+")");
        opt.value=cluster.name;picker.append(opt);
      }
      picker.value=selected;
      $("knowledge-map-page").textContent="Страница "+(state.page+1)+" из "+Math.max(1,catalog.pages);
      $("knowledge-map-count").textContent=catalog.total+" заметок";
      $("knowledge-map-prev").disabled=state.page<=0;
      $("knowledge-map-next").disabled=state.page+1>=catalog.pages;
      if(!catalog.nodes.some(n=>n.path===state.selected))state.selected=catalog.nodes[0]?.path||"";
      renderMap();noteDetails(state.selected);
    }catch(e){
      if(token===state.catalogRequest)status("Каталог карты недоступен: "+e.message,true);
    }
  }
  function renderMap(){
    const data=state.data,root=$("knowledge-insights-graph");
    root.replaceChildren();
    if(!data)return;
    const query=state.neighborhood?"":$("knowledge-insights-search").value.trim().toLocaleLowerCase("ru");
    const kind=$("knowledge-insights-filter").value;
    const all=(state.catalog?.nodes||data.nodes).filter(n=>!query||
      (n.path+" "+(n.tags||[]).join(" ")).toLocaleLowerCase("ru").includes(query));
    const shown=all.slice(0,240);
    const ids=new Set(shown.map(n=>n.path));
    const cx=480,cy=310,rx=385,ry=235,coords=new Map();
    const center=state.neighborhood?state.catalog?.focus:null;
    const satellites=center?shown.filter(n=>n.path!==center):shown;
    if(center)coords.set(center,{x:cx,y:cy});
    satellites.forEach((n,i)=>{
      const angle=2*Math.PI*i/Math.max(1,satellites.length)-Math.PI/2;
      const layer=center?0.82:(shown.length===1?0:.45+.5*(i%3)/2);
      coords.set(n.path,{x:cx+Math.cos(angle)*rx*layer,y:cy+Math.sin(angle)*ry*layer});
    });
    const lines=[...data.links.filter(l=>kind==="all"||l.kind===kind),
      ...(state.catalog?.links||[]).filter(l=>kind==="all"||l.kind===kind),
      ...(kind==="all"||kind==="suggested"?data.suggestions.map(s=>({...s,kind:"suggested"})):[])];
    for(const l of lines){
      if(!ids.has(l.from)||!ids.has(l.to))continue;
      const a=coords.get(l.from),b=coords.get(l.to);
      svg("line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,
        stroke:l.kind==="wiki"?"#a47b41":l.kind==="canvas"?"#718cad":"#c2b5a3",
        "stroke-width":l.kind==="suggested"?1:2.2,
        "stroke-dasharray":l.kind==="suggested"?"5 6":"none",opacity:0.77},root);
    }
    for(const n of shown){
      const p=coords.get(n.path),g=svg("g",{tabindex:0,role:"button","aria-label":"Заметка "+n.title},root);
      g.classList.add("knowledge-insights-vertex");
      if(n.path===state.selected)g.classList.add("selected");
      svg("circle",{cx:p.x,cy:p.y,r:8,fill:n.path===state.selected?"#b7863a":"#e3c18d",
        stroke:"#86613a","stroke-width":1.5},g);
      if(shown.length<=85||shown.indexOf(n)%Math.ceil(shown.length/85)===0){
        const text=svg("text",{x:p.x+11,y:p.y-9,"font-size":12,fill:"#6e593c"},g);
        text.textContent=n.title.length>22?n.title.slice(0,19)+"…":n.title;
      }
      const tooltip=svg("title",{},g);tooltip.textContent=n.path;
      const select=()=>{state.selected=n.path;noteDetails(n.path);renderMap();};
      g.addEventListener("click",select);
      g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select();}});
    }
    if(!shown.length) {
      const t=svg("text",{x:480,y:310,"text-anchor":"middle","font-size":16,fill:"#927f68"},root);
      t.textContent="Нет заметок для отображения";
    }
    if(state.neighborhood){
      status("Прямые wiki-ссылки: "+state.catalog.counts.incoming+" входящих, "+
        state.catalog.counts.outgoing+" исходящих. Показано "+shown.length+
        " из "+state.catalog.total+" связанных заметок."+
        (state.catalog.truncated?" Часть окружения скрыта лимитом 120 узлов.":""));
    }else{
      status("Анализировано: "+data.counts.analyzed+" из "+data.counts.total+
        " заметок. На схеме показано "+shown.length+(all.length>shown.length?" из "+all.length:"")+
        ". "+data.method+(data.truncated?" Анализ сходства ограничен первыми 180 заметками.":""));
    }
  }
  async function confirmSuggestion(s,button){
    if(!confirm("Добавить wiki-ссылку из «"+s.from+"» в «"+s.to+
      "»? Исходная заметка будет изменена, предыдущая версия сохранится в истории."))return;
    button.disabled=true;
    try{
      if(window.AmayurenaKnowledge?.beforeInsightsWrite)
        await window.AmayurenaKnowledge.beforeInsightsWrite();
      await fetchJson("/api/knowledge/insights/accept",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({from:s.from,to:s.to,expectedSha:s.sourceSha,targetSha:s.targetSha})
      });
      if(window.AmayurenaKnowledge?.reloadInsightsSource)
        await window.AmayurenaKnowledge.reloadInsightsSource(s.from);
      await load();
      status("Связь добавлена после подтверждения. Источник: "+s.from);
    }catch(e){status("Связь не добавлена: "+e.message,true);button.disabled=false;}
  }
  function renderReview(){
    const data=state.data,suggest=$("knowledge-insights-suggestions"),warn=$("knowledge-insights-warnings");
    suggest.replaceChildren();warn.replaceChildren();
    if(!data.suggestions.length)suggest.append(node("p","knowledge-insights-small","Нет новых предложений по выбранному правилу сходства."));
    for(const s of data.suggestions.slice(0,35)){
      const row=node("div","knowledge-insights-review-row");
      row.append(node("strong","",s.from+" ↔ "+s.to),
        node("small","","Основание: "+s.sharedTerms.join(", ")+
          (s.sharedTags.length?" · метки: "+s.sharedTags.join(", "):"")+
          " · условное сходство: "+Math.round(s.score*100)+"%"));
      const action=node("button","btn btn-soft","Подтвердить связь");
      action.type="button";action.addEventListener("click",()=>{void confirmSuggestion(s,action);});
      row.append(action);suggest.append(row);
    }
    for(const d of data.disagreements.slice(0,20)){
      const item=node("div","knowledge-insights-review-row");
      item.append(node("strong","",d.from+" / "+d.to),
        node("small","","Отличается свойство «"+d.field+"». Требует проверки по исходным заметкам."));
      warn.append(item);
    }
    for(const link of (data.outside||[]).slice(0,12)){
      const item=node("div","knowledge-insights-review-row");
      item.append(node("strong","",link.from),
        node("small","","Ссылка ведёт на существующую заметку за пределами 180 анализируемых: "+link.to));
      warn.append(item);
    }
    for(const missing of data.missing.slice(0,20)){
      const item=node("div","knowledge-insights-review-row");
      item.append(node("strong","",missing.from),
        node("small","","Не найдена заметка: [["+missing.reference+"]]"));
      warn.append(item);
    }
    if(!warn.children.length)warn.append(node("p","knowledge-insights-small","Проверок пока нет."));
  }
  async function load(){
    const request=++state.request;
    status("Проверяю связи между заметками и досками Canvas…");
    try{
      const data=await fetchJson("/api/knowledge/insights");
      if(request!==state.request)return;
      state.data=data;
      if(!data.nodes.some(n=>n.path===state.selected))state.selected=data.nodes[0]?.path||"";
      stats();renderMap();noteDetails(state.selected);renderReview();
      void loadCatalog();
    }catch(e){if(request===state.request)status("Ошибка построения карты: "+e.message,true);}
  }
  $("knowledge-insights-tab").addEventListener("click",()=>{
    window.AmayurenaKnowledgeAdvanced.show("insights");
    void load();
  });
  $("knowledge-insights-refresh").addEventListener("click",()=>{void load();});
  let searchTimer=null;
  $("knowledge-insights-search").addEventListener("input",()=>{
    clearTimeout(searchTimer);state.page=0;
    searchTimer=setTimeout(()=>{void loadCatalog();},230);
  });
  $("knowledge-map-folder").addEventListener("change",e=>{
    state.folder=e.target.value;state.page=0;void loadCatalog();
  });
  $("knowledge-map-prev").addEventListener("click",()=>{
    if(state.page>0){state.page--;void loadCatalog();}
  });
  $("knowledge-map-next").addEventListener("click",()=>{
    if(state.catalog && state.page+1<state.catalog.pages){state.page++;void loadCatalog();}
  });
  $("knowledge-map-neighbors").addEventListener("click",()=>{void loadNeighbors(state.selected);});
  $("knowledge-map-back").addEventListener("click",()=>{void loadCatalog();});
  $("knowledge-insights-filter").addEventListener("change",renderMap);
  window.AmayurenaInsights={load};
})();
