import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekModelAdapter, FakeDeviceAdapter, FakeModelAdapter } from "../src/index.js";
import { confirm, harness, transport } from "./helpers.js";

const AI_DISCLAIMER = "Luna 是 AI 工具噢，我的回答仅供参考。";
const MEDICAL_DISCLAIMER = "不构成医疗诊断";

function okFetch(content) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

class DeferredDeviceAdapter extends FakeDeviceAdapter {
  constructor() {
    super();
    this.entered = new Map();
    this.gates = new Map();
  }

  defer(deviceId) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    this.gates.set(deviceId, { promise, release });
    return promise;
  }

  release(deviceId) {
    const gate = this.gates.get(deviceId);
    if (gate) gate.release();
  }

  async execute(command, device, targetState) {
    this.entered.set(device.id, true);
    const gate = this.gates.get(device.id);
    if (gate) await gate.promise;
    return super.execute(command, device, targetState);
  }
}

async function waitFor(condition, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return condition();
}

test("AC-010 普通问候回复附带统一免责文案", async () => {
  const { send } = harness();
  const result = await send("你好");
  assert.equal(result.responseType, "chat");
  assert.match(result.message.content, new RegExp(AI_DISCLAIMER));
  assert.equal(result.receipt, undefined);
});

test("AC-011 AC-019 健康话题追加医疗强化句且不替代通用免责", async () => {
  const { send } = harness();
  const health = await send("空气质量会影响健康吗");
  assert.match(health.message.content, new RegExp(AI_DISCLAIMER));
  assert.match(health.message.content, new RegExp(MEDICAL_DISCLAIMER));

  const general = await send("二氧化碳为什么会升高");
  assert.match(general.message.content, new RegExp(AI_DISCLAIMER));
  assert.doesNotMatch(general.message.content, new RegExp(MEDICAL_DISCLAIMER));
});

test("AC-012 急性不适安全引导优先且同时保留双免责", async () => {
  const { send } = harness();
  const result = await send("我呼吸困难并且胸痛");
  assert.match(result.message.content, /离开.*风险环境.*紧急服务|紧急服务.*专业医疗/);
  assert.match(result.message.content, new RegExp(AI_DISCLAIMER));
  assert.match(result.message.content, new RegExp(MEDICAL_DISCLAIMER));
});

test("AC-019 模型生成的聊天与知识健康回复同时含双免责", async () => {
  const chatModel = new DeepSeekModelAdapter({ apiKey: "k", enabled: true, fetchImpl: okFetch("如果持续咳嗽，建议关注呼吸道健康。") });
  const chatHarness = harness({ model: chatModel });
  const chat = await chatHarness.send("你好，我最近有点咳嗽");
  assert.equal(chat.responseType, "chat");
  assert.equal(chat.sources[0].type, "model");
  assert.match(chat.message.content, new RegExp(AI_DISCLAIMER));
  assert.match(chat.message.content, new RegExp(MEDICAL_DISCLAIMER));

  const knowledgeModel = new DeepSeekModelAdapter({ apiKey: "k", enabled: true, fetchImpl: okFetch("长期暴露在污染空气中可能影响呼吸道健康。") });
  const knowledgeHarness = harness({ model: knowledgeModel });
  const knowledge = await knowledgeHarness.send("空气污染会伤害健康吗");
  assert.equal(knowledge.responseType, "knowledge");
  assert.equal(knowledge.sources[0].type, "model");
  assert.match(knowledge.message.content, new RegExp(AI_DISCLAIMER));
  assert.match(knowledge.message.content, new RegExp(MEDICAL_DISCLAIMER));
});

test("AC-095 实时天气或室外数值无可信来源时拒绝且不编造室内快照", async () => {
  const { send } = harness();
  for (const question of ["今天天气怎么样", "天气预报", "室外 PM2.5 是多少", "室外温度多少", "外面空气质量怎么样", "AQI 是多少", "今天下雨吗"]) {
    const result = await send(question);
    assert.equal(result.responseType, "rejection", question);
    assert.equal(result.error?.code, "ENVIRONMENT_UNAVAILABLE", question);
    assert.match(result.message.content, /室外|天气|无法提供|不可得/, question);
    assert.doesNotMatch(result.message.content, /PM2\.5 18|CO2 720|湿度 48|温度 24/, question);
  }
  const concept = await send("室外 PM2.5 是什么");
  assert.equal(concept.responseType, "knowledge");
  const indoor = await send("现在空气怎么样");
  assert.equal(indoor.responseType, "environment_status");
  assert.match(indoor.message.content, /PM2\.5 18/);
});

