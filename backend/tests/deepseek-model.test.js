import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekModelAdapter, DEEPSEEK_MAX_TOKENS_CAP } from "../src/index.js";
import { loadDotEnvIfPresent } from "../src/config/env.js";
import { guardModelReply } from "../src/conversation/reply-safety.js";
import { harness } from "./helpers.js";

function okFetch(content) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function makeAdapter(fetchImpl, options = {}) {
  // Explicit endpoint/model shield these assertions from any real backend/.env
  // values that may exist on the machine running the tests.
  return new DeepSeekModelAdapter({ apiKey: "test-key", enabled: true, endpoint: "https://api.deepseek.com", model: "deepseek-chat", fetchImpl, ...options });
}

test("DeepSeek 适配器请求结构符合端点、模型、限额与密钥约束", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "安全回复" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = makeAdapter(fetchImpl);
  const text = await adapter.respond({ kind: "chat", message: "你好" });
  assert.equal(text, "安全回复");
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.body.model, "deepseek-chat");
  assert.ok(captured.body.max_tokens >= 1 && captured.body.max_tokens <= DEEPSEEK_MAX_TOKENS_CAP);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.messages[0].role, "system");
  assert.equal(captured.body.messages[1].content, "你好");

  const knowledge = await adapter.respond({ kind: "knowledge", message: "二氧化碳为什么会升高" });
  assert.equal(knowledge, "安全回复");
  assert.match(captured.body.messages[0].content, /空气健康知识/);
  assert.equal(captured.body.messages[1].content, "二氧化碳为什么会升高");
});

test("未启用、缺少密钥或非法端点时不可用且不发起网络请求", async () => {
  const disabled = new DeepSeekModelAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(disabled.available, false);
  await assert.rejects(() => disabled.respond({ kind: "chat", message: "你好" }), /deepseek model unavailable/);

  const noKey = new DeepSeekModelAdapter({ enabled: true, apiKey: "", fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(noKey.available, false);
  await assert.rejects(() => noKey.respond({ kind: "chat", message: "你好" }), /deepseek model unavailable/);

  assert.throws(() => new DeepSeekModelAdapter({ apiKey: "k", enabled: true, endpoint: "http://insecure.example" }), /https/);
});

test("失败、超时与异常均不自动重试且错误不泄露密钥", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response("{}", { status: 500 });
  };
  const adapter = makeAdapter(failing);
  await assert.rejects(() => adapter.respond({ kind: "chat", message: "你好" }), /deepseek model unavailable/);
  assert.equal(calls, 1);

  let abortCalls = 0;
  const hanging = (url, options) => new Promise((resolve, reject) => {
    abortCalls += 1;
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const timeoutAdapter = makeAdapter(hanging, { timeoutMs: 20 });
  await assert.rejects(() => timeoutAdapter.respond({ kind: "chat", message: "你好" }), /deepseek model unavailable/);
  assert.equal(abortCalls, 1);

  const secretAdapter = makeAdapter(() => { throw new Error("sk-secret-xyz leaked path"); });
  await assert.rejects(() => secretAdapter.respond({ kind: "chat", message: "你好" }), /deepseek model unavailable/);
});

test("候选提取仅意图分类，且失败时降级为固定 unknown 而非抛错", async () => {
  const adapter = makeAdapter(() => { throw new Error("network down"); });
  const candidate = await adapter.extractCandidate({ message: "打开空气净化器" });
  assert.deepEqual(candidate, { intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 });

  const disabled = new DeepSeekModelAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("must not be called"); } });
  const disabledCandidate = await disabled.extractCandidate({ message: "打开空气净化器" });
  assert.deepEqual(disabledCandidate, { intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 });
  assert.equal(disabled.available, false);
});

test("真实模型安全聊天回复进入 chat 且来源为 model", async () => {
  const adapter = makeAdapter(okFetch("你好，很高兴认识你。"));
  const { app, send } = harness({ model: adapter });
  const chat = await send("你好");
  assert.equal(chat.responseType, "chat");
  assert.equal(chat.message.content, "你好，很高兴认识你。 Luna 是 AI 工具噢，我的回答仅供参考。");
  assert.equal(chat.sources.length, 1);
  assert.equal(chat.sources[0].type, "model");
  assert.equal(chat.sources[0].referenceId, "deepseek-chat");
  assert.equal(Number.isNaN(new Date(chat.sources[0].observedAt).getTime()), false);
  assert.equal(chat.receipt, undefined);
  assert.equal(app.adapters.devices.commands.length, 0);
});

