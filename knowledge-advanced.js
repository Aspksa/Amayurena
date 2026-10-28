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
      clearTimeout(canvas.timer);
      canvas.board = null; canvas.name = ""; canvas.dirty = 0; canvas.saved = 0;
      await api(query("/api/knowledge/canvas", "name", name), undefined, "DELETE");
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

  async function loadBases() {
    const target = $("knowledge-bases-table");
    try {
      const data = await api("/api/knowledge/bases");
      config.rows = data.rows || []; config.columns = data.columns || [];
      const select = $("knowledge-bases-property"), selected = select.value;
      select.replaceChildren();
      for (const c of config.columns) { const option = mk("option", "", c); option.value = c; select.append(option); }
      if (config.columns.includes(selected)) select.value = selected;
      renderBases();
    } catch (e) { target.replaceChildren(mk("p", "knowledge-placeholder", e.message)); }
  }
  function cellValue(row, key) {
    const value = row[key] === undefined ? row.properties[key] : row[key];
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  function renderBases() {
    const container = $("knowledge-bases-table");
    container.replaceChildren();
    const phrase = $("knowledge-bases-search").value.toLocaleLowerCase("ru");
    const field = $("knowledge-bases-property").value || "title";
    const valueFilter = $("knowledge-bases-value").value.toLocaleLowerCase("ru");
    const rows = config.rows.filter(row =>
      (row.path + " " + Object.values(row.properties).join(" ")).toLocaleLowerCase("ru").includes(phrase) &&
      cellValue(row, field).toLocaleLowerCase("ru").includes(valueFilter))
      .sort((a, b) => cellValue(a, field).localeCompare(cellValue(b, field), "ru"));
    $("knowledge-bases-count").textContent = rows.length + " из " + config.rows.length + " заметок · сортировка: " + field;
    const table = mk("table", "knowledge-bases-grid"), thead = mk("thead"), header = mk("tr");
    const cols = ["title", "folder", ...config.columns.filter(c => !["title", "folder", "updatedAt"].includes(c)), "updatedAt"];
    for (const column of cols) header.append(mk("th", "", column === "title" ? "Заметка" : column === "folder" ? "Папка" : column === "updatedAt" ? "Изменено" : column));
    thead.append(header); table.append(thead);
    const body = mk("tbody");
    for (const row of rows.slice(0, 250)) {
      const tr = mk("tr"); tr.tabIndex = 0; tr.title = "Открыть " + row.path;
      for (const col of cols) tr.append(mk("td", "", col === "updatedAt" ? new Date(row.updatedAt).toLocaleDateString("ru-RU") : cellValue(row, col)));
      tr.addEventListener("click", () => { void config.callbacks.onNoteOpen(row.path); });
      tr.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); void config.callbacks.onNoteOpen(row.path); }
      });
      body.append(tr);
    }
    table.append(body); container.append(table);
    if (rows.length > 250) container.append(mk("p", "knowledge-placeholder", "Показаны первые 250 строк. Уточните фильтр."));
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
    $("knowledge-history-close").addEventListener("click", () => $("knowledge-history-dialog").close());
    for (const element of document.querySelectorAll("[data-knowledge-mode]")) {
      if (["canvas", "bases"].includes(element.dataset.knowledgeMode))
        element.addEventListener("click", () => show(element.dataset.knowledgeMode));
    }
  }
  window.AmayurenaKnowledgeAdvanced = { init, show, update, renderHistory };
})();
