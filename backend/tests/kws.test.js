import test from "node:test";
import assert from "node:assert/strict";
import { KwsFallbackAdapter, KwsHttpAdapter } from "../src/adapters/kws.js";

function audioBytes(length = 8000) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = 128; // 静音
  return bytes;
}

test("KwsFallbackAdapter 恒可用并返回结构化结果", () => {
  const adapter = new KwsFallbackAdapter();
  assert.equal(adapter.available, true);
  const result = adapter.check(audioBytes());
  assert.ok(result);
  assert.equal(typeof result.detected, "boolean");
  assert.equal(result.keyword, "小云小云");
  assert.equal(result.source, "fallback");
  if (result.detected) {
    assert.equal(typeof result.score, "number");
    assert.equal(typeof result.latencyMs, "number");
  }
});

test("KwsFallbackAdapter 空音频返回 null", () => {
  const adapter = new KwsFallbackAdapter();
  assert.equal(adapter.check(new Uint8Array(0)), null);
  assert.equal(adapter.check(null), null);
});

test("KwsFallbackAdapter disabled 时不可用", () => {
  const adapter = new KwsFallbackAdapter({ enabled: false });
  assert.equal(adapter.available, false);
  assert.equal(adapter.check(audioBytes()), null);
});

test("KwsHttpAdapter 未启用时不可用且不发请求", async () => {
  const adapter = new KwsHttpAdapter({ enabled: false, fetchImpl: async () => { throw new Error("should not call"); } });
  assert.equal(adapter.available, false);
  assert.equal(await adapter.check(audioBytes()), null);
});

test("KwsHttpAdapter 正常代理返回检测结果", async () => {
  const adapter = new KwsHttpAdapter({
    serviceUrl: "http://127.0.0.1:8901",
    enabled: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8901/kws");
      assert.equal(options.method, "POST");
      assert.ok(options.body instanceof Uint8Array);
      return {
        ok: true,
        json: async () => ({ detected: true, keyword: "小云小云", score: 0.92, latency_ms: 180, source: "python-kws" }),
      };
    },
  });
  const result = await adapter.check(audioBytes());
  assert.equal(result.detected, true);
  assert.equal(result.score, 0.92);
  assert.equal(result.latencyMs, 180);
  assert.equal(result.source, "python-kws");
});

test("KwsHttpAdapter 服务失败/超时降级 null 且不抛", async () => {
  const adapter = new KwsHttpAdapter({
    serviceUrl: "http://127.0.0.1:8901",
    enabled: true,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const result = await adapter.check(audioBytes());
  assert.equal(result, null);
});
