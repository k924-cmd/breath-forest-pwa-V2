import test from "node:test";
import assert from "node:assert/strict";
import { SingingEasterEgg, parseEasterDecision, EASTER_REPLY_TEMPLATE } from "../src/index.js";

function makeModelAdapter(reply) {
  let calls = 0;
  return {
    generative: true,
    referenceId: "test-model",
    respond: async () => { calls += 1; return reply; },
    calls: () => calls,
  };
}

function makeTtsAdapter(audio = Buffer.from("wav-bytes")) {
  let calls = 0;
  return {
    available: true,
    referenceId: "test-tts",
    synthesize: async (text, options) => { calls += 1; return { audio, format: "wav", voice: "冰糖", text, sing: options?.sing }; },
    calls: () => calls,
  };
}

test("parseEasterDecision 解析唱歌 JSON", () => {
  const decision = parseEasterDecision('{"isSinging":true,"songName":"月亮代表我的心","continuation":"你问我爱你有多深 我爱你有几分"}');
  assert.deepEqual(decision, {
    isSinging: true,
    songName: "月亮代表我的心",
    continuation: "你问我爱你有多深 我爱你有几分",
  });
});

test("parseEasterDecision 容忍代码围栏与前后空白", () => {
  const decision = parseEasterDecision('```json\n {"isSinging":true,"songName":"小星星","continuation":"一闪一闪亮晶晶 满天都是小星星"} \n```');
  assert.equal(decision.songName, "小星星");
  assert.equal(decision.continuation, "一闪一闪亮晶晶 满天都是小星星");
});

test("parseEasterDecision 对非唱歌或缺失字段返回 null", () => {
  assert.equal(parseEasterDecision('{"isSinging":false,"songName":"","continuation":""}'), null);
  assert.equal(parseEasterDecision('{"isSinging":true,"songName":"x","continuation":""}'), null);
  assert.equal(parseEasterDecision("not json"), null);
  assert.equal(parseEasterDecision(""), null);
});

test("彩蛋编排：唱歌时返回歌词、音频与固定回复模板", async () => {
  const model = makeModelAdapter('{"isSinging":true,"songName":"晴天","continuation":"故事的小黄花 从出生那年就飘着"}');
  const tts = makeTtsAdapter();
  const egg = new SingingEasterEgg({ model, tts });
  assert.equal(egg.available, true);

  const result = await egg.run("用户哼唱的模糊歌词转写");
  assert.equal(model.calls(), 1);
  assert.equal(tts.calls(), 1);
  assert.equal(result.songName, "晴天");
  assert.equal(result.continuation, "故事的小黄花 从出生那年就飘着");
  assert.equal(result.audio.toString(), "wav-bytes");
  assert.equal(result.format, "wav");
  assert.ok(result.replyText.includes("故事的小黄花"));
  assert.ok(result.replyText.includes("空气小助手"));
});

test("彩蛋编排：唱歌时用 sing:true 调用 TTS 并带 (唱歌) 标签", async () => {
  const model = makeModelAdapter('{"isSinging":true,"songName":"稻香","continuation":"还记得你说家是唯一的城堡 随着稻香河流继续奔跑"}');
  let ttsOptions = null;
  const tts = {
    available: true,
    synthesize: async (text, options) => { ttsOptions = { text, options }; return { audio: Buffer.from("wav"), format: "wav" }; },
  };
  const egg = new SingingEasterEgg({ model, tts });
  const result = await egg.run("唱歌转写");
  assert.equal(ttsOptions.text, "还记得你说家是唯一的城堡 随着稻香河流继续奔跑");
  assert.equal(ttsOptions.options.sing, true);
  assert.ok(result);
});

test("彩蛋编排：非唱歌时返回 null 且不调用 TTS", async () => {
  const model = makeModelAdapter('{"isSinging":false,"songName":"","continuation":""}');
  const tts = makeTtsAdapter();
  const egg = new SingingEasterEgg({ model, tts });
  const result = await egg.run("今天天气怎么样");
  assert.equal(result, null);
  assert.equal(tts.calls(), 0);
});

test("彩蛋编排：模型或 TTS 不可用时返回 null", async () => {
  const eggNoModel = new SingingEasterEgg({ model: null, tts: makeTtsAdapter() });
  assert.equal(eggNoModel.available, false);
  assert.equal(await eggNoModel.run("唱歌"), null);

  const eggNoTts = new SingingEasterEgg({ model: makeModelAdapter('{"isSinging":true,"songName":"x","continuation":"a b"}'), tts: null });
  assert.equal(eggNoTts.available, false);
  assert.equal(await eggNoTts.run("唱歌"), null);
});

test("彩蛋编排：模型异常、TTS 异常与空输入均返回 null", async () => {
  const throwingModel = new SingingEasterEgg({
    model: { generative: true, respond: async () => { throw new Error("boom"); } },
    tts: makeTtsAdapter(),
  });
  assert.equal(await throwingModel.run("唱歌"), null);

  const throwingTts = new SingingEasterEgg({
    model: makeModelAdapter('{"isSinging":true,"songName":"x","continuation":"a b"}'),
    tts: { available: true, synthesize: async () => { throw new Error("boom"); } },
  });
  assert.equal(await throwingTts.run("唱歌"), null);

  const egg = new SingingEasterEgg({ model: makeModelAdapter('{"isSinging":true}'), tts: makeTtsAdapter() });
  assert.equal(await egg.run(""), null);
  assert.equal(await egg.run("   "), null);
});

test("固定回复模板包含歌词与空气管家引导", () => {
  const reply = EASTER_REPLY_TEMPLATE("两句歌词");
  assert.ok(reply.includes("两句歌词"));
  assert.ok(reply.includes("空气小助手 Luna"));
  assert.ok(reply.includes("净化器"));
});
