(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TOOL_LABELS = {
    text_statistics: "Статистика текста", calculate: "Калькулятор", current_time_utc: "Время UTC"
  };
  const sessions = window.AmayurenaSessions;
  const MAX_CHAT = sessions.MAX_MESSAGES, MAX_TASKS = 30;
  const d = {
    catalog: $("agent-catalog-panel"), view: $("agent-workspace"),
    back: $("workspace-back"), name: $("workspace-name"), meta: $("workspace-meta"),
    connection: $("workspace-connection"), error: $("workspace-error"),
    chatHistory: $("workspace-chat-history"), chatForm: $("workspace-chat-form"),
    chatInput: $("workspace-chat-input"), chatSend: $("workspace-chat-send"),
    clearChat: $("workspace-clear-chat"),
    chatSelect: $("workspace-chat-select"), newChat: $("workspace-new-chat"),
    deleteChat: $("workspace-delete-chat"), renameChat: $("workspace-rename-chat"),
    chatSearch: $("workspace-chat-search"), cancelChat: $("workspace-chat-cancel"),
    usage: $("workspace-usage"), diagnostics: $("workspace-diagnostics"), executionLog: $("workspace-execution-log"),
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
  let chatBook = null;
  let activeRequest = null;

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
  function activeSession() {return chatBook?.sessions.find(x=>x.id===chatBook.current);}
  function storeBook(id) {
    const current=activeSession();
    if(current)current.messages=data.chat.slice(-MAX_CHAT);
    chatBook.tasks=data.tasks.slice(-MAX_TASKS);
    try {
      chatBook=sessions.store(localStorage,id).save(chatBook);
      return true;
    }catch(_){
      error("Не удалось сохранить диалоги. Проверьте место в хранилище браузера.");
      return false;
    }
  }
  function loadHistory(id) {
    try {
      chatBook=sessions.store(localStorage,id).load();
      if(!chatBook.current) {
        chatBook=sessions.create(chatBook,"Новый диалог", "chat_"+Date.now().toString(36));
      }
      const current=activeSession();
      return {chat:current?.messages.slice(-MAX_CHAT)||[],tasks:chatBook.tasks.slice(-MAX_TASKS)};
    }catch(e){
      error("История диалогов недоступна: "+e.message);
      chatBook=sessions.create(sessions.empty(),"Новый диалог","chat_"+Date.now().toString(36));
      return {chat:[],tasks:[]};
    }
  }
  function saveHistory(id,next) {
    data=next;
    return storeBook(id);
  }
  function renderDialogs() {
    d.chatSelect.replaceChildren();
    for(const entry of chatBook?.sessions||[]){
      const option=el("option","",entry.title);
      option.value=entry.id;
      d.chatSelect.append(option);
    }
    d.chatSelect.value=chatBook?.current||"";
    d.deleteChat.disabled=busy||!chatBook?.current;
    d.renameChat.disabled=busy||!chatBook?.current;
  }
  function selectSession(id){
    if(!agent||busy||!chatBook?.sessions.some(s=>s.id===id))return;
    storeBook(agent.id);
    chatBook.current=id;
    data.chat=activeSession().messages.slice();
    d.chatSearch.value="";
    storeBook(agent.id);
    renderDialogs();renderChat();
  }
  function newSession(){
    if(!agent||busy)return;
    storeBook(agent.id);
    try{
      chatBook=sessions.create(chatBook,"Новый диалог","chat_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6));
      data.chat=[];
      storeBook(agent.id);renderDialogs();renderChat();
    }catch(e){error(e.message);}
  }
  function deleteSession(){
    if(!agent||busy||!chatBook?.current||!confirm("Удалить текущий диалог без возможности восстановления?"))return;
    chatBook=sessions.remove(chatBook,chatBook.current);
    if(!chatBook.current) chatBook=sessions.create(chatBook,"Новый диалог","chat_"+Date.now().toString(36));
    data.chat=activeSession().messages.slice();
    storeBook(agent.id);renderDialogs();renderChat();
  }
  function renameSession(){
    if(!agent||busy)return;
    const current=activeSession();
    if(!current)return;
    const title=prompt("Название диалога:",current.title);
    if(title===null)return;
    if(!title.trim()||title.trim().length>80){error("Имя диалога: от 1 до 80 символов.");return;}
    current.title=title.trim();
    storeBook(agent.id);renderDialogs();
  }
  function time(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("ru-RU");
  }
  function renderExecutionLog(){
    d.executionLog.replaceChildren();
    const events=(chatBook?.log||[]).slice(-25).reverse();
    if(!events.length){
      d.executionLog.append(el("p","workspace-placeholder","Событий выполнения пока нет."));
      return;
    }
    const labels={
      agent_enabled:"Агент включён",agent_disabled:"Агент остановлен",
      chat_ok:"Диалог: ответ получен",chat_error:"Диалог: ошибка",
      chat_cancel:"Диалог: ожидание отменено",task_ok:"Задача завершена",
      task_error:"Задача не завершена",tool_ok:"Инструмент выполнен",tool_error:"Ошибка инструмента"
    };
    for(const event of events){
      const row=el("div","workspace-execution-entry");
      row.append(el("strong","",labels[event.kind]||event.kind));
      let details=time(event.at);
      if(event.model)details+=" · "+event.model;
      if(Number.isFinite(event.elapsedMs))details+=" · "+(event.elapsedMs/1000).toFixed(1)+" с";
      if(Number.isFinite(event.inputTokens))details+=" · вход "+event.inputTokens+" токенов";
      if(Number.isFinite(event.outputTokens))details+=" · выход "+event.outputTokens+" токенов";
      if(event.tool)details+=" · "+(TOOL_LABELS[event.tool]||event.tool);
      row.append(el("small","",details));
      d.executionLog.append(row);
    }
  }
  function recordExecution(kind,details={}){
    if(!agent||!chatBook)return;
    try{
      chatBook=sessions.recordEvent(chatBook,kind,details);
      storeBook(agent.id);
      renderExecutionLog();
    }catch(_){
      error("Не удалось записать событие в локальный журнал.");
    }
  }
  function renderChat() {
    d.chatHistory.replaceChildren();
    if (!data.chat.length) d.chatHistory.append(el("p", "workspace-placeholder", "Здесь появится диалог с агентом."));
    const phrase=d.chatSearch.value.trim().toLocaleLowerCase("ru");
    for (const msg of data.chat.filter(m=>!phrase||m.content.toLocaleLowerCase("ru").includes(phrase))) {
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
    d.cancelChat.hidden = !value;
    d.chatSelect.disabled=value;
    d.newChat.disabled=value;
    d.deleteChat.disabled=value;
    d.renameChat.disabled=value;
  }
  async function requestJson(endpoint, body, signal) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal
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
    error("");
    data = loadHistory(config.id);
    renderDialogs();
    d.chatSearch.value="";
    d.diagnostics.textContent="Для новой сессии пока нет запросов.";
    d.usage.textContent="Расходы в валюте не вычисляются без подтверждённого тарифа Cloud.ru.";
    d.catalog.hidden = true;
    d.view.hidden = false;
    d.name.textContent = config.name;
    d.meta.textContent = (config.role || "Универсальный") + " · Модель: " + (config.model || "endpoint-selected");
    d.chatInput.value = "";
    d.taskInput.value = "";
    renderChat(); renderTasks(); renderTools(); renderExecutionLog();
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
    if (!agent || busy || !configured || agent.enabled===false) return;
    const prompt = inputElement.value.trim();
    if (!prompt || prompt.length > 12000) { error("Введите сообщение или задачу длиной до 12000 символов."); return; }
    const current = agent;
    const token = generation;
    const history = mode === "chat"
      ? data.chat.slice(-16).map(m => ({ role: m.role, content: m.content.slice(0, 12000) })) : [];
    setBusy(true);
    const started=Date.now();
    const controller=new AbortController();
    activeRequest=controller;
    error("");
    setConnection("pending", "Модель отвечает…");
    try {
      const result = await requestJson("/api/chat", {
        agent: { name: current.name, role: current.role, instructions: current.instructions,
          model: current.model || "", enabledTools: current.enabledTools || [] },
        mode, input: prompt, history
      },controller.signal);
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
      recordExecution(mode==="chat"?"chat_ok":"task_ok",{
        model:result.model,elapsedMs:Date.now()-started,
        inputTokens:result.usage?.prompt_tokens,outputTokens:result.usage?.completion_tokens
      });
      const elapsed=(Date.now()-started)/1000;
      const usage=result.usage;
      d.diagnostics.textContent="Модель: "+(result.model||current.model||"не указана")+
        " · ответ за "+elapsed.toFixed(1)+" с · инструменты: "+(result.toolsUsed?.length||0);
      d.usage.textContent=usage?
        "Токены по данным провайдера: вход "+usage.prompt_tokens+", выход "+usage.completion_tokens+
          ". Денежная стоимость не рассчитана (нет тарифа).":
        "Cloud.ru не вернул токены; стоимость вычислить невозможно.";
      inputElement.value = "";
    } catch (e) {
      if (token === generation) {
        recordExecution(e.name==="AbortError"?"chat_cancel":(mode==="chat"?"chat_error":"task_error"),{
          model:current.model,elapsedMs:Date.now()-started
        });
        error(e.name==="AbortError"?"Ожидание ответа отменено пользователем. Серверный запрос может ещё выполняться.":(e.message||"Ошибка запуска."));
        d.diagnostics.textContent="Ошибка после "+((Date.now()-started)/1000).toFixed(1)+" с: "+(e.name||"ответ не получен");
      }
    } finally {
      if(activeRequest===controller)activeRequest=null;
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
      if (token === generation) {
        d.toolResult.textContent = JSON.stringify(response.result, null, 2);
        recordExecution("tool_ok",{tool:name});
      }
    } catch (e) { if (token === generation) { error(e.message);recordExecution("tool_error",{tool:name}); } }
    finally { if (token === generation) setBusy(false); }
  }

  function init(callback) {
    onBack = callback;
    d.back.addEventListener("click", () => { closeAgent(); onBack(); });
    d.chatForm.addEventListener("submit", event => { event.preventDefault(); submit("chat", d.chatInput); });
    d.taskForm.addEventListener("submit", event => { event.preventDefault(); submit("task", d.taskInput); });
    d.toolForm.addEventListener("submit", event => { event.preventDefault(); runTool(); });
    d.toolSelect.addEventListener("change", updateToolFields);
    d.chatSelect.addEventListener("change",e=>selectSession(e.target.value));
    d.newChat.addEventListener("click",newSession);
    d.deleteChat.addEventListener("click",deleteSession);
    d.renameChat.addEventListener("click",renameSession);
    d.chatSearch.addEventListener("input",renderChat);
    d.cancelChat.addEventListener("click",()=>{activeRequest?.abort();});
    d.clearChat.addEventListener("click", () => {
      if (!agent || busy || !data.chat.length || !confirm("Очистить диалог этого агента?")) return;
      const next = { ...data, chat: [] };
      if (saveHistory(agent.id, next)) { data = next; renderChat(); }
    });
  }
  window.AmayurenaWorkspace = { init, openAgent, closeAgent };
})();
