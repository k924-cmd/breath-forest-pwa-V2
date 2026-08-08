import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAssistantServer } from "../src/api/http-server.js";
import { createLocalAssistant } from "../src/index.js";

async function jsonResponse(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function makeEasterAssistant() {
  const model = {
    generative: true,
    referenceId: "test-deepseek",
    respond: async () => '{"isSinging":true,"songName":"晴天","continuation":"故事的小黄花 从出生那年就飘着"}',
  };
  const tts = {
    available: true,
    referenceId: "test-mimo",
    synthesize: async (text, options) => ({
      audio: Buffer.from("fake-sing-wav"),
      format: "wav",
      voice: "冰糖",
      text,
      sing: options?.sing,
    }),
  };
  return createLocalAssistant({ model, tts });
}

test("HTTP /v1/tts/easter-egg 唱歌链路返回歌词、回复与音频", async (context) => {
  const assistant = makeEasterAssistant();
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const { response, body } = await jsonResponse(`${address.url}/v1/tts/easter-egg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "用户哼唱的一段模糊歌词转写" }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.songName, "晴天");
  assert.equal(body.continuation, "故事的小黄花 从出生那年就飘着");
  assert.ok(body.replyText.includes("故事的小黄花"));
  assert.ok(body.replyText.includes("空气小助手"));
  assert.equal(body.format, "wav");
  // base64 解码回原音频字节
  assert.equal(Buffer.from(body.audio, "base64").toString(), "fake-sing-wav");
});

test("HTTP /v1/tts/easter-egg 非唱歌返回 available:false", async (context) => {
  const model = {
    generative: true,
    respond: async () => '{"isSinging":false,"songName":"","continuation":""}',
  };
  const tts = { available: true, synthesize: async () => ({ audio: Buffer.from("x") }) };
  const assistant = createLocalAssistant({ model, tts });
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const { response, body } = await jsonResponse(`${address.url}/v1/tts/easter-egg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "今天天气怎么样" }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.available, false);
});

test("HTTP /v1/tts/easter-egg 校验请求体与 404 路由", async (context) => {
  const assistant = makeEasterAssistant();
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const empty = await jsonResponse(`${address.url}/v1/tts/easter-egg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.response.status, 400);

  const unknownField = await jsonResponse(`${address.url}/v1/tts/easter-egg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x", evil: true }),
  });
  assert.equal(unknownField.response.status, 400);

  const wrongMethod = await jsonResponse(`${address.url}/v1/tts/easter-egg`, {});
  assert.equal(wrongMethod.response.status, 405);

  const notFound = await jsonResponse(`${address.url}/v1/tts/other`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(notFound.response.status, 404);
});
