(function () {
  "use strict";

  const core = window.AmayurenaAgents;
  const $ = (id) => document.getElementById(id);
  const dom = {
    home: $("home-view"), agentsView: $("agents-view"), knowledge: $("knowledge-view"), pageTitle: $("page-title"),
    navCount: $("nav-count"), homeCount: $("home-agent-count"),
    grid: $("agent-grid"), empty: $("empty-agents"), emptyTitle: $("empty-title"),
    emptySubtitle: $("empty-subtitle"), emptyCreate: $("empty-create"),
    search: $("agent-search"), resultCount: $("result-count"),
    dialog: $("agent-dialog"), form: $("agent-form"), dialogHeading: $("dialog-heading"),
    name: $("agent-name"), role: $("agent-role"), description: $("agent-description"),
    instructions: $("agent-instructions"), model: $("agent-model"), formError: $("form-error"),
    toast: $("toast"), warning: $("storage-warning"), importFile: $("import-file")
  };
  let agents = [];
  let editingId = null;
  let storageHealthy = true;
  let toastTimer = null;

  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3200);
  }

  function showStorageWarning(detail) {
    storageHealthy = false;
    dom.warning.textContent = "Хранилище браузера недоступно или повреждено. Изменения не будут сохранены. " + detail;
    dom.warning.hidden = false;
  }

  function readCatalog() {
    try {
      const content = localStorage.getItem(core.STORAGE_KEY);
      return content ? core.parseBackup(content) : [];
    } catch (error) {
      showStorageWarning(error.message || "");
      return [];
    }
  }

  function saveCatalog(next) {
    if (!storageHealthy) {
      showToast("Сохранение недоступно: проверьте хранилище браузера.");
      return false;
    }
    try {
      localStorage.setItem(core.STORAGE_KEY, core.makeBackup(next));
      agents = next;
      refresh();
      return true;
    } catch (error) {
      showStorageWarning(error.message || "");
      showToast("Не удалось сохранить каталог.");
      return false;
    }
  }

  function navigate(page) {
    const target = ["home", "agents", "knowledge"].includes(page) ? page : "home";
    window.AmayurenaWorkspace.closeAgent();
    dom.home.hidden = target !== "home";
    dom.agentsView.hidden = target !== "agents";
    dom.knowledge.hidden = target !== "knowledge";
    if (target === "knowledge") void window.AmayurenaKnowledge.open();
    dom.pageTitle.textContent = target === "agents" ? "Агенты" : target === "knowledge" ? "Знания" : "Главная";
    document.title = (target === "agents" ? "Агенты" : target === "knowledge" ? "Знания" : "Главная") + " — Amayurena";
    for (const link of document.querySelectorAll(".nav-link")) {
      const active = link.dataset.page === target;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function setPage(page) {
    const hash = ["home", "agents", "knowledge"].includes(page) ? "#" + page : "#home";
    if (location.hash !== hash) location.hash = hash;
    else navigate(page);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, className, handler, aria) {
    const button = element("button", className, label);
    button.type = "button";
    if (aria) button.setAttribute("aria-label", aria);
    button.addEventListener("click", handler);
    return button;
  }

  function renderCard(agent) {
    const card = element("article", "agent-card");
    const header = element("div", "agent-card-top");
    const monogram = element("div", "agent-avatar", agent.name.slice(0, 1).toLocaleUpperCase("ru"));
    monogram.setAttribute("aria-hidden", "true");
    header.append(monogram, element("span", "agent-status", agent.enabled===false ? "Остановлен" : "Готов к запуску"));
    card.append(header, element("h3", "agent-name", agent.name), element("div", "agent-role", agent.role));
    card.append(element("p", "agent-description", agent.description || "Описание пока не добавлено."));
    const footer = element("div", "agent-card-footer");
    const meta = element("span", "agent-date", "Изменён: " + new Date(agent.updatedAt).toLocaleDateString("ru-RU"));
    const actions = element("div", "card-actions");
    actions.append(
      actionButton(agent.enabled===false?"Запустить":"Остановить", "btn btn-small btn-soft",
        () => toggleAgent(agent.id), "Сменить состояние "+agent.name),
      actionButton("Открыть", "btn btn-small btn-primary", () => openWorkspace(agent.id), "Открыть " + agent.name),
      actionButton("Изменить", "btn btn-small btn-soft", () => openEditor(agent.id), "Изменить " + agent.name),
      actionButton("Удалить", "btn btn-small btn-danger", () => removeAgent(agent.id), "Удалить " + agent.name)
    );
    footer.append(meta, actions);
    card.append(footer);
    return card;
  }

  function toggleAgent(id) {
    const current=agents.find(a=>a.id===id);
    if(!current)return;
    const enabled=current.enabled===false;
    const next=agents.map(a=>a.id===id?{...a,enabled,updatedAt:new Date().toISOString()}:a);
    if(saveCatalog(next)) {
      try {
        const store=window.AmayurenaSessions.store(localStorage,id);
        const book=store.load();
        store.save(window.AmayurenaSessions.recordEvent(book,enabled?"agent_enabled":"agent_disabled"));
      }catch(_){showToast("Статус агента изменён, но событие не записано в журнал.");}
      if(!enabled)window.AmayurenaWorkspace.closeAgent();
      showToast(enabled?"Агент включён для ручных запросов.":"Агент остановлен. Фоновые процессы не запускаются.");
    }
  }
  function refresh() {
    const visible = core.filterAgents(agents, dom.search.value);
    dom.homeCount.textContent = String(agents.length);
    dom.navCount.textContent = String(agents.length);
    dom.resultCount.textContent = visible.length + " из " + agents.length;
    dom.grid.replaceChildren(...visible.map(renderCard));
    dom.empty.hidden = visible.length !== 0;
    if (visible.length === 0) {
      const filtered = dom.search.value.trim().length > 0;
      dom.emptyTitle.textContent = filtered ? "Ничего не найдено" : "Здесь появятся ваши агенты";
      dom.emptySubtitle.textContent = filtered
        ? "Попробуйте другое имя, роль или описание."
        : "Создайте первого агента, назначьте ему роль и сохраните инструкции.";
      dom.emptyCreate.hidden = filtered;
    }
  }

  function openWorkspace(id) {
    const selected = agents.find(item => item.id === id);
    if (!selected) return;
    if(selected.enabled===false){showToast("Сначала включите агента.");return;}
    if (location.hash !== "#agents") history.replaceState(null, "", "#agents");
    navigate("agents");
    window.AmayurenaWorkspace.openAgent(selected);
    dom.pageTitle.textContent = selected.name;
    document.title = selected.name + " — Amayurena";
  }

  function openEditor(id) {
    const agent = id ? agents.find((item) => item.id === id) : null;
    if (id && !agent) return;
    editingId = agent ? agent.id : null;
    dom.form.reset();
    dom.formError.hidden = true;
    dom.dialogHeading.textContent = agent ? "Редактировать агента" : "Новый агент";
    dom.name.value = agent ? agent.name : "";
    dom.role.value = agent ? agent.role : "";
    dom.description.value = agent ? agent.description : "";
    dom.instructions.value = agent ? agent.instructions : "";
    dom.model.value = agent ? (agent.model || "") : "";
    $("agent-enabled").checked = !agent || agent.enabled !== false;
    for (const toolName of core.AVAILABLE_TOOLS) {
      $("tool-" + toolName).checked = !!agent && (agent.enabledTools || []).includes(toolName);
    }
    dom.dialog.showModal();
    dom.name.focus();
  }

  function closeEditor() {
    dom.dialog.close();
    editingId = null;
  }

  function handleSubmit(event) {
    event.preventDefault();
    dom.formError.hidden = true;
    const old = editingId ? agents.find((item) => item.id === editingId) : null;
    if (editingId && !old) return;
    try {
      const draft = core.normalizeAgent({
        name: dom.name.value, role: dom.role.value,
        description: dom.description.value, instructions: dom.instructions.value,
        model: dom.model.value, enabled: $("agent-enabled").checked,
        enabledTools: core.AVAILABLE_TOOLS.filter(name => $("tool-" + name).checked)
      }, old ? { id: old.id, createdAt: old.createdAt } : undefined);
      if (!old && agents.length >= core.MAX_AGENTS) {
        throw new Error("Достигнут лимит в " + core.MAX_AGENTS + " агентов.");
      }
      const next = old
        ? agents.map((item) => item.id === old.id ? draft : item)
        : [draft, ...agents];
      if (saveCatalog(next)) {
        closeEditor();
        showToast(old ? "Изменения сохранены." : "Агент создан.");
      }
    } catch (error) {
      dom.formError.textContent = error.message;
      dom.formError.hidden = false;
    }
  }

  function removeAgent(id) {
    const found = agents.find((item) => item.id === id);
    if (!found || !confirm("Удалить агента «" + found.name + "»? Это действие нельзя отменить.")) return;
    if (saveCatalog(agents.filter((item) => item.id !== id))) showToast("Агент удалён.");
  }

  function exportCatalog() {
    const blob = new Blob([core.makeBackup(agents)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "amayurena-agents-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Резервная копия подготовлена.");
  }

  async function importCatalog(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast("Файл слишком большой (максимум 5 МБ).");
      return;
    }
    try {
      const imported = core.parseBackup(await file.text());
      if (!confirm("Заменить текущие " + agents.length + " агентов данными из файла (" + imported.length + ")? Сначала экспортируйте резервную копию.")) return;
      if (saveCatalog(imported)) showToast("Каталог восстановлен: " + imported.length + " агентов.");
    } catch (error) {
      showToast("Импорт отклонён: " + error.message);
    }
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => setPage(link.dataset.page));
  });
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
  $("go-agents").addEventListener("click", () => setPage("agents"));
  $("create-agent").addEventListener("click", () => openEditor());
  dom.emptyCreate.addEventListener("click", () => openEditor());
  $("close-dialog").addEventListener("click", closeEditor);
  $("cancel-dialog").addEventListener("click", closeEditor);
  dom.form.addEventListener("submit", handleSubmit);
  dom.search.addEventListener("input", refresh);
  $("export-agents").addEventListener("click", exportCatalog);
  $("import-agents").addEventListener("click", () => dom.importFile.click());
  dom.importFile.addEventListener("change", importCatalog);
  dom.dialog.addEventListener("close", () => { editingId = null; });

  window.addEventListener("amayurena:avatar-action", event => {
    const action = event.detail && event.detail.action;
    if (action === "agents-chat") {
      navigate("agents");
      if (agents.length) openWorkspace(agents[0].id);
      else showToast("Сначала создайте первого агента для чата.");
      return;
    }
    if (action === "agents" || action === "home") navigate(action);
  });
  window.AmayurenaWorkspace.init(() => navigate("agents"));
  agents = readCatalog();
  navigate(location.hash.slice(1));
  refresh();
})();
