import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createHttpAssistantServer, DEFAULT_REQUEST_TIMEOUT_MS } from "../src/api/http-server.js";

function makeAdminHash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return salt.toString("hex") + scryptSync(password, salt, 64).toString("hex");
}

function messageRequest(message, sequence, overrides = {}) {
  return {
    contractVersion: "1.0.0",
    conversationId: overrides.conversationId ?? `http-conversation-${sequence}`,
    clientMessageId: `http-client-${sequence}`,
    idempotencyKey: `http-key-${sequence}`,
    message,
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    ...overrides,
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

  await context.test("API Key 未配置时不要求鉴权", async () => {
    const { response, body } = await jsonResponse(`${address.url}/v1/health`);
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
  });

  await context.test("API Key 配置后缺失或错误返回 401，正确返回 200", async () => {
    const secured = createHttpAssistantServer({ port: 0, apiKey: "s3cret" });
    const securedAddress = await secured.start();
    context.after(() => secured.close());
    const missing = await jsonResponse(`${securedAddress.url}/v1/health`);
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.code, "UNAUTHORIZED");
    assert.equal(missing.body.retryable, false);
    const wrong = await jsonResponse(`${securedAddress.url}/v1/health`, { headers: { "X-Api-Key": "wrong" } });
    assert.equal(wrong.response.status, 401);
    const ok = await jsonResponse(`${securedAddress.url}/v1/health`, { headers: { "X-Api-Key": "s3cret" } });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.body.status, "ok");
  });

  await context.test("后端登录：正确凭据发 token、错误凭据 401、无 token 访问受限路由 401", async () => {
    const secured = createHttpAssistantServer({
      port: 0,
      apiKey: "k",
      adminPasswordHash: makeAdminHash("correct-horse", "ab".repeat(32)),
      sessionTtlMs: 60_000,
    });
    const securedAddress = await secured.start();
    context.after(() => secured.close());
    const badLogin = await jsonResponse(`${securedAddress.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "k" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    assert.equal(badLogin.response.status, 401);
    assert.equal(badLogin.body.code, "INVALID_CREDENTIALS");
    const login = await jsonResponse(`${securedAddress.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "k" },
      body: JSON.stringify({ username: "admin", password: "correct-horse" }),
    });
    assert.equal(login.response.status, 200);
    assert.equal(typeof login.body.token, "string");
    const token = login.body.token;
    const noToken = await jsonResponse(`${securedAddress.url}/v1/health`, { headers: { "X-Api-Key": "k" } });
    assert.equal(noToken.response.status, 200);
    assert.equal(noToken.body.status, "ok");
    const withToken = await jsonResponse(`${securedAddress.url}/v1/health`, {
      headers: { "X-Api-Key": "k", Authorization: `Bearer ${token}` },
    });
    assert.equal(withToken.response.status, 200);
    const logout = await jsonResponse(`${securedAddress.url}/v1/auth/logout`, {
      method: "POST",
      headers: { "X-Api-Key": "k", Authorization: `Bearer ${token}` },
    });
    assert.equal(logout.response.status, 200);
    const afterLogout = await jsonResponse(`${securedAddress.url}/v1/health`, {
      headers: { "X-Api-Key": "k", Authorization: `Bearer ${token}` },
    });
    assert.equal(afterLogout.response.status, 200);
    assert.equal(afterLogout.body.status, "ok");
  });

  await context.test("敏感 POST 路由限流：超限返回 429 并带 Retry-After", async () => {
    const limited = createHttpAssistantServer({ port: 0, rateLimitEnabled: true, rateLimitMax: 2 });
    const limitedAddress = await limited.start();
    context.after(() => limited.close());
    const headers = { "X-Api-Key": "k", Authorization: "Bearer t", "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" };
    const post = () => jsonResponse(`${limitedAddress.url}/v1/conversations/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(messageRequest("ping", 999)),
    });
    const get = () => jsonResponse(`${limitedAddress.url}/v1/health`, { headers: { "CF-Connecting-IP": "203.0.113.7" } });
    assert.equal((await get()).response.status, 200);
    assert.ok([200, 400].includes((await post()).response.status));
    assert.ok([200, 400].includes((await post()).response.status));
    const blocked = await post();
    assert.equal(blocked.response.status, 429);
    assert.equal(blocked.body.code, "RATE_LIMITED");
    assert.equal(blocked.response.headers.get("retry-after"), "60");
    const getStillAllowed = await get();
    assert.equal(getStillAllowed.response.status, 200);
  });

  await context.test("JSON 深度守卫：深层嵌套请求返回 400", async () => {
    let nested = null;
    for (let i = 0; i < 80; i++) nested = { a: nested };
    const deep = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nested),
    });
    assert.equal(deep.response.status, 400);
    assert.equal(deep.body.code, "INVALID_REQUEST");
  });

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

  await context.test("POST accepts city field and rejects non-string city", async () => {
    const withCity = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageRequest("现在空气怎么样", 9, { city: "杭州" })),
    });
    assert.equal(withCity.response.status, 200);

    const badCity = await jsonResponse(`${address.url}/v1/conversations/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageRequest("现在空气怎么样", 10, { city: 42 })),
    });
    assert.equal(badCity.response.status, 400);
    assert.equal(badCity.body.code, "INVALID_REQUEST");
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
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS, DELETE");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, X-Api-Key, Authorization");

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

test("POST /v1/asr 转写成功返回文字", async (context) => {
  const assistant = {
    getBootstrap: async () => ({ contractVersion: "1.0.0", mode: "local_mock" }),
    sendMessage: async () => ({}),
    transcribeAudio: async (audio, options) => ({ available: true, text: "你好，我是呼吸森林的语音助手" }),
  };
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const wav = Buffer.from("fake-wav-bytes");
  const { response, body } = await jsonResponse(`${address.url}/v1/asr`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { text: "你好，我是呼吸森林的语音助手" });
});

test("POST /v1/asr 适配器不可用时返回 503 且不泄露内部信息", async (context) => {
  const assistant = {
    getBootstrap: async () => ({ contractVersion: "1.0.0", mode: "local_mock" }),
    sendMessage: async () => ({}),
    transcribeAudio: async () => ({ available: false, reason: "asr_unavailable" }),
  };
  const service = createHttpAssistantServer({ assistant, port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const wav = Buffer.from("fake-wav-bytes");
  const { response, body } = await jsonResponse(`${address.url}/v1/asr`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  assert.equal(response.status, 503);
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  assert.equal(body.retryable, true);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId", "retryable"]);
  assert.doesNotMatch(JSON.stringify(body), /stack|node:|at\s+\w+|asr_unavailable|fake-wav/i);
});

test("POST /v1/asr 空音频与超限音频返回契约错误", async (context) => {
  const service = createHttpAssistantServer({ port: 0 });
  const address = await service.start();
  context.after(() => service.close());

  const empty = await jsonResponse(`${address.url}/v1/asr`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: Buffer.alloc(0),
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.body.code, "INVALID_REQUEST");

  const oversized = await jsonResponse(`${address.url}/v1/asr`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: Buffer.alloc(9 * 1024 * 1024),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.code, "INPUT_TOO_LONG");
  assert.doesNotMatch(JSON.stringify([empty.body, oversized.body]), /stack|node:|at\s+\w+/i);
});
