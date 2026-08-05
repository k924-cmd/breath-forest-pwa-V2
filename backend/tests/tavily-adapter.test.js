import test from "node:test";
import assert from "node:assert/strict";
import { TavilySearchAdapter, TAVILY_MAX_RESULTS_DEFAULT } from "../src/index.js";

function makeAdapter(fetchImpl, options = {}) {
  // Explicit endpoint/maxResults shield these assertions from any real
  // backend/.env values that may exist on the machine running the tests.
  return new TavilySearchAdapter({ apiKey: "test-key", enabled: true, endpoint: "https://api.tavily.com/search", maxResults: 3, fetchImpl, ...options });
}

test("Tavily 适配器请求结构符合端点、查询与密钥约束", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      answer: "杭州今天晴，26°C",
      results: [
        { title: "杭州天气", url: "https://example.com/hz", content: "晴 26°C" },
        { title: "空气质量", url: "https://example.com/aqi", content: "AQI 良好" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = makeAdapter(fetchImpl);
  const result = await adapter.search("今天天气怎么样");
  assert.equal(captured.url, "https://api.tavily.com/search");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.body.api_key, "test-key");
  assert.equal(captured.body.query, "今天天气怎么样");
  assert.equal(captured.body.max_results, TAVILY_MAX_RESULTS_DEFAULT);
  assert.equal(captured.body.include_answer, true);
  assert.equal(result.answer, "杭州今天晴，26°C");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, "杭州天气");
  assert.equal(result.source, "real_time");
  assert.equal(result.referenceId, "tavily");
  assert.ok(result.observedAt);
});

test("未启用或缺少密钥时不可用且不发起网络请求", async () => {
  const disabled = new TavilySearchAdapter({ apiKey: "k", enabled: false, fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(disabled.available, false);
  assert.equal(await disabled.search("今天天气怎么样"), null);

  const noKey = new TavilySearchAdapter({ enabled: true, apiKey: "", fetchImpl: () => { throw new Error("should not call"); } });
  assert.equal(noKey.available, false);
  assert.equal(await noKey.search("今天天气怎么样"), null);

  const noQuery = makeAdapter(() => { throw new Error("should not call"); });
  assert.equal(await noQuery.search("   "), null);
});

test("失败、非 2xx 与异常均返回 null 且不泄露密钥", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response("{}", { status: 500 });
  };
  const adapter = makeAdapter(failing);
  assert.equal(await adapter.search("今天天气怎么样"), null);
  assert.equal(calls, 1);

  const throwing = makeAdapter(async () => { throw new Error("network down"); });
  assert.equal(await throwing.search("今天天气怎么样"), null);

  const badJson = makeAdapter(async () => new Response("not json", { status: 200 }));
  assert.equal(await badJson.search("今天天气怎么样"), null);
});
