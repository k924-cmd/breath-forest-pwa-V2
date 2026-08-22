import { clone } from "../core/utils.js";

export class ManualClock {
  constructor(iso = "2026-08-03T04:00:00.000Z") {
    this.current = new Date(iso);
  }
  now() { return new Date(this.current); }
  iso() { return this.now().toISOString(); }
  advance(milliseconds) { this.current = new Date(this.current.getTime() + milliseconds); }
  set(iso) { this.current = new Date(iso); }
}

export class SystemClock {
  now() { return new Date(); }
  iso() { return new Date().toISOString(); }
  advance() { throw new Error("SystemClock is read-only; use ManualClock for time travel in tests."); }
  set() { throw new Error("SystemClock is read-only; use ManualClock for time travel in tests."); }
}

export class SequentialIdGenerator {
  constructor(prefix = "id") { this.prefix = prefix; this.value = 0; }
  next(kind = this.prefix) { this.value += 1; return `${kind}-${String(this.value).padStart(4, "0")}`; }
}

export class InMemoryStateRepository {
  constructor() {
    this.conversations = new Map();
    this.tasks = new Map();
    this.idempotency = new Map();
  }
  getConversation(id) {
    if (!this.conversations.has(id)) {
      this.conversations.set(id, { actorId: null, scopeId: null, topic: null, recentDeviceId: null, currentTaskId: null, messages: [], pendingClarification: null, pendingConfirmation: null });
    }
    return this.conversations.get(id);
  }
  getTask(scopeId) { return this.tasks.get(scopeId) ?? null; }
  setTask(scopeId, task) { this.tasks.set(scopeId, task); return task; }
  // Extended message-persistence interface. InMemory keeps a per-conversation
  // list so listMessages reflects what the assistant recorded in memory; it
  // never survives a restart (matching the existing in-memory behaviour).
  persistMessages(conversationId, messages) {
    if (!conversationId || !Array.isArray(messages) || !messages.length) return;
    const state = this.conversations.get(conversationId);
    const target = state && Array.isArray(state.messages) ? state.messages : [];
    const existing = new Set(target.map((message) => message.id).filter(Boolean));
    for (const message of messages) {
      if (message && message.id && !existing.has(message.id)) target.push(message);
    }
    if (state && target.length > 12) target.splice(0, target.length - 12);
  }
  listMessages(conversationId) {
    const state = this.conversations.get(conversationId);
    return Array.isArray(state?.messages) ? state.messages.map((message) => ({ ...message })) : [];
  }
  deleteMessages(conversationId, messageIds) {
    const state = this.conversations.get(conversationId);
    if (!state || !Array.isArray(state.messages)) return 0;
    const ids = new Set(Array.isArray(messageIds) ? messageIds : []);
    const before = state.messages.length;
    state.messages = state.messages.filter((message) => !ids.has(message.id));
    return before - state.messages.length;
  }
  listConversations() {
    return [...this.conversations.entries()]
      .map(([id, state]) => ({ id, actorId: state?.actorId ?? null, scopeId: state?.scopeId ?? null, title: null, createdAt: null, updatedAt: null }))
      .filter((conversation) => conversation.actorId !== null || conversation.scopeId !== null);
  }
}

export class FakeModelAdapter {
  constructor({ available = true, responder, candidateFactory } = {}) {
    this.available = available;
    // Fake model replies are deterministic canned text, not generative model
    // output; it must not be labelled with the "model" source.
    this.generative = false;
    this.responder = responder ?? (() => "你好，我是 Luna。有什么空气或设备问题可以帮你？");
    this.candidateFactory = candidateFactory ?? (() => ({ intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 }));
    this.candidateCalls = 0;
    this.responseCalls = 0;
  }
  async extractCandidate(input) {
    this.candidateCalls += 1;
    if (!this.available) throw new Error("model unavailable");
    return clone(await this.candidateFactory(input));
  }
  async respond(input) {
    this.responseCalls += 1;
    if (!this.available) throw new Error("model unavailable");
    return String(await this.responder(input));
  }
}

export class FakeEnvironmentAdapter {
  constructor(snapshot = null) { this.snapshot = snapshot; this.available = true; }
  async read() {
    if (!this.available) throw new Error("environment unavailable");
    return clone(this.snapshot);
  }
}

export class FakeDeviceAdapter {
  constructor() {
    this.available = true;
    this.commands = [];
    this.outcomes = new Map();
  }
  setOutcome(deviceId, outcome) { this.outcomes.set(deviceId, outcome); }
  async execute(command, device, targetState) {
    if (!this.available) throw Object.assign(new Error("device service unavailable"), { code: "SERVICE_UNAVAILABLE" });
    this.commands.push(clone(command));
    const outcome = this.outcomes.get(device.id) ?? "succeeded";
    if (outcome === "timed_out") return { status: "timed_out", actualState: "unknown", errorCode: "EXECUTION_TIMEOUT", source: "mock" };
    if (outcome === "failed") return { status: "failed", actualState: device.state, errorCode: "EXECUTION_FAILED", source: "mock" };
    if (outcome === "unknown") return { status: "unknown", actualState: "unknown", errorCode: "EXECUTION_FAILED", source: "mock" };
    return { status: "succeeded", actualState: targetState, source: "mock" };
  }
}

export const OPTIMIZATION_MODES = Object.freeze({
  comfort: { label: "舒适优先", goal: "在健康底线内优先体感舒适", weights: { health: 0.45, comfort: 0.4, energy: 0.15 }, healthFloor: { maxPm25: 35, maxCo2: 1200 }, devices: ["air_purifier", "smart_window", "range_hood"] },
  balanced: { label: "均衡自动", goal: "平衡健康、舒适与能耗", weights: { health: 0.4, comfort: 0.3, energy: 0.3 }, healthFloor: { maxPm25: 35, maxCo2: 1200 }, devices: ["air_purifier", "smart_window", "range_hood"] },
  eco: { label: "低碳优先", goal: "在健康底线内降低能耗", weights: { health: 0.45, comfort: 0.15, energy: 0.4 }, healthFloor: { maxPm25: 35, maxCo2: 1200 }, devices: ["air_purifier", "smart_window", "range_hood"] },
});

export class FakeOptimizerAdapter {
  constructor({ source = "mock", candidates = [] } = {}) {
    if (!["mock", "replay"].includes(source)) throw new Error("V1 optimizer source must be mock or replay");
    this.source = source;
    this.available = true;
    this.candidates = candidates;
    this.calls = 0;
  }
  async propose({ mode }) {
    this.calls += 1;
    if (!this.available) throw new Error("optimizer unavailable");
    if (!OPTIMIZATION_MODES[mode]) throw new Error("unsupported mode");
    return clone(this.candidates);
  }
}

const forbiddenTelemetryKey = /(message|content|prompt|response|name|address|email|phone|secret|token|key|stack)/i;

export class InMemoryTelemetryAdapter {
  constructor() { this.events = []; this.available = true; }
  emit(event) {
    if (!this.available) return;
    const properties = Object.fromEntries(Object.entries(event.properties ?? {}).filter(([key]) => !forbiddenTelemetryKey.test(key)));
    this.events.push(clone({ ...event, properties }));
  }
}
