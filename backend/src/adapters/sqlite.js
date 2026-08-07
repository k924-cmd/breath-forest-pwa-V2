import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let sequence = 0;

function createId(prefix) {
  sequence += 1;
  const suffix = `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${suffix}`;
}

const DEFAULT_STATE = () => ({
  actorId: null,
  scopeId: null,
  topic: null,
  recentDeviceId: null,
  currentTaskId: null,
  messages: [],
  pendingClarification: null,
  pendingConfirmation: null,
});

const ALLOWED_META_KEYS = ["sources", "error", "realtime", "continuation", "confirmation", "clarification", "task", "receipt", "receiptId", "requestId", "planId"];

// rowKeyField is set for SqliteStateRepository (persistMessages) so meta and
// responseType/sourceMode land in their dedicated columns; the InMemory no-op
// keeps every payload key in the meta bag and never touches SQLite.
function persistMessagesWith(table, conversationId, messages, { rowKeyField = null } = {}) {
  if (!conversationId || !Array.isArray(messages) || !messages.length) return;
  const rows = messages.map((raw) => {
    const message = raw && typeof raw === "object" ? raw : {};
    const meta = {};
    for (const key of ALLOWED_META_KEYS) {
      if (message[key] !== undefined) meta[key] = message[key];
    }
    return {
      id: String(message.id ?? createId("sqlite-message")),
      conversation_id: conversationId,
      role: String(message.role ?? "assistant"),
      content: String(message.content ?? ""),
      response_type: rowKeyField ? (message.responseType ?? null) : null,
      status: rowKeyField ? (message.status ?? null) : null,
      created_at: String(message.createdAt ?? new Date().toISOString()),
      meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
    };
  });
  const byTime = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const updateConversation = table.prepare(
    "INSERT INTO conversations(id, actor_id, scope_id, title, created_at, updated_at) VALUES (?, NULL, NULL, NULL, ?, ?) "
    + "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at"
  );
  updateConversation.run(conversationId, byTime[0].created_at, byTime[byTime.length - 1].created_at);
  const upsert = table.prepare(
    "INSERT INTO messages(id, conversation_id, role, content, response_type, status, created_at, meta) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
    + "ON CONFLICT(id) DO UPDATE SET role = excluded.role, content = excluded.content, "
    + "response_type = excluded.response_type, status = excluded.status, created_at = excluded.created_at, meta = excluded.meta"
  );
  for (const row of rows) {
    upsert.run(row.id, row.conversation_id, row.role, row.content, row.response_type, row.status, row.created_at, row.meta);
  }
}

function readRowToMessage(row) {
  const message = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
  if (row.response_type !== null && row.response_type !== undefined) message.responseType = row.response_type;
  if (row.status !== null && row.status !== undefined) message.status = row.status;
  if (row.meta) {
    let meta;
    try {
      meta = JSON.parse(row.meta);
    } catch {
      meta = null;
    }
    if (meta && typeof meta === "object") {
      for (const [key, value] of Object.entries(meta)) {
        if (value !== undefined) message[key] = value;
      }
    }
  }
  return message;
}

export class SqliteStateRepository {
  constructor(options = {}) {
    const dbPath = options.path ?? ":memory:";
    this.file = dbPath === ":memory:" ? null : dbPath;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS messages ("
      + "id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, "
      + "response_type TEXT, status TEXT, created_at TEXT NOT NULL, meta TEXT)"
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS conversations ("
      + "id TEXT PRIMARY KEY, actor_id TEXT, scope_id TEXT, title TEXT, created_at TEXT, updated_at TEXT)"
    );
    this.conversations = new Map();
    this.tasks = new Map();
    this.idempotency = new Map();
  }

  getConversation(id) {
    if (!this.conversations.has(id)) this.conversations.set(id, DEFAULT_STATE());
    return this.conversations.get(id);
  }

  getTask(scopeId) {
    return this.tasks.get(scopeId) ?? null;
  }

  setTask(scopeId, task) {
    this.tasks.set(scopeId, task);
    return task;
  }

  persistMessages(conversationId, messages) {
    if (!conversationId || !Array.isArray(messages) || !messages.length) return;
    persistMessagesWith(this.db, conversationId, messages, { rowKeyField: true });
  }

  listMessages(conversationId) {
    const rows = this.db.prepare(
      "SELECT id, role, content, response_type, status, created_at, meta FROM messages "
      + "WHERE conversation_id = ? ORDER BY created_at, rowid"
    ).all(String(conversationId));
    return rows.map(readRowToMessage);
  }

  deleteMessages(conversationId, messageIds) {
    const ids = Array.isArray(messageIds) ? messageIds.filter((value) => typeof value === "string" && value) : [];
    if (!ids.length) return 0;
    const statement = this.db.prepare("DELETE FROM messages WHERE conversation_id = ? AND id = ?");
    let deleted = 0;
    for (const id of ids) deleted += Number(statement.run(String(conversationId), id).changes > 0);
    return deleted;
  }

  listConversations(scopeId) {
    const rows = this.db.prepare(
      "SELECT c.id, c.actor_id, c.scope_id, c.title, c.created_at, c.updated_at FROM conversations c "
      + "WHERE c.scope_id = ? OR c.scope_id IS NULL ORDER BY c.updated_at DESC, c.created_at DESC"
    ).all(String(scopeId));
    return rows.map((row) => {
      const conversation = {
        id: row.id,
        actorId: row.actor_id,
        scopeId: row.scope_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      if (conversation.updatedAt === null) {
        const latest = this.db.prepare("SELECT created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id);
        conversation.updatedAt = latest?.created_at ?? null;
      }
      return conversation;
    });
  }

  close() {
    this.db.close();
  }
}
