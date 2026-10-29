(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const ui = {
    search: $("knowledge-search"), tree: $("knowledge-tree"),
    path: $("knowledge-path"), editor: $("knowledge-editor"), preview: $("knowledge-preview"),
    backlinks: $("knowledge-backlinks"), graph: $("knowledge-graph"),
    stats: $("knowledge-stats"), status: $("knowledge-status"), panel: $("knowledge-editor-panel"),
    graphPanel: $("knowledge-graph-panel"), delete: $("knowledge-delete"),
    save: $("knowledge-save"), mode: $("knowledge-mode"),
    create: $("knowledge-create"), folder: $("knowledge-folder")
  };
  let notes = [], folders = [], active = "", revision = 0, committed = 0, saveTimer = null;
  let loadedSha = "", searchTimer = null, searchGeneration = 0, moveSource = null;
  const editorPrefs = (() => {
    try { const saved=JSON.parse(localStorage.getItem("amayu.editor.preferences.v2")||"{}");
      return {density:saved.density==="compact"?"compact":"comfortable",
        split:saved.split===true,sync:saved.sync!==false,outline:saved.outline!==false};
    }catch(_){return {density:"comfortable",split:false,sync:true,outline:true};}
  })();
  let syncingEditorScroll=false;
  let queue = Promise.resolve(), navigation = Promise.resolve(), graph = { nodes: [], edges: [], missing: [] }, initialized = false;
  const workspace = window.AmayurenaEditorTools.workspace(window.localStorage);
  const collapsed = new Set((() => {
    try { const x = JSON.parse(localStorage.getItem("amayu.editor.collapsed")); return Array.isArray(x) ? x.filter(v => typeof v === "string") : []; }
    catch (_) { return []; }
  })());
  function saveCollapsed() {
    try { localStorage.setItem("amayu.editor.collapsed", JSON.stringify([...collapsed])); } catch (_) {}
  }

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
    const row = node("div", "knowledge-note-row");
    const b = node("button", "knowledge-note" + (note.path === active ? " selected" : ""));
    b.type = "button";
    b.append(node("span", "knowledge-note-icon", "◇"), node("span", "", note.title));
    b.title = note.path;
    b.addEventListener("click", () => { void openNote(note.path); });
    const favorite = node("button", "knowledge-note-star" + (workspace.state.favorites.includes(note.path) ? " selected" : ""),
      workspace.state.favorites.includes(note.path) ? "★" : "☆");
    favorite.type = "button";
    favorite.title = "Добавить или убрать из избранного";
    favorite.setAttribute("aria-label", "Избранное: " + note.title);
    favorite.setAttribute("aria-pressed", String(workspace.state.favorites.includes(note.path)));
    favorite.addEventListener("click", () => {
      workspace.favorite(note.path); renderTree(); renderTabs();
    });
    row.append(b, favorite);
    return row;
  }
  function renderShortcuts() {
    function populate(id, paths, emptyText) {
      const container = $(id);
      container.replaceChildren();
      const map = new Map(notes.map(n => [n.path, n]));
      for (const path of paths.slice(0, id === "knowledge-recent" ? 8 : 15)) {
        const item = map.get(path);
        if (!item) continue;
        const button = node("button", "knowledge-shortcut" + (active === path ? " selected" : ""),
          (workspace.state.pinned.includes(path) ? "⌁ " : "◇ ") + item.title);
        button.type = "button";
        button.title = path;
        button.addEventListener("click", () => { void openNote(path); });
        container.append(button);
      }
      if (!container.children.length) container.append(node("p", "knowledge-placeholder", emptyText));
    }
    populate("knowledge-favorites", workspace.state.favorites, "Отмечайте важные заметки звёздочкой.");
    populate("knowledge-recent", workspace.state.recent, "Недавно открытых заметок нет.");
  }
  function renderTabs() {
    const container = $("knowledge-open-tabs");
    container.replaceChildren();
    const byPath = new Map(notes.map(n => [n.path, n]));
    const ordering = [...workspace.state.tabs].sort((a,b) =>
      Number(workspace.state.pinned.includes(b)) - Number(workspace.state.pinned.includes(a)));
    for (const path of ordering) {
      if (!byPath.has(path)) continue;
      const box = node("div", "knowledge-tab" + (path === active ? " selected" : ""));
      const label = node("button", "knowledge-tab-open",
        (workspace.state.pinned.includes(path) ? "⌁ " : "") + byPath.get(path).title);
      label.type = "button";
      label.title = path;
      label.setAttribute("role", "tab");
      label.setAttribute("aria-selected", String(path === active));
      label.addEventListener("click", () => { void openNote(path); });
      const close = node("button", "knowledge-tab-x", "×");
      close.type = "button";
      close.title = "Закрыть вкладку";
      close.setAttribute("aria-label", "Закрыть вкладку " + path);
      close.addEventListener("click", () => { void closeTab(path); });
      box.append(label, close); container.append(box);
    }
    $("knowledge-tab-close").disabled = !active;
  }
  function renderBreadcrumbs() {
    const bar = $("knowledge-breadcrumbs");
    bar.replaceChildren();
    if (!active) return;
    const parts = active.split("/");
    let current = "";
    parts.forEach((part,i) => {
      if (i) bar.append(node("span", "knowledge-crumb-divider", "›"));
      current += (i ? "/" : "") + part;
      if (i < parts.length-1) {
        const folderPath = current;
        const button = node("button", "knowledge-crumb", part);
        button.type = "button"; button.title = "Открыть папку в дереве";
        button.addEventListener("click", () => {
          const ancestors = folderPath.split("/");
          for (let j=0;j<ancestors.length;j++) collapsed.delete(ancestors.slice(0,j+1).join("/"));
          saveCollapsed(); renderTree();
          $("knowledge-tree").scrollIntoView({ behavior:"smooth", block:"nearest" });
        });
        bar.append(button);
      } else bar.append(node("strong", "", part));
    });
  }
  function updateActions() {
    const favorite = workspace.state.favorites.includes(active);
    const pinned = workspace.state.pinned.includes(active);
    $("knowledge-favorite").textContent = favorite ? "★ В избранном" : "☆ В избранное";
    $("knowledge-favorite").setAttribute("aria-pressed", String(favorite));
    $("knowledge-pin").textContent = pinned ? "⌁ Открепить" : "⌁ Закрепить";
    $("knowledge-pin").setAttribute("aria-pressed", String(pinned));
  }
  function closeTab(path) {
    return navigate(async () => {
      if (path === active) {
        await saveNow();
        if (revision > committed) {
          message("Не удалось закрыть вкладку: сохранение не завершено.", true); return false;
        }
      }
      workspace.close(path);
      if (path === active) {
        active = "";
        ui.path.textContent = "";
        ui.editor.value = "";
        loadedSha = "";
        revision = 0; committed = 0;
        const next = workspace.state.tabs.at(-1);
        if (next) await openNoteImpl(next);
        else {
          ui.panel.hidden = true;
          void window.AmayurenaKnowledgeAdvanced.update(notes, "");
          setMode("editor");
        }
      }
      renderTabs(); renderTree();
      return true;
    });
  }
  function renderTree() {
    const query = ui.search.value.trim().toLocaleLowerCase("ru");
    const visible = notes.filter(n => (n.path + "\n" + n.excerpt).toLocaleLowerCase("ru").includes(query));
    ui.tree.replaceChildren();
    const byFolder = new Map();
    const children = new Map();
    for (const folder of folders) {
      const parts = folder.split("/");
      const parent = parts.length === 1 ? "" : parts.slice(0,-1).join("/");
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(folder);
    }
    for (const note of visible) {
      if (!byFolder.has(note.folder)) byFolder.set(note.folder, []);
      byFolder.get(note.folder).push(note);
    }
    function renderFolder(parent, container, depth) {
      if (depth > 30) return;
      for (const folder of children.get(parent) || []) {
        const hasVisible = !query || visible.some(n => n.path.startsWith(folder + "/")) ||
          folder.toLocaleLowerCase("ru").includes(query);
        if (!hasVisible) continue;
        const group = node("div", "knowledge-folder-group");
        const head = node("div", "knowledge-folder-head");
        const expanded = query || !collapsed.has(folder);
        const toggle = node("button", "knowledge-folder-toggle", (expanded ? "▾ " : "▸ ") + folder.split("/").at(-1));
        toggle.type = "button";
        toggle.title = folder;
        toggle.setAttribute("aria-expanded", String(expanded));
        const tools = node("button", "knowledge-folder-move", "⋯");
        tools.type = "button";
        tools.title = "Переименовать или переместить папку";
        tools.setAttribute("aria-label", "Переместить папку " + folder);
        tools.addEventListener("click", () => { void openMove("folder", folder); });
        head.append(toggle, tools); group.append(head);
        const contents = node("div", "knowledge-folder-children");
        contents.hidden = !expanded;
        toggle.addEventListener("click", () => {
          if (collapsed.has(folder)) collapsed.delete(folder); else collapsed.add(folder);
          saveCollapsed(); renderTree();
        });
        for (const note of byFolder.get(folder) || []) contents.append(noteButton(note));
        renderFolder(folder, contents, depth+1);
        group.append(contents); container.append(group);
      }
    }
    for (const note of byFolder.get("") || []) ui.tree.append(noteButton(note));
    renderFolder("", ui.tree, 0);
    if (!notes.length) {
      const empty = node("div", "knowledge-first-start");
      empty.append(node("strong", "", "Ваша база знаний пока пуста."),
        node("p", "", "Создайте первую заметку прямо в Amayurena."));
      const begin = node("button", "btn btn-primary", "＋ Первая заметка");
      begin.type = "button"; begin.addEventListener("click", openCreateDialog);
      empty.append(begin); ui.tree.append(empty);
    } else if (!visible.length && query) ui.tree.append(node("p", "knowledge-placeholder", "Совпадений по названию нет. Проверьте результаты полнотекстового поиска."));
    ui.stats.textContent = notes.length + " заметок · " + folders.length + " папок · " + graph.edges.length + " связей";
    renderShortcuts();
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
  function storeEditorPrefs(){
    try{localStorage.setItem("amayu.editor.preferences.v2",JSON.stringify(editorPrefs));}
    catch(_){/* preferences are optional */}
  }
  function applyEditorPrefs(){
    $("knowledge-view").dataset.density=editorPrefs.density;
    $("knowledge-layout-density").value=editorPrefs.density;
    $("knowledge-editor-layout").dataset.layout=editorPrefs.split?"split":"stack";
    $("knowledge-editor-outline").hidden=!editorPrefs.outline;
    for(const [id,flag] of [["knowledge-editor-view-split",editorPrefs.split],
      ["knowledge-editor-sync",editorPrefs.sync],["knowledge-editor-outline-toggle",editorPrefs.outline]]) {
      $(id).setAttribute("aria-pressed",String(flag));
    }
    $("knowledge-editor-view-split").textContent=editorPrefs.split?"Один столбец":"Две панели";
    $("knowledge-editor-sync").textContent=editorPrefs.sync?"Прокрутка связана":"Прокрутка независимо";
    $("knowledge-editor-outline-toggle").textContent=editorPrefs.outline?"Скрыть оглавление":"Показать оглавление";
  }
  function renderOutline(){
    const nav=$("knowledge-outline-list");
    nav.replaceChildren();
    const parser=window.AmayurenaOutline;
    if(!parser)return;
    const {headings,lineCount}=parser.analyze(ui.editor.value);
    $("knowledge-editor-line-count").textContent=lineCount+" стр. · "+ui.editor.value.length+" символов";
    if(!headings.length){
      nav.append(node("p","knowledge-placeholder","Заголовки начинаются с #, ## или ###."));
      return;
    }
    for(const entry of headings.slice(0,150)){
      const button=node("button","knowledge-outline-entry",entry.title);
      button.type="button";
      button.style.paddingLeft=((entry.level-1)*10+8)+"px";
      button.title="Строка "+entry.line;
      button.addEventListener("click",()=>{
        const offset=parser.lineOffset(ui.editor.value,entry.line);
        ui.editor.focus();
        ui.editor.setSelectionRange(offset,offset);
        const ratio=offset/Math.max(1,ui.editor.value.length);
        ui.editor.scrollTop=parser.progressToPixels(ratio,ui.editor.scrollHeight,ui.editor.clientHeight);
        if(editorPrefs.sync)syncEditorToPreview();
      });
      nav.append(button);
    }
  }
  function syncEditorToPreview(){
    if(!editorPrefs.sync||syncingEditorScroll||!window.AmayurenaOutline)return;
    syncingEditorScroll=true;
    try{
      const ratio=ui.editor.scrollTop/Math.max(1,ui.editor.scrollHeight-ui.editor.clientHeight);
      ui.preview.scrollTop=window.AmayurenaOutline.progressToPixels(ratio,
        ui.preview.scrollHeight,ui.preview.clientHeight);
    }finally{syncingEditorScroll=false;}
  }
  function syncPreviewToEditor(){
    if(!editorPrefs.sync||syncingEditorScroll||!window.AmayurenaOutline)return;
    syncingEditorScroll=true;
    try{
      const ratio=ui.preview.scrollTop/Math.max(1,ui.preview.scrollHeight-ui.preview.clientHeight);
      ui.editor.scrollTop=window.AmayurenaOutline.progressToPixels(ratio,
        ui.editor.scrollHeight,ui.editor.clientHeight);
    }finally{syncingEditorScroll=false;}
  }
  async function loadAttachments(){
    const box=$("knowledge-attachment-items");
    box.replaceChildren();
    if(!active)return;
    const current=active;
    try{
      const items=await request("/api/knowledge/attachments?path="+encodeURIComponent(current));
      if(active!==current)return;
      if(!items.items.length){
        box.append(node("span","knowledge-placeholder","Вложений пока нет."));return;
      }
      for(const attachment of items.items){
        const row=node("div","knowledge-attachment-row");
        const name=node("span","",attachment.name+" · "+Math.ceil(attachment.bytes/1024)+" КиБ");
        const download=node("button","btn btn-soft","Сохранить файл");
        download.type="button";
        download.addEventListener("click",()=>{
          const anchor=document.createElement("a");
          anchor.href="/api/knowledge/attachment?id="+encodeURIComponent(attachment.id);
          anchor.download=attachment.name;
          document.body.append(anchor);anchor.click();anchor.remove();
        });
        row.append(name,download);box.append(row);
      }
    }catch(e){
      if(active===current)$("knowledge-attachment-status").textContent="Не удалось прочитать вложения: "+e.message;
    }
  }
  async function uploadAttachment(){
    const file=$("knowledge-attachment-file").files?.[0];
    $("knowledge-attachment-file").value="";
    if(!file||!active)return;
    if(file.size===0||file.size>5*1024*1024){
      $("knowledge-attachment-status").textContent="Файл должен быть от 1 байта до 5 МиБ.";return;
    }
    const path=active;
    try{
      await beforeMutation();
      if(active!==path)throw Error("За время загрузки изменилась заметка.");
      $("knowledge-attachment-status").textContent="Загружаю файл на локальный сервер…";
      const params=new URLSearchParams({path,name:file.name});
      const response=await fetch("/api/knowledge/attachment?"+params.toString(),{
        method:"POST",headers:{"Content-Type":"application/octet-stream"},body:await file.arrayBuffer()
      });
      const result=await response.json();
      if(!response.ok)throw Error(result.error||"HTTP "+response.status);
      $("knowledge-attachment-status").textContent="Прикреплено: "+result.name;
      await loadAttachments();
    }catch(e){$("knowledge-attachment-status").textContent="Вложение не сохранено: "+e.message;}
  }
  function renderPreview() {
    window.AmayurenaMarkdown.render(ui.preview, ui.editor.value,
      target => resolveLink(active, target), path => { void openNote(path); });
    renderOutline();
    syncEditorToPreview();
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
    workspace.reconcile(notes.map(n => n.path));
    renderTree(); renderBacklinks(); renderGraph(); renderTabs();
    if (active) { renderBreadcrumbs(); updateActions(); }
    void window.AmayurenaKnowledgeAdvanced.update(notes, active);
  }
  function draftKey(path) { return "amayurena.knowledge.draft." + path; }
  function keepDraft(path, value) {
    try { sessionStorage.setItem(draftKey(path), value); }
    catch (_) { message("Черновик не удалось сохранить в браузере. Скопируйте текст перед закрытием.", true); }
  }
  function clearDraft(path, value) {
    try { if (sessionStorage.getItem(draftKey(path)) === value) sessionStorage.removeItem(draftKey(path)); }
    catch (_) { /* browser storage is optional */ }
  }
  function scheduleSave() {
    if (!active) return;
    revision++;
    keepDraft(active, ui.editor.value);
    message("Ожидает сохранения…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveNow(); }, 650);
    renderPreview();
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!active || revision <= committed) return queue;
    const savedPath = active, value = ui.editor.value, version = revision;
    queue = queue.catch(() => {}).then(async () => {
      if (savedPath === active && version <= committed) return;
      message("Сохраняется…");
      try {
        const reply = await post("/api/knowledge/note", { path: savedPath, content: value, expectedSha: loadedSha });
        if (active === savedPath) {
          loadedSha = reply.sha;
          committed = Math.max(committed, version);
          clearDraft(savedPath, value);
          message(revision > version ? "Есть новые несохранённые изменения" : "Сохранено на диске");
        }
        await refresh();
      } catch (error) {
        keepDraft(savedPath, value);
        message("Не сохранено: " + error.message + " — текст остался в редакторе.", true);
      }
    });
    return queue;
  }
  function navigate(fn) {
    navigation = navigation.catch(() => {}).then(fn);
    return navigation;
  }
  function openNote(path, force = false) {
    return navigate(() => openNoteImpl(path, force));
  }
  async function openNoteImpl(path, force = false) {
    if (path === active && !force) {
      setMode("editor"); renderTabs(); updateActions(); return true;
    }
    if (!force) {
      await saveNow();
      if (active && revision > committed) {
        message("Переход отменён: текущая заметка не сохранена. Черновик сохранён в браузере.", true);
        return false;
      }
    }
    try {
      const record = await request("/api/knowledge/note?path=" + encodeURIComponent(path));
      workspace.open(record.path);
      active = record.path;
      ui.editor.value = record.content;
      loadedSha = record.sha || "";
      try {
        const unsaved = sessionStorage.getItem(draftKey(record.path));
        if (unsaved !== null && unsaved !== record.content &&
            confirm("Найден несохранённый черновик этой заметки. Восстановить его?")) {
          ui.editor.value = unsaved;
        }
      } catch (_) { /* browser storage is optional */ }
      ui.path.textContent = record.path;
      ui.panel.hidden = false;
      revision = ui.editor.value === record.content ? 0 : 1;
      committed = 0;
      renderTree(); renderPreview(); renderBacklinks(); renderGraph(); renderTabs(); renderBreadcrumbs(); updateActions();
      void window.AmayurenaKnowledgeAdvanced.update(notes, active);
      setMode("editor");
      void loadAttachments();
      if (revision) {
        keepDraft(record.path, ui.editor.value);
        message("Восстановлен черновик. Нажмите «Сохранить».");
      } else message("Готово к редактированию");
      return true;
    } catch (error) {
      message("Не удалось открыть вкладку: " + error.message, true);
      return false;
    }
  }
  async function saveAsCopy() {
    if (!active) return;
    const from = active, value = ui.editor.value;
    const suggested = from.replace(/\.md$/i, " - копия.md");
    const raw = prompt("Куда сохранить отдельную копию заметки? Укажите новое имя файла:", suggested);
    if (raw === null || !raw.trim()) return;
    const to = raw.trim();
    if (to === from) {
      message("Для копии укажите новое имя файла.", true); return;
    }
    clearTimeout(saveTimer);
    await queue;
    try {
      await post("/api/knowledge/note/create", { path: to, content: value });
      if (active !== from || ui.editor.value !== value) {
        message("Копия создана: " + to + ". Текущий черновик остался открытым.", true);
        await refresh();
        return;
      }
      await refresh();
      const loaded = await openNote(to, true);
      if (loaded) {
        clearDraft(from, value);
        message("Отдельная копия сохранена: " + to);
      } else message("Копия создана: " + to + ". Переключение не выполнено.", true);
    } catch (error) {
      message("Копия не сохранена: " + error.message + ". Текст остался в редакторе.", true);
    }
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
      const oldPath = active;
      await request("/api/knowledge/note?path=" + encodeURIComponent(oldPath), { method: "DELETE" });
      workspace.forget(oldPath);
      active = ""; ui.editor.value = ""; ui.path.textContent = ""; ui.panel.hidden = true;
      loadedSha = ""; revision = 0; committed = 0;
      await refresh(); message("Заметка перемещена в корзину.");
      const next = workspace.state.tabs.at(-1);
      if (next) await openNote(next);
    } catch (error) { message(error.message, true); }
  }

  function query(path, args) {
    const params = new URLSearchParams(args);
    return path + "?" + params.toString();
  }
  function scheduleSearch() {
    clearTimeout(searchTimer);
    const target = $("knowledge-search-results");
    const phrase = ui.search.value.trim();
    if (!phrase) { target.hidden = true; target.replaceChildren(); ++searchGeneration; return; }
    searchTimer = setTimeout(() => { void runSearch(); }, 230);
  }
  async function runSearch() {
    const target = $("knowledge-search-results");
    const phrase = ui.search.value.trim();
    if (!phrase) { target.hidden = true; target.replaceChildren(); return; }
    const token = ++searchGeneration;
    target.hidden = false;
    target.replaceChildren(node("p", "knowledge-placeholder", "Поиск по содержимому…"));
    try {
      const result = await request(query("/api/knowledge/search", { q: phrase }));
      if (token !== searchGeneration || ui.search.value.trim() !== phrase) return;
      target.replaceChildren(node("p", "knowledge-search-summary",
        result.results.length + (result.truncated ? "+" : "") + " совпадений"));
      if (!result.results.length) target.append(node("p", "knowledge-placeholder", "Совпадений нет."));
      for (const entry of result.results) {
        const button = node("button", "knowledge-search-item");
        button.type = "button";
        button.append(node("strong", "", entry.path), node("small", "", entry.snippet));
        button.addEventListener("click", () => { ui.search.value = ""; scheduleSearch(); renderTree(); void openNote(entry.path); });
        target.append(button);
      }
    } catch (e) { if (token === searchGeneration) target.replaceChildren(node("p", "knowledge-placeholder", e.message)); }
  }
  function moveError(text) {
    const target = $("knowledge-move-error");
    target.textContent = text;
    target.hidden = !text;
  }
  async function beforeMutation() {
    await saveNow();
    if (active && revision > committed) throw new Error("Текущая заметка не сохранена. Перенос и восстановление отменены.");
    if (window.AmayurenaKnowledgeAdvanced.savePending) {
      await window.AmayurenaKnowledgeAdvanced.savePending();
    }
  }
  async function openMove(kind, path) {
    try { await beforeMutation(); }
    catch (e) { message(e.message, true); return; }
    moveSource = { kind, path };
    $("knowledge-move-source").textContent =
      (kind === "folder" ? "Папка: " : "Заметка: ") + path;
    $("knowledge-move-destination").value = path;
    moveError("");
    $("knowledge-move-dialog").showModal();
    $("knowledge-move-destination").focus();
  }
  async function submitMove(event) {
    event.preventDefault();
    const button = $("knowledge-move-submit");
    if (!moveSource || button.disabled) return;
    const { kind, path: from } = moveSource;
    const to = $("knowledge-move-destination").value.trim();
    button.disabled = true;
    moveError("");
    try {
      await beforeMutation();
      const result = await post(kind === "folder" ? "/api/knowledge/folder/move" : "/api/knowledge/note/move",
        { from, to });
      const previousActive = active;
      let newActive = active;
      if (kind === "note" && active === from) newActive = to;
      else if (kind === "folder" && active.startsWith(from + "/")) newActive = to + active.slice(from.length);
      $("knowledge-move-dialog").close();
      moveSource = null;
      workspace.changePath(from, to, kind === "folder");
      await refresh();
      if (previousActive && newActive) await openNote(newActive, true);
      message("Перемещено без перезаписи: " + (result.moved || 1) + " элементов.");
    } catch (e) { moveError("Не удалось переместить: " + e.message); }
    finally { button.disabled = false; }
  }
  async function openTrash() {
    const target = $("knowledge-trash-items");
    $("knowledge-trash-dialog").showModal();
    target.replaceChildren(node("p", "knowledge-placeholder", "Загрузка корзины…"));
    try {
      const response = await request("/api/knowledge/trash");
      target.replaceChildren();
      if (!response.items.length) target.append(node("p", "knowledge-placeholder", "Корзина пуста."));
      for (const item of response.items) {
        const row = node("div", "knowledge-maintenance-row");
        row.append(node("span", "", item.path + " · " + new Date(item.deletedAt).toLocaleString("ru-RU")));
        const button = node("button", "btn btn-small btn-soft", "Восстановить");
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await beforeMutation();
            await post("/api/knowledge/trash/restore", { id: item.id });
            await refresh();
            await openTrashRefresh();
            message("Заметка восстановлена из корзины.");
          } catch (e) { message("Ошибка восстановления: " + e.message, true); }
          finally { button.disabled = false; }
        });
        row.append(button); target.append(row);
      }
    } catch (e) { target.replaceChildren(node("p", "knowledge-placeholder", e.message)); }
  }
  async function openTrashRefresh() {
    $("knowledge-trash-dialog").close();
    await openTrash();
  }
  async function listBackups() {
    const target = $("knowledge-backup-items");
    target.replaceChildren(node("p", "knowledge-placeholder", "Проверка резервных копий…"));
    try {
      const response = await request("/api/knowledge/backups");
      target.replaceChildren();
      if (!response.items.length) target.append(node("p", "knowledge-placeholder", "Резервных копий пока нет."));
      for (const item of response.items) {
        const row = node("div", "knowledge-maintenance-row");
        row.append(node("span", "", new Date(item.createdAt).toLocaleString("ru-RU") +
          " · " + item.count + " файлов · " + Math.round(item.bytes / 1024) + " КиБ"));
        const button = node("button", "btn btn-small btn-soft", "Восстановить всё");
        button.type = "button";
        button.addEventListener("click", async () => {
          if (!confirm("Полностью восстановить заметки, доски, историю и корзину из этой копии? Текущие файлы будут заменены. Перед восстановлением сделайте новую резервную копию.")) return;
          button.disabled = true;
          try {
            await beforeMutation();
            await post("/api/knowledge/backup/restore", { id: item.id, confirm: "RESTORE_BACKUP" });
            location.reload();
          } catch (e) { $("knowledge-backup-status").textContent = "Ошибка: " + e.message; }
          finally { button.disabled = false; }
        });
        row.append(button); target.append(row);
      }
    } catch (e) { target.replaceChildren(node("p", "knowledge-placeholder", e.message)); }
  }
  async function createBackup() {
    const button = $("knowledge-create-backup");
    button.disabled = true;
    $("knowledge-backup-status").textContent = "Создание локальной копии…";
    try {
      await beforeMutation();
      const data = await post("/api/knowledge/backup/create", { confirm: "CREATE_BACKUP" });
      $("knowledge-backup-status").textContent = "Копия создана: " + data.count + " файлов.";
      await listBackups();
    } catch (e) { $("knowledge-backup-status").textContent = "Ошибка: " + e.message; }
    finally { button.disabled = false; }
  }
  function formatEditor(action) {
    if (!active) return;
    const editor = ui.editor;
    try {
      const result = window.AmayurenaEditorTools.formatSelection(editor.value,
        editor.selectionStart, editor.selectionEnd, action);
      editor.value = result.content;
      editor.focus();
      editor.setSelectionRange(result.start, result.end);
      scheduleSave();
    } catch (err) { message(err.message, true); }
  }
  function focusSearch() {
    const search = ui.search;
    search.focus();
    search.select();
    if (window.matchMedia && window.matchMedia("(max-width: 740px)").matches) {
      search.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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
      applyEditorPrefs();
      $("knowledge-layout-density").addEventListener("change",e=>{
        editorPrefs.density=e.target.value==="compact"?"compact":"comfortable";
        storeEditorPrefs();applyEditorPrefs();
      });
      for(const [id,key] of [["knowledge-editor-view-split","split"],["knowledge-editor-sync","sync"],
        ["knowledge-editor-outline-toggle","outline"]]){
        $(id).addEventListener("click",()=>{
          editorPrefs[key]=!editorPrefs[key];storeEditorPrefs();applyEditorPrefs();
        });
      }
      ui.editor.addEventListener("scroll",syncEditorToPreview,{passive:true});
      ui.preview.addEventListener("scroll",syncPreviewToEditor,{passive:true});
      $("knowledge-attachment-add").addEventListener("click",()=>$("knowledge-attachment-file").click());
      $("knowledge-attachment-file").addEventListener("change",()=>{void uploadAttachment();});
      ui.editor.addEventListener("input", scheduleSave);
      ui.editor.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveNow(); }
      });
      ui.search.addEventListener("input", () => { renderTree(); scheduleSearch(); });
      $("knowledge-favorite").addEventListener("click", () => {
        if (!active) return;
        workspace.favorite(active); renderTree(); renderTabs(); updateActions();
      });
      $("knowledge-pin").addEventListener("click", () => {
        if (!active) return;
        workspace.pin(active); renderTree(); renderTabs(); updateActions();
      });
      $("knowledge-tab-close").addEventListener("click", () => { if (active) void closeTab(active); });
      $("knowledge-format-toolbar").addEventListener("click", event => {
        const button = event.target.closest("[data-format]");
        if (button) formatEditor(button.dataset.format);
      });
      document.addEventListener("keydown", event => {
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === "k") { event.preventDefault(); focusSearch(); }
        else if (key === "tab" && workspace.state.tabs.length > 1) {
          event.preventDefault();
          const index = workspace.state.tabs.indexOf(active);
          const delta = event.shiftKey ? -1 : 1;
          const next = workspace.state.tabs[(index + delta + workspace.state.tabs.length) % workspace.state.tabs.length];
          if (next) void openNote(next);
        } else if (event.target === ui.editor) {
          if (key === "b") { event.preventDefault(); formatEditor("bold"); }
          if (key === "i") { event.preventDefault(); formatEditor("italic"); }
        }
      });
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
      $("knowledge-rename").addEventListener("click", () => { if (active) void openMove("note", active); });
      $("knowledge-move-form").addEventListener("submit", e => { void submitMove(e); });
      $("knowledge-move-cancel").addEventListener("click", () => $("knowledge-move-dialog").close());
      $("knowledge-trash-button").addEventListener("click", () => { void openTrash(); });
      $("knowledge-trash-close").addEventListener("click", () => $("knowledge-trash-dialog").close());
      $("knowledge-backups-button").addEventListener("click", () => {
        $("knowledge-backups-dialog").showModal(); void listBackups();
      });
      $("knowledge-backups-close").addEventListener("click", () => $("knowledge-backups-dialog").close());
      $("knowledge-create-backup").addEventListener("click", () => { void createBackup(); });
      window.addEventListener("beforeunload", e => {
        if (active && revision > committed) { e.preventDefault(); e.returnValue = ""; }
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && active && revision > committed) void saveNow();
      });
      window.addEventListener("online", () => { if (active && revision > committed) void saveNow(); });
      ui.save.addEventListener("click", () => { void saveNow(); });
      $("knowledge-save-copy").addEventListener("click", () => { void saveAsCopy(); });
      ui.mode.addEventListener("click", () => setMode(ui.mode.dataset.current === "graph" ? "editor" : "graph"));
    }
    try {
      await refresh();
      if (!active && workspace.state.tabs.length) await openNote(workspace.state.tabs.at(-1));
      if (revision <= committed) message("База знаний доступна локально.");
    }
    catch (error) { message("Не удалось открыть хранилище: " + error.message, true); }
  }
  async function beforeInsightsWrite() {
    await saveNow();
    if(active && revision>committed) throw Error("Есть несохранённый текст. Сначала сохраните заметку.");
    await window.AmayurenaKnowledgeAdvanced.savePending();
  }
  async function reloadInsightsSource(path) {
    if(active===path) {
      await openNote(path,true);
      window.AmayurenaKnowledgeAdvanced.show("insights");
    } else await refresh();
  }
  window.AmayurenaKnowledge = { open, openNote, beforeInsightsWrite, reloadInsightsSource };
})();
