// Real generative model adapter for local V1 development.
//
// Opt-in only: the default backend keeps FakeModelAdapter and never calls out.
// When enabled, the adapter (a) maps the raw user message to a V1 intent via
// intent classification when rule-based routing returns no candidate, and
// (b) generates display text for chat / knowledge. Entities, device
// resolution, environment facts, policy and execution receipts remain fixed
// code, so the model can only ever choose an intent, never fabricate devices,
// actions, values or execution results. The API key is read from local
// configuration and is never logged, emitted, or included in errors.

import { fileURLToPath } from "node:url";
import { loadDotEnvIfPresent } from "../config/env.js";
import { INTENTS } from "../conversation/router.js";

export const DEEPSEEK_DEFAULT_ENDPOINT = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";
export const DEEPSEEK_MAX_TOKENS_CAP = 512;
export const DEEPSEEK_TIMEOUT_MS_CAP = 15_000;

const SYSTEM_PROMPTS = Object.freeze({
  chat: "你是“呼吸森林”的本地 AI 小助手 Luna。你可以进行一般性聊天，并介绍空气与设备知识。你必须只依据用户给出的信息回答：不得编造或声称当前设备状态、当前环境读数或任何执行结果；不得声称已经操作设备或将要自动操作设备；不得提供医疗诊断或紧急救助建议。请使用中文，回答简洁自然。",
  knowledge: "你是“呼吸森林”的空气健康知识助手。请使用中文简洁、客观地解释空气健康和 V1 设备的一般知识。不得编造或声称当前设备状态、当前环境读数或任何执行结果；不得声称已经执行任何操作；不得提供医疗诊断或替代专业医疗建议。",
  intent: "你是“呼吸森林”本地 AI 助手 Luna 的意图分类器。用户消息只会被分类，你绝不能编造或声称设备状态、环境读数、执行结果或任何事实；不做任何操作。请把用户消息映射到且仅映射到下列意图之一，并输出严格 JSON（不要输出任何其他文字）：\n{\"intent\":\"<意图>\",\"confidence\":<0到1之间的小数>}\n\n可用意图：\n- device_control：打开/关闭/开窗/关窗/控制某个设备（含中文口语与英文，如 turn on/off the purifier、open/close the window、power 等）\n- device_query：查询某设备的状态/是否在线\n- environment_query：查询室内空气/环境（PM2.5、AQI、CO2、湿度、温度、空气评分，如 air quality、how is the air 等）\n- weather_query：查询室外实时天气或室外数值（天气预报、AQI、室外温度等）\n- cooking_guard_create：开始烹饪/火锅空气守护\n- optimization_create：启动模拟优化（舒适/均衡/低碳）\n- task_query：查询当前任务/模式\n- task_pause：暂停任务；task_resume：恢复任务；task_stop：停止任务\n- knowledge_query：询问空气/设备/健康的一般性知识或原理（是什么、为什么、怎么工作、介绍一下）\n- chat：纯闲聊、问候、无法归入其他类别的对话\n- unknown：无法可靠识别意图时\n\n判断要点：涉及具体设备动作→device_control；涉及具体设备状态→device_query；涉及室内空气读数→environment_query；涉及室外→weather_query；涉及空气/设备原理知识→knowledge_query；纯问候或闲聊→chat；其他情况倾向 unknown。不要识别或编造设备名、房间、动作、模式、时间等实体。",
});

const INTENT_FALLBACK = Object.freeze({ intent: "unknown", entities: {}, evidence: "", source: "model", confidence: 0 });

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export class DeepSeekModelAdapter {
  constructor(options = {}) {
    loadDotEnvIfPresent(fileURLToPath(new URL("../../.env", import.meta.url)));
    this.endpoint = (options.endpoint ?? process.env.DEEPSEEK_ENDPOINT ?? DEEPSEEK_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    if (!this.endpoint.startsWith("https://")) throw new Error("DeepSeek endpoint must use https");
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
    this.maxTokens = clampInteger(options.maxTokens ?? process.env.DEEPSEEK_MAX_TOKENS, DEEPSEEK_MAX_TOKENS_CAP, 1, DEEPSEEK_MAX_TOKENS_CAP);
    this.timeoutMs = clampInteger(options.timeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS, DEEPSEEK_TIMEOUT_MS_CAP, 1_000, DEEPSEEK_TIMEOUT_MS_CAP);
    this.enabled = options.enabled ?? parseEnabled(process.env.DEEPSEEK_ENABLED);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referenceId = options.referenceId ?? this.model;
    this.responseCalls = 0;
  }

  get available() {
    return this.enabled === true && typeof this.apiKey === "string" && this.apiKey.length > 0 && typeof this.fetchImpl === "function";
  }

  get generative() {
    return this.available;
  }

  // Intent classification fallback: when rule-based routing finds no candidate,
  // ask the real model to map the raw message to a single V1 intent. The model
  // only returns an intent (plus confidence); entities are re-extracted from
  // the user text by validateSemanticCandidate, so the model can never invent
  // devices, actions, modes, times or execution facts. Any failure — model
  // unavailable, network error, timeout, unparsable JSON, unknown intent —
  // degrades to the fixed unknown fallback and never throws.
  async extractCandidate(input = {}) {
    if (!this.available) return { ...INTENT_FALLBACK };
    const userMessage = typeof input?.message === "string" ? input.message : "";
    if (!userMessage.trim()) return { ...INTENT_FALLBACK };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPTS.intent },
            { role: "user", content: userMessage },
          ],
          max_tokens: 128,
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean") return { ...INTENT_FALLBACK };
      if (!response.ok) return { ...INTENT_FALLBACK };
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) return { ...INTENT_FALLBACK };
      const parsed = parseIntentCandidate(content);
      if (!parsed) return { ...INTENT_FALLBACK };
      return {
        intent: parsed.intent,
        entities: {},
        evidence: userMessage,
        source: "model",
        confidence: parsed.confidence,
      };
    } catch {
      // Never leak the key, request body or provider details.
      return { ...INTENT_FALLBACK };
    } finally {
      clearTimeout(timer);
    }
  }

  async respond(input = {}) {
    if (!this.available) throw new Error("deepseek model unavailable");
    const kind = input.kind === "knowledge" ? "knowledge" : "chat";
    const userMessage = typeof input.message === "string" ? input.message : "";
    if (!userMessage) throw new Error("deepseek model unavailable");
    this.responseCalls += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPTS[kind] },
            { role: "user", content: userMessage },
          ],
          max_tokens: this.maxTokens,
          temperature: kind === "knowledge" ? 0.3 : 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean") throw new Error("deepseek model unavailable");
      if (!response.ok) throw new Error("deepseek model unavailable");
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("deepseek model unavailable");
      return content;
    } catch (error) {
      // Never leak the key, request body or provider details.
      throw new Error("deepseek model unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// Tolerantly parse the model's strict-JSON intent reply. Pulls the first JSON
// object out of the content, accepts lowercase / Chinese values, and only
// trusts intents that exist in the shared INTENTS set. Any miss degrades to
// null so the caller returns the fixed unknown fallback.
function parseIntentCandidate(content) {
  try {
    const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const rawIntent = typeof parsed?.intent === "string" ? parsed.intent.trim().toLowerCase() : "";
    if (!rawIntent || !INTENTS.has(rawIntent)) return null;
    const confidence = Number(parsed?.confidence);
    return {
      intent: rawIntent,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    };
  } catch {
    return null;
  }
}
