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
    create: $("knowledge-create"), folder: $("knowledge-folder")
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
    if (!notes.length) {
      const empty = node("div", "knowledge-first-start");
      empty.append(node("strong", "", "Ваша база знаний пока пуста."),
        node("p", "", "Начните с собственной заметки. Импорт и дополнительные программы не нужны."));
      const begin = node("button", "btn btn-primary", "＋ Первая заметка");
      begin.type = "button";
      begin.addEventListener("click", openCreateDialog);
      empty.append(begin); ui.tree.append(empty);
    } else if (!visible.length && query) {
      ui.tree.append(node("p", "knowledge-placeholder", "Ничего не найдено."));
    }
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
  function createError(text) {
    const target = $("knowledge-create-error");
    target.textContent = text;
    target.hidden = !text;
  }
  function folderError(text) {
    const target = $("knowledge-folder-error");
    target.textContent = text;
    target.hidden = !text;
  }
  function previewNewNote() {
    const title = $("knowledge-create-name").value;
    const folder = $("knowledge-create-folder").value;
    const template = $("knowledge-create-template").value;
    try {
      if (!title.trim()) {
        $("knowledge-create-preview").textContent = "Введите название, чтобы увидеть содержимое.";
        return;
      }
      const draft = window.AmayurenaNative.buildNote(title, folder, template);
      $("knowledge-create-preview").textContent = draft.content;
    } catch (err) {
      $("knowledge-create-preview").textContent = err.message;
    }
  }
  function openCreateDialog() {
    const dialog = $("knowledge-create-dialog");
    $("knowledge-create-form").reset();
    const select = $("knowledge-create-folder");
    select.replaceChildren();
    const root = node("option", "", "Корень базы знаний");
    root.value = "";
    select.append(root);
    for (const folder of folders) {
      const option = node("option", "", folder);
      option.value = folder;
      select.append(option);
    }
    const currentFolder = active.includes("/") ? active.slice(0, active.lastIndexOf("/")) : "";
    if (folders.includes(currentFolder)) select.value = currentFolder;
    createError("");
    previewNewNote();
    dialog.showModal();
    $("knowledge-create-name").focus();
  }
  async function submitCreate(event) {
    event.preventDefault();
    const submit = $("knowledge-create-submit");
    if (submit.disabled) return;
    let draft;
    try {
      draft = window.AmayurenaNative.buildNote(
        $("knowledge-create-name").value,
        $("knowledge-create-folder").value,
        $("knowledge-create-template").value);
    } catch (err) { createError(err.message); return; }
    if (notes.some(n => n.path.toLocaleLowerCase("ru") === draft.path.toLocaleLowerCase("ru"))) {
      createError("Заметка с таким названием уже существует в выбранной папке.");
      return;
    }
    submit.disabled = true;
    createError("");
    try {
      await saveNow();
      if (active && revision > committed) throw new Error("Сначала сохраните текущую заметку.");
      await post("/api/knowledge/note/create", { path: draft.path, content: draft.content });
      await refresh();
      $("knowledge-create-dialog").close();
      await openNote(draft.path);
      message("Создана новая заметка: " + draft.title);
    } catch (err) { createError("Не удалось создать заметку: " + err.message); }
    finally { submit.disabled = false; }
  }
  function openFolderDialog() {
    $("knowledge-folder-form").reset();
    folderError("");
    $("knowledge-folder-dialog").showModal();
    $("knowledge-folder-name").focus();
  }
  async function submitFolder(event) {
    event.preventDefault();
    const button = $("knowledge-folder-submit");
    if (button.disabled) return;
    const path = $("knowledge-folder-name").value.trim();
    button.disabled = true;
    folderError("");
    try {
      await post("/api/knowledge/folder", { path });
      await refresh();
      $("knowledge-folder-dialog").close();
      message("Создана папка: " + path);
    } catch (err) { folderError("Не удалось создать папку: " + err.message); }
    finally { button.disabled = false; }
  }
  async function deleteNote() {
    if (!active || !confirm("Удалить заметку «" + active + "»? Предыдущая версия останется в истории.")) return;
    await saveNow();
    if (active && revision > committed) return;
    try {
      await request("/api/knowledge/note?path=" + encodeURIComponent(active), { method: "DELETE" });
      active = ""; ui.editor.value = ""; ui.path.textContent = ""; ui.panel.hidden = true;
      await refresh(); message("Заметка удалена. История сохранена.");
    } catch (error) { message(error.message, true); }
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
        beforeRestore: async () => { await saveNow(); if (active && revision > committed) throw new Error("Текущие изменения не сохранены."); },
        onReload: path => openNote(path, true)
      });
      ui.editor.addEventListener("input", scheduleSave);
      ui.editor.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveNow(); }
      });
      ui.search.addEventListener("input", renderTree);
      ui.create.addEventListener("click", openCreateDialog);
      ui.folder.addEventListener("click", openFolderDialog);
      $("knowledge-create-form").addEventListener("submit", event => { void submitCreate(event); });
      $("knowledge-create-cancel").addEventListener("click", () => $("knowledge-create-dialog").close());
      $("knowledge-create-name").addEventListener("input", previewNewNote);
      $("knowledge-create-folder").addEventListener("change", previewNewNote);
      $("knowledge-create-template").addEventListener("change", previewNewNote);
      $("knowledge-folder-form").addEventListener("submit", event => { void submitFolder(event); });
      $("knowledge-folder-cancel").addEventListener("click", () => $("knowledge-folder-dialog").close());
      ui.delete.addEventListener("click", () => { void deleteNote(); });
      ui.save.addEventListener("click", () => { void saveNow(); });
      ui.mode.addEventListener("click", () => setMode(ui.mode.dataset.current === "graph" ? "editor" : "graph"));
    }
    try { await refresh(); message("База знаний доступна локально."); }
    catch (error) { message("Не удалось открыть хранилище: " + error.message, true); }
  }
  window.AmayurenaKnowledge = { open };
})();