test("AC-095b 配置实时搜索后，天气/室外查询走 Tavily 并返回实时信息", async () => {
  const fakeRealtime = {
    available: true,
    referenceId: "tavily",
    search: async (query) => ({
      answer: "杭州今天晴，26°C，AQI 良好。",
      results: [{ title: "杭州天气", url: "https://example.com/hz-weather", content: "晴 26°C" }],
      query,
      source: "real_time",
      referenceId: "tavily",
      observedAt: "2026-08-05T12:00:00.000Z",
    }),
  };
  const { send } = harness({ realtime: fakeRealtime });
  for (const question of ["今天天气怎么样", "天气预报", "室外 PM2.5 是多少", "AQI 是多少"]) {
    const result = await send(question);
    assert.equal(result.responseType, "real_time", question);
    assert.match(result.message.content, /实时信息：杭州今天晴，26°C，AQI 良好。/);
    assert.equal(result.sources[0].type, "real_time");
    assert.ok(result.realtime, question);
    assert.equal(result.realtime.source, "real_time");
    assert.doesNotMatch(result.message.content, /PM2\.5 18|CO2 720|湿度 48|温度 24/, question);
  }
});

test("AC-095c 实时搜索服务失败时降级为拒绝且不编造", async () => {
  const failingRealtime = {
    available: true,
    referenceId: "tavily",
    search: async () => null,
  };
  const { send } = harness({ realtime: failingRealtime });
  const result = await send("今天天气怎么样");
  assert.equal(result.responseType, "rejection");
  assert.equal(result.error?.code, "ENVIRONMENT_UNAVAILABLE");
  assert.match(result.message.content, /无法提供|不可用/);
});

test("AC-096 超长输入在语义路由、历史方案检查与模型调用之前返回 INPUT_TOO_LONG", async () => {
  const model = new FakeModelAdapter();
  const devices = new FakeDeviceAdapter();
  const { app } = harness({ model, devices });
  const base = { contractVersion: "1.0.0", conversationId: "c", clientMessageId: "m", idempotencyKey: "k", locale: "zh-CN", timezone: "Asia/Shanghai" };

  const historicalLong = await app.sendMessage({ ...base, message: `${"上次那个方案".repeat(700)}`, idempotencyKey: "k-historical" }, transport);
  assert.equal(historicalLong.error.code, "INPUT_TOO_LONG");
  assert.doesNotMatch(historicalLong.message.content, /历史方案/);

  const emojiLong = await app.sendMessage({ ...base, message: "😀".repeat(4001), idempotencyKey: "k-emoji" }, transport);
  assert.equal(emojiLong.error.code, "INPUT_TOO_LONG");

  const exactly4000 = await app.sendMessage({ ...base, message: `现在空气怎么样${"啊".repeat(3993)}`, idempotencyKey: "k-4000" }, transport);
  assert.equal(exactly4000.responseType, "environment_status");
  assert.notEqual(exactly4000.error?.code, "INPUT_TOO_LONG");

  assert.equal(model.candidateCalls + model.responseCalls, 0);
  assert.equal(devices.commands.length, 0);
});

test("AC-032 AC-033 智能窗户直接执行保留能力、版本与回执校验", async () => {
  const { app, send } = harness();
  const opened = await send("打开智能窗户");
  assert.equal(opened.responseType, "execution_result");
  assert.equal(opened.confirmation, undefined);
  assert.equal(opened.receipt.status, "succeeded");
  assert.equal(opened.receipt.source, "mock");
  assert.equal(opened.sources[0].type, "mock");
  assert.equal(app.adapters.devices.commands.length, 1);

  const noop = await send("打开智能窗户");
  assert.equal(noop.receipt.status, "noop");
  assert.equal(app.adapters.devices.commands.length, 1);

  const window = app.adapters.registry.get("window-living");
  app.adapters.registry.replace({ ...window, connectionStatus: "offline" });
  const offline = await send("关闭智能窗户");
  assert.equal(offline.error?.code, "DEVICE_UNAVAILABLE");
  assert.equal(app.adapters.devices.commands.length, 1);

  app.adapters.registry.replace({ ...window, connectionStatus: "online", state: "unknown", stateVersion: window.stateVersion + 1 });
  const unknown = await send("关闭智能窗户");
  assert.equal(unknown.error?.code, "DEVICE_UNAVAILABLE");
  assert.equal(app.adapters.devices.commands.length, 1);
});

