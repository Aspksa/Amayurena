(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const ui = {
    search: $("knowledge-search"), tree: $("knowledge-tree"), empty: $("knowledge-empty"),
    path: $("knowledge-path"), editor: $("knowledge-editor"), preview: $("knowledge-preview"),
    backlinks: $("knowledge-backlinks"), graph: $("knowledge-graph"),
    stats: $("knowledge-stats"), status: $("knowledge-status"), panel: $("knowledge-editor-panel"),
    graphPanel: $("knowledge-graph-panel"), delete: $("knowledge-delete"),
    save: $("knowledge-save"), mode: $("knowledge-mode"),
    create: $("knowledge-create"), folder: $("knowledge-folder"),
    importButton: $("knowledge-import"), importFile: $("knowledge-import-files")
  };
  let notes = [], folders = [], active = "", revision = 0, committed = 0, saveTimer = null;
  let queue = Promise.resolve(), graph = { nodes: [], edges: [], missing: [] }, initialized = false;

  function node(tag, className, value) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (value !== undefined) n.textContent = value;
    return n;
  }
  function message(text, bad = false) {
    ui.status.textContent = text;
    ui.status.dataset.error = String(bad);
  }
  async function request(url, options) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error("Некорректный ответ локального сервера."); }
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    return data;
  }
  function post(url, body) {
    return request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function noteButton(note) {
    const b = node("button", "knowledge-note" + (note.path === active ? " selected" : ""));
    b.type = "button";
    b.append(node("span", "knowledge-note-icon", "◇"), node("span", "", note.title));
    b.title = note.path;
    b.addEventListener("click", () => { void openNote(note.path); });
    return b;
  }
  function renderTree() {
    const query = ui.search.value.trim().toLocaleLowerCase("ru");
    const visible = notes.filter(n => (n.path + "\n" + n.excerpt).toLocaleLowerCase("ru").includes(query));
    ui.tree.replaceChildren();
    const roots = visible.filter(n => !n.folder);
    if (roots.length) {
      const block = node("div", "knowledge-folder-group");
      block.append(node("div", "knowledge-folder-title", "Корень"));
      roots.forEach(n => block.append(noteButton(n)));
      ui.tree.append(block);
    }
    for (const folder of folders) {
      const matches = visible.filter(n => n.folder === folder);
      if (!matches.length && query) continue;
      const block = node("div", "knowledge-folder-group");
      block.append(node("div", "knowledge-folder-title", "▸ " + folder));
      matches.forEach(n => block.append(noteButton(n)));
      ui.tree.append(block);
    }
    if (!visible.length && !folders.length) ui.tree.append(node("p", "knowledge-placeholder", "Заметок пока нет."));
    else if (!visible.length && query) ui.tree.append(node("p", "knowledge-placeholder", "Ничего не найдено."));
    ui.stats.textContent = notes.length + " заметок · " + folders.length + " папок · " + graph.edges.length + " связей";
  }
  function resolveLink(from, target) {
    const normalized = target.split("#")[0].split("|")[0].trim().replace(/\.md$/i, "");
    const exact = normalized.toLocaleLowerCase("ru");
    const matches = notes.filter(n => n.path.replace(/\.md$/i, "").toLocaleLowerCase("ru") === exact ||
      n.path.replace(/\.md$/i, "").toLocaleLowerCase("ru") ===
        ((from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "") + normalized).toLocaleLowerCase("ru"));
    if (matches.length) return matches[0].path;
    const names = notes.filter(n => n.title.toLocaleLowerCase("ru") === exact);
    return names.length === 1 ? names[0].path : "";
  }
  function appendInline(parent, line) {
    const regex = /\[\[([^\]\r\n]{1,250})\]\]/g;
    let last = 0, match;
    while ((match = regex.exec(line))) {
      if (match.index > last) parent.append(document.createTextNode(line.slice(last, match.index)));
      const label = match[1].split("|")[1] || match[1].split("#")[0];
      const target = resolveLink(active, match[1]);
      const button = node("button", "knowledge-wikilink" + (target ? "" : " missing"), label);
      button.type = "button";
      button.title = target || "Заметка пока не найдена";
      button.addEventListener("click", () => { if (target) void openNote(target); });
      parent.append(button);
      last = regex.lastIndex;
    }
    if (last < line.length) parent.append(document.createTextNode(line.slice(last)));
  }
  function renderPreview() {
    window.AmayurenaMarkdown.render(ui.preview, ui.editor.value,
      target => resolveLink(active, target), path => { void openNote(path); });
  }
  function renderBacklinks() {
    ui.backlinks.replaceChildren();
    if (!active) return;
    const linked = graph.edges.filter(e => e.to === active).map(e => e.from);
    const unique = [...new Set(linked)];
    if (!unique.length) ui.backlinks.append(node("p", "knowledge-placeholder", "Обратных ссылок пока нет."));
    for (const path of unique) {
      const b = node("button", "knowledge-backlink", path);
      b.type = "button";
      b.addEventListener("click", () => { void openNote(path); });
      ui.backlinks.append(b);
    }
  }
  function renderGraph() {
    const svg = ui.graph;
    svg.replaceChildren();
    const entries = graph.nodes.slice(0, 80);
    if (!entries.length) return;
    const positions = new Map();
    const width = 900, height = 580, count = entries.length;
    entries.forEach((entry, i) => {
      const angle = 2 * Math.PI * i / Math.max(1, count) - Math.PI / 2;
      const radius = Math.min(230, 75 + count * 4);
      positions.set(entry.path, {
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius
      });
    });
    function svgEl(name, attributes) {
      const n = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attributes)) n.setAttribute(key, String(value));
      return n;
    }
    for (const edge of graph.edges) {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      if (!a || !b) continue;
      svg.append(svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#d9c9a9", "stroke-width": 2 }));
    }
    for (const entry of entries) {
      const p = positions.get(entry.path);
      const group = svgEl("g", { role: "button", tabindex: "0", "aria-label": "Открыть " + entry.title });
      const circle = svgEl("circle", { cx: p.x, cy: p.y, r: entry.path === active ? 20 : 14,
        fill: entry.path === active ? "#ac7937" : "#eedbb9", stroke: "#aa874f", "stroke-width": 1.5 });
      const label = svgEl("text", { x: p.x, y: p.y + 34, "text-anchor": "middle", "font-size": 13, fill: "#645642" });
      label.textContent = entry.title.slice(0, 22);
      group.append(circle, label);
      group.addEventListener("click", () => { void openNote(entry.path); });
      group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openNote(entry.path); } });
      svg.append(group);
    }
    ui.graph.setAttribute("viewBox", "0 0 900 580");
  }
  async function refresh() {
    const [list, links] = await Promise.all([
      request("/api/knowledge"),
      request("/api/knowledge/graph")
    ]);
    notes = list.notes;
    folders = list.folders;
    graph = links;
    renderTree(); renderBacklinks(); renderGraph();
    void window.AmayurenaKnowledgeAdvanced.update(notes, active);
  }
  function scheduleSave() {
    if (!active) return;
    revision++;
    message("Не сохранено");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveNow(); }, 850);
    renderPreview();
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!active || revision <= committed) return queue;
    const savedPath = active, value = ui.editor.value, version = revision;
    queue = queue.catch(() => {}).then(async () => {
      await post("/api/knowledge/note", { path: savedPath, content: value });
      if (active === savedPath && version >= committed) {
        committed = version;
        message("Сохранено на диске");
      }
      await refresh();
    }).catch(error => { message("Ошибка сохранения: " + error.message, true); });
    return queue;
  }
  async function openNote(path, force = false) {
    if (path === active && !force) { setMode("editor"); return; }
    if (!force) {
      await saveNow();
      if (active && revision > committed) return;
    }
    try {
      const record = await request("/api/knowledge/note?path=" + encodeURIComponent(path));
      active = record.path;
      ui.editor.value = record.content;
      ui.path.textContent = record.path;
      ui.panel.hidden = false;
      revision = 0; committed = 0;
      renderTree(); renderPreview(); renderBacklinks(); renderGraph();
      void window.AmayurenaKnowledgeAdvanced.update(notes, active);
      setMode("editor");
      message("Готово к редактированию");
    } catch (error) { message(error.message, true); }
  }
  async function createNote() {
    const raw = prompt("Путь новой заметки (например, Идеи/Моя заметка.md):", "Новая заметка.md");
    if (raw === null) return;
    const path = raw.trim();
    if (!path) return;
    if (notes.some(note => note.path.toLocaleLowerCase("ru") === path.toLocaleLowerCase("ru"))) {
      message("Заметка с таким именем уже существует.", true); return;
    }
    await saveNow();
    if (active && revision > committed) return;
    try {
      await post("/api/knowledge/note", { path, content: "# " + path.split("/").pop().replace(/\.md$/i, "") + "\n\n" });
      await refresh();
      await openNote(path);
    } catch (error) { message(error.message, true); }
  }
  async function createFolder() {
    const raw = prompt("Название папки (например, Проекты/Идеи):");
    if (raw === null || !raw.trim()) return;
    try { await post("/api/knowledge/folder", { path: raw.trim() }); await refresh(); message("Папка создана."); }
    catch (error) { message(error.message, true); }
  }
  async function deleteNote() {
    if (!active || !confirm("Удалить заметку «" + active + "»? Это действие нельзя отменить.")) return;
    await saveNow();
    if (active && revision > committed) return;
    try {
      await request("/api/knowledge/note?path=" + encodeURIComponent(active), { method: "DELETE" });
      active = ""; ui.editor.value = ""; ui.path.textContent = ""; ui.panel.hidden = true;
      await refresh(); message("Заметка удалена.");
    } catch (error) { message(error.message, true); }
  }
  async function importNotes(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    await saveNow();
    if (active && revision > committed) return;
    let count = 0;
    for (const file of files) {
      if (!/\.md$/i.test(file.name) || file.size > 128 * 1024) { message("Пропущен неподдерживаемый файл: " + file.name, true); continue; }
      try {
        if (notes.some(n => n.path.toLocaleLowerCase("ru") === file.name.toLocaleLowerCase("ru"))) {
          message("Пропущен существующий файл: " + file.name, true); continue;
        }
        await post("/api/knowledge/note", { path: file.name, content: await file.text() });
        count++; await refresh();
      } catch (error) { message(file.name + ": " + error.message, true); }
    }
    if (count) message("Импортировано заметок: " + count);
  }
  function setMode(mode) {
    const isGraph = mode === "graph";
    ui.panel.hidden = isGraph || !active;
    ui.graphPanel.hidden = !isGraph;
    ui.mode.dataset.current = isGraph ? "graph" : "editor";
    ui.mode.textContent = isGraph ? "Редактор" : "Граф";
    window.AmayurenaKnowledgeAdvanced.show(isGraph ? "graph" : "editor");
    if (isGraph) renderGraph();
  }
  async function open() {
    if (!initialized) {
      initialized = true;
      window.AmayurenaKnowledgeAdvanced.init({
        onNoteOpen: openNote,
        beforeRestore: saveNow,
        onReload: path => openNote(path, true)
      });
      ui.editor.addEventListener("input", scheduleSave);
      ui.editor.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveNow(); }
      });
      ui.search.addEventListener("input", renderTree);
      ui.create.addEventListener("click", () => { void createNote(); });
      ui.folder.addEventListener("click", () => { void createFolder(); });
      ui.delete.addEventListener("click", () => { void deleteNote(); });
      ui.save.addEventListener("click", () => { void saveNow(); });
      ui.mode.addEventListener("click", () => setMode(ui.mode.dataset.current === "graph" ? "editor" : "graph"));
      ui.importButton.addEventListener("click", () => ui.importFile.click());
      ui.importFile.addEventListener("change", e => { void importNotes(e); });
    }
    try { await refresh(); message("База знаний доступна локально."); }
    catch (error) { message("Не удалось открыть хранилище: " + error.message, true); }
  }
  window.AmayurenaKnowledge = { open };
})();
