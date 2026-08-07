import test from "node:test";
import assert from "node:assert/strict";
import { DashScopeAsrAdapter, DASHSCOPE_ASR_DEFAULT_MODEL } from "../src/index.js";

function makeAdapter(fetchImpl, options = {}) {
  // Explicit endpoint/model shield these assertions from any real
  // backend/.env values that may exist on the machine running the tests.
  return new DashScopeAsrAdapter({
    apiKey: "test-key",
    enabled: true,
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: DASHSCOPE_ASR_DEFAULT_MODEL,
    fetchImpl,
    ...options,
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("DashScope ASR 适配器请求结构符合端点、模型与密钥约束", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return jsonResponse({
      choices: [{ message: { content: "你好，我是呼吸森林的语音助手", role: "assistant" } }],
    });
  };
  const adapter = makeAdapter(fetchImpl);
  const audio = Buffer.from("fake-wav-bytes");
  const result = await adapter.transcribe(audio, { mimeType: "audio/wav" });
  assert.equal(captured.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.equal(captured.body.model, DASHSCOPE_ASR_DEFAULT_MODEL);
  assert.equal(captured.body.stream, false);
  const content = captured.body.messages[0].content[0];
  assert.equal(content.type, "input_audio");
  assert.ok(content.input_audio.data.startsWith("data:audio/wav;base64,"));
  assert.equal(content.input_audio.data, `data:audio/wav;base64,${audio.toString("base64")}`);
  assert.equal(result.text, "你好，我是呼吸森林的语音助手");
  assert.equal(result.language, null);
  assert.equal(result.referenceId, DASHSCOPE_ASR_DEFAULT_MODEL);
  assert.ok(result.observedAt);
});

test("未启用或缺少密钥时不可用且不发起网络请求", async () => {
  const disabled = new DashScopeAsrAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(disabled.available, false);
  assert.equal(await disabled.transcribe(Buffer.from("x")), null);

  const noKey = new DashScopeAsrAdapter({ enabled: true, apiKey: "", fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(noKey.available, false);
  assert.equal(await noKey.transcribe(Buffer.from("x")), null);

  const emptyAudio = makeAdapter(() => { throw new Error("should not call"); });
  assert.equal(await emptyAudio.transcribe(new Uint8Array(0)), null);
});

test("失败、非 2xx 与异常均返回 null 且不泄露密钥", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return jsonResponse({ error: { message: "boom" } }, 500);
  };
  const adapter = makeAdapter(failing);
  assert.equal(await adapter.transcribe(Buffer.from("x")), null);
  assert.equal(calls, 1);

  const throwing = makeAdapter(async () => { throw new Error("network down"); });
  assert.equal(await throwing.transcribe(Buffer.from("x")), null);

  const emptyTranscript = makeAdapter(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));
  assert.equal(await emptyTranscript.transcribe(Buffer.from("x")), null);

  const badJson = makeAdapter(async () => new Response("not json", { status: 200 }));
  assert.equal(await badJson.transcribe(Buffer.from("x")), null);
});