test("真实模型知识回复附统一免责且来源为 model", async () => {
  const adapter = makeAdapter(okFetch("二氧化碳通常因人员呼吸和通风不足而累积。"));
  const { send } = harness({ model: adapter });
  const knowledge = await send("二氧化碳为什么会升高");
  assert.equal(knowledge.responseType, "knowledge");
  assert.match(knowledge.message.content, /人员呼吸和通风不足/);
  assert.match(knowledge.message.content, /仅供参考/);
  assert.doesNotMatch(knowledge.message.content, /不构成医疗诊断/);
  assert.equal(knowledge.sources[0].type, "model");
  assert.equal(knowledge.receipt, undefined);
});

test("无回执时模型执行或当前状态文本被固定模板替换", async () => {
  const unsafeVariants = ["操作完成", "替你处理好了", "设备现在开启", "净化器正在运行", "已经替你执行完毕", "已开启，执行成功", "当前PM2.5是 85", "现在二氧化碳浓度 1800 ppm"];
  for (const unsafeText of unsafeVariants) {
    const adapter = makeAdapter(okFetch(unsafeText));
    const { send } = harness({ model: adapter });
    const chat = await send("你好");
    assert.equal(chat.responseType, "chat");
    assert.equal(chat.error?.code, "MODEL_UNAVAILABLE");
    assert.equal(chat.sources[0].type, "template");
    assert.doesNotMatch(chat.message.content, /已开启|执行成功|操作完成|替你处理好了|设备现在开启|净化器正在运行|替你执行完毕|1800 ppm/);

    const knowledge = await send("二氧化碳为什么会升高");
    assert.equal(knowledge.responseType, "knowledge");
    assert.equal(knowledge.error?.code, "MODEL_UNAVAILABLE");
    assert.equal(knowledge.sources[0].type, "template");
    assert.match(knowledge.message.content, /人员呼吸.*燃烧.*通风不足/);
    assert.doesNotMatch(knowledge.message.content, /已开启|执行成功|操作完成|替你处理好了|设备现在开启|净化器正在运行|替你执行完毕|1800 ppm/);
  }
});

test("真实模型调用失败或超时时降级为固定模板", async () => {
  const adapter = makeAdapter(async () => { throw new Error("network down"); });
  const { send } = harness({ model: adapter });
  const chat = await send("你好");
  assert.equal(chat.error?.code, "MODEL_UNAVAILABLE");
  assert.match(chat.message.content, /暂时不可用/);
  assert.equal(chat.sources[0].type, "template");

  const knowledge = await send("二氧化碳为什么会升高");
  assert.equal(knowledge.error?.code, "MODEL_UNAVAILABLE");
  assert.match(knowledge.message.content, /人员呼吸/);
  assert.equal(knowledge.sources[0].type, "template");
});

test("真实模型文本不能影响设备执行链路", async () => {
  const adapter = makeAdapter(okFetch("已开启，执行成功"));
  const { app, send } = harness({ model: adapter });
  const result = await send("打开空气净化器");
  assert.equal(result.responseType, "execution_result");
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(app.adapters.devices.commands.length, 1);
  assert.doesNotMatch(result.message.content, /已开启，执行成功/);
  assert.equal(result.sources[0].type, "mock");
});

test("急症知识不调用真实模型", async () => {
  const adapter = makeAdapter(okFetch("危险内容"));
  const { send } = harness({ model: adapter });
  const urgent = await send("我呼吸困难并且胸痛");
  assert.match(urgent.message.content, /离开.*风险环境.*紧急服务|紧急服务.*专业医疗/);
  assert.equal(adapter.responseCalls, 0);
});

test("未启用的真实模型仍走 MODEL_UNAVAILABLE 降级", async () => {
  const disabled = new DeepSeekModelAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("should not call"); } });
  const { send } = harness({ model: disabled });
  const chat = await send("你好");
  assert.equal(chat.error?.code, "MODEL_UNAVAILABLE");
  assert.equal(chat.sources[0].type, "template");
  assert.match(chat.message.content, /暂时不可用/);
});

test("固定模型文本安全边界", () => {
  assert.equal(guardModelReply("  你好呀  "), "你好呀");
  assert.equal(guardModelReply(""), null);
  assert.equal(guardModelReply("   "), null);
  assert.equal(guardModelReply("x".repeat(4001)), null);
  for (const unsafe of ["操作完成", "替你处理好了", "设备现在开启", "净化器正在运行", "已经替你执行完毕", "已开启，执行成功", "当前PM2.5是 85", "现在二氧化碳浓度 1800 ppm", "净化器已启动"]) {
    assert.equal(guardModelReply(unsafe), null, unsafe);
  }
  for (const safe of [
    "你好，我是 Luna，很高兴认识你。",
    "空气净化器通过风机让空气经过滤材，以减少颗粒物。",
    "你可以打开净化器来改善空气，但实际执行需要用户确认。",
    "室内二氧化碳浓度超过 1000 ppm 时应注意通风。",
    "PM2.5 是空气动力学直径不大于 2.5 微米的颗粒物。",
  ]) {
    assert.equal(guardModelReply(safe), safe, safe);
  }
});

