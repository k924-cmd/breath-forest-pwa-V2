import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAssistantServer, DEFAULT_REQUEST_TIMEOUT_MS } from "../src/api/http-server.js";

function messageRequest(message, sequence, overrides = {}) {
  return {
    contractVersion: "1.0.0",
    conversationId: overrides.conversationId ?? `http-conversation-${sequence}`,
    clientMessageId: `http-client-${sequence}`,
    idempotencyKey: `http-key-${sequence}`,
    message,
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
  };
}

async function jsonResponse(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test("本地 HTTP 适配器契约", async (context) => {
  const service = createHttpAssistantServer({
    port: 0,
    actorId: "configured-local-actor",
    scopeId: "configured-local-scope",
  });
  const address = await service.start();
  context.after(() => service.close());
  assert.equal(address.host, "127.0.0.1");
  assert.ok(address.port > 0);
  assert.equal(service.server.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);

  await context.test("GET health", async () => {
    const { response, body } = await jsonResponse(`${address.url}/v1/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(body, { status: "ok", contractVersion: "1.0.0", mode: "local_mock" });
    assert.doesNotMatch(JSON.stringify(body), /stack|process\.env|\\|:\//i);
  });

  await context.test("GET bootstrap preserves Mock sources", async () => {
    const { response, body } = await jsonResponse(`${address.url}/v1/bootstrap`);
    assert.equal(response.status, 200);
    assert.equal(body.contractVersion, "1.0.0");
    assert.equal(body.mode, "local_mock");
    assert.equal(Number.isNaN(new Date(body.observedAt).getTime()), false);
    assert.equal(body.activeTask, null);
    assert.ok(body.devices.length >= 6);
    assert.equal(body.devices.every((device) => device.source === "mock"), true);
    assert.equal(body.environment.source, "mock");
    assert.equal(body.environment.freshness, "fresh");

    service.assistant.adapters.environment.snapshot.freshness = "stale";
    const stale = await jsonResponse(`${address.url}/v1/bootstrap`);
    assert.equal(stale.body.environment, null);
    service.assistant.adapters.environment.snapshot.freshness = "fresh";
  });

  await context.test("POST success path and server-side identity injection", async () => {
    const request = messageRequest("现在空气怎么样", 1, { conversationId: "identity-conversation" });
    const { response, body } = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Actor-Id": "attacker-actor",
        "X-Scope-Id": "attacker-scope",
      },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    assert.equal(body.responseType, "environment_status");
    const state = service.assistant.adapters.repository.getConversation("identity-conversation");
    assert.equal(state.actorId, "configured-local-actor");
    assert.equal(state.scopeId, "configured-local-scope");
  });

  await context.test("structured domain error still returns HTTP 200", async () => {
    const { response, body } = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageRequest("打开加湿器", 2)),
    });
    assert.equal(response.status, 200);
    assert.equal(body.responseType, "rejection");
    assert.equal(body.error.code, "ACTION_UNSUPPORTED");
  });

  await context.test("CORS allowlist and preflight", async () => {
    const allowed = await jsonResponse(`${address.url}/v1/health`, { headers: { Origin: "http://localhost:4173" } });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.response.headers.get("access-control-allow-origin"), "http://localhost:4173");

    const denied = await jsonResponse(`${address.url}/v1/health`, { headers: { Origin: "https://untrusted.example" } });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, "POLICY_REJECTED");
    assert.equal(denied.response.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${address.url}/v1/conversations/messages`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:4173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");

    const identityPreflight = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-Actor-Id",
      },
    });
    assert.equal(identityPreflight.response.status, 400);
  });

  await context.test("rejects wrong Content-Type, oversized body and invalid JSON", async () => {
    const wrongType = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.response.status, 415);
    assert.equal(wrongType.body.code, "INVALID_REQUEST");

    const oversized = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageRequest("x".repeat(70 * 1024), 3)),
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.code, "INPUT_TOO_LONG");

    const invalidJson = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.code, "INVALID_REQUEST");
  });

  await context.test("returns stable 404, 405 and contract errors without stacks", async () => {
    const missing = await jsonResponse(`${address.url}/v1/missing`);
    assert.equal(missing.response.status, 404);
    assert.deepEqual(Object.keys(missing.body).sort(), ["code", "message", "requestId", "retryable"]);

    const wrongMethod = await jsonResponse(`${address.url}/v1/health`, { method: "POST" });
    assert.equal(wrongMethod.response.status, 405);
    assert.equal(wrongMethod.response.headers.get("allow"), "GET");

    const invalidContract = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(invalidContract.response.status, 400);
    assert.doesNotMatch(JSON.stringify([missing.body, wrongMethod.body, invalidContract.body]), /stack|node:|at\s+\w+/i);
  });
});

test("HTTP 处理期限覆盖等待中的助手适配器", async (context) => {
  const assistant = {
    getBootstrap: async () => new Promise(() => {}),
    sendMessage: async () => new Promise(() => {}),
  };
  const service = createHttpAssistantServer({ assistant, port: 0, requestTimeoutMs: 25 });
  const address = await service.start();
  context.after(() => service.close());

  const { response, body } = await jsonResponse(`${address.url}/v1/bootstrap`);
  assert.equal(response.status, 503);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId", "retryable"]);
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  assert.equal(body.retryable, true);
  assert.doesNotMatch(JSON.stringify(body), /stack|node:|at\s+\w+/i);
});

test("HTTP 未处理异常使用稳定公开错误且不泄露内部信息", async (context) => {
  const assistant = {
    getBootstrap: async () => {
      throw new Error("private credential and C:\\internal\\service.js:42");
    },
    sendMessage: async () => {
      throw new Error("private conversation");
    },
  };
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const { response, body } = await jsonResponse(`${address.url}/v1/bootstrap`);
  assert.equal(response.status, 500);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId", "retryable"]);
  assert.equal(body.code, "INTERNAL_ERROR");
  assert.equal(body.retryable, true);
  assert.doesNotMatch(JSON.stringify(body), /credential|conversation|service\.js|stack|node:|at\s+\w+/i);
});

test("GET /v1/weather 无实时适配器时降级返回", async (context) => {
  const service = createHttpAssistantServer({ port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const { response, body } = await jsonResponse(`${address.url}/v1/weather?city=${encodeURIComponent("杭州")}`);
  assert.equal(response.status, 200);
  assert.equal(body.available, false);
  assert.equal(body.city, "杭州");
  assert.equal(body.reason, "realtime_unavailable");
});
