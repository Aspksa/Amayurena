(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AmayurenaAgents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "amayurena.agents.v1";
  const BACKUP_VERSION = 1;
  const MAX_AGENTS = 500;
  const LIMITS = Object.freeze({ name: 60, role: 60, description: 400, instructions: 6000 });

  function safeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function newId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "agent-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  function normalizeAgent(input, options) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Некорректные данные агента.");
    }
    const opts = options || {};
    const name = safeString(input.name);
    const role = safeString(input.role) || "Универсальный";
    const description = safeString(input.description);
    const instructions = safeString(input.instructions);
    if (!name) throw new Error("Укажите имя агента.");
    for (const [field, value] of Object.entries({ name, role, description, instructions })) {
      if (value.length > LIMITS[field]) throw new Error("Превышена длина поля: " + field);
    }
    const now = opts.now || new Date().toISOString();
    const id = opts.id || newId();
    return {
      id,
      name,
      role,
      description,
      instructions,
      createdAt: opts.createdAt || now,
      updatedAt: now
    };
  }

  function validateBackupAgent(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("В резервной копии обнаружена повреждённая запись.");
    }
    const id = safeString(raw.id);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw new Error("Некорректный идентификатор агента.");
    }
    const createdAt = safeString(raw.createdAt);
    const updatedAt = safeString(raw.updatedAt);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
      throw new Error("Некорректная дата агента.");
    }
    return normalizeAgent(raw, { id, createdAt, now: updatedAt });
  }

  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error("Файл не является корректным JSON.");
    }
    if (!data || typeof data !== "object" || data.version !== BACKUP_VERSION || !Array.isArray(data.agents)) {
      throw new Error("Неизвестный формат резервной копии.");
    }
    if (data.agents.length > MAX_AGENTS) throw new Error("Слишком много агентов в файле.");
    const agents = data.agents.map(validateBackupAgent);
    const ids = new Set(agents.map((agent) => agent.id));
    if (ids.size !== agents.length) throw new Error("Повторяющиеся идентификаторы агентов.");
    return agents;
  }

  function makeBackup(agents) {
    return JSON.stringify({ version: BACKUP_VERSION, exportedAt: new Date().toISOString(), agents }, null, 2);
  }

  function filterAgents(agents, query) {
    const needle = safeString(query).toLocaleLowerCase("ru");
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.role, agent.description].some((part) =>
        part.toLocaleLowerCase("ru").includes(needle)
      )
    );
  }

  return { STORAGE_KEY, MAX_AGENTS, LIMITS, normalizeAgent, parseBackup, makeBackup, filterAgents };
});