test("AC-034 智能窗户执行前状态版本变化时放弃执行且不陈述成功", async () => {
  const devices = new DeferredDeviceAdapter();
  const { app, send } = harness({ devices });
  const pending = await send("今天18点开始火锅空气守护并开窗");
  await confirm(send, pending.confirmation);
  app.adapters.clock.set("2026-08-03T10:00:00.000Z");

  devices.defer("hood-kitchen");
  const due = app.runDueTasks("home-1");
  assert.equal(await waitFor(() => devices.entered.has("hood-kitchen")), true);
  app.adapters.registry.updateState("window-living", "open");
  devices.release("hood-kitchen");
  const result = await due;

  const windowAction = result.receipt.actions.find((action) => action.deviceId === "window-living");
  assert.equal(windowAction.errorCode, "CONFIRMATION_INVALIDATED");
  assert.equal(devices.commands.some((command) => command.deviceId === "window-living"), false);
  assert.equal(result.receipt.status, "partial_success");
});

test("AC-039 多设备即时控制要求拆分，多设备查询要求选择", async () => {
  const { app, send } = harness();
  const control = await send("打开空气净化器和抽油烟机");
  assert.equal(control.responseType, "rejection");
  assert.match(control.message.content, /一次只支持一个设备/);
  assert.equal(app.adapters.devices.commands.length, 0);

  const query = await send("空气净化器和抽油烟机状态怎么样");
  assert.equal(query.responseType, "clarification");
  assert.equal(query.clarification.kind, "device");
  assert.deepEqual(query.clarification.options, ["客厅空气净化器", "厨房抽油烟机"]);
  assert.equal(app.adapters.devices.commands.length, 0);
});

test("AC-075 澄清选项文本与 continuation 均合并原请求重走完整链路", async () => {
  const { app, send } = harness();
  const pending = await send("打开");
  assert.equal(pending.clarification.kind, "device");
  const result = await send("客厅空气净化器");
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(app.adapters.devices.commands.length, 1);

  const modePending = await send("启动优化");
  assert.deepEqual(modePending.clarification.options, ["舒适优先", "均衡自动", "低碳优先"]);
  const modeResult = await send("舒适优先");
  assert.equal(modeResult.responseType, "confirmation");
  assert.match(modeResult.confirmation.plan.summary, /舒适优先/);
  assert.equal(app.taskService.current("home-1"), null);
});

test("DEP-005 回执与时间字段数据完整且为有效 ISO 时间", async () => {
  const { send } = harness();
  const result = await send("打开空气净化器");
  const receipt = result.receipt;
  assert.ok(receipt.receiptId && receipt.requestId && receipt.planId);
  assert.ok(["succeeded", "failed", "noop", "timed_out", "unknown", "partial_success"].includes(receipt.status));
  assert.equal(Number.isNaN(new Date(receipt.startedAt).getTime()), false);
  assert.equal(Number.isNaN(new Date(receipt.completedAt).getTime()), false);
  assert.ok(receipt.actions.length >= 1);
  assert.equal(Number.isNaN(new Date(result.message.createdAt).getTime()), false);

  const device = await send("空气净化器状态怎么样");
  assert.equal(Number.isNaN(new Date(device.sources[0].observedAt).getTime()), false);
});

test("AC-098 getWeather 返回结构化天气数据", async () => {
  const fakeRealtime = {
    available: true,
    referenceId: "tavily",
    search: async (query) => ({
      answer: "杭州今天多云，26°C，湿度 60%。",
      results: [{ title: "杭州天气", url: "https://example.com/hz", content: "多云 26°C" }],
      query,
      source: "real_time",
      referenceId: "tavily",
      observedAt: "2026-08-05T12:00:00.000Z",
    }),
  };
  const { app } = harness({ realtime: fakeRealtime });
  const result = await app.getWeather("杭州");
  assert.equal(result.available, true);
  assert.equal(result.city, "杭州");
  assert.equal(result.temp, "26");
  assert.equal(result.condition, "多云");
  assert.equal(result.icon, "cloud");
  assert.ok(result.observedAt);
});

test("AC-098b getWeather 无实时适配器时降级", async () => {
  const { app } = harness();
  const result = await app.getWeather("杭州");
  assert.equal(result.available, false);
  assert.equal(result.reason, "realtime_unavailable");
});

test("AC-098c getWeather 搜索失败时降级", async () => {
  const failingRealtime = { available: true, referenceId: "tavily", search: async () => null };
  const { app } = harness({ realtime: failingRealtime });
  const result = await app.getWeather("杭州");
  assert.equal(result.available, false);
  assert.equal(result.reason, "realtime_failed");
});
