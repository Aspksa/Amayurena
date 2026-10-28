"use strict";

const TOOL_DEFS = Object.freeze([
  { type: "function", function: {
    name: "text_statistics", description: "Подсчитать слова, символы и строки в переданном тексте.",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "Текст для подсчёта (до 8000 символов)" }
    }, required: ["text"], additionalProperties: false }
  }},
  { type: "function", function: {
    name: "calculate", description: "Выполнить одну точную базовую арифметическую операцию.",
    parameters: { type: "object", properties: {
      operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      a: { type: "number" }, b: { type: "number" }
    }, required: ["operation", "a", "b"], additionalProperties: false }
  }},
  { type: "function", function: {
    name: "current_time_utc", description: "Получить текущее время UTC в ISO 8601.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }}
]);
const TOOL_NAMES = TOOL_DEFS.map(x => x.function.name);
const MAX_MESSAGES = 16;
const MAX_TEXT = 12000;

function toolResult(name, args, clock = () => new Date()) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Неверные аргументы инструмента.");
  if (name === "text_statistics") {
    if (typeof args.text !== "string" || args.text.length > 8000) throw new Error("Текст должен быть не длиннее 8000 символов.");
    return { words: (args.text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || []).length,
      characters: Array.from(args.text).length,
      lines: args.text === "" ? 0 : args.text.split(/\r\n|\r|\n/).length };
  }
  if (name === "calculate") {
    const { operation, a, b } = args;
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 1e12 || Math.abs(b) > 1e12)
      throw new Error("Операнды должны быть конечными числами в допустимом диапазоне.");
    const result = operation === "add" ? a + b
      : operation === "subtract" ? a - b
      : operation === "multiply" ? a * b
      : operation === "divide" && b !== 0 ? a / b : NaN;
    if (!Number.isFinite(result)) throw new Error("Операция или результат недопустимы.");
    return { result };
  }
  if (name === "current_time_utc") return { utc: clock().toISOString() };
  throw new Error("Инструмент не разрешён.");
}

function normalizeRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Некорректный запрос.");
  const agent = data.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) throw new Error("Не указан агент.");
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  const role = typeof agent.role === "string" ? agent.role.trim() : "";
  const instructions = typeof agent.instructions === "string" ? agent.instructions : "";
  const model = typeof agent.model === "string" ? agent.model.trim() : "";
  if (!name || name.length > 60 || role.length > 60 || instructions.length > 6000 ||
      model.length > 120 || (model && !/^[\w.\/:+-]+$/.test(model))) {
    throw new Error("Неверная конфигурация агента.");
  }
  const input = typeof data.input === "string" ? data.input.trim() : "";
  if (!input || input.length > MAX_TEXT) throw new Error("Задача должна содержать от 1 до 12000 символов.");
  const mode = data.mode === "task" ? "task" : data.mode === "chat" ? "chat" : null;
  if (!mode) throw new Error("Неизвестный режим запуска.");
  const requestedTools = Array.isArray(agent.enabledTools) ? agent.enabledTools : [];
  if (requestedTools.length > TOOL_NAMES.length ||
      requestedTools.some(t => !TOOL_NAMES.includes(t)) ||
      new Set(requestedTools).size !== requestedTools.length) throw new Error("Недопустимый список инструментов.");
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length > MAX_MESSAGES) throw new Error("Слишком длинная история.");
  const normalizedHistory = history.map(message => {
    if (!message || !["user","assistant"].includes(message.role) ||
        typeof message.content !== "string" || message.content.length > MAX_TEXT) {
      throw new Error("Некорректная история диалога.");
    }
    return { role: message.role, content: message.content };
  });
  return { name, role, instructions, model, mode, input, enabledTools: requestedTools, history: normalizedHistory };
}

function endpointUrl(base) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password ||
      !url.hostname.endsWith(".cloud.ru") || url.port || url.search || url.hash) {
    throw new Error("Для Cloud.ru укажите публичный HTTPS-эндпоинт домена cloud.ru.");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") url.pathname = "/v1/chat/completions";
  else if (pathname.endsWith("/chat/completions")) url.pathname = pathname;
  else if (pathname.endsWith("/v1")) url.pathname = pathname + "/chat/completions";
  else throw new Error("URL должен оканчиваться на /v1 или /v1/chat/completions.");
  return url.toString();
}

