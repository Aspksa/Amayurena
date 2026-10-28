(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const config = { notes: [], active: "", columns: [], rows: [], callbacks: {}, initialized: false };
  const canvas = { name: "", board: null, boards: [], queue: Promise.resolve(), navigation: Promise.resolve(),
    dirty: 0, saved: 0, connecting: "", timer: null, sha: null, zoom: 1, transitioning: false,
    history: null, selected: new Set(), grid: false, dragging: false };
  let historyToken = 0;
  const basesState = { types: {}, views: [], sha: "", currentView: "", busy: false };
  const basesTypes = ["text", "number", "date", "checkbox", "select", "tags"];
  const basesBuiltin = ["title", "folder", "updatedAt"];
  const basesReserved = new Set(["title", "folder", "updatedAt"]);


  async function api(endpoint, body, method) {
    const options = body === undefined ? { method: method || "GET" } : {
      method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    };
    const r = await fetch(endpoint, options);
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "HTTP " + r.status);
    return out;
  }
  const query = (endpoint, key, value) => endpoint + "?" + key + "=" + encodeURIComponent(value);
  const error = text => { $("knowledge-status").textContent = text; $("knowledge-status").dataset.error = "true"; };
  const info = text => { $("knowledge-status").textContent = text; $("knowledge-status").dataset.error = "false"; };

  async function renderHistory() {
    const token = ++historyToken;
    const panel = $("knowledge-history");
    panel.replaceChildren();
    if (!config.active) {
      panel.append(mk("p", "knowledge-placeholder", "Выберите заметку."));
      return;
    }
    try {
      const data = await api(query("/api/knowledge/history", "path", config.active));
      if (token !== historyToken) return;
      const versions = data.versions || [];
      if (!versions.length) panel.append(mk("p", "knowledge-placeholder", "Предыдущих версий пока нет."));
      for (const version of versions) {
        const row = mk("div", "knowledge-version");
        const at = new Date(version.at).toLocaleString("ru-RU");
        row.append(mk("span", "", at + " · " + version.bytes + " Б"));
        const view = mk("button", "btn btn-small btn-soft", "Просмотр");
        view.type = "button";
        view.addEventListener("click", async () => {
          try {
            const uri = query("/api/knowledge/history/version", "path", config.active) + "&id=" + encodeURIComponent(version.id);
            const record = await api(uri);
            $("knowledge-history-content").value = record.content;
            $("knowledge-history-dialog").showModal();
          } catch (e) { error(e.message); }
        });
        const restore = mk("button", "btn btn-small btn-soft", "Вернуть");
        restore.type = "button";
        restore.addEventListener("click", async () => {
          const note = config.active;
          if (!confirm("Восстановить состояние заметки «" + note + "» на " + at + "? Текущая версия будет сохранена в истории.")) return;
          try {
            await config.callbacks.beforeRestore();
            await api("/api/knowledge/history/restore", { path: note, id: version.id });
            await config.callbacks.onReload(note);
            await renderHistory();
            info("Версия восстановлена; предыдущая сохранена в истории.");
          } catch (e) { error("Не удалось восстановить: " + e.message); }
        });
        row.append(view, restore); panel.append(row);
      }
    } catch (e) { if (token === historyToken) error("История: " + e.message); }
  }

  function show(mode) {
    $("knowledge-editor-panel").hidden = mode !== "editor" || !config.active;
    $("knowledge-graph-panel").hidden = mode !== "graph";
    $("knowledge-canvas-panel").hidden = mode !== "canvas";
    $("knowledge-bases-panel").hidden = mode !== "bases";
    $("knowledge-insights-panel").hidden = mode !== "insights";
    $("knowledge-inspector").hidden = mode === "canvas" || mode === "bases" || mode === "insights";
    for (const item of document.querySelectorAll("[data-knowledge-mode]")) {
      item.classList.toggle("knowledge-active-tab", item.dataset.knowledgeMode === mode);
    }
    if (mode === "canvas") void openCanvas();
    if (mode === "bases") void loadBases();
  }

  async function update(notes, active) {
    config.notes = notes;
    if (active !== config.active) {
      config.active = active;
      void renderHistory();
    } else if (active) void renderHistory();
  }

  const layout = window.AmayurenaCanvasLayout;
  const canvasExtra = window.AmayurenaCanvasEnhance;
  function canvasStatus(text) { $("knowledge-canvas-status").textContent = text; }
  const viewport = () => $("knowledge-canvas-viewport");
  function canvasSave() {
    clearTimeout(canvas.timer);
    if (!canvas.board || canvas.dirty <= canvas.saved) return canvas.queue;
    const board = canvas.board, name = canvas.name, revision = canvas.dirty;
    const data = JSON.parse(JSON.stringify(board));
    canvas.queue = canvas.queue.catch(() => {}).then(async () => {
      if (canvas.board !== board || canvas.name !== name || revision <= canvas.saved) return;
      const result = await api("/api/knowledge/canvas", { name, board: data, expectedSha: canvas.sha });
      canvas.sha = result.sha;
      canvas.saved = Math.max(canvas.saved, revision);
      canvasStatus(canvas.dirty > canvas.saved ? "На доске есть новые несохранённые изменения." : "Доска сохранена на диске.");
    });
    return canvas.queue;
  }
  async function flushCanvas() {
    clearTimeout(canvas.timer);
    while (canvas.board && canvas.dirty > canvas.saved) {
      try { await canvasSave(); }
      catch (e) {
        canvasStatus("Сохранение не выполнено: " + e.message + ". Переключение заблокировано.");
        throw e;
      }
    }
    await canvas.queue;
  }
  function renderHistoryButtons(){
    $("knowledge-canvas-undo").disabled=!canvas.history?.canUndo();
    $("knowledge-canvas-redo").disabled=!canvas.history?.canRedo();
    $("knowledge-canvas-copy").disabled=!canvas.board || !canvas.selected.size;
  }
  function undoCanvas(){
    if(!canvas.board||canvas.transitioning)return;
    const prev=canvas.history?.undo();
    if(!prev)return;
    canvas.board=prev;canvasChanged(false);renderCanvas();
  }
  function redoCanvas(){
    if(!canvas.board||canvas.transitioning)return;
    const next=canvas.history?.redo();
    if(!next)return;
    canvas.board=next;canvasChanged(false);renderCanvas();
  }
  function selectAllCanvas(){
    if(!canvas.board)return;
    canvas.selected=new Set(canvas.board.nodes.map(n=>n.id));
    renderCanvas();
  }
  function copyCanvas(){
    if(!canvas.board||canvas.transitioning)return;
    try{
      const output=canvasExtra.copySelected(canvas.board,[...canvas.selected],
        ()=>uid("copy"));
      canvas.board=output.board;
      canvas.selected=new Set(output.ids);
      if(output.ids.length)canvasChanged();
      renderCanvas();
      if(output.ids.length)canvasStatus("Карточки скопированы: "+output.ids.length);
    }catch(e){canvasStatus(e.message);}
  }
  function canvasChanged(record = true) {
    if(record&&canvas.history)canvas.history.record(canvas.board);
    canvas.dirty++;
    renderHistoryButtons();
    canvasStatus("Изменения доски ожидают сохранения…");
    clearTimeout(canvas.timer);
    canvas.timer = setTimeout(() => {
      void canvasSave().catch(e => canvasStatus("Не удалось сохранить: " + e.message + ". Повторите сохранение."));
    }, 550);
    renderMinimap();
  }
  function uid(prefix = "n") { return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10); }
  function groupAt(id) { return (canvas.board.groups || []).find(g => g.id === id); }
  function drawEdges() {
    const layer = $("knowledge-canvas-edges");
    layer.replaceChildren();
    if (!canvas.board) return;
    const byId = new Map(canvas.board.nodes.map(n => [n.id, n]));
    for (const edge of canvas.board.edges) {
      const a = byId.get(edge.from), b = byId.get(edge.to);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const attrs = { x1: a.x + 110, y1: a.y + 62, x2: b.x + 110, y2: b.y + 62,
        stroke: "#b79760", "stroke-width": "3", "stroke-linecap": "round" };
      for (const [key, value] of Object.entries(attrs)) line.setAttribute(key, String(value));
      layer.append(line);
    }
  }
  function storeZoom() {
    if (!canvas.name) return;
    try { localStorage.setItem("amayu.canvas.zoom." + encodeURIComponent(canvas.name), String(canvas.zoom)); }
    catch (_) { /* zoom preference is optional */ }
  }
  function setZoom(value, preserveCenter = true) {
    const scroller = viewport(), old = canvas.zoom;
    const target = layout.zoom(value);
    const dimensions = preserveCenter ?
      layout.viewAt(old,target,scroller.scrollLeft,scroller.scrollTop,scroller.clientWidth,scroller.clientHeight) :
      { zoom:target,left:scroller.scrollLeft,top:scroller.scrollTop };
    canvas.zoom = target;
    const space = $("knowledge-canvas-space");
    space.style.width = layout.WIDTH * target + "px";
    space.style.height = layout.HEIGHT * target + "px";
    const surface = space.querySelector(".knowledge-canvas-surface");
    surface.style.transform = "scale(" + target + ")";
    scroller.scrollLeft = dimensions.left;
    scroller.scrollTop = dimensions.top;
    $("knowledge-canvas-zoom-label").textContent = Math.round(target*100) + "%";
    storeZoom();
    renderMinimap();
  }
  function svgRect(parent, attrs) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [key,value] of Object.entries(attrs)) rect.setAttribute(key, String(value));
    parent.append(rect);
  }
  function renderMinimap() {
    const svg = $("knowledge-canvas-minimap"), scroller=viewport();
    svg.replaceChildren();
    svgRect(svg,{x:0,y:0,width:200,height:150,fill:"#fbf6ea"});
    if (canvas.board) {
      for (const g of canvas.board.groups || []) svgRect(svg,{
        x:g.x/layout.WIDTH*200,y:g.y/layout.HEIGHT*150,
        width:g.width/layout.WIDTH*200,height:g.height/layout.HEIGHT*150,
        fill:"#e8d2a9",stroke:"#c7a16d","stroke-width":0.7,rx:2
      });
      for (const n of canvas.board.nodes) svgRect(svg,{
        x:n.x/layout.WIDTH*200,y:n.y/layout.HEIGHT*150,
        width:layout.CARD_W/layout.WIDTH*200,height:layout.CARD_H/layout.HEIGHT*150,
        fill:n.type==="file"?"#9c9bba":"#bb9150",rx:1
      });
    }
    const box=layout.minimapRect(scroller.scrollLeft,scroller.scrollTop,
      scroller.clientWidth,scroller.clientHeight,canvas.zoom);
    svgRect(svg,{x:box.x,y:box.y,width:box.width,height:box.height,
      fill:"none",stroke:"#7d482a","stroke-width":2,"pointer-events":"none"});
  }
  function panTo(x,y) {
    const scroller=viewport();
    scroller.scrollLeft=layout.clamp(x*canvas.zoom-scroller.clientWidth/2,0,
      Math.max(0,layout.WIDTH*canvas.zoom-scroller.clientWidth));
    scroller.scrollTop=layout.clamp(y*canvas.zoom-scroller.clientHeight/2,0,
      Math.max(0,layout.HEIGHT*canvas.zoom-scroller.clientHeight));
    renderMinimap();
  }
  function fitBoard() {
    if (!canvas.board) { setZoom(1); return; }
    const elements=[...canvas.board.nodes.map(n=>({x:n.x,y:n.y,width:layout.CARD_W,height:layout.CARD_H})),
      ...(canvas.board.groups||[])];
    if (!elements.length) { setZoom(1);panTo(350,250);return; }
    const minX=Math.min(...elements.map(x=>x.x)),maxX=Math.max(...elements.map(x=>x.x+x.width));
    const minY=Math.min(...elements.map(x=>x.y)),maxY=Math.max(...elements.map(x=>x.y+x.height));
    const scroller=viewport();
    setZoom(Math.min((scroller.clientWidth-55)/(maxX-minX+40),
      (scroller.clientHeight-55)/(maxY-minY+40),1.7));
    panTo((minX+maxX)/2,(minY+maxY)/2);
  }
  function connect(id) {
    if (canvas.transitioning) return;
    if (!canvas.connecting) { canvas.connecting=id; canvasStatus("Выберите вторую карточку для связи.");return; }
    const from=canvas.connecting;canvas.connecting="";
    if (from===id) { canvasStatus("Свяжите две разные карточки.");return; }
    if (canvas.board.edges.length>=120) { canvasStatus("Максимум 120 связей.");return; }
    if (!canvas.board.edges.some(e=>e.from===from && e.to===id)) {
      canvas.board.edges.push({from,to:id});canvasChanged();renderCanvas();
    }
  }
  function drag(handle, record, movingGroup=false) {
    handle.addEventListener("pointerdown", event=>{
      if (canvas.transitioning || event.button!==0) return;
      event.preventDefault();
      const pointer=event.pointerId,sx=event.clientX,sy=event.clientY;
      const x=record.x,y=record.y;
      const members=movingGroup ? canvas.board.nodes.filter(n=>n.groupId===record.id).map(n=>({node:n,x:n.x,y:n.y})) : [];
      let moved=false;
      canvas.dragging=true;
      handle.setPointerCapture(pointer);
      const motion=e=>{
        if (e.pointerId!==pointer) return;
        const dx=Math.round((e.clientX-sx)/canvas.zoom),dy=Math.round((e.clientY-sy)/canvas.zoom);
        const nx=layout.clamp(x+dx,0,movingGroup?layout.WIDTH-record.width:3200);
        const ny=layout.clamp(y+dy,0,movingGroup?layout.HEIGHT-record.height:2400);
        if (nx===record.x && ny===record.y) return;
        record.x=canvas.grid?layout.clamp(canvasExtra.snap(nx),0,movingGroup?layout.WIDTH-record.width:3200):nx;
        record.y=canvas.grid?layout.clamp(canvasExtra.snap(ny),0,movingGroup?layout.HEIGHT-record.height:2400):ny;
        moved=true;
        const shiftX=record.x-x,shiftY=record.y-y;
        for (const member of members) {
          member.node.x=layout.clamp(member.x+shiftX,0,3200);
          member.node.y=layout.clamp(member.y+shiftY,0,2400);
        }
        renderPositions();drawEdges();renderMinimap();
      };
      const finish=e=>{
        if (e.pointerId!==pointer)return;
        handle.removeEventListener("pointermove",motion);
        handle.removeEventListener("pointerup",finish);
        handle.removeEventListener("pointercancel",finish);
        if (handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);
        canvas.dragging=false;
        if (moved)canvasChanged();
      };
      handle.addEventListener("pointermove",motion);
      handle.addEventListener("pointerup",finish);
      handle.addEventListener("pointercancel",finish);
    });
  }
  function renderPositions() {
    const byId=new Map(canvas.board.nodes.map(n=>[n.id,n]));
    for (const el of $("knowledge-canvas-nodes").children) {
      const item=byId.get(el.dataset.id);
      if (item){el.style.left=item.x+"px";el.style.top=item.y+"px";}
    }
    const groups=new Map(canvas.board.groups.map(g=>[g.id,g]));
    for (const el of $("knowledge-canvas-groups").children) {
      const item=groups.get(el.dataset.id);
      if (item){el.style.left=item.x+"px";el.style.top=item.y+"px";}
    }
  }
  function groupCard(node) {
    if (canvas.transitioning) return;
    const choices=canvas.board.groups.map(g=>g.label).join(", ");
    if (!canvas.board.groups.length) {canvasStatus("Создайте группу кнопкой «＋ Группа».");return;}
    const current=groupAt(node.groupId);
    const result=prompt("Выберите группу по названию: "+choices+". Пусто — убрать из группы.",current?.label||"");
    if (result===null)return;
    const label=result.trim();
    if (!label) delete node.groupId;
    else {
      const g=canvas.board.groups.find(item=>item.label.toLocaleLowerCase("ru")===label.toLocaleLowerCase("ru"));
      if (!g) {canvasStatus("Группа с таким названием не найдена.");return;}
      node.groupId=g.id;
      const members=canvas.board.nodes.filter(n=>n.groupId===g.id);
      const i=members.indexOf(node);
      node.x=layout.clamp(g.x+20+(i%3)*245,0,3200);
      node.y=layout.clamp(g.y+52+Math.floor(i/3)*165,0,2400);
    }
    canvasChanged();renderCanvas();
  }
  function renderCanvas() {
    const container=$("knowledge-canvas-nodes"), groups=$("knowledge-canvas-groups");
    container.replaceChildren();groups.replaceChildren();
    if (!canvas.board){drawEdges();renderMinimap();return;}
    for (const g of canvas.board.groups || []) {
      const element=mk("section","knowledge-canvas-group knowledge-canvas-group-"+g.tone);
      element.dataset.id=g.id;
      element.style.left=g.x+"px";element.style.top=g.y+"px";
      element.style.width=g.width+"px";element.style.height=g.height+"px";
      const heading=mk("div","knowledge-canvas-group-heading");
      const grip=mk("span","knowledge-canvas-group-grip","⋮⋮ "+g.label);
      grip.title="Переместить группу с карточками";
      drag(grip,g,true);
      const rename=mk("button","","✎");rename.type="button";rename.title="Переименовать группу";
      rename.addEventListener("click",()=>{
        const name=prompt("Название группы:",g.label);
        if (name===null)return;
        if (!name.trim()||name.trim().length>70){canvasStatus("Название от 1 до 70 символов.");return;}
        g.label=name.trim();canvasChanged();renderCanvas();
      });
      const del=mk("button","","×");del.type="button";del.title="Удалить группу, сохранив карточки";
      del.addEventListener("click",()=>{
        if (!confirm("Убрать группу «"+g.label+"»? Карточки сохранятся."))return;
        canvas.board.groups=canvas.board.groups.filter(item=>item.id!==g.id);
        for (const n of canvas.board.nodes)if(n.groupId===g.id)delete n.groupId;
        canvasChanged();renderCanvas();
      });
      heading.append(grip,rename,del);element.append(heading);groups.append(element);
    }
    const sc=viewport(),hasViewport=sc.clientWidth>0&&sc.clientHeight>0;
    const left=sc.scrollLeft/canvas.zoom-360,top=sc.scrollTop/canvas.zoom-290;
    const right=left+sc.clientWidth/canvas.zoom+720,bottom=top+sc.clientHeight/canvas.zoom+580;
    for (const record of canvas.board.nodes) {
      if(hasViewport&&(record.x>right||record.x+layout.CARD_W<left||
        record.y>bottom||record.y+layout.CARD_H<top))continue;
      const card=mk("article","knowledge-canvas-node"+(canvas.selected.has(record.id)?" selected":""));
      card.dataset.id=record.id;
      card.addEventListener("click",e=>{
        if(e.target.closest("button")||e.target.classList.contains("knowledge-canvas-grip"))return;
        if(e.ctrlKey||e.metaKey){
          if(canvas.selected.has(record.id))canvas.selected.delete(record.id);
          else canvas.selected.add(record.id);
        }else canvas.selected=new Set([record.id]);
        renderHistoryButtons();renderCanvas();
      });
      card.style.left=record.x+"px";card.style.top=record.y+"px";
      const handle=mk("div","knowledge-canvas-grip","⋮⋮ Переместить");
      card.append(handle);drag(handle,record);
      card.append(mk("div","knowledge-canvas-text",record.type==="file"?"◇ "+record.file:record.text));
      const buttons=mk("div","knowledge-canvas-card-actions");
      function btn(label,callback){const b=mk("button","",label);b.type="button";b.addEventListener("click",callback);buttons.append(b);}
      if(record.type==="file")btn("Открыть",()=>{void config.callbacks.onNoteOpen(record.file);});
      if(record.type==="text")btn("Изменить",()=>{
        if (canvas.transitioning)return;
        const changed=prompt("Текст карточки:",record.text);
        if(changed===null)return;
        if(changed.length>2500){canvasStatus("Максимум 2500 символов.");return;}
        record.text=changed;canvasChanged();renderCanvas();
      });
      btn(groupAt(record.groupId)?"Группа: "+groupAt(record.groupId).label:"В группу",()=>groupCard(record));
      btn("Связать",()=>connect(record.id));
      btn("×",()=>{
        if(canvas.transitioning||!confirm("Удалить карточку и её связи?"))return;
        canvas.board.nodes=canvas.board.nodes.filter(n=>n.id!==record.id);
        canvas.board.edges=canvas.board.edges.filter(e=>e.from!==record.id&&e.to!==record.id);
        canvasChanged();renderCanvas();
      });
      card.append(buttons);container.append(card);
    }
    drawEdges();renderMinimap();
  }
  async function listBoards() {
    const data=await api("/api/knowledge/canvases");
    canvas.boards=data.boards||[];
    const select=$("knowledge-canvas-select");
    select.replaceChildren();
    const placeholder=mk("option","","Выберите доску");placeholder.value="";select.append(placeholder);
    for (const item of canvas.boards) {
      const opt=mk("option","",item.name);opt.value=item.name;select.append(opt);
    }
    select.value=canvas.name;
  }
  async function loadDirect(name) {
    const loaded=name ? await api(query("/api/knowledge/canvas","name",name)) : null;
    canvas.name=name;
    canvas.board=loaded?{nodes:loaded.nodes,edges:loaded.edges,groups:loaded.groups||[]}:null;
    canvas.sha=loaded?loaded.sha:null;
    canvas.dirty=0;canvas.saved=0;canvas.connecting="";
    canvas.history=canvas.board?canvasExtra.timeline(canvas.board):null;
    canvas.selected=new Set();renderHistoryButtons();
    $("knowledge-canvas-select").value=name;
    let savedZoom=1;
    try { savedZoom=Number(localStorage.getItem("amayu.canvas.zoom."+encodeURIComponent(name)))||1; }catch(_){}
    setZoom(savedZoom,false);renderCanvas();
    if (canvas.board && (canvas.board.groups.length || canvas.board.nodes.length)) {
      const first=canvas.board.groups[0] || canvas.board.nodes[0];
      panTo(first.x+110,first.y+80);
    } else panTo(380,270);
    canvasStatus(name?"Доска «"+name+"» загружена.":"Создайте доску Canvas.");
  }
  function navigateCanvas(fn) {
    canvas.navigation=canvas.navigation.catch(()=>{}).then(async()=>{
      canvas.transitioning=true;
      try {await flushCanvas();return await fn();}
      catch(e){
        $("knowledge-canvas-select").value=canvas.name;
        canvasStatus("Операция отменена: "+e.message+". Несохранённая доска осталась открытой.");
        return false;
      } finally {canvas.transitioning=false;}
    });
    return canvas.navigation;
  }
  function loadBoard(name) {return navigateCanvas(()=>loadDirect(name));}
  function openCanvas() {
    return navigateCanvas(async()=>{
      await listBoards();
      if(!canvas.board&&canvas.boards.length)await loadDirect(canvas.boards[0].name);
    });
  }
  async function createBoard() {
    const requested=prompt("Название новой доски Canvas:");
    if(requested===null||!requested.trim())return;
    const name=requested.trim();
    await navigateCanvas(async()=>{
      if(canvas.boards.some(b=>b.name.toLocaleLowerCase("ru")===name.toLocaleLowerCase("ru"))){
        throw Error("Доска уже существует.");
      }
      const initial=canvasExtra.template($("knowledge-canvas-template").value);
      await api("/api/knowledge/canvas",{name,board:initial,expectedSha:null});
      await listBoards();await loadDirect(name);
    });
  }
  function deleteBoard() {
    if(!canvas.name||!confirm("Удалить доску Canvas «"+canvas.name+"»?"))return Promise.resolve();
    return navigateCanvas(async()=>{
      const name=canvas.name;
      await api(query("/api/knowledge/canvas","name",name)+"&expectedSha="+encodeURIComponent(canvas.sha),
        undefined,"DELETE");
      canvas.board=null;canvas.name="";canvas.sha=null;canvas.dirty=0;canvas.saved=0;
      await listBoards();renderCanvas();
      canvasStatus("Доска удалена.");
    });
  }
  function addNode(type) {
    if(!canvas.board||canvas.transitioning){canvasStatus("Сначала создайте доску.");return;}
    if(canvas.board.nodes.length>=60){canvasStatus("Максимум 60 карточек.");return;}
    let value=type==="text"?prompt("Текст карточки Canvas:"):
      prompt("Путь существующей заметки:",config.notes[0]?.path||"");
    if(value===null||!value.trim())return;
    value=value.trim();
    if(type==="text"&&value.length>2500){canvasStatus("Максимум 2500 символов.");return;}
    if(type==="file"&&!config.notes.some(n=>n.path===value)){canvasStatus("Заметка не найдена.");return;}
    const scroller=viewport();
    const index=canvas.board.nodes.length;
    const record={id:uid(),type,x:layout.clamp(Math.round(scroller.scrollLeft/canvas.zoom+50+(index%3)*250),0,3200),
      y:layout.clamp(Math.round(scroller.scrollTop/canvas.zoom+50+Math.floor(index%3)*170),0,2400)};
    if(type==="text")record.text=value;else record.file=value;
    canvas.board.nodes.push(record);canvasChanged();renderCanvas();
  }
  function addGroup() {
    if(!canvas.board||canvas.transitioning){canvasStatus("Выберите доску.");return;}
    if(canvas.board.groups.length>=20){canvasStatus("Максимум 20 групп.");return;}
    const value=prompt("Название новой группы:");
    if(value===null||!value.trim())return;
    const label=value.trim();
    if(label.length>70){canvasStatus("Название группы слишком длинное.");return;}
    if(canvas.board.groups.some(g=>g.label.toLocaleLowerCase("ru")===label.toLocaleLowerCase("ru"))){
      canvasStatus("Группа с таким названием уже существует.");return;
    }
    const scroller=viewport();
    canvas.board.groups.push({id:uid("g"),label,tone:["gold","blue","green","rose"][canvas.board.groups.length%4],
      x:layout.clamp(Math.round(scroller.scrollLeft/canvas.zoom+40),0,layout.WIDTH-520),
      y:layout.clamp(Math.round(scroller.scrollTop/canvas.zoom+40),0,layout.HEIGHT-350),
      width:520,height:350});
    canvasChanged();renderCanvas();
  }
  function autoArrange() {
    if(!canvas.board||canvas.transitioning)return;
    if(!confirm("Автоматически расположить группы и карточки? Их текущие координаты изменятся."))return;
    try {
      const arranged=layout.arrange(canvas.board);
      canvas.board=arranged;
      canvasChanged();renderCanvas();fitBoard();
    } catch (e) { canvasStatus("Не удалось упорядочить: "+e.message); }
  }

  function basesStatus(text, bad = false) {
    const field = $("knowledge-bases-message");
    field.textContent = text;
    field.dataset.error = String(bad);
  }
  function cellValue(row, key) {
    const value = row[key] === undefined ? row.properties[key] : row[key];
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  function columns() {
    return ["title", "folder", ...config.columns.filter(c => !basesBuiltin.includes(c)), "updatedAt"];
  }
  function fillOptions(id, values, empty = null) {
    const element = $(id), selected = element.value;
    element.replaceChildren();
    if (empty !== null) {
      const opt = mk("option", "", empty);
      opt.value = ""; element.append(opt);
    }
    for (const value of values) {
      const option = mk("option", "", value === "title" ? "Заметка" : value === "folder" ? "Папка" : value === "updatedAt" ? "Изменено" : value);
      option.value = value;
      element.append(option);
    }
    if (values.includes(selected)) element.value = selected;
  }
  function formView() {
    return {
      layout: $("knowledge-bases-layout").value,
      sort: $("knowledge-bases-sort").value || "title",
      direction: $("knowledge-bases-direction").value,
      group: $("knowledge-bases-group").value,
      filterField: $("knowledge-bases-property").value || "title",
      filterValue: $("knowledge-bases-value").value
    };
  }
  function applyView(view) {
    $("knowledge-bases-layout").value = view.layout;
    $("knowledge-bases-sort").value = view.sort;
    $("knowledge-bases-direction").value = view.direction;
    $("knowledge-bases-group").value = view.group;
    $("knowledge-bases-property").value = view.filterField;
    $("knowledge-bases-value").value = view.filterValue;
    renderBases();
  }
  function renderViewSelect() {
    const select = $("knowledge-bases-views"), current = basesState.currentView;
    select.replaceChildren();
    const first=mk("option", "", "Текущий вид");
    first.value=""; select.append(first);
    for (const view of basesState.views) {
      const option=mk("option","",view.name); option.value=view.id; select.append(option);
    }
    select.value = basesState.views.some(v=>v.id===current) ? current : "";
    $("knowledge-bases-delete-view").disabled = !select.value;
  }
  async function storeSettings() {
    const data=await api("/api/knowledge/bases/settings", {
      settings: { types:basesState.types, views:basesState.views }, expectedSha:basesState.sha
    });
    basesState.sha=data.sha;
    basesState.types=data.types;
    basesState.views=data.views;
    renderViewSelect();
    return data;
  }
  async function loadBases() {
    const target = $("knowledge-bases-table");
    try {
      const [data,settings]=await Promise.all([
        api("/api/knowledge/bases"),api("/api/knowledge/bases/settings")
      ]);
      config.rows = data.rows || [];
      config.columns = [...new Set([...(data.columns || []),...Object.keys(settings.types || {})])];
      basesState.types = settings.types || {};
      basesState.views = settings.views || [];
      basesState.sha = settings.sha;
      fillOptions("knowledge-bases-property",config.columns);
      fillOptions("knowledge-bases-sort",config.columns);
      fillOptions("knowledge-bases-group",config.columns,"Без группировки");
      renderViewSelect();
      renderBases();
    } catch (e) {
      target.replaceChildren(mk("p","knowledge-placeholder",e.message));
      basesStatus("Ошибка Bases: "+e.message,true);
    }
  }
  async function createField() {
    const input=$("knowledge-bases-new-field"), key=input.value.trim();
    const type=$("knowledge-bases-type").value;
    if (!/^[a-zA-Zа-яА-ЯёЁ][\wа-яА-ЯёЁ-]{0,39}$/.test(key) || basesReserved.has(key)) {
      basesStatus("Введите уникальное название поля (буквы, цифры и дефисы).",true); return;
    }
    if (config.columns.includes(key)) {
      basesStatus("Поле уже существует. Для смены типа используйте кнопку заголовка таблицы.",true); return;
    }
    if (!basesTypes.includes(type)) return;
    basesState.types[key]=type;
    const previousColumns=config.columns.slice();
    config.columns.push(key);
    try {
      await storeSettings();
      fillOptions("knowledge-bases-property",config.columns);
      fillOptions("knowledge-bases-sort",config.columns);
      fillOptions("knowledge-bases-group",config.columns,"Без группировки");
      input.value="";
      renderBases();
      basesStatus("Поле добавлено. Отредактируйте его в строке заметки.");
    } catch (error) {
      delete basesState.types[key];
      config.columns=previousColumns;
      basesStatus("Не удалось сохранить поле: "+error.message,true);
      void loadBases();
    }
  }
  async function changeType(key) {
    if (basesReserved.has(key)) return;
    const current=basesState.types[key] || "text";
    const requested=prompt("Тип поля «"+key+"»: text / number / date / checkbox / select / tags",current);
    if (requested===null) return;
    const type=requested.trim().toLowerCase();
    if (!basesTypes.includes(type)) {
      basesStatus("Допустимые типы: text, number, date, checkbox, select, tags.",true); return;
    }
    if (type===current) return;
    if (!confirm("Сменить тип поля? Уже записанные значения не будут преобразованы автоматически.")) return;
    basesState.types[key]=type;
    try { await storeSettings(); renderBases(); basesStatus("Тип поля обновлён: "+key+" → "+type); }
    catch(e) { basesState.types[key]=current; basesStatus(e.message,true); }
  }
  function editorValue(type, raw) {
    if (type==="checkbox") return raw===true;
    if (type==="number") {
      if (raw==="" || !Number.isFinite(Number(raw))) throw new Error("Введите число.");
      return Number(raw);
    }
    if (type==="tags") return raw.split(",").map(x=>x.trim()).filter(Boolean);
    return raw;
  }
  async function writeProperty(row,key,type,value,editor) {
    if (basesState.busy) return;
    basesState.busy=true;
    if (editor) editor.disabled=true;
    basesStatus("Сохранение свойства…");
    try {
      await config.callbacks.beforeRestore();
      const result=await api("/api/knowledge/bases/property",{
        path:row.path,key,type,value,expectedSha:row.sha
      });
      if (config.active===row.path) await config.callbacks.onReload(row.path);
      await loadBases();
      basesStatus(result.unchanged ? "Свойство не изменилось." : "Свойство сохранено в заметке и истории.");
    } catch(e) {
      basesStatus("Не удалось сохранить: "+e.message,true);
      await loadBases();
    } finally { basesState.busy=false; }
  }
  function editableCell(row,key) {
    const td=mk("td","knowledge-bases-editable");
    const type=basesState.types[key] || (Array.isArray(row.properties[key])?"tags":"text");
    const value=cellValue(row,key);
    const label=mk("button","knowledge-bases-cell-button",value || "＋");
    label.type="button";
    label.title="Изменить поле "+key+" · "+type;
    label.addEventListener("click",()=>{
      if (basesState.busy) return;
      td.replaceChildren();
      const input=mk(type==="select"?"select":"input","knowledge-bases-input");
      if (type==="select") {
        const options=[...new Set([value,...config.rows.map(r=>cellValue(r,key))].filter(Boolean))].slice(0,100);
        const blank=mk("option","","Выберите…");blank.value="";input.append(blank);
        for (const item of options) {
          const opt=mk("option","",item);opt.value=item;input.append(opt);
        }
        const custom=mk("option","","＋ Другое значение");custom.value="__new_choice__";input.append(custom);
        input.value=value;
      } else {
        input.type=type==="number"?"number":type==="date"?"date":type==="checkbox"?"checkbox":"text";
        if (type==="number") input.step="any";
        if (type==="checkbox") input.checked=value.toLowerCase()==="true";
        else input.value=value;
        if (type==="tags") input.placeholder="метка1, метка2";
      }
      const commit=()=>{
        try {
          const v=editorValue(type,type==="checkbox"?input.checked:input.value);
          void writeProperty(row,key,type,v,input);
        } catch(e) { basesStatus(e.message,true); renderBases(); }
      };
      input.addEventListener("keydown",e=>{
        if (e.key==="Escape") { e.preventDefault(); renderBases(); }
        if (e.key==="Enter") { e.preventDefault(); commit(); }
      });
      if (type==="checkbox") input.addEventListener("change",commit);
      if (type==="select") input.addEventListener("change",()=>{
        if (input.value==="__new_choice__") {
          const other=prompt("Новое значение поля «"+key+"»:");
          if (other===null) { renderBases(); return; }
          void writeProperty(row,key,type,other.trim(),input);
        } else commit();
      });
      const ok=mk("button","knowledge-bases-commit","✓");
      ok.type="button";ok.title="Сохранить";ok.addEventListener("click",commit);
      const cancel=mk("button","knowledge-bases-cancel","×");
      cancel.type="button";cancel.title="Отмена";cancel.addEventListener("click",renderBases);
      td.append(input,ok,cancel);input.focus();
    });
    td.append(label);return td;
  }
  function renderBases() {
    const container=$("knowledge-bases-table");
    container.replaceChildren();
    const phrase=$("knowledge-bases-search").value.toLocaleLowerCase("ru").trim();
    const state=formView();
    const rows=config.rows.filter(row=>{
      const matches=(row.path+" "+Object.values(row.properties).join(" ")).toLocaleLowerCase("ru").includes(phrase);
      const filter=cellValue(row,state.filterField).toLocaleLowerCase("ru").includes(state.filterValue.toLocaleLowerCase("ru"));
      return matches && filter;
    }).sort((a,b)=> {
      const key=state.sort;
      const type=basesState.types[key] || "text";
      const x=cellValue(a,key),y=cellValue(b,key);
      const cmp=type==="number" ? Number(x||0)-Number(y||0) : x.localeCompare(y,"ru",{numeric:true});
      return (state.direction==="desc"?-1:1)*cmp;
    });
    $("knowledge-bases-count").textContent=rows.length+" из "+config.rows.length+
      " заметок · "+(state.layout==="cards"?"карточки":"таблица")+
      (state.group?" · группировка "+state.group:"");
    const groups=new Map();
    for (const item of rows.slice(0,250)) {
      const group=state.group ? cellValue(item,state.group) || "Без значения" : "";
      if (!groups.has(group)) groups.set(group,[]);
      groups.get(group).push(item);
    }
    if (!rows.length) container.append(mk("p","knowledge-placeholder","Нет заметок. Создайте заметку или измените фильтр."));
    for (const [group,items] of groups) {
      const section=mk("section","knowledge-bases-group");
      if (state.group) section.append(mk("h4","knowledge-bases-group-name",group+" · "+items.length));
      if (state.layout==="cards") {
        const wrap=mk("div","knowledge-bases-card-grid");
        for (const row of items) {
          const card=mk("article","knowledge-bases-card");
          const open=mk("button","knowledge-bases-card-open",row.title);
          open.type="button";open.addEventListener("click",()=>{ void config.callbacks.onNoteOpen(row.path); });
          card.append(open);
          for (const key of columns().filter(c=>!basesBuiltin.includes(c))) {
            const line=mk("div","knowledge-bases-card-row");
            line.append(mk("span","",key),editableCell(row,key));card.append(line);
          }
          wrap.append(card);
        }
        section.append(wrap);
      } else {
        const table=mk("table","knowledge-bases-grid"),head=mk("thead"),hr=mk("tr");
        for (const key of columns()) {
          const cell=mk("th");
          if (basesBuiltin.includes(key)) cell.textContent=key==="title"?"Заметка":key==="folder"?"Папка":"Изменено";
          else {
            const button=mk("button","knowledge-bases-field-type",key+" · "+(basesState.types[key]||"text"));
            button.type="button";button.title="Изменить тип поля";button.addEventListener("click",()=>{void changeType(key);});
            cell.append(button);
          }
          hr.append(cell);
        }
        head.append(hr);table.append(head);
        const body=mk("tbody");
        for (const row of items) {
          const tr=mk("tr");
          for (const key of columns()) {
            if (key==="title") {
              const cell=mk("td"),link=mk("button","knowledge-bases-open",row.title);
              link.type="button";link.title=row.path;
              link.addEventListener("click",()=>{void config.callbacks.onNoteOpen(row.path);});
              cell.append(link);tr.append(cell);
            } else if (key==="folder") tr.append(mk("td","",row.folder));
            else if (key==="updatedAt") tr.append(mk("td","",new Date(row.updatedAt).toLocaleDateString("ru-RU")));
            else tr.append(editableCell(row,key));
          }
          body.append(tr);
        }
        table.append(body);section.append(table);
      }
      container.append(section);
    }
    if (rows.length>250) container.append(mk("p","knowledge-placeholder","Показаны первые 250 строк. Уточните фильтр."));
  }
  async function saveView() {
    const name=prompt("Имя сохранённого представления:");
    if (name===null) return;
    if (!name.trim() || name.length>65) { basesStatus("Имя вида должно содержать 1–65 символов.",true);return; }
    const id="view-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,6);
    if (basesState.views.length>=30) { basesStatus("Максимум 30 сохранённых видов.",true);return; }
    const record={id,name:name.trim(),...formView()};
    basesState.views.push(record);
    try { await storeSettings();basesState.currentView=id;renderViewSelect();basesStatus("Вид сохранён."); }
    catch(e) { basesState.views.pop();basesStatus(e.message,true); }
  }
  async function deleteView() {
    const id=$("knowledge-bases-views").value;
    const item=basesState.views.find(v=>v.id===id);
    if (!item || !confirm("Удалить сохранённый вид «"+item.name+"»? Данные заметок сохранятся."))return;
    basesState.views=basesState.views.filter(v=>v.id!==id);
    try { await storeSettings();basesState.currentView="";renderViewSelect();basesStatus("Представление удалено."); }
    catch(e) { basesState.views.push(item);basesStatus(e.message,true);void loadBases(); }
  }
  function init(callbacks) {
    if (config.initialized) return;
    config.initialized = true;
    config.callbacks = callbacks;
    $("knowledge-canvas-new").addEventListener("click", () => { void createBoard(); });
    $("knowledge-canvas-delete").addEventListener("click", () => { void deleteBoard(); });
    $("knowledge-canvas-text").addEventListener("click", () => addNode("text"));
    $("knowledge-canvas-file").addEventListener("click", () => addNode("file"));
    $("knowledge-canvas-save").addEventListener("click", () => {
      void flushCanvas().catch(e => canvasStatus("Не сохранено: "+e.message));
    });
    $("knowledge-canvas-group").addEventListener("click",addGroup);
    $("knowledge-canvas-layout").addEventListener("click",autoArrange);
    $("knowledge-canvas-undo").addEventListener("click",undoCanvas);
    $("knowledge-canvas-redo").addEventListener("click",redoCanvas);
    $("knowledge-canvas-select-all").addEventListener("click",selectAllCanvas);
    $("knowledge-canvas-copy").addEventListener("click",copyCanvas);
    $("knowledge-canvas-snap").addEventListener("click",()=>{
      canvas.grid=!canvas.grid;
      $("knowledge-canvas-snap").textContent=canvas.grid?"Сетка: вкл.":"Сетка: выкл.";
      $("knowledge-canvas-snap").setAttribute("aria-pressed",String(canvas.grid));
    });
    $("knowledge-canvas-zoom-in").addEventListener("click",()=>setZoom(canvas.zoom*1.2));
    $("knowledge-canvas-zoom-out").addEventListener("click",()=>setZoom(canvas.zoom/1.2));
    $("knowledge-canvas-zoom-reset").addEventListener("click",()=>setZoom(1));
    $("knowledge-canvas-zoom-fit").addEventListener("click",fitBoard);
    const scroller=viewport();
    let redrawTimer=null;
    scroller.addEventListener("scroll",()=>{
      renderMinimap();
      if(canvas.dragging)return;
      clearTimeout(redrawTimer);
      redrawTimer=setTimeout(()=>{if(canvas.board&&!canvas.dragging)renderCanvas();},110);
    },{passive:true});
    scroller.addEventListener("wheel",e=>{
      if(!e.ctrlKey)return;
      e.preventDefault();
      setZoom(canvas.zoom*(e.deltaY<0?1.1:1/1.1));
    },{passive:false});
    scroller.addEventListener("keydown",e=>{
      if(e.key==="Home"){e.preventDefault();scroller.scrollLeft=0;scroller.scrollTop=0;renderMinimap();}
      if(e.key==="f"||e.key==="F"){e.preventDefault();fitBoard();}
      if(e.key==="+"||e.key==="="){e.preventDefault();setZoom(canvas.zoom*1.2);}
      if(e.key==="-"){e.preventDefault();setZoom(canvas.zoom/1.2);}
    });
    scroller.addEventListener("pointerdown",e=>{
      if(e.button!==1)return;
      e.preventDefault();
      const pointer=e.pointerId,startX=e.clientX,startY=e.clientY,
        left=scroller.scrollLeft,top=scroller.scrollTop;
      scroller.setPointerCapture(pointer);
      const move=event=>{
        if(event.pointerId!==pointer)return;
        scroller.scrollLeft=left-(event.clientX-startX);
        scroller.scrollTop=top-(event.clientY-startY);
        renderMinimap();
      };
      const done=event=>{
        if(event.pointerId!==pointer)return;
        scroller.removeEventListener("pointermove",move);
        scroller.removeEventListener("pointerup",done);
        scroller.removeEventListener("pointercancel",done);
        if(scroller.hasPointerCapture(pointer))scroller.releasePointerCapture(pointer);
      };
      scroller.addEventListener("pointermove",move);
      scroller.addEventListener("pointerup",done);
      scroller.addEventListener("pointercancel",done);
    });
    $("knowledge-canvas-minimap").addEventListener("click",e=>{
      const map=e.currentTarget,rect=map.getBoundingClientRect();
      if(!rect.width||!rect.height)return;
      const x=layout.clamp((e.clientX-rect.left)/rect.width,0,1)*layout.WIDTH;
      const y=layout.clamp((e.clientY-rect.top)/rect.height,0,1)*layout.HEIGHT;
      panTo(x,y);scroller.focus();
    });
    window.addEventListener("resize",renderMinimap);

    $("knowledge-canvas-select").addEventListener("change", e => {
      const selected = e.target.value; void loadBoard(selected).catch(err => canvasStatus(err.message));
    });
    $("knowledge-bases-search").addEventListener("input", renderBases);
    $("knowledge-bases-property").addEventListener("change", renderBases);
    $("knowledge-bases-value").addEventListener("input", renderBases);

    for (const id of ["knowledge-bases-sort","knowledge-bases-direction",
      "knowledge-bases-group","knowledge-bases-layout"]) {
      $(id).addEventListener("change", renderBases);
    }
    $("knowledge-bases-views").addEventListener("change",event=>{
      basesState.currentView=event.target.value;
      const view=basesState.views.find(item=>item.id===basesState.currentView);
      if (view) applyView(view); else renderBases();
      renderViewSelect();
    });
    $("knowledge-bases-save-view").addEventListener("click",()=>{void saveView();});
    $("knowledge-bases-delete-view").addEventListener("click",()=>{void deleteView();});
    $("knowledge-bases-add-field").addEventListener("click",()=>{void createField();});

    $("knowledge-history-close").addEventListener("click", () => $("knowledge-history-dialog").close());
    for (const element of document.querySelectorAll("[data-knowledge-mode]")) {
      if (["canvas", "bases"].includes(element.dataset.knowledgeMode))
        element.addEventListener("click", () => show(element.dataset.knowledgeMode));
    }
  }
  async function savePending() { await flushCanvas(); }
  window.AmayurenaKnowledgeAdvanced = { init, show, update, renderHistory, savePending };
})();
