import test from "node:test";
import assert from "node:assert/strict";
import { MiMoTtsAdapter, MIMO_TTS_DEFAULT_MODEL, SINGING_TAG } from "../src/index.js";

function makeAdapter(fetchImpl, options = {}) {
  return new MiMoTtsAdapter({
    apiKey: "test-mimo-key",
    enabled: true,
    endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
    model: MIMO_TTS_DEFAULT_MODEL,
    fetchImpl,
    ...options,
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function audioResponse(audioData) {
  return jsonResponse({
    choices: [{ message: { role: "assistant", audio: { data: audioData } } }],
  });
}

test("MiMo TTS 请求结构符合端点、模型、api-key 与音频参数约束", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return audioResponse(Buffer.from("fake-wav-bytes").toString("base64"));
  };
  const adapter = makeAdapter(fetchImpl);
  const result = await adapter.synthesize("空气净化器已开启", { sing: false });
  assert.equal(captured.url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.options.headers["api-key"], "test-mimo-key");
  assert.equal(captured.body.model, MIMO_TTS_DEFAULT_MODEL);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.audio.format, "wav");
  assert.equal(captured.body.audio.voice, "冰糖");
  assert.equal(captured.body.messages[0].role, "user");
  assert.equal(captured.body.messages[1].role, "assistant");
  assert.equal(captured.body.messages[1].content, "空气净化器已开启");
  assert.equal(result.audio.toString(), "fake-wav-bytes");
  assert.equal(result.format, "wav");
  assert.equal(result.sing, false);
});

test("唱歌模式在文本开头自动加 (唱歌) 标签", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return audioResponse(Buffer.from("sing-wav").toString("base64"));
  };
  const adapter = makeAdapter(fetchImpl);
  const result = await adapter.synthesize("两条歌词接续", { sing: true });
  assert.equal(captured.messages[1].content, `${SINGING_TAG}两条歌词接续`);
  assert.equal(result.sing, true);
  assert.equal(result.audio.toString(), "sing-wav");
});

test("已带 (唱歌) 标签时不重复添加", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return audioResponse(Buffer.from("wav").toString("base64"));
  };
  const adapter = makeAdapter(fetchImpl);
  await adapter.synthesize(`${SINGING_TAG}歌词`, { sing: true });
  assert.equal(captured.messages[1].content, `${SINGING_TAG}歌词`);
});

test("未启用或缺少密钥时不可用且不发起网络请求", async () => {
  const disabled = new MiMoTtsAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(disabled.available, false);
  assert.equal(await disabled.synthesize("测试"), null);

  const noKey = new MiMoTtsAdapter({ enabled: true, apiKey: "", fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(noKey.available, false);
  assert.equal(await noKey.synthesize("测试"), null);

  const emptyText = makeAdapter(() => { throw new Error("should not call"); });
  assert.equal(await emptyText.synthesize(""), null);
  assert.equal(await emptyText.synthesize("   "), null);
});

test("失败、非 2xx、空音频与异常均返回 null 且不泄露密钥", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return jsonResponse({ error: { message: "boom" } }, 500);
  };
  const adapter = makeAdapter(failing);
  assert.equal(await adapter.synthesize("测试"), null);
  assert.equal(calls, 1);

  const throwing = makeAdapter(async () => { throw new Error("network down"); });
  assert.equal(await throwing.synthesize("测试"), null);

  const emptyAudio = makeAdapter(async () => audioResponse(""));
  assert.equal(await emptyAudio.synthesize("测试"), null);

  const badJson = makeAdapter(async () => new Response("not json", { status: 200 }));
  assert.equal(await badJson.synthesize("测试"), null);
});
