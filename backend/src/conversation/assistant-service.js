import { PublicError, publicError, safePublicError } from "../core/errors.js";
import {
  CONFIRMATION_TTL_MS,
  CONTRACT_VERSION,
  ENVIRONMENT_FRESHNESS_MS,
  IDEMPOTENCY_TTL_MS,
  addMilliseconds,
  clone,
  isValidTimezone,
  sha256,
  sourceRef,
  zonedTodayAt,
} from "../core/utils.js";
import { actionTarget } from "../devices/registry.js";
import { extractCity, localRoute, validateSemanticCandidate } from "./router.js";
import { lookupKnowledge } from "./knowledge-base.js";
import { detectHealthTopic, guardModelReply } from "./reply-safety.js";
import { decideSingleDevice, validatePlannedActions } from "../policies/policy.js";
import { OPTIMIZATION_MODES } from "../adapters/fakes.js";
import { TaskService } from "../tasks/task-service.js";

const AI_DISCLAIMER = " Luna 是 AI 工具噢，我的回答仅供参考。";
const MEDICAL_DISCLAIMER = " 以上仅为一般性信息，不构成医疗诊断，也不能替代专业医疗建议。";
const CHAT_FALLBACK_TEMPLATE = "你好，我是 Luna。我可以陪你聊聊，也可以帮助查询空气、设备或管理 V1 任务。设备状态和执行结果只会依据可信状态或回执说明。";
const CHAT_DEGRADED_TEMPLATE = "聊天模型暂时不可用；设备和环境的明确查询、本地确定性控制仍可继续使用。";
const KNOWLEDGE_URGENT_TEMPLATE = "请先离开可能的风险环境，到空气安全处，并尽快联系当地紧急服务或专业医疗人员。这里不能替代紧急救助或医疗诊断。";
const COMMON_CITIES = ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "西安", "重庆"];

function composeReplyText(content, healthTopic) {
  return `${content}${AI_DISCLAIMER}${healthTopic ? MEDICAL_DISCLAIMER : ""}`;
}

export class AssistantService {
  constructor(dependencies) {
    Object.assign(this, dependencies);
    this.taskService = new TaskService(dependencies);
    this.taskSpecs = new Map();
    this.realtime = dependencies.realtime ?? null;
    this.asr = dependencies.asr ?? null;
  }

