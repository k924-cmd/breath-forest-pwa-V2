import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpAssistantServer } from "../src/api/http-server.js";
import { createLocalAssistant, SqliteStateRepository } from "../src/index.js";

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

async function withService(context, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "breath-forest-http-sqlite-"));
  // node:test after 钩子按注册顺序执行；先释放数据库连接与服务器，再删临时目录（Windows 文件锁）
  let repository = overrides.repository;
  if (!repository) repository = new SqliteStateRepository({ path: join(directory, "http-test.db") });
  const service = createHttpAssistantServer({
    port: 0,
    assistant: createLocalAssistant({ repository }),
    ...overrides,
  });
  const address = await service.start();
  context.after(() => repository.close());
  context.after(() => service.close());
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { service, address };
}

test("对话历史 API：GET 空会话返回空数组 200", async (context) => {
  const { address } = await withService(context);
  const { response, body } = await jsonResponse(`${address.url}/v1/conversations/ghost-conversation/messages`);
  assert.equal(response.status, 200);
  assert.equal(body.contractVersion, "1.0.0");
  assert.equal(body.conversationId, "ghost-conversation");
  assert.deepEqual(body.messages, []);
  assert.equal(body.count, 0);
});

test("对话历史 API：DELETE 非法 messageIds 返回 400 INVALID_REQUEST", async (context) => {
  const { address } = await withService(context);
  const bad = [
    { messageIds: "nope" },
    { messageIds: [42] },
    { messageIds: [""] },
    {},
  ];
  for (const payload of bad) {
    const { response, body } = await jsonResponse(`${address.url}/v1/conversations/history-conversation/messages`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(body.code, "INVALID_REQUEST", JSON.stringify(payload));
  }
  const extraField = await jsonResponse(`${address.url}/v1/conversations/history-conversation/messages`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds: ["a"], other: 1 }),
  });
  assert.equal(extraField.response.status, 400);
  assert.equal(extraField.body.code, "INVALID_REQUEST");
});

test("对话历史 API：DELETE 方法出现在 CORS preflight 的 Allow-Methods 里", async (context) => {
  const { address } = await withService(context);
  const preflight = await fetch(`${address.url}/v1/conversations/history-conversation/messages`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:4173",
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:4173");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS, DELETE");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, X-Api-Key, Authorization");
});

test("会话完整链路：发消息 → 读取两条 → 删除 → 读取为空", async (context) => {
  const { address, service } = await withService(context);
  const conversationId = "full-cycle-conversation";

  const send = await jsonResponse(`${address.url}/v1/conversations/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageRequest("现在空气怎么样", 1, { conversationId })),
  });
  assert.equal(send.response.status, 200);
  assert.equal(send.body.responseType, "environment_status");

  const listed = await jsonResponse(`${address.url}/v1/conversations/${conversationId}/messages`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.conversationId, conversationId);
  assert.equal(listed.body.count, 2);
  assert.deepEqual(listed.body.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(listed.body.messages[0].content, "现在空气怎么样");
  assert.equal(listed.body.messages[0].status, undefined);
  assert.equal(listed.body.messages[1].role, "assistant");
  assert.equal(listed.body.messages[1].responseType, "environment_status");
  assert.equal(listed.body.messages[1].status, "complete");
  assert.ok(Array.isArray(listed.body.messages[1].sources));
  assert.ok(listed.body.messages[1].sources.length >= 1);
  assert.equal(new Date(listed.body.messages[0].createdAt).getTime() <= new Date(listed.body.messages[1].createdAt).getTime(), true);

  const idempotentReread = await jsonResponse(`${address.url}/v1/conversations/${conversationId}/messages`);
  assert.equal(idempotentReread.body.count, 2);
  // InMemory 会话态只保留 user 消息；assistant 消息在 SQLite messages 表中
  assert.equal(service.assistant.adapters.repository.getConversation(conversationId).messages.length, 1);

  const ids = listed.body.messages.map((message) => message.id);
  const removed = await jsonResponse(`${address.url}/v1/conversations/${conversationId}/messages`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds: ids }),
  });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body, { deleted: 2, conversationId });

  const after = await jsonResponse(`${address.url}/v1/conversations/${conversationId}/messages`);
  assert.equal(after.response.status, 200);
  assert.equal(after.body.count, 0);
  assert.deepEqual(after.body.messages, []);
});

test("对话历史 API：路由方法与错误契约稳定", async (context) => {
  const { address } = await withService(context);
  const wrongMethod = await jsonResponse(`${address.url}/v1/conversations/abc/messages`, { method: "PUT" });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.body.code, "INVALID_REQUEST");

  const missing = await jsonResponse(`${address.url}/v1/conversations/abc/not-messages`);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.code, "INVALID_REQUEST");
  assert.doesNotMatch(JSON.stringify(missing.body), /stack|node:|at\s+\w+/i);
});
