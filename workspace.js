(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TOOL_LABELS = {
    text_statistics: "Статистика текста", calculate: "Калькулятор", current_time_utc: "Время UTC"
  };
  const HISTORY_PREFIX = "amayurena.workspace.v1.";
  const MAX_CHAT = 40, MAX_TASKS = 30;
  const d = {
    catalog: $("agent-catalog-panel"), view: $("agent-workspace"),
    back: $("workspace-back"), name: $("workspace-name"), meta: $("workspace-meta"),
    connection: $("workspace-connection"), error: $("workspace-error"),
    chatHistory: $("workspace-chat-history"), chatForm: $("workspace-chat-form"),
    chatInput: $("workspace-chat-input"), chatSend: $("workspace-chat-send"),
    clearChat: $("workspace-clear-chat"),
    taskHistory: $("workspace-task-history"), taskForm: $("workspace-task-form"),
    taskInput: $("workspace-task-input"), taskRun: $("workspace-task-run"),
    toolForm: $("workspace-tool-form"), toolSelect: $("workspace-tool-select"),
    toolText: $("workspace-tool-text"), toolTextArea: $("workspace-text-tool"),
    toolMathArea: $("workspace-math-tool"), mathA: $("workspace-math-a"),
    mathB: $("workspace-math-b"), mathOperation: $("workspace-math-operation"),
    toolRun: $("workspace-tool-run"), toolInfo: $("workspace-tools-info"),
    toolResult: $("workspace-tool-result")
  };
  let agent = null;
  let data = { chat: [], tasks: [] };
  let busy = false;
  let configured = false;
  let generation = 0;
  let onBack = () => {};

  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function error(text) { d.error.textContent = text; d.error.hidden = !text; }
  function setConnection(state, text) {
    d.connection.dataset.state = state;
    d.connection.textContent = text;
  }
  function key(id) { return HISTORY_PREFIX + id; }
  function validChat(m) {
    return m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" &&
      m.content.length <= 16000 && typeof m.at === "string";
  }
  function validTask(t) {
    return t && typeof t.input === "string" && t.input.length <= 12000 &&
      typeof t.reply === "string" && t.reply.length <= 16000 &&
      typeof t.at === "string";
  }
  function loadHistory(id) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key(id)) || "{}");
      return { chat: Array.isArray(parsed.chat) ? parsed.chat.filter(validChat).slice(-MAX_CHAT) : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(validTask).slice(-MAX_TASKS) : [] };
    } catch (_) {
      error("Не удалось прочитать историю в этом браузере.");
      return { chat: [], tasks: [] };
    }
  }
  function saveHistory(id, next) {
    try {
      localStorage.setItem(key(id), JSON.stringify(next));
      return true;
    } catch (_) {
      error("Не удалось сохранить историю. Проверьте доступ к локальному хранилищу или освободите место.");
      return false;
    }
  }
  function time(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("ru-RU");
  }
  function renderChat() {
    d.chatHistory.replaceChildren();
    if (!data.chat.length) d.chatHistory.append(el("p", "workspace-placeholder", "Здесь появится диалог с агентом."));
    for (const msg of data.chat) {
      const item = el("div", "message message-" + msg.role);
      item.append(el("strong", "message-sender", msg.role === "user" ? "Вы" : agent.name));
      item.append(el("p", "message-body", msg.content));
      item.append(el("span", "message-time", time(msg.at)));
      d.chatHistory.append(item);
    }
    d.chatHistory.scrollTop = d.chatHistory.scrollHeight;
  }
  function renderTasks() {
    d.taskHistory.replaceChildren();
    if (!data.tasks.length) d.taskHistory.append(el("p", "workspace-placeholder", "Задачи ещё не запускались."));
    for (const task of [...data.tasks].reverse()) {
      const item = el("article", "task-log-entry");
      item.append(el("span", "task-time", time(task.at)),
        el("h4", "", task.input), el("p", "", task.reply));
      if (task.tools && task.tools.length) {
        item.append(el("small", "tool-use-label", "Использованы: " + task.tools.map(t => TOOL_LABELS[t.name] || t.name).join(", ")));
      }
      d.taskHistory.append(item);
    }
  }
  function renderTools() {
    const names = agent.enabledTools || [];
    d.toolSelect.replaceChildren(...names.map(name => {
      const opt = el("option", "", TOOL_LABELS[name]); opt.value = name; return opt;
    }));
    d.toolInfo.textContent = names.length
      ? "Разрешено: " + names.map(name => TOOL_LABELS[name]).join(" · ")
      : "Инструменты выключены. Включите их в настройках агента.";
    d.toolForm.hidden = !names.length;
    d.toolResult.textContent = "";
    updateToolFields();
  }
  function updateToolFields() {
    const name = d.toolSelect.value;
    d.toolTextArea.hidden = name !== "text_statistics";
    d.toolMathArea.hidden = name !== "calculate";
  }
  function setBusy(value) {
    busy = value;
    d.chatSend.disabled = value || !configured;
    d.taskRun.disabled = value || !configured;
    d.toolRun.disabled = value;
    d.clearChat.disabled = value;
  }
  async function requestJson(endpoint, body) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error("Сервер вернул некорректный ответ."); }
    if (!response.ok) throw new Error(result.error || "Ошибка сервера (HTTP " + response.status + ")");
    return result;
  }
  async function checkConnection(token) {
    try {
      if (location.protocol === "file:") throw new Error("Запустите Amayurena.bat вместо открытия index.html.");
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Сервер недоступен.");
      const status = await response.json();
      if (token !== generation) return;
      configured = status.configured === true;
      setConnection(configured ? "ready" : "offline",
        configured ? "Cloud.ru настроен" : "Cloud.ru не настроен");
      if (!configured) error("Чтобы отправлять сообщения, задайте AMAYURENA_API_BASE_URL и AMAYURENA_API_KEY и перезапустите сервер.");
    } catch (e) {
      if (token !== generation) return;
      configured = false;
      setConnection("offline", "Сервер недоступен");
      error(e.message);
    }
    if (token === generation) setBusy(false);
  }
  function openAgent(config) {
    generation++;
    agent = config;
    configured = false;
    busy = false;
    data = loadHistory(config.id);
    d.catalog.hidden = true;
    d.view.hidden = false;
    d.name.textContent = config.name;
    d.meta.textContent = (config.role || "Универсальный") + " · Модель: " + (config.model || "endpoint-selected");
    d.chatInput.value = "";
    d.taskInput.value = "";
    error("");
    renderChat(); renderTasks(); renderTools();
    setConnection("pending", "Проверка подключения…");
    setBusy(false);
    checkConnection(generation);
    d.back.focus();
  }
  function closeAgent() {
    generation++;
    agent = null;
    d.view.hidden = true;
    d.catalog.hidden = false;
    configured = false;
  }
  async function submit(mode, inputElement) {
    if (!agent || busy || !configured) return;
    const prompt = inputElement.value.trim();
    if (!prompt || prompt.length > 12000) { error("Введите сообщение или задачу длиной до 12000 символов."); return; }
    const current = agent;
    const token = generation;
    const history = mode === "chat"
      ? data.chat.slice(-16).map(m => ({ role: m.role, content: m.content })) : [];
    setBusy(true);
    error("");
    setConnection("pending", "Модель отвечает…");
    try {
      const result = await requestJson("/api/chat", {
        agent: { name: current.name, role: current.role, instructions: current.instructions,
          model: current.model || "", enabledTools: current.enabledTools || [] },
        mode, input: prompt, history
      });
      if (token !== generation || !agent || agent.id !== current.id) return;
      const at = new Date().toISOString();
      if (mode === "chat") {
        data.chat.push({ role: "user", content: prompt, at }, { role: "assistant", content: result.reply, at });
        data.chat = data.chat.slice(-MAX_CHAT);
        renderChat();
      } else {
        data.tasks.push({ input: prompt, reply: result.reply, tools: result.toolsUsed, at });
        data.tasks = data.tasks.slice(-MAX_TASKS);
        renderTasks();
      }
      saveHistory(current.id, data);
      inputElement.value = "";
    } catch (e) {
      if (token === generation) error(e.message || "Ошибка запуска.");
    } finally {
      if (token === generation) {
        setConnection(configured ? "ready" : "offline", configured ? "Cloud.ru настроен" : "Cloud.ru не настроен");
        setBusy(false);
      }
    }
  }
  async function runTool() {
    if (!agent || busy) return;
    const name = d.toolSelect.value;
    if (!(agent.enabledTools || []).includes(name)) return;
    let args = {};
    if (name === "text_statistics") args.text = d.toolText.value;
    if (name === "calculate") {
      if (!d.mathA.value.trim() || !d.mathB.value.trim()) { error("Введите оба числа."); return; }
      args = { a: Number(d.mathA.value), b: Number(d.mathB.value), operation: d.mathOperation.value };
    }
    const token = generation;
    setBusy(true); error("");
    try {
      const response = await requestJson("/api/tools", { name, args });
      if (token === generation) d.toolResult.textContent = JSON.stringify(response.result, null, 2);
    } catch (e) { if (token === generation) error(e.message); }
    finally { if (token === generation) setBusy(false); }
  }

  function init(callback) {
    onBack = callback;
    d.back.addEventListener("click", () => { closeAgent(); onBack(); });
    d.chatForm.addEventListener("submit", event => { event.preventDefault(); submit("chat", d.chatInput); });
    d.taskForm.addEventListener("submit", event => { event.preventDefault(); submit("task", d.taskInput); });
    d.toolForm.addEventListener("submit", event => { event.preventDefault(); runTool(); });
    d.toolSelect.addEventListener("change", updateToolFields);
    d.clearChat.addEventListener("click", () => {
      if (!agent || busy || !data.chat.length || !confirm("Очистить диалог этого агента?")) return;
      const next = { ...data, chat: [] };
      if (saveHistory(agent.id, next)) { data = next; renderChat(); }
    });
  }
  window.AmayurenaWorkspace = { init, openAgent, closeAgent };
})();