test("本地 .env 仅加载 DEEPSEEK_* 且不覆盖已有环境变量", () => {
  const dir = mkdtempSync(join(tmpdir(), "breath-forest-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "# comment\nDEEPSEEK_MODEL=env-model\nDEEPSEEK_API_KEY=env-key\nOTHER=no\nDEEPSEEK_TIMEOUT_MS=3000\n", "utf8");
  const keys = ["DEEPSEEK_MODEL", "DEEPSEEK_API_KEY", "DEEPSEEK_ENDPOINT", "DEEPSEEK_ENABLED", "DEEPSEEK_MAX_TOKENS", "DEEPSEEK_TIMEOUT_MS"];
  const previous = new Map(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  // Pre-set the timeout on purpose: existing environment values must never be
  // overwritten by the local .env loader (loadDotEnvIfPresent semantics).
  process.env.DEEPSEEK_TIMEOUT_MS = "15000";
  try {
    loadDotEnvIfPresent(file);
    assert.equal(process.env.DEEPSEEK_MODEL, "env-model");
    assert.equal(process.env.DEEPSEEK_API_KEY, "env-key");
    assert.equal(process.env.DEEPSEEK_TIMEOUT_MS, "15000");
    assert.equal(process.env.OTHER, undefined);
  } finally {
    for (const key of keys) {
      if (previous.has(key)) process.env[key] = previous.get(key);
      else delete process.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("候选意图分类请求使用严格 JSON 提示、低温和受限 token", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"device_control","confidence":0.95}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = makeAdapter(fetchImpl);
  const candidate = await adapter.extractCandidate({ message: "Turn on the purifier" });
  assert.deepEqual(candidate, { intent: "device_control", entities: {}, evidence: "Turn on the purifier", source: "model", confidence: 0.95 });
  assert.equal(captured.body.max_tokens <= 128, true);
  assert.equal(captured.body.temperature, 0);
  assert.match(captured.body.messages[0].content, /意图分类|device_control/);
  assert.equal(captured.body.messages[1].content, "Turn on the purifier");
});

test("候选意图分类异常输出均降级为固定 unknown 且不抛错", async () => {
  const cases = [
    { content: "not json", expect: "unknown" },
    { content: '{"intent":"invented_intent","confidence":0.9}', expect: "unknown" },
    { content: '{"intent":"task_stop","confidence":0.9}', expect: "task_stop" },
    { content: '{"intent":"task_pause","confidence":1}', expect: "task_pause" },
    { content: '{"confidence":0.9}', expect: "unknown" },
  ];
  for (const item of cases) {
    const adapter = makeAdapter(okFetch(item.content));
    const candidate = await adapter.extractCandidate({ message: "你好" });
    assert.equal(candidate.intent, item.expect, item.content);
    assert.equal(candidate.source, "model");
    assert.equal(candidate.confidence >= 0 && candidate.confidence <= 1, true);
  }

  const badConfidence = makeAdapter(okFetch('{"intent":"chat","confidence":"abc"}'));
  assert.equal((await badConfidence.extractCandidate({ message: "hi" })).confidence, 0);

  const wrongShape = await makeAdapter(() => new Response("{}", { status: 200 })).extractCandidate({ message: "hi" });
  assert.deepEqual(wrongShape, { intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 });

  const emptyMessage = await makeAdapter(() => { throw new Error("must not be called"); }).extractCandidate({ message: "   " });
  assert.deepEqual(emptyMessage, { intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 });
});

test("模型候选返回 unknown 时给引导性回复而非干巴巴拒绝", async () => {
  const model = new DeepSeekModelAdapter({ apiKey: "k", enabled: true, fetchImpl: okFetch('{"intent":"unknown","confidence":0.1}') });
  const { app, send } = harness({ model });
  const result = await send("帮我弄得舒服点");
  assert.equal(result.responseType, "chat");
  assert.equal(result.error?.code, "INTENT_UNCLEAR");
  assert.match(result.message.content, /没有执行任何操作/);
  assert.match(result.message.content, /可以帮你/);
  assert.match(result.message.content, /仅供参考/);
  assert.equal(app.adapters.devices.commands.length, 0);
});

test("模型候选为受禁止状态变更时仍拒绝且不执行", async () => {
  const model = new DeepSeekModelAdapter({ apiKey: "k", enabled: true, fetchImpl: okFetch('{"intent":"task_stop","confidence":0.9}') });
  const { app, send } = harness({ model });
  const result = await send("照你说的办");
  assert.equal(result.responseType, "rejection");
  assert.equal(result.error?.code, "INTENT_UNCLEAR");
  assert.equal(app.adapters.devices.commands.length, 0);
});