  async sendMessage(request, transport = {}) {
    const requestId = this.ids.next("request");
    const started = this.clock.now().getTime();
    let conversationId = typeof request?.conversationId === "string" && request.conversationId ? request.conversationId : "unknown";
    try {
      const normalized = this.#validateRequest(request, transport, requestId);
      conversationId = normalized.conversationId;
      const idempotency = this.#findIdempotency(normalized, transport.scopeId, requestId);
      if (idempotency) return idempotency;
      this.#event("assistant_request_received", { requestId, conversationId, properties: { messageLength: [...normalized.message].length, locale: normalized.locale } });
      const result = await this.#process(normalized, transport, requestId);
      this.#saveIdempotency(normalized, transport.scopeId, result);
      if (result.error) this.#event("public_error_returned", { requestId, conversationId, properties: { errorCode: result.error.code, surface: "assistant", retryable: result.error.retryable } });
      this.#event("assistant_response_completed", {
        requestId,
        conversationId,
        properties: { responseType: result.responseType, outcome: result.error?.code ?? "completed", durationMs: Math.max(0, this.clock.now().getTime() - started) },
      });
      this.#persistTurn(conversationId, result);
      return clone(result);
    } catch (error) {
      const safe = safePublicError(error, requestId);
      const result = this.#errorResponse(conversationId, requestId, safe, safe.code === "POLICY_REJECTED" ? "rejection" : "error");
      this.#event("public_error_returned", { requestId, conversationId, properties: { errorCode: safe.code, surface: "assistant", retryable: safe.retryable } });
      this.#persistTurn(conversationId, result);
      return result;
    }
  }

  async runDueTasks(scopeId) {
    const before = this.taskService.current(scopeId);
    const beforeSpec = before ? this.taskSpecs.get(before.taskId) : null;
    if (before?.status === "scheduled" && beforeSpec?.expectedTaskVersion !== before.taskVersion) {
      return { triggered: false, task: before, errorCode: "CONFIRMATION_INVALIDATED" };
    }
    const transition = this.taskService.activateDue(scopeId);
    if (!transition.changed) return { triggered: false, task: transition.task };
    this.#taskEvent(transition.task, transition.fromStatus);
    const spec = this.taskSpecs.get(transition.task.taskId);
    if (transition.task.type !== "cooking_guard" || !spec) return { triggered: true, task: transition.task };
    const policy = validatePlannedActions(spec.actions, this.registry);
    if (policy.outcome !== "allow") {
      const failed = this.repository.getTask(scopeId);
      failed.status = "failed";
      failed.taskVersion += 1;
      failed.updatedAt = this.clock.iso();
      this.repository.setTask(scopeId, failed);
      this.#taskEvent(failed, "running");
      return { triggered: true, task: clone(failed), errorCode: "POLICY_REJECTED" };
    }
    const receipt = await this.#executeActions(spec.actions, spec.requestId, spec.planId, `${spec.idempotencyKey}:scheduled`);
    return { triggered: true, task: this.taskService.current(scopeId), receipt };
  }

  async runOptimizationCycle(scopeId) {
    const task = this.taskService.current(scopeId);
    if (!task || task.type !== "optimization" || task.status !== "running") return { executed: false, reason: "NO_RUNNING_OPTIMIZATION", task };
    let candidates;
    try {
      candidates = await this.optimizer.propose({ mode: task.mode, task: clone(task) });
    } catch {
      this.#event("dependency_degraded", { taskId: task.taskId, properties: { dependency: "optimizer", errorCode: "OPTIMIZER_UNAVAILABLE" } });
      return { executed: false, reason: "OPTIMIZER_UNAVAILABLE", message: "模拟优化器不可用，本轮未执行动作。", task };
    }
    const current = this.taskService.current(scopeId);
    if (!current || current.taskId !== task.taskId || current.taskVersion !== task.taskVersion || current.status !== "running") {
      return { executed: false, reason: "TASK_CHANGED_DURING_OPTIMIZATION", message: "模拟优化任务状态已变化，本轮候选动作已丢弃，未执行任何设备动作。", task: current };
    }
    const actions = [];
    for (const item of Array.isArray(candidates) ? candidates : []) {
      const device = this.registry.get(item.deviceId);
      if (!device || !["air_purifier", "range_hood", "smart_window"].includes(device.type)) continue;
      const targetState = actionTarget(device, item.action);
      const decision = decideSingleDevice(device, item.action, targetState);
      if (decision.outcome !== "allow" || decision.reasonCodes.includes("TARGET_ALREADY_SATISFIED")) continue;
      actions.push(this.#plannedAction(device, item.action, targetState));
      if (actions.length === 3) break;
    }
    if (!actions.length) return { executed: false, reason: "NO_LEGAL_CANDIDATE", message: "模拟优化本轮没有合法候选动作，未执行任何设备动作。", task, source: this.optimizer.source };
    const plan = this.#makePlan({ kind: "optimization_task", summary: `模拟优化 ${OPTIMIZATION_MODES[task.mode].label} 本轮候选动作`, actions, requiresConfirmation: false, isSimulation: true });
    const receipt = await this.#executeActions(actions, this.ids.next("cycle-request"), plan.planId, this.ids.next("cycle-key"), {
      scopeId,
      taskId: task.taskId,
      taskVersion: task.taskVersion,
    });
    const interrupted = receipt.actions.some((action) => action.errorCode === "TASK_CHANGED_DURING_EXECUTION");
    const sentCount = receipt.actions.filter((action) => action.errorCode !== "TASK_CHANGED_DURING_EXECUTION").length;
    const message = interrupted
      ? `模拟优化任务状态在执行期间发生变化，剩余动作已中止；回执状态：${receipt.status}。`
      : "模拟优化候选动作已经过策略裁决，结果以可信回执为准。";
    return { executed: sentCount > 0, interrupted, message, task: this.taskService.current(scopeId), receipt, source: this.optimizer.source };
  }

  endConversation(conversationId) {
    return this.repository.conversations.delete(conversationId);
  }

  async getBootstrap(scopeId) {
    let environment = null;
    try {
      const snapshot = await this.environment.read();
      const age = this.clock.now().getTime() - new Date(snapshot?.observedAt).getTime();
      if (this.#validEnvironment(snapshot) && age >= -1_000 && age <= ENVIRONMENT_FRESHNESS_MS && snapshot.freshness === "fresh") {
        environment = clone(snapshot);
      }
    } catch {
      environment = null;
    }
    return {
      contractVersion: CONTRACT_VERSION,
      devices: this.registry.list(),
      environment,
      activeTask: this.taskService.current(scopeId),
      realtime: this.realtime?.available === true ? { available: true, source: this.realtime.referenceId ?? "tavily" } : { available: false },
      mode: "local_mock",
      observedAt: this.clock.iso(),
    };
  }

  async getWeather(city) {
    const cityName = typeof city === "string" && city.trim() ? city.trim() : "杭州";
    if (!this.realtime?.available) {
      return { available: false, city: cityName, reason: "realtime_unavailable" };
    }
    let snapshot;
    try {
      snapshot = await this.realtime.search(`${cityName} 今天天气 请用中文回答`);
    } catch {
      snapshot = null;
    }
    if (!snapshot || typeof snapshot.answer !== "string" || !snapshot.answer.trim()) {
      return { available: false, city: cityName, reason: "realtime_failed" };
    }
    const answer = snapshot.answer.trim();
    const tempMatch = answer.match(/(-?\d+(?:\.\d+)?)\s*(?:°|℃|度)/);
    const lower = answer.toLowerCase();
    let icon = "sun";
    let condition = "晴";
    if (/rain|drizzle|shower|storm|thunder|雨/.test(lower)) { icon = "rain"; condition = "雨"; }
    else if (/cloud|overcast|haze|阴|多云/.test(lower)) { icon = "cloud"; condition = "多云"; }
    else if (/snow|雪/.test(lower)) { icon = "snow"; condition = "雪"; }
    else if (/wind|breeze|gust|风/.test(lower)) { icon = "wind"; condition = "风"; }
    else if (/sunny|clear|fine|晴/.test(lower)) { icon = "sun"; condition = "晴"; }
    return {
      available: true,
      city: cityName,
      temp: tempMatch ? tempMatch[1] : null,
      condition,
      icon,
      answer,
      source: snapshot.source ?? "real_time",
      referenceId: snapshot.referenceId ?? "tavily",
      observedAt: snapshot.observedAt,
    };
  }

  async transcribeAudio(audio, options = {}) {
    if (!this.asr?.available) return { available: false, reason: "asr_unavailable" };
    if (!(audio instanceof Uint8Array) || audio.length === 0) return { available: false, reason: "asr_empty" };
    let result;
    try {
      result = await this.asr.transcribe(audio, { mimeType: options.mimeType });
    } catch {
      result = null;
    }
    if (!result || typeof result.text !== "string" || !result.text) {
      return { available: false, reason: "asr_failed" };
    }
    return {
      available: true,
      text: result.text,
      language: result.language ?? null,
      source: "asr",
      referenceId: result.referenceId ?? "dashscope",
      observedAt: result.observedAt,
    };
  }

  #validateRequest(request, transport, requestId) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw publicError("INVALID_REQUEST", "请求格式无效。", { requestId });
    const allowedFields = new Set(["contractVersion", "conversationId", "clientMessageId", "idempotencyKey", "message", "locale", "timezone", "continuation", "city"]);
    if (Object.keys(request).some((field) => !allowedFields.has(field))) throw publicError("INVALID_REQUEST", "请求包含未定义字段。", { requestId });
    if (request.contractVersion !== CONTRACT_VERSION) throw publicError("CONTRACT_VERSION_UNSUPPORTED", "不支持的契约版本。", { requestId });
    for (const field of ["conversationId", "clientMessageId", "idempotencyKey"]) {
      if (typeof request[field] !== "string" || request[field].length < 1 || request[field].length > 128) throw publicError("INVALID_REQUEST", "请求标识无效。", { requestId });
    }
    if (typeof request.message !== "string") throw publicError("INVALID_REQUEST", "消息格式无效。", { requestId });
    const message = request.message.trim();
    if (!message) throw publicError("INVALID_REQUEST", "消息不能为空。", { requestId });
    if ([...message].length > 4000) throw publicError("INPUT_TOO_LONG", "消息不能超过 4000 个字符。", { requestId });
    if (typeof request.locale !== "string" || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(request.locale)) throw publicError("INVALID_REQUEST", "语言格式无效。", { requestId });
    if (!isValidTimezone(request.timezone)) throw publicError("INVALID_REQUEST", "时区格式无效。", { requestId });
    if (request.continuation !== undefined) {
      if (!request.continuation || typeof request.continuation !== "object" || !["clarification", "confirmation"].includes(request.continuation.type) || typeof request.continuation.id !== "string") {
        throw publicError("INVALID_REQUEST", "continuation 格式无效。", { requestId });
      }
      if (Object.keys(request.continuation).some((field) => !["type", "id"].includes(field))) throw publicError("INVALID_REQUEST", "continuation 包含未定义字段。", { requestId });
    }
    if (typeof transport.actorId !== "string" || !transport.actorId || typeof transport.scopeId !== "string" || !transport.scopeId) {
      throw publicError("INVALID_REQUEST", "缺少可信身份或作用域。", { requestId });
    }
    return { ...request, message, city: typeof request.city === "string" ? request.city.trim() : "" };
  }

  #findIdempotency(request, scopeId, requestId) {
    const key = `${scopeId}:${request.idempotencyKey}`;
    const existing = this.repository.idempotency.get(key);
    if (!existing || this.clock.now().getTime() - new Date(existing.createdAt).getTime() > IDEMPOTENCY_TTL_MS) return null;
    const payloadHash = sha256(this.#idempotentPayload(request));
    if (payloadHash !== existing.payloadHash) throw publicError("IDEMPOTENCY_CONFLICT", "相同幂等键不能用于不同请求。", { requestId });
    return clone(existing.result);
  }

  #saveIdempotency(request, scopeId, result) {
    this.repository.idempotency.set(`${scopeId}:${request.idempotencyKey}`, {
      payloadHash: sha256(this.#idempotentPayload(request)), createdAt: this.clock.iso(), result: clone(result),
    });
  }

  #idempotentPayload(request) {
    return { contractVersion: request.contractVersion, conversationId: request.conversationId, clientMessageId: request.clientMessageId, message: request.message, locale: request.locale, timezone: request.timezone, continuation: request.continuation ?? null, city: request.city ?? null };
  }

  async #process(request, transport, requestId) {
    const state = this.repository.getConversation(request.conversationId);
    if (state.actorId && (state.actorId !== transport.actorId || state.scopeId !== transport.scopeId)) throw publicError("INVALID_REQUEST", "会话不属于当前可信身份或作用域。", { requestId });
    state.actorId ??= transport.actorId;
    state.scopeId ??= transport.scopeId;
    this.#rememberMessage(state, "user", request.message, request.clientMessageId);
    let route = localRoute(request.message);
    let modelConsulted = false;

    if (request.continuation?.type === "clarification" && !state.pendingClarification) throw publicError("INVALID_REQUEST", "当前没有待澄清问题。", { requestId });

    if (state.pendingConfirmation && this.clock.now() > new Date(state.pendingConfirmation.public.expiresAt) && route?.intent !== "confirm" && request.continuation?.type !== "confirmation") {
      state.pendingConfirmation.public.status = "expired";
      state.pendingConfirmation = null;
    }

    if (state.pendingConfirmation) {
      if (route?.intent === "cancel") return this.#cancelConfirmation(state, request, requestId);
      if (/^(保留|保留旧任务|不替换)$/.test(request.message)) return this.#cancelConfirmation(state, request, requestId, "已保留当前任务，没有创建新任务。");
      if (route?.intent === "confirm" || request.continuation?.type === "confirmation") return this.#confirm(state, request, transport, requestId);
      const current = state.pendingConfirmation.public;
      return this.#response(request, requestId, "confirmation", `当前仍有一个待确认计划，请先确认或取消：${current.plan.summary}`, [sourceRef("rule", current.createdAt, current.plan.planId)], { confirmation: clone(current), error: { code: "CONFIRMATION_REQUIRED", message: "请先处理当前待确认计划。", retryable: false, requestId } });
    } else if (route?.intent === "confirm" || request.continuation?.type === "confirmation") {
      throw publicError("CONFIRMATION_NOT_FOUND", "当前没有待确认计划，请重新发起操作。", { requestId });
    }

    if (state.pendingClarification) {
      if (this.clock.now() > new Date(state.pendingClarification.public.expiresAt)) state.pendingClarification = null;
    }
    if (state.pendingClarification) {
      if (request.continuation?.type === "clarification" && request.continuation.id !== state.pendingClarification.public.clarificationId) {
        throw publicError("INVALID_REQUEST", "澄清标识不匹配。", { requestId });
      }
      if (route && ["environment_query", "task_query", "chat", "knowledge_query"].includes(route.intent)) {
        state.pendingClarification = null;
      } else {
        const original = state.pendingClarification.originalMessage;
        state.pendingClarification = null;
        route = localRoute(`${original} ${request.message}`);
      }
    }

    if (!route) {
      try {
        route = validateSemanticCandidate(await this.model.extractCandidate({ message: request.message }), request.message);
        modelConsulted = true;
      } catch {
        this.#event("dependency_degraded", { requestId, conversationId: request.conversationId, properties: { dependency: "model", errorCode: "MODEL_UNAVAILABLE" } });
      }
    }
    if (!route || route.intent === "unknown") {
      if (route?.entities?.unsupported) return this.#rejection(request, requestId, "POLICY_REJECTED", "V1 不支持真实 DQN、真实 MQTT、自定义权重、真实收益声明或绕过安全规则。", ["请选择舒适优先、均衡自动或低碳优先的模拟优化。"]);
      if (route?.entities?.historicalReference) return this.#rejection(request, requestId, "INTENT_UNCLEAR", "V1 不恢复跨日或跨会话的历史方案，请重新选择场景或模拟优化模式。", []);
      if (route?.entities?.forbiddenModelMutation) return this.#rejection(request, requestId, "INTENT_UNCLEAR", "该操作不在 V1 允许范围内。请使用明确的设备、动作或查询表达。", []);
      if (!modelConsulted) return this.#rejection(request, requestId, "INTENT_UNCLEAR", "我无法可靠理解该请求，因此没有执行任何操作。请使用明确的设备、动作或查询表达。", []);
      return this.#unknownGuidance(request, requestId);
    }

    state.topic = route.intent;
    switch (route.intent) {
      case "chat": return this.#chat(request, requestId);
      case "knowledge_query": return this.#knowledge(request, requestId, route);
      case "weather_query": return this.#rejection(request, requestId, "ENVIRONMENT_UNAVAILABLE", "V1 暂无可信的外部实时天气或室外数据源，无法提供室外数值或天气预报；室内环境与设备查询仍可使用可信快照。", []);
      case "real_time_query": return this.#realTimeQuery(state, request, requestId);
      case "environment_query": return this.#environment(request, requestId, route);
      case "device_query": return this.#deviceQuery(state, request, requestId, route);
      case "device_control": return this.#deviceControl(state, request, transport, requestId, route);
      case "cooking_guard_create": return this.#cooking(state, request, transport, requestId, route);
      case "optimization_create": return this.#optimization(state, request, transport, requestId, route);
      case "task_query": return this.#taskQuery(state, request, transport, requestId);
      case "task_pause": return this.#taskTransition(state, request, transport, requestId, "pause");
      case "task_resume": return this.#taskTransition(state, request, transport, requestId, "resume");
      case "task_stop": return this.#taskTransition(state, request, transport, requestId, "stop");
      case "cancel": return this.#response(request, requestId, "chat", "当前没有需要取消的待确认计划。", []);
      default: return this.#rejection(request, requestId, "INTENT_UNCLEAR", "该请求不在 V1 支持范围内。", []);
    }
  }

  async #chat(request, requestId) {
    try {
      if (this.model?.generative === true) {
        const guarded = guardModelReply(await this.model.respond({ kind: "chat", message: request.message }));
        if (!guarded) throw new Error("unsafe model reply");
        return this.#response(request, requestId, "chat", composeReplyText(guarded, detectHealthTopic(request.message, guarded)), [sourceRef("model", this.clock.iso(), this.model.referenceId)]);
      }
      await this.model.respond({ kind: "chat", message: request.message });
      return this.#response(request, requestId, "chat", composeReplyText(CHAT_FALLBACK_TEMPLATE, detectHealthTopic(request.message)), [sourceRef("template", this.clock.iso())]);
    } catch {
      this.#event("dependency_degraded", { requestId, conversationId: request.conversationId, properties: { dependency: "model", errorCode: "MODEL_UNAVAILABLE" } });
      return this.#response(request, requestId, "chat", composeReplyText(CHAT_DEGRADED_TEMPLATE, detectHealthTopic(request.message)), [sourceRef("template", this.clock.iso())], { error: { code: "MODEL_UNAVAILABLE", message: "聊天模型暂时不可用。", retryable: true, requestId } });
    }
  }

  async #knowledge(request, requestId, route) {
    if (route.entities.urgent) {
      return this.#response(request, requestId, "knowledge", composeReplyText(KNOWLEDGE_URGENT_TEMPLATE, true), [sourceRef("template", this.clock.iso())]);
    }
    const knowledge = lookupKnowledge(request.message);
    if (this.model?.generative === true) {
      try {
        const guarded = guardModelReply(await this.model.respond({ kind: "knowledge", message: request.message, topic: knowledge.topic }));
        if (guarded) {
          return this.#response(request, requestId, "knowledge", composeReplyText(guarded, detectHealthTopic(request.message, guarded)), [sourceRef("model", this.clock.iso(), this.model.referenceId)]);
        }
      } catch {
        // Fall through to the fixed local knowledge base.
      }
      this.#event("dependency_degraded", { requestId, conversationId: request.conversationId, properties: { dependency: "model", errorCode: "MODEL_UNAVAILABLE" } });
      return this.#response(request, requestId, "knowledge", composeReplyText(knowledge.content, detectHealthTopic(request.message, knowledge.content)), [sourceRef("template", this.clock.iso(), `knowledge-${knowledge.topic}-v1`)], { error: { code: "MODEL_UNAVAILABLE", message: "知识模型暂时不可用，已使用本地固定知识。", retryable: true, requestId } });
    }
    return this.#response(request, requestId, "knowledge", composeReplyText(knowledge.content, detectHealthTopic(request.message, knowledge.content)), [sourceRef("template", this.clock.iso(), `knowledge-${knowledge.topic}-v1`)]);
  }

  async #environment(request, requestId, route) {
    let snapshot;
    try { snapshot = await this.environment.read(); } catch { snapshot = null; }
    if (!this.#validEnvironment(snapshot)) {
      return this.#errorResponse(request.conversationId, requestId, publicError("ENVIRONMENT_UNAVAILABLE", "暂时无法获得可信的当前环境数据。", { retryable: true, requestId }), "environment_status");
    }
    const age = this.clock.now().getTime() - new Date(snapshot.observedAt).getTime();
    if (age > ENVIRONMENT_FRESHNESS_MS || age < -1_000 || snapshot.freshness === "stale") {
      return this.#errorResponse(request.conversationId, requestId, publicError("ENVIRONMENT_STALE", "环境数据已过期，不能作为当前读数。", { retryable: true, requestId }), "environment_status", [sourceRef(snapshot.source, snapshot.observedAt)]);
    }
    const labels = { pm25: "PM2.5", co2: "CO2", humidity: "湿度", temperature: "温度", score: "空气评分" };
    const metrics = route.entities.metrics?.length ? route.entities.metrics : ["pm25", "co2", "humidity", "temperature", "score"];
    const values = metrics.map((key) => `${labels[key]} ${snapshot[key]}`).join("，");
    const sourceLabel = snapshot.source === "mock" ? "Mock 数据" : snapshot.source === "replay" ? "Replay 数据" : "传感器数据";
    return this.#response(request, requestId, "environment_status", `${values}；状态：${snapshot.status}；观测时间：${snapshot.observedAt}；来源：${sourceLabel}。`, [sourceRef(snapshot.source, snapshot.observedAt)]);
  }

  #validEnvironment(value) {
    return value && ["pm25", "co2", "humidity", "temperature", "score"].every((key) => Number.isFinite(value[key]))
      && value.pm25 >= 0 && value.co2 >= 0 && value.humidity >= 0 && value.humidity <= 100 && value.score >= 0 && value.score <= 100
      && typeof value.status === "string" && value.status.length > 0 && value.status.length <= 120
      && !Number.isNaN(new Date(value.observedAt).getTime()) && ["mock", "replay", "sensor"].includes(value.source) && ["fresh", "stale"].includes(value.freshness);
  }

  async #realTimeQuery(state, request, requestId) {
    if (!this.realtime?.available) {
      return this.#rejection(request, requestId, "ENVIRONMENT_UNAVAILABLE", "实时天气或室外数据源尚未接入，无法提供室外数值或天气预报；室内环境与设备查询仍可使用可信快照。", []);
    }
    const city = extractCity(request.message) ?? (request.city?.trim() || null);
    if (!city) {
      return this.#clarification(state, request, requestId, "city", "请告诉我要查询哪个城市的天气？", COMMON_CITIES);
    }
    let snapshot;
    try { snapshot = await this.realtime.search(`${city} 今天天气 请用中文回答`); } catch { snapshot = null; }
    if (!snapshot || typeof snapshot.answer !== "string") {
      this.#event("dependency_degraded", { requestId, conversationId: request.conversationId, properties: { dependency: "realtime", errorCode: "REALTIME_UNAVAILABLE" } });
      return this.#rejection(request, requestId, "ENVIRONMENT_UNAVAILABLE", "实时搜索服务暂时不可用，无法提供实时天气或室外信息，请稍后再试。", []);
    }
    const content = `实时信息：${snapshot.answer}`;
    return this.#response(request, requestId, "real_time", content, [sourceRef("real_time", snapshot.observedAt, snapshot.referenceId ?? "tavily")], { realtime: snapshot });
  }

  #resolveDevice(state, route, fullText) {
    if (route.entities.usesReference) return state.recentDeviceId ? [this.registry.get(state.recentDeviceId)].filter(Boolean) : [];
    return this.registry.resolve(fullText);
  }

  #deviceQuery(state, request, requestId, route) {
    const devices = this.#resolveDevice(state, route, request.message);
    if (!devices.length) return this.#clarification(state, request, requestId, "device", "请说明要查询哪个设备。", this.registry.list().map((item) => item.name).slice(0, 6));
    if (devices.length > 1) return this.#clarification(state, request, requestId, "device", "找到多个候选设备，请选择一个。", devices.map((item) => item.name));
    const device = devices[0];
    state.recentDeviceId = device.id;
    const support = device.controlSupport === "supported" ? "可操作" : "V1 待接入，不可操作";
    const status = device.state === "unknown" ? "状态未知" : `状态 ${device.state}`;
    return this.#response(request, requestId, "device_status", `${device.name}：${status}，连接 ${device.connectionStatus}，${support}；观测时间：${device.observedAt}；来源：Mock 设备注册表。`, [sourceRef(device.source, device.observedAt, device.id)]);
  }

  async #deviceControl(state, request, transport, requestId, route) {
    if (route.entities.multipleRequested) return this.#rejection(request, requestId, "POLICY_REJECTED", "V1 一次只支持一个设备的即时控制，请拆分请求。", []);
    const devices = this.#resolveDevice(state, route, request.message);
    if (!devices.length) return this.#clarification(state, request, requestId, route.entities.usesReference ? "reference" : "device", route.entities.usesReference ? "当前会话没有唯一的最近设备，请重新选择。" : "请说明要控制哪个设备。", []);
    if (devices.length > 1) return this.#clarification(state, request, requestId, "device", "找到多个候选设备，请选择一个。", devices.map((item) => item.name));
    const device = devices[0];
    state.recentDeviceId = device.id;
    if (!route.entities.requestedState) return this.#clarification(state, request, requestId, "action", `请说明要打开还是关闭${device.name}。`, ["打开", "关闭"]);
    const action = device.type === "smart_window"
      ? (route.entities.requestedState === "on" ? "open" : "close")
      : (route.entities.requestedState === "on" ? "turn_on" : "turn_off");
    const targetState = actionTarget(device, action);
    const decision = decideSingleDevice(device, action, targetState);
    if (decision.outcome === "reject") return this.#rejection(request, requestId, decision.reasonCodes[0] === "DEVICE_UNAVAILABLE" ? "DEVICE_UNAVAILABLE" : "ACTION_UNSUPPORTED", decision.message, []);
    const actionItem = this.#plannedAction(device, action, targetState);
    const plan = this.#makePlan({ kind: "single_device", summary: `${device.name}：${device.state} → ${targetState}`, actions: [actionItem], requiresConfirmation: decision.outcome === "confirm" });
    if (decision.outcome === "confirm") return this.#saveConfirmation(state, request, transport, requestId, plan, { kind: "single_device" });
    const receipt = await this.#executeActions(plan.actions, requestId, plan.planId, request.idempotencyKey);
    return this.#executionResponse(request, requestId, receipt);
  }

  async #cooking(state, request, transport, requestId, route) {
    const schedule = this.#parseSchedule(route.entities.timeText, request.timezone, requestId);
    if (schedule.error) return this.#clarification(state, request, requestId, "time", schedule.error, ["立即开始", "提供今天稍后的明确时间"]);
    const purifier = this.registry.list().find((device) => device.type === "air_purifier");
    const hood = this.registry.list().find((device) => device.type === "range_hood");
    if (![purifier, hood].every((device) => device && device.connectionStatus === "online" && device.controlSupport === "supported" && device.state !== "unknown")) {
      return this.#rejection(request, requestId, "DEVICE_UNAVAILABLE", "烹饪守护所需的抽油烟机或空气净化器不可用，未创建任务。", []);
    }
    const actions = [
      this.#plannedAction(hood, "turn_on", "on"),
      this.#plannedAction(purifier, "turn_on", "on"),
    ];
    if (route.entities.includeWindow || route.entities.closeWindow) {
      const window = this.registry.list().find((device) => device.type === "smart_window");
      if (!window || window.connectionStatus !== "online" || window.state === "unknown") return this.#rejection(request, requestId, "DEVICE_UNAVAILABLE", "智能窗户不可用，不能按所选方案创建任务。", []);
      const action = route.entities.includeWindow ? "open" : "close";
      actions.push(this.#plannedAction(window, action, actionTarget(window, action)));
    }
    const current = this.taskService.current(transport.scopeId);
    const startText = schedule.scheduledFor ? `${schedule.scheduledFor}（${request.timezone}）` : "立即开始";
    const windowText = actions.length === 3 ? `；窗户动作：${actions[2].targetState}` : "；不改变智能窗户";
    const summary = `固定烹饪/火锅空气守护：开启抽油烟机、开启空气净化器${windowText}；${startText}；持续至用户停止；执行来源：Mock 设备。`;
    const plan = this.#makePlan({ kind: current ? "task_replacement" : "cooking_guard", summary, actions, requiresConfirmation: true, scheduledFor: schedule.scheduledFor, timezone: request.timezone, taskVersion: current?.taskVersion ?? 0 });
    return this.#saveConfirmation(state, request, transport, requestId, plan, { kind: "task", specification: { type: "cooking_guard", scheduledFor: schedule.scheduledFor, executionSource: "mock" }, replaceTaskId: current?.taskId ?? null });
  }

  async #optimization(state, request, transport, requestId, route) {
    const mode = route.entities.mode;
    if (!mode) return this.#clarification(state, request, requestId, "mode", "请选择一种模拟优化模式。", ["舒适优先", "均衡自动", "低碳优先"]);
    if (!OPTIMIZATION_MODES[mode]) return this.#rejection(request, requestId, "POLICY_REJECTED", "V1 仅支持三种固定模拟优化模式。", []);
    if (!this.optimizer.available || !["mock", "replay"].includes(this.optimizer.source)) {
      return this.#rejection(request, requestId, "OPTIMIZER_UNAVAILABLE", "Mock/Replay 优化器不可用，未创建模拟优化任务。", []);
    }
    const config = OPTIMIZATION_MODES[mode];
    const current = this.taskService.current(transport.scopeId);
    const summary = `${config.label}：${config.goal}；设备范围：空气净化器、智能窗户、抽油烟机；模拟优化；持续至用户停止；来源：${this.optimizer.source === "mock" ? "Mock" : "Replay"}。`;
    const plan = this.#makePlan({ kind: current ? "task_replacement" : "optimization_task", summary, actions: [], requiresConfirmation: true, isSimulation: true, taskVersion: current?.taskVersion ?? 0 });
    const policyConfigHash = sha256({ weights: config.weights, healthFloor: config.healthFloor, devices: config.devices });
    return this.#saveConfirmation(state, request, transport, requestId, plan, { kind: "task", specification: { type: "optimization", mode, executionSource: this.optimizer.source, controlledDeviceTypes: [...config.devices], policyConfigHash }, replaceTaskId: current?.taskId ?? null });
  }

  #parseSchedule(text, timezone) {
    if (/明天|后天|每天|每周|跨日|下周/.test(text)) return { error: "V1 只支持今天的未来明确时间，不支持跨日或循环排程。" };
    const match = text.match(/(?:今天)?\s*(\d{1,2})(?:[:：点时])(\d{1,2})?/);
    if (!match) {
      if (/晚上|下午|早上|稍后|一会/.test(text) && !/现在|立即/.test(text)) return { error: "时间不够明确，请提供今天的具体小时和分钟。" };
      return { scheduledFor: null };
    }
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (hour > 23 || minute > 59) return { error: "时间格式无效。" };
    const scheduled = zonedTodayAt(this.clock.now(), timezone, hour, minute);
    if (!scheduled || scheduled <= this.clock.now()) return { error: "指定时间已过去，请改为立即开始或今天稍后的明确时间。" };
    return { scheduledFor: scheduled.toISOString() };
  }

  #taskQuery(state, request, transport, requestId) {
    const task = this.taskService.current(transport.scopeId);
    state.currentTaskId = task?.taskId ?? null;
    if (!task) return this.#response(request, requestId, "task_status", "当前没有活动任务。", [sourceRef("rule", this.clock.iso())], { error: { code: "TASK_NOT_FOUND", message: "当前没有活动任务。", retryable: false, requestId } });
    const simulation = task.type === "optimization" ? "；模拟优化" : "";
    const mode = task.mode ? `；模式：${OPTIMIZATION_MODES[task.mode].label}` : "";
    const timing = `；创建时间：${task.createdAt}${task.scheduledFor ? `；计划时间：${task.scheduledFor}` : ""}`;
    return this.#response(request, requestId, "task_status", `当前任务：${task.type}；状态：${task.status}${mode}${simulation}${timing}；任务停止不会自动反转历史设备动作。`, [sourceRef("rule", task.updatedAt, task.taskId)], { task });
  }

  #taskTransition(state, request, transport, requestId, operation) {
    const active = this.taskService.current(transport.scopeId);
    const latestStopped = operation === "stop" ? this.taskService.latest(transport.scopeId) : null;
    const current = active ?? (latestStopped?.status === "stopped" ? latestStopped : null);
    state.currentTaskId = current?.taskId ?? null;
    if (!current) return this.#response(request, requestId, "task_status", "当前没有活动任务。", [sourceRef("rule", this.clock.iso())], { error: { code: "TASK_NOT_FOUND", message: "当前没有活动任务。", retryable: false, requestId } });
    if (operation === "resume" && current.status === "paused") {
      const validation = this.#validateResume(current);
      if (!validation.ok) return this.#response(request, requestId, "task_status", `${validation.message}，任务保持暂停。`, [sourceRef("rule", this.clock.iso())], { task: current, error: { code: validation.code, message: validation.message, retryable: validation.retryable, requestId } });
    }
    const result = this.taskService.transition(transport.scopeId, operation);
    if (result.invalid) return this.#response(request, requestId, "task_status", `当前状态 ${result.task.status} 不支持该操作。`, [sourceRef("rule", this.clock.iso())], { task: result.task, error: { code: "INVALID_TASK_TRANSITION", message: "不允许的任务状态迁移。", retryable: false, requestId } });
    if (result.changed && operation === "pause") this.#captureResumeState(result.task);
    if (result.changed) this.#taskEvent(result.task, result.fromStatus);
    state.currentTaskId = result.task.status === "stopped" ? null : result.task.taskId;
    const labels = { pause: "暂停", resume: "运行", stop: "停止" };
    const suffix = operation === "stop" ? "；不会自动反转已经完成的设备动作" : "";
    const simulation = result.task.type === "optimization" ? "；模拟优化" : "";
    return this.#response(request, requestId, "task_status", `任务当前为${labels[operation]}状态${simulation}${suffix}。`, [sourceRef("rule", result.task.updatedAt, result.task.taskId)], { task: result.task });
  }

  #cookingDependenciesAvailable() {
    return ["air_purifier", "range_hood"].every((type) => {
      const device = this.registry.list().find((item) => item.type === type);
      return device?.connectionStatus === "online" && device.controlSupport === "supported" && device.state !== "unknown";
    });
  }

  #captureResumeState(task) {
    const specification = this.taskSpecs.get(task.taskId);
    if (!specification) return false;
    const devices = task.type === "cooking_guard"
      ? specification.actions.map((action) => this.registry.get(action.deviceId)).filter(Boolean)
      : this.registry.list().filter((device) => specification.controlledDeviceTypes?.includes(device.type));
    specification.resumeDeviceStateVersions = Object.fromEntries(devices.map((device) => [device.id, device.stateVersion]));
    return true;
  }

  #validateResume(task) {
    const specification = this.taskSpecs.get(task.taskId);
    if (!specification || specification.type !== task.type || !specification.resumeDeviceStateVersions) {
      return { ok: false, code: "POLICY_REJECTED", message: "缺少可信的任务恢复规格", retryable: false };
    }
    if (task.type === "cooking_guard") return this.#validateCookingResume(specification);
    if (task.type === "optimization") return this.#validateOptimizationResume(task, specification);
    return { ok: false, code: "POLICY_REJECTED", message: "任务类型不支持恢复", retryable: false };
  }

  #validateCookingResume(specification) {
    const actions = specification.actions ?? [];
    const types = actions.map((action) => action.deviceType);
    const fixedTemplate = actions.length >= 2 && actions.length <= 3
      && types.filter((type) => type === "air_purifier").length === 1
      && types.filter((type) => type === "range_hood").length === 1
      && types.filter((type) => type === "smart_window").length <= 1
      && actions.every((action) => {
        if (["air_purifier", "range_hood"].includes(action.deviceType)) return action.action === "turn_on" && action.targetState === "on";
        return action.deviceType === "smart_window" && ((action.action === "open" && action.targetState === "open") || (action.action === "close" && action.targetState === "closed"));
      });
    if (!fixedTemplate) return { ok: false, code: "POLICY_REJECTED", message: "烹饪守护规格不符合固定模板", retryable: false };
    const reboundActions = [];
    for (const action of actions) {
      const device = this.registry.get(action.deviceId);
      const expectedVersion = specification.resumeDeviceStateVersions[action.deviceId];
      if (!device || expectedVersion === undefined || device.stateVersion !== expectedVersion) return { ok: false, code: "CONFIRMATION_INVALIDATED", message: "设备状态版本已变化", retryable: false };
      if (device.connectionStatus !== "online" || device.controlSupport !== "supported" || device.state === "unknown") return { ok: false, code: "DEVICE_UNAVAILABLE", message: "烹饪守护依赖设备不可用", retryable: true };
      if (!device.availableActions.includes(action.action)) return { ok: false, code: "POLICY_REJECTED", message: "设备能力不再满足任务策略", retryable: false };
      reboundActions.push({ ...action, expectedStateVersion: expectedVersion });
    }
    const decision = validatePlannedActions(reboundActions, this.registry);
    if (decision.outcome !== "allow") return { ok: false, code: "POLICY_REJECTED", message: "烹饪守护策略复核未通过", retryable: false };
    return { ok: true };
  }

  #validateOptimizationResume(task, specification) {
    const config = OPTIMIZATION_MODES[task.mode];
    const configuredTypes = [...(specification.controlledDeviceTypes ?? [])].sort();
    const expectedPolicyHash = config ? sha256({ weights: config.weights, healthFloor: config.healthFloor, devices: config.devices }) : null;
    if (!config || !task.isSimulation || !["mock", "replay"].includes(task.executionSource)
      || specification.executionSource !== task.executionSource || this.optimizer.source !== task.executionSource
      || specification.policyConfigHash !== expectedPolicyHash
      || JSON.stringify(configuredTypes) !== JSON.stringify([...config.devices].sort())) {
      return { ok: false, code: "POLICY_REJECTED", message: "模拟优化规格或固定策略不匹配", retryable: false };
    }
    if (!this.optimizer.available) return { ok: false, code: "OPTIMIZER_UNAVAILABLE", message: "优化器不可用", retryable: true };
    const devices = this.registry.list().filter((device) => configuredTypes.includes(device.type));
    const expectedIds = Object.keys(specification.resumeDeviceStateVersions).sort();
    if (!devices.length || JSON.stringify(devices.map((device) => device.id).sort()) !== JSON.stringify(expectedIds)) {
      return { ok: false, code: "POLICY_REJECTED", message: "模拟优化可控设备集合已变化", retryable: false };
    }
    for (const device of devices) {
      if (device.stateVersion !== specification.resumeDeviceStateVersions[device.id]) return { ok: false, code: "CONFIRMATION_INVALIDATED", message: "模拟优化设备状态版本已变化", retryable: false };
      if (device.connectionStatus !== "online" || device.controlSupport !== "supported" || device.state === "unknown") return { ok: false, code: "DEVICE_UNAVAILABLE", message: "模拟优化可控设备不可用", retryable: true };
      const requiredActions = device.type === "smart_window" ? ["open", "close"] : ["turn_on", "turn_off"];
      if (!requiredActions.every((action) => device.availableActions.includes(action))) return { ok: false, code: "POLICY_REJECTED", message: "模拟优化设备能力不符合固定策略", retryable: false };
    }
    return { ok: true };
  }

  #plannedAction(device, action, targetState) {
    return { actionId: this.ids.next("action"), deviceId: device.id, deviceType: device.type, action, targetState, expectedStateVersion: device.stateVersion };
  }

  #makePlan({ kind, summary, actions, requiresConfirmation, scheduledFor, timezone, isSimulation, taskVersion }) {
    const now = this.clock.iso();
    const normalized = { kind, summary, actions: actions.map(({ actionId: _ignored, ...action }) => action), requiresConfirmation, scheduledFor: scheduledFor ?? null, timezone: timezone ?? null, isSimulation: isSimulation ?? false, taskVersion: taskVersion ?? null };
    const plan = { planId: this.ids.next("plan"), planHash: sha256(normalized), kind, summary, actions, requiresConfirmation, createdAt: now, expiresAt: addMilliseconds(now, CONFIRMATION_TTL_MS) };
    if (taskVersion !== undefined) plan.taskVersion = taskVersion;
    if (scheduledFor) plan.scheduledFor = scheduledFor;
    if (timezone) plan.timezone = timezone;
    if (isSimulation !== undefined) plan.isSimulation = isSimulation;
    return plan;
  }

  #saveConfirmation(state, request, transport, requestId, plan, internal) {
    const publicConfirmation = {
      confirmationId: this.ids.next("confirmation"), conversationId: request.conversationId, plan,
      deviceStateVersions: Object.fromEntries(plan.actions.map((action) => [action.deviceId, action.expectedStateVersion])),
      status: "pending", createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    };
    if (plan.taskVersion !== undefined) publicConfirmation.taskVersion = plan.taskVersion;
    state.pendingConfirmation = { public: publicConfirmation, actorId: transport.actorId, scopeId: transport.scopeId, internal };
    this.#event("confirmation_presented", { requestId, conversationId: request.conversationId, properties: { planKind: plan.kind, expiresInSeconds: 120 } });
    const prefix = internal.replaceTaskId ? "当前已有任务。确认后将先停止旧任务，再创建新任务。" : "请确认以下计划：";
    return this.#response(request, requestId, "confirmation", `${prefix}${plan.summary}`, [sourceRef("rule", plan.createdAt, plan.planId)], { confirmation: clone(publicConfirmation), error: { code: "CONFIRMATION_REQUIRED", message: "该计划需要确认。", retryable: false, requestId } });
  }

  #cancelConfirmation(state, request, requestId, content = "已取消待确认计划，没有执行任何动作。") {
    const pending = state.pendingConfirmation;
    pending.public.status = "cancelled";
    state.pendingConfirmation = null;
    this.#event("confirmation_resolved", { requestId, conversationId: request.conversationId, properties: { resolution: "cancelled" } });
    return this.#response(request, requestId, "chat", content, [sourceRef("rule", this.clock.iso())]);
  }

  async #confirm(state, request, transport, requestId) {
    const pending = state.pendingConfirmation;
    const supplied = request.continuation?.type === "confirmation" ? request.continuation.id : pending.public.confirmationId;
    if (supplied !== pending.public.confirmationId || pending.actorId !== transport.actorId || pending.scopeId !== transport.scopeId) {
      throw publicError("CONFIRMATION_INVALIDATED", "确认身份、作用域或标识不匹配，请重新发起。", { requestId });
    }
    if (this.clock.now() > new Date(pending.public.expiresAt)) {
      pending.public.status = "expired";
      state.pendingConfirmation = null;
      throw publicError("CONFIRMATION_EXPIRED", "确认已超过 120 秒有效期，请重新发起。", { requestId });
    }
    const plan = pending.public.plan;
    if (sha256({ kind: plan.kind, summary: plan.summary, actions: plan.actions.map(({ actionId: _ignored, ...action }) => action), requiresConfirmation: plan.requiresConfirmation, scheduledFor: plan.scheduledFor ?? null, timezone: plan.timezone ?? null, isSimulation: plan.isSimulation ?? false, taskVersion: plan.taskVersion ?? null }) !== plan.planHash) {
      state.pendingConfirmation = null;
      throw publicError("CONFIRMATION_INVALIDATED", "计划内容已变化，请重新发起。", { requestId });
    }
    const current = this.taskService.current(transport.scopeId);
    if (plan.taskVersion !== undefined && plan.taskVersion !== (current?.taskVersion ?? 0)) {
      state.pendingConfirmation = null;
      throw publicError("CONFIRMATION_INVALIDATED", "当前任务版本已变化，请重新发起。", { requestId });
    }
    const policy = validatePlannedActions(plan.actions, this.registry);
    if (policy.outcome !== "allow") {
      state.pendingConfirmation = null;
      throw publicError("CONFIRMATION_INVALIDATED", "设备状态或策略已变化，请重新发起。", { requestId });
    }
    pending.public.status = "confirmed";
    state.pendingConfirmation = null;
    this.#event("confirmation_resolved", { requestId, conversationId: request.conversationId, properties: { resolution: "confirmed" } });
    if (pending.internal.kind === "single_device") {
      const receipt = await this.#executeActions(plan.actions, requestId, plan.planId, request.idempotencyKey);
      return this.#executionResponse(request, requestId, receipt);
    }
    if (pending.internal.specification.type === "optimization" && !this.optimizer.available) throw publicError("OPTIMIZER_UNAVAILABLE", "优化器不可用，未创建任务。", { retryable: true, requestId });
    if (pending.internal.specification.type === "cooking_guard" && !this.#cookingDependenciesAvailable()) throw publicError("DEVICE_UNAVAILABLE", "必要设备不可用，未创建任务。", { retryable: true, requestId });
    if (pending.internal.replaceTaskId) {
      const stopped = this.taskService.stopForReplacement(transport.scopeId);
      if (!stopped.changed && stopped.task?.status !== "stopped") throw publicError("INVALID_TASK_TRANSITION", "旧任务停止失败，未创建新任务。", { requestId });
      if (stopped.changed) this.#taskEvent(stopped.task, stopped.fromStatus);
    }
    const created = this.taskService.create(transport.scopeId, pending.internal.specification);
    if (created.conflict) throw publicError("TASK_CONFLICT", "当前仍有活动任务，未创建新任务。", { requestId });
    this.taskSpecs.set(created.task.taskId, { ...pending.internal.specification, actions: clone(plan.actions), requestId, planId: plan.planId, idempotencyKey: request.idempotencyKey, expectedTaskVersion: created.task.taskVersion });
    state.currentTaskId = created.task.taskId;
    this.#taskEvent(created.task, "none");
    if (created.task.type === "cooking_guard" && created.task.status === "running") {
      const receipt = await this.#executeActions(plan.actions, requestId, plan.planId, request.idempotencyKey);
      const response = this.#executionResponse(request, requestId, receipt, created.task);
      response.message.content = `烹饪守护任务已创建并运行。${response.message.content}`;
      return response;
    }
    const simulation = created.task.type === "optimization" ? "模拟优化" : "烹饪守护";
    return this.#response(request, requestId, "task_status", `${simulation}任务已创建，状态：${created.task.status}。任务创建不代表设备动作已经成功。`, [sourceRef("rule", created.task.updatedAt, created.task.taskId)], { task: created.task });
  }

  async #executeActions(actions, requestId, planId, baseIdempotencyKey, taskGuard = null) {
    const startedAt = this.clock.iso();
    const results = [];
    for (let index = 0; index < actions.length; index += 1) {
      const item = actions[index];
      if (taskGuard && !this.#taskGuardAllowsExecution(taskGuard)) {
        for (const unsent of actions.slice(index)) {
          const currentDevice = this.registry.get(unsent.deviceId);
          results.push({ actionId: unsent.actionId, deviceId: unsent.deviceId, requestedAction: unsent.action, actualState: currentDevice?.state ?? "unknown", status: "failed", errorCode: "TASK_CHANGED_DURING_EXECUTION", source: "mock" });
        }
        break;
      }
      const device = this.registry.get(item.deviceId);
      if (!device || device.stateVersion !== item.expectedStateVersion) {
        results.push({ actionId: item.actionId, deviceId: item.deviceId, requestedAction: item.action, actualState: device?.state ?? "unknown", status: "failed", errorCode: "CONFIRMATION_INVALIDATED", source: "mock" });
        continue;
      }
      if (device.state === item.targetState) {
        results.push({ actionId: item.actionId, deviceId: item.deviceId, requestedAction: item.action, actualState: device.state, status: "noop", source: "mock" });
        continue;
      }
      const command = { requestId, idempotencyKey: `${baseIdempotencyKey}:${item.actionId}`, planId, deviceId: item.deviceId, action: item.action, expectedStateVersion: item.expectedStateVersion, issuedAt: this.clock.iso() };
      let outcome;
      try { outcome = await this.devices.execute(command, device, item.targetState); }
      catch { outcome = { status: "failed", actualState: "unknown", errorCode: "SERVICE_UNAVAILABLE", source: "mock" }; }
      if (outcome.status === "succeeded") this.registry.updateState(item.deviceId, item.targetState);
      const result = { actionId: item.actionId, deviceId: item.deviceId, requestedAction: item.action, actualState: outcome.actualState ?? "unknown", status: outcome.status, source: outcome.source ?? "mock" };
      if (outcome.errorCode) result.errorCode = outcome.errorCode;
      results.push(result);
      this.#event("device_action_completed", { requestId, properties: { deviceType: device.type, action: item.action, receiptStatus: result.status, executionSource: result.source } });
    }
    const statuses = results.map((result) => result.status);
    let status;
    if (statuses.every((item) => item === "noop")) status = "noop";
    else if (statuses.every((item) => item === "succeeded")) status = "succeeded";
    else if (statuses.some((item) => ["succeeded", "noop"].includes(item)) && statuses.some((item) => !["succeeded", "noop"].includes(item))) status = "partial_success";
    else if (statuses.some((item) => item === "timed_out")) status = "timed_out";
    else if (statuses.some((item) => item === "unknown")) status = "unknown";
    else status = "failed";
    return { receiptId: this.ids.next("receipt"), requestId, planId, status, actions: results, source: "mock", startedAt, completedAt: this.clock.iso() };
  }

  #taskGuardAllowsExecution(guard) {
    const current = this.taskService.current(guard.scopeId);
    return current?.taskId === guard.taskId && current.taskVersion === guard.taskVersion && current.status === "running";
  }

  #executionResponse(request, requestId, receipt, task) {
    const descriptions = receipt.actions.map((item) => `${item.deviceId}：${item.status}${item.actualState ? `（${item.actualState}）` : ""}`).join("；");
    let content;
    if (receipt.status === "succeeded") content = `设备动作已由 Mock 执行器确认完成：${descriptions}。`;
    else if (receipt.status === "noop") content = `设备已经处于目标状态，没有重复执行：${descriptions}。`;
    else if (receipt.status === "partial_success") content = `设备动作部分成功，不能视为整体成功：${descriptions}。`;
    else if (receipt.status === "timed_out") content = `设备执行超时，最终状态未知：${descriptions}。`;
    else content = `设备执行失败或最终状态未知：${descriptions}。`;
    const extra = { receipt, ...(task ? { task } : {}) };
    if (["failed", "partial_success", "unknown"].includes(receipt.status)) extra.error = { code: "EXECUTION_FAILED", message: "设备动作未全部成功。", retryable: true, requestId };
    if (receipt.status === "timed_out") extra.error = { code: "EXECUTION_TIMEOUT", message: "设备执行超时，最终状态未知。", retryable: true, requestId };
    return this.#response(request, requestId, "execution_result", content, [sourceRef("mock", receipt.completedAt, receipt.receiptId)], extra);
  }

  #clarification(state, request, requestId, kind, prompt, options) {
    const now = this.clock.iso();
    const publicClarification = { clarificationId: this.ids.next("clarification"), originalRequestId: requestId, kind, prompt, options: options.slice(0, 10), createdAt: now, expiresAt: addMilliseconds(now, CONFIRMATION_TTL_MS) };
    state.pendingClarification = { public: publicClarification, originalMessage: request.message };
    this.#event("clarification_presented", { requestId, conversationId: request.conversationId, properties: { clarificationKind: kind } });
    return this.#response(request, requestId, "clarification", prompt, [sourceRef("rule", now)], { clarification: publicClarification, error: { code: "CLARIFICATION_REQUIRED", message: prompt, retryable: false, requestId } });
  }

  #unknownGuidance(request, requestId) {
    // Model / rule fallback reached a genuine unknown intent. Do not pretend to
    // understand or act; instead guide the user to what Luna can reliably do.
    const content = `我还没有完全理解你的意思，所以没有执行任何操作。我可以帮你：查询室内空气（如“现在空气怎么样”）、控制设备（如“打开空气净化器”）、了解空气知识（如“PM2.5 是什么”）、管理任务（如“当前任务”或“暂停任务”），或启动模拟优化（如“舒适优先优化”）。也可以直接和我闲聊。请试着换一种问法。`;
    return this.#response(request, requestId, "chat", composeReplyText(content, detectHealthTopic(request.message)), [sourceRef("rule", this.clock.iso())], { error: { code: "INTENT_UNCLEAR", message: "无法可靠识别意图，已引导用户重新表达。", retryable: false, requestId } });
  }

  #rejection(request, requestId, code, message, alternatives) {
    const content = alternatives.length ? `${message} 可选操作：${alternatives.join("；")}` : message;
    return this.#response(request, requestId, "rejection", content, [sourceRef("rule", this.clock.iso())], { error: { code, message, retryable: ["DEVICE_UNAVAILABLE", "OPTIMIZER_UNAVAILABLE"].includes(code), requestId } });
  }

  #response(request, requestId, responseType, content, sources, extra = {}) {
    return {
      contractVersion: CONTRACT_VERSION,
      requestId,
      conversationId: request.conversationId,
      message: { id: this.ids.next("message"), role: "assistant", content, status: extra.error && responseType === "error" ? "error" : "complete", createdAt: this.clock.iso() },
      responseType,
      sources,
      ...extra,
    };
  }

  #errorResponse(conversationId, requestId, error, responseType = "error", sources = []) {
    return {
      contractVersion: CONTRACT_VERSION,
      requestId,
      conversationId,
      message: { id: this.ids.next("message"), role: "assistant", content: error.message, status: "error", createdAt: this.clock.iso() },
      responseType,
      sources,
      error: error instanceof PublicError ? error.toJSON() : error,
    };
  }

  #rememberMessage(state, role, content, messageId = null) {
    const id = typeof messageId === "string" && messageId ? messageId : this.ids.next("message");
    state.messages.push({ id, role, content, createdAt: this.clock.iso() });
    if (state.messages.length > 12) state.messages.splice(0, state.messages.length - 12);
  }

  #persistTurn(conversationId, result) {
    if (!conversationId || typeof conversationId !== "string" || !conversationId) return;
    const state = this.repository.getConversation(conversationId);
    const userMessages = Array.isArray(state?.messages) ? state.messages.filter((message) => message?.role === "user").map((message) => ({ ...message })) : [];
    const userMessage = userMessages[userMessages.length - 1];
    if (!userMessage || !result?.message) return;
    const assistantMessage = {
      ...result.message,
      responseType: result.responseType ?? null,
      ...(Array.isArray(result.sources) ? { sources: result.sources } : {}),
      ...Object.fromEntries(Object.entries(result).filter(([key]) => ["error", "realtime", "confirmation", "clarification", "task", "receipt", "receiptId", "requestId", "planId"].includes(key))),
    };
    if (typeof this.repository.persistMessages === "function") {
      try {
        this.repository.persistMessages(conversationId, [userMessage, assistantMessage]);
      } catch {
        // Persistence is best-effort and cannot change the main result.
      }
    }
  }

  #event(eventName, partial) {
    try {
      this.telemetry.emit({ eventId: this.ids.next("event"), eventName, eventVersion: "1.0.0", occurredAt: this.clock.iso(), source: "backend", ...partial });
    } catch {
      // Telemetry is best-effort and cannot change the main result.
    }
  }

  #taskEvent(task, fromStatus) {
    this.#event("task_state_changed", { taskId: task.taskId, properties: { taskType: task.type, fromStatus, toStatus: task.status, isSimulation: task.isSimulation } });
  }
}

