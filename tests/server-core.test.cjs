"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { toolResult, normalizeRequest, endpointUrl, configured, chatCompletion } = require("../server-core");

const env = {
  AMAYURENA_API_BASE_URL: "https://example-shared.modelrun.inference.cloud.ru/v1",
  AMAYURENA_API_KEY: "fixture-only-token",
  AMAYURENA_MODEL: "endpoint-selected"
};
const baseRequest = {
  agent: { name: "Амаюрэна", role: "Аналитик", instructions: "Будь точной.", model: "",
    enabledTools: [] },
  input: "Привет", mode: "chat", history: []
};

test("cloud URL is derived from verified HTTPS host, never from browser payload", () => {
  assert.equal(endpointUrl(env.AMAYURENA_API_BASE_URL),
    "https://example-shared.modelrun.inference.cloud.ru/v1/chat/completions");
  assert.equal(endpointUrl("https://example-shared.modelrun.inference.cloud.ru/v1/chat/completions"),
    "https://example-shared.modelrun.inference.cloud.ru/v1/chat/completions");
  for (const candidate of [
    "http://127.0.0.1/v1", "https://cloud.ru.evil.test/v1",
    "https://evil.test/v1", "https://u:p@example.cloud.ru/v1",
    "https://example.cloud.ru:4430/v1"
  ]) assert.throws(() => endpointUrl(candidate));
  assert.equal(configured({}), false);
  assert.equal(configured(env), true);
});

test("permissions and payload sizes are bounded", () => {
  assert.throws(() => normalizeRequest({ ...baseRequest, input: " " }), /Задача/);
  assert.throws(() => normalizeRequest({ ...baseRequest, input: "а".repeat(12001) }), /12000/);
  assert.throws(() => normalizeRequest({ ...baseRequest, agent: { ...baseRequest.agent,
    enabledTools: ["not-a-tool"] } }), /инструмент/);
  assert.throws(() => normalizeRequest({ ...baseRequest, history: [{ role: "system", content: "inject" }] }), /история/);
});

test("safe local tools work, invalid operations rejected", () => {
  assert.deepEqual(toolResult("calculate", { a: 8, b: 2, operation: "divide" }), { result: 4 });
  assert.throws(() => toolResult("calculate", { a: 8, b: 0, operation: "divide" }));
  assert.deepEqual(toolResult("text_statistics", { text: "Привет мир\nТест" }),
    { words: 3, characters: 15, lines: 2 });
  assert.equal(toolResult("current_time_utc", {}, () => new Date("2026-10-28T00:00:00Z")).utc,
    "2026-10-28T00:00:00.000Z");
  assert.throws(() => toolResult("shell", {}), /разрешён/);
});

test("completes one Cloud.ru chat with no tool permissions", async () => {
  let called = 0;
  const fetchImpl = async (url, options) => {
    called++;
    assert.equal(url, endpointUrl(env.AMAYURENA_API_BASE_URL));
    assert.equal(options.headers.Authorization, "Bearer fixture-only-token");
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, "endpoint-selected");
    assert.equal(sent.tools, undefined);
    assert.equal(sent.messages[0].role, "system");
    assert.equal(sent.messages.at(-1).content, "Привет");
    return { ok: true, json: async () => ({
      model: "endpoint-selected", choices: [{ message: { content: "Здравствуйте!" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }) };
  };
  const answer = await chatCompletion(baseRequest, { env, fetchImpl });
  assert.equal(answer.reply, "Здравствуйте!");
  assert.equal(answer.usage.completion_tokens, 2);
  assert.equal(called, 1);
});

test("allows model tool call only from explicit allowlist", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (calls++ === 0) {
      assert.equal(body.tools.length, 1);
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: null, tool_calls: [{ id: "call-1", type: "function",
          function: { name: "calculate", arguments: '{"operation":"multiply","a":6,"b":7}' } }]
      } }] }) };
    }
    assert.equal(body.messages.at(-1).role, "tool");
    assert.equal(JSON.parse(body.messages.at(-1).content).result, 42);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "Ответ: 42" } }] }) };
  };
  const answer = await chatCompletion({ ...baseRequest, agent: { ...baseRequest.agent,
    enabledTools: ["calculate"] } }, { env, fetchImpl });
  assert.equal(answer.reply, "Ответ: 42");
  assert.deepEqual(answer.toolsUsed[0].result, { result: 42 });
});

test("rejects forbidden tool even if model asks for it", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: {
    content: null, tool_calls: [{ id: "evil", function: { name: "shell", arguments: "{}" } }]
  } }] }) });
  await assert.rejects(
    () => chatCompletion({ ...baseRequest, agent: { ...baseRequest.agent,
      enabledTools: ["calculate"] } }, { env, fetchImpl }), /запрещённый/);
});

test("cloud errors do not reflect credential contents", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => chatCompletion(baseRequest, { env, fetchImpl }), err =>
      err.message.includes("401") && !err.message.includes(env.AMAYURENA_API_KEY));
});