function configured(env) {
  if (!env.AMAYURENA_API_BASE_URL || !env.AMAYURENA_API_KEY) return false;
  try { endpointUrl(env.AMAYURENA_API_BASE_URL); return true; } catch (_) { return false; }
}

async function chatCompletion(payload, context) {
  const request = normalizeRequest(payload);
  const { env, fetchImpl = fetch } = context;
  if (!env.AMAYURENA_API_BASE_URL || !env.AMAYURENA_API_KEY)
    throw Object.assign(new Error("Cloud.ru не настроен. Укажите AMAYURENA_API_BASE_URL и AMAYURENA_API_KEY."), { status: 503 });
  const url = endpointUrl(env.AMAYURENA_API_BASE_URL);
  const model = request.model || env.AMAYURENA_MODEL || "endpoint-selected";
  const system = [
    "Ты персональный ИИ-агент Amayurena.",
    "Имя: " + request.name,
    "Роль: " + (request.role || "Универсальный"),
    "Следуй пользовательским инструкциям агента, не выдавая неподтверждённое за факт.",
    "Инструкции агента:\n" + request.instructions,
    request.mode === "task"
      ? "Пользователь запустил одну задачу. Дай полезный итог, не заявляй о внешних действиях, если они не выполнялись."
      : "Отвечай на последнее сообщение в контексте диалога."
  ].join("\n\n");
  const messages = [{ role: "system", content: system }, ...request.history,
    { role: "user", content: request.input }];
  const tools = TOOL_DEFS.filter(t => request.enabledTools.includes(t.function.name));
  const toolsUsed = [];
  const signal = AbortSignal.timeout(60000);
  for (let step = 0; step < 4; step++) {
    const body = { model, messages, stream: false, max_tokens: 800 };
    if (tools.length && step < 3) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.AMAYURENA_API_KEY,
          "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError")
        throw Object.assign(new Error("Модель не ответила за 60 секунд."), { status: 504 });
      throw Object.assign(new Error("Не удалось подключиться к Cloud.ru."), { status: 502 });
    }
    if (!response.ok) {
      throw Object.assign(new Error("Cloud.ru вернул HTTP " + response.status +
        (response.status === 400 && tools.length ? ". Возможно, выбранная модель не поддерживает инструменты — отключите их и повторите." : ".")), { status: 502 });
    }
    let data;
    try { data = await response.json(); } catch (_) {
      throw Object.assign(new Error("Ответ модели не является JSON."), { status: 502 });
    }
    const choice = data && data.choices && data.choices[0];
    const message = choice && choice.message;
    if (!message) throw Object.assign(new Error("В ответе модели нет сообщения."), { status: 502 });
    const calls = message.tool_calls || [];
    if (!Array.isArray(calls) || calls.length > 4) throw new Error("Слишком много вызовов инструментов.");
    if (!calls.length) {
      const reply = typeof message.content === "string" ? message.content.trim() : "";
      if (!reply) throw Object.assign(new Error("Модель вернула пустой ответ."), { status: 502 });
      return { reply: reply.slice(0, 16000), model: typeof data.model === "string" ? data.model : model,
        toolsUsed, usage: data.usage && {
          prompt_tokens: Number(data.usage.prompt_tokens) || 0,
          completion_tokens: Number(data.usage.completion_tokens) || 0
        } };
    }
    if (step >= 3 || toolsUsed.length + calls.length > 4)
      throw Object.assign(new Error("Превышен лимит вызовов инструментов для одной задачи."), { status: 422 });
    messages.push({ role: "assistant", content: typeof message.content === "string" ? message.content : null, tool_calls: calls });
    for (const call of calls) {
      const name = call && call.function && call.function.name;
      if (!request.enabledTools.includes(name) || !call.id) {
        throw Object.assign(new Error("Модель запросила запрещённый инструмент."), { status: 422 });
      }
      let args;
      try { args = JSON.parse(call.function.arguments || "{}"); }
      catch (_) { throw Object.assign(new Error("Модель передала неверные параметры инструмента."), { status: 422 }); }
      let output;
      try { output = toolResult(name, args); }
      catch (e) { output = { error: e.message }; }
      toolsUsed.push({ name, result: output });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  throw Object.assign(new Error("Лимит итераций агента исчерпан."), { status: 422 });
}

module.exports = { TOOL_DEFS, TOOL_NAMES, toolResult, normalizeRequest, endpointUrl, configured, chatCompletion };
