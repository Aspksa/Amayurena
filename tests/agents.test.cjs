"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAgent, makeBackup, parseBackup, filterAgents, MAX_AGENTS
} = require("../agents-core.js");

test("creates an agent with a stable data shape", () => {
  const agent = normalizeAgent({ name: "  Архивариус  ", role: "  Документы  " }, {
    id: "agent-test", now: "2026-10-28T00:00:00.000Z"
  });
  assert.equal(agent.id, "agent-test");
  assert.equal(agent.name, "Архивариус");
  assert.equal(agent.role, "Документы");
  assert.equal(agent.description, "");
  assert.equal(agent.createdAt, agent.updatedAt);
});

test("editing retains identity and creation time", () => {
  const old = normalizeAgent({ name: "Агент" }, {
    id: "fixed-id", now: "2026-01-01T00:00:00.000Z"
  });
  const changed = normalizeAgent({ name: "Агент 2" }, {
    id: old.id, createdAt: old.createdAt, now: "2026-02-01T00:00:00.000Z"
  });
  assert.equal(changed.id, old.id);
  assert.equal(changed.createdAt, old.createdAt);
  assert.notEqual(changed.updatedAt, old.updatedAt);
});

test("requires a name and applies field limits", () => {
  assert.throws(() => normalizeAgent({ name: " " }), /имя/);
  assert.throws(() => normalizeAgent({ name: "А".repeat(61) }), /name/);
  assert.throws(() => normalizeAgent({ name: "Да", instructions: "a".repeat(6001) }), /instructions/);
});

test("roundtrips backup with Russian text", () => {
  const agent = normalizeAgent({ name: "Амаюрэна", description: "Поиск информации" }, {
    id: "agent-001", now: "2026-10-28T00:00:00.000Z"
  });
  assert.deepEqual(parseBackup(makeBackup([agent])), [agent]);
});

test("rejects malformed backups without partial import", () => {
  assert.throws(() => parseBackup("garbage"), /JSON/);
  assert.throws(() => parseBackup('{"version":99,"agents":[]}'), /формат/);
  assert.throws(() => parseBackup('{"version":1,"agents":[{"name":"Без ID"}]}'), /идентификатор/);
  const agent = normalizeAgent({ name: "Проверка" }, {
    id: "duplicate", now: "2026-10-28T00:00:00.000Z"
  });
  assert.throws(() => parseBackup(makeBackup([agent, agent])), /Повторяющиеся/);
  assert.throws(() => parseBackup(makeBackup(Array(MAX_AGENTS + 1).fill(agent))), /Слишком много/);
});

test("search matches name, role, description and ignores case", () => {
  const agents = [
    { name: "Архивариус", role: "Документы", description: "Хранит записи" },
    { name: "Счётчик", role: "Финансы", description: "Проверяет отчёты" }
  ];
  assert.equal(filterAgents(agents, "АРХИВ").length, 1);
  assert.equal(filterAgents(agents, "финансы").length, 1);
  assert.equal(filterAgents(agents, "отчёты").length, 1);
  assert.equal(filterAgents(agents, "").length, 2);
});

test("agent backup keeps selected model and tool permissions", () => {
  const agent = normalizeAgent({
    name: "Счётчик", model: "endpoint-selected",
    enabledTools: ["calculate", "text_statistics"]
  }, { id: "agent-model", now: "2026-10-28T00:00:00.000Z" });
  const restored = parseBackup(makeBackup([agent]))[0];
  assert.equal(restored.model, "endpoint-selected");
  assert.deepEqual(restored.enabledTools, ["calculate", "text_statistics"]);
});

test("old v1 backup imports with empty model and disabled tools", () => {
  const old = {
    version: 1, agents: [{ id: "legacy-01", name: "Старый агент",
      role: "Архивариус", description: "", instructions: "",
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }]
  };
  const agent = parseBackup(JSON.stringify(old))[0];
  assert.equal(agent.model, "");
  assert.deepEqual(agent.enabledTools, []);
});

test("agent does not accept unknown tools or malformed model", () => {
  assert.throws(() => normalizeAgent({ name: "Агент", enabledTools: ["shell"] }), /инструмент/);
  assert.throws(() => normalizeAgent({ name: "Агент", model: " bad model " }), /модели/);
});
