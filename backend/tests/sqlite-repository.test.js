import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAssistant, InMemoryStateRepository, SqliteStateRepository } from "../src/index.js";
import { harness } from "./helpers.js";

test("SqliteStateRepository 持久化消息后重新实例化仍能读回", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "breath-forest-sqlite-"));
  const file = join(directory, "test.db");
  // 先注册 close 钩子，再注册 rm 钩子（node:test after 钩子按注册顺序执行，Windows 上需先释放 WAL 文件）
  let second = null;
  context.after(() => second?.close());
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = new SqliteStateRepository({ path: file });
  first.persistMessages("conv-a", [
    { id: "m-1", role: "user", content: "现在空气怎么样", createdAt: "2026-08-07T01:00:00.000Z" },
    { id: "m-2", role: "assistant", content: "PM2.5 18", createdAt: "2026-08-07T01:00:01.000Z", responseType: "environment_status", status: "complete", sources: [{ type: "mock", observedAt: "2026-08-07T01:00:00.000Z" }] },
  ]);
  first.close();

  second = new SqliteStateRepository({ path: file });
  const messages = second.listMessages("conv-a");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, "m-1");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "现在空气怎么样");
  assert.equal(messages[1].id, "m-2");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].responseType, "environment_status");
  assert.equal(messages[1].status, "complete");
  assert.deepEqual(messages[1].sources, [{ type: "mock", observedAt: "2026-08-07T01:00:00.000Z" }]);
  // 重新实例化不丢已持久化会话；尚未持久化过的会话读取为空
  assert.equal(second.listMessages("never-seen").length, 0);
});

test("SqliteStateRepository persistMessages/listMessages/deleteMessages 正常工作", (context) => {
  const repository = new SqliteStateRepository({ path: ":memory:" });
  context.after(() => repository.close());

  repository.persistMessages("conv-b", [
    { id: "u-1", role: "user", content: "打开空气净化器", createdAt: "2026-08-07T02:00:00.000Z" },
    { id: "a-1", role: "assistant", content: "已执行", createdAt: "2026-08-07T02:00:02.000Z", responseType: "execution_result", receipt: { receiptId: "r-1", status: "succeeded", actions: [] } },
    { id: "u-2", role: "user", content: "空气净化器状态怎么样", createdAt: "2026-08-07T02:00:03.000Z" },
  ]);
  repository.persistMessages("conv-b", [
    { id: "a-2", role: "assistant", content: "状态 运行", createdAt: "2026-08-07T02:00:04.000Z", responseType: "device_status", sources: [{ type: "mock", observedAt: "2026-08-07T02:00:04.000Z", referenceId: "purifier-living" }] },
  ]);

  const messages = repository.listMessages("conv-b");
  assert.deepEqual(messages.map((message) => message.id), ["u-1", "a-1", "u-2", "a-2"]);
  assert.equal(messages[1].receipt.receiptId, "r-1");
  assert.equal(messages[3].sources[0].referenceId, "purifier-living");

  const deleted = repository.deleteMessages("conv-b", ["a-1", "u-2", "missing"]);
  assert.equal(deleted, 2);
  const remaining = repository.listMessages("conv-b");
  assert.deepEqual(remaining.map((message) => message.id), ["u-1", "a-2"]);
  const conv = repository.listConversations("home-1").find((item) => item.id === "conv-b");
  assert.equal(conv.actorId, null);
  assert.equal(conv.scopeId, null);
  assert.equal(conv.title, null);
  assert.equal(conv.createdAt, "2026-08-07T02:00:00.000Z");
  assert.equal(typeof conv.updatedAt, "string");
  assert.ok(conv.updatedAt.length > 0);
});

test("SqliteStateRepository 与 InMemory 接口兼容，createLocalAssistant 可零侵入替换", async (context) => {
  const repository = new SqliteStateRepository({ path: ":memory:" });
  context.after(() => repository.close());

  const { app, send } = harness({ repository });
  const result = await send("现在空气怎么样", { conversationId: "compat-conversation" });
  assert.equal(result.responseType, "environment_status");
  assert.equal(result.message.role, "assistant");

  const state = app.adapters.repository.getConversation("compat-conversation");
  // InMemory 行为：state.messages 只记录 user 消息；assistant 消息走 SQLite 持久化
  assert.deepEqual(state.messages.map((message) => message.role), ["user"]);
  assert.equal(state.actorId, "actor-1");
  assert.equal(state.scopeId, "home-1");
  state.messages.push({ id: "extra", role: "user", content: "外部 push", createdAt: "2026-08-07T03:00:00.000Z" });
  assert.equal(app.adapters.repository.getConversation("compat-conversation").messages.length, 2);

  const persisted = repository.listMessages("compat-conversation");
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.map((message) => message.role), ["user", "assistant"]);
  assert.equal(persisted[1].responseType, "environment_status");
  assert.ok(persisted[1].sources.length >= 1);
  assert.equal(app.endConversation("compat-conversation"), true);
  assert.equal(app.adapters.repository.conversations.has("compat-conversation"), false);
});

test("SqliteStateRepository 每次 getConversation 返回同构默认态", (context) => {
  const repository = new SqliteStateRepository({ path: ":memory:" });
  context.after(() => repository.close());
  const state = repository.getConversation("fresh-conversation");
  assert.deepEqual(Object.keys(state).sort(), [
    "actorId", "currentTaskId", "messages", "pendingClarification", "pendingConfirmation", "recentDeviceId", "scopeId", "topic",
  ]);
  assert.deepEqual(state.messages, []);
  assert.equal(state.pendingConfirmation, null);
  assert.equal(state.pendingClarification, null);
  assert.equal(repository.getTask("home-1"), null);
  const task = { taskId: "t-1", status: "running", taskVersion: 1, updatedAt: "2026-08-07T04:00:00.000Z" };
  assert.equal(repository.setTask("home-1", task), task);
  assert.equal(repository.getTask("home-1"), task);
});

test("InMemoryStateRepository 扩展接口与 Sqlite 行为一致", () => {
  const repository = new InMemoryStateRepository();
  const state = repository.getConversation("c");
  state.messages.push({ id: "u", role: "user", content: "hi", createdAt: "2026-08-07T05:00:00.000Z" });
  repository.persistMessages("c", [{ id: "a", role: "assistant", content: "hello", createdAt: "2026-08-07T05:00:01.000Z", responseType: "chat" }]);
  assert.deepEqual(repository.listMessages("c").map((message) => message.role), ["user", "assistant"]);
  assert.equal(repository.deleteMessages("c", ["u"]), 1);
  assert.deepEqual(repository.listMessages("c").map((message) => message.id), ["a"]);
});

test("createLocalAssistant 默认仍使用 InMemoryStateRepository", async () => {
  const { app } = harness();
  assert.ok(app.adapters.repository instanceof InMemoryStateRepository);
  const result = await app.sendMessage(
    { contractVersion: "1.0.0", conversationId: "default-c", clientMessageId: "m", idempotencyKey: "k", message: "你好", locale: "zh-CN", timezone: "Asia/Shanghai" },
    { actorId: "a", scopeId: "s" }
  );
  assert.equal(result.responseType, "chat");
});
