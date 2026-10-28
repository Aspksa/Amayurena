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
  const canvas = { name: "", board: null, boards: [], pending: null, queue: Promise.resolve(),
    dirty: 0, saved: 0, connecting: "", timer: null };
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
    $("knowledge-inspector").hidden = mode === "canvas" || mode === "bases";
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

  function canvasStatus(text) { $("knowledge-canvas-status").textContent = text; }
  function canvasSave() {
    if (!canvas.board || canvas.dirty <= canvas.saved) return canvas.queue;
    clearTimeout(canvas.timer);
    const name = canvas.name;
    const data = JSON.parse(JSON.stringify(canvas.board));
    const revision = canvas.dirty;
    canvas.queue = canvas.queue.catch(() => {}).then(async () => {
      await api("/api/knowledge/canvas", { name, board: data });
      if (name === canvas.name && revision >= canvas.saved) {
        canvas.saved = revision; canvasStatus("Доска сохранена на диске.");
      }
    }).catch(e => canvasStatus("Не удалось сохранить: " + e.message));
    return canvas.queue;
  }
  function canvasChanged() {
    canvas.dirty++;
    canvasStatus("Изменения не сохранены…");
    clearTimeout(canvas.timer);
    canvas.timer = setTimeout(() => { void canvasSave(); }, 500);
  }
  function uid() { return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10); }
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
  function connect(id) {
    if (!canvas.connecting) { canvas.connecting = id; canvasStatus("Выберите вторую карточку для связи."); return; }
    const source = canvas.connecting;
    canvas.connecting = "";
    if (source === id) { canvasStatus("Выберите разные карточки."); return; }
    if (!canvas.board.edges.some(e => e.from === source && e.to === id)) {
      canvas.board.edges.push({ from: source, to: id });
      canvasChanged(); renderCanvas();
    }
  }
  function draggable(handle, element, record) {
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX, startY = event.clientY, origX = record.x, origY = record.y;
      const pointer = event.pointerId;
      handle.setPointerCapture(pointer);
      const move = e => {
        if (e.pointerId !== pointer) return;
        record.x = Math.max(0, Math.min(3200, Math.round(origX + e.clientX - startX)));
        record.y = Math.max(0, Math.min(2400, Math.round(origY + e.clientY - startY)));
        element.style.left = record.x + "px";
        element.style.top = record.y + "px";
        drawEdges();
      };
      const end = e => {
        if (e.pointerId !== pointer) return;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        canvasChanged();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  }
  function renderCanvas() {
    const container = $("knowledge-canvas-nodes");
    container.replaceChildren();
    if (!canvas.board) return;
    for (const record of canvas.board.nodes) {
      const card = mk("article", "knowledge-canvas-node");
      card.style.left = record.x + "px";
      card.style.top = record.y + "px";
      const handle = mk("div", "knowledge-canvas-grip", "⋮⋮ Переместить");
      card.append(handle); draggable(handle, card, record);
      const body = mk("div", "knowledge-canvas-text", record.type === "file" ? "◇ " + record.file : record.text);
      card.append(body);
      const buttons = mk("div", "knowledge-canvas-card-actions");
      function btn(label, callback) {
        const button = mk("button", "", label); button.type = "button";
        button.addEventListener("click", callback); buttons.append(button);
      }
      if (record.type === "file") btn("Открыть", () => { void config.callbacks.onNoteOpen(record.file); });
      if (record.type === "text") btn("Изменить", () => {
        const updated = prompt("Текст карточки:", record.text);
        if (updated === null) return;
        if (updated.length > 2500) { canvasStatus("Максимум 2500 символов."); return; }
        record.text = updated; canvasChanged(); renderCanvas();
      });
      btn("Связать", () => connect(record.id));
      btn("×", () => {
        if (!confirm("Удалить карточку и её связи?")) return;
        canvas.board.nodes = canvas.board.nodes.filter(n => n.id !== record.id);
        canvas.board.edges = canvas.board.edges.filter(e => e.from !== record.id && e.to !== record.id);
        canvasChanged(); renderCanvas();
      });
      card.append(buttons);
      container.append(card);
    }
    drawEdges();
  }
  async function listBoards() {
    const data = await api("/api/knowledge/canvases");
    canvas.boards = data.boards || [];
    const select = $("knowledge-canvas-select");
    select.replaceChildren();
    select.append(mk("option", "", "Выберите доску"));
    select.firstElementChild.value = "";
    for (const item of canvas.boards) {
      const opt = mk("option", "", item.name); opt.value = item.name;
      select.append(opt);
    }
    select.value = canvas.name;
  }
  async function loadBoard(name) {
    await canvasSave();
    if (canvas.board && canvas.dirty > canvas.saved) { canvasStatus("Сохранение не удалось; переключение отменено."); return; }
    canvas.name = name;
    canvas.board = name ? await api(query("/api/knowledge/canvas", "name", name)) : null;
    canvas.dirty = 0; canvas.saved = 0;
    $("knowledge-canvas-select").value = name;
    renderCanvas();
    canvasStatus(name ? "Доска «" + name + "» загружена." : "Создайте доску Canvas.");
  }
  async function openCanvas() {
    try {
      await listBoards();
      if (!canvas.board && canvas.boards.length) await loadBoard(canvas.boards[0].name);
    } catch (e) { canvasStatus("Ошибка Canvas: " + e.message); }
  }
  async function createBoard() {
    const name = prompt("Название новой доски Canvas:");
    if (name === null || !name.trim()) return;
    const cleaned = name.trim();
    if (canvas.boards.some(b => b.name.toLowerCase() === cleaned.toLowerCase())) {
      canvasStatus("Доска уже существует."); return;
    }
    try {
      await canvasSave();
      if (canvas.board && canvas.dirty > canvas.saved) return;
      await api("/api/knowledge/canvas", { name: cleaned, board: { nodes: [], edges: [] } });
      await listBoards();
      await loadBoard(cleaned);
    } catch (e) { canvasStatus(e.message); }
  }
  async function deleteBoard() {
    if (!canvas.name || !confirm("Удалить доску Canvas «" + canvas.name + "»?")) return;
    const name = canvas.name;
    try {
      await canvasSave();
      if (canvas.dirty > canvas.saved) { canvasStatus("Удаление отменено: изменения не сохранены."); return; }
      clearTimeout(canvas.timer);
      await api(query("/api/knowledge/canvas", "name", name), undefined, "DELETE");
      canvas.board = null; canvas.name = ""; canvas.dirty = 0; canvas.saved = 0;
      await listBoards(); renderCanvas(); canvasStatus("Доска удалена.");
    } catch (e) { canvasStatus(e.message); }
  }
  function addNode(type) {
    if (!canvas.board) { canvasStatus("Сначала создайте доску."); return; }
    if (canvas.board.nodes.length >= 60) { canvasStatus("На одной доске максимум 60 карточек."); return; }
    let content = type === "text" ? prompt("Текст карточки Canvas:") :
      prompt("Путь к заметке для карточки:", config.notes[0]?.path || "");
    if (content === null || !content.trim()) return;
    content = content.trim();
    if (type === "text" && content.length > 2500) { canvasStatus("Максимум 2500 символов."); return; }
    if (type === "file" && !config.notes.some(n => n.path === content)) { canvasStatus("Указанная заметка не найдена."); return; }
    const index = canvas.board.nodes.length;
    const record = { id: uid(), type, x: 35 + (index % 5) * 260, y: 35 + Math.floor(index / 5) * 180 };
    if (type === "text") record.text = content; else record.file = content;
    canvas.board.nodes.push(record);
    canvasChanged(); renderCanvas();
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
    $("knowledge-canvas-save").addEventListener("click", () => { void canvasSave(); });
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
  async function savePending() {
    await canvasSave();
    if (canvas.board && canvas.dirty > canvas.saved) {
      throw new Error("Изменения Canvas не сохранены. Операция отменена.");
    }
  }
  window.AmayurenaKnowledgeAdvanced = { init, show, update, renderHistory, savePending };
})();
