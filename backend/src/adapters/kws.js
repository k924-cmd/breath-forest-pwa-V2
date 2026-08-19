// Wake-word (keyword spotting) adapters for 「小云小云」.
//
// Two backends, selected by configuration:
//   - KwsHttpAdapter: proxies to a Python KWS service (FunASR cFSMN model,
//     speech_charctc_kws_phone-xiaoyun) running on Linux/本机. Enabled when
//     KWS_SERVICE_URL is configured and reachable.
//   - KwsFallbackAdapter: local simulation used when the real model is not
//     deployed. Returns a plausible {detected, score, latencyMs} so the frontend
//     chain, tests and kws-eval pipeline all run without the Python model.
//
// Safety posture mirrors the other adapters: keys never logged, any failure
// degrades to a null / {detected:false} result, never throws.

import { fileURLToPath } from "node:url";
import { loadDotEnvIfPresent } from "../config/env.js";

export const KWS_DEFAULT_KEYWORD = "小云小云";
export const KWS_SERVICE_DEFAULT_URL = "http://127.0.0.1:8901";
export const KWS_TIMEOUT_MS_CAP = 8_000;

function parseEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// 模拟唤醒检测器：真实模型不可用时兜底。基于音频能量做粗略判断——
// 有足够语音能量即随机加权判命中，保证链路/测试可跑，但结果不真实。
export class KwsFallbackAdapter {
  constructor(options = {}) {
    this.keyword = options.keyword ?? KWS_DEFAULT_KEYWORD;
    this.hitRate = options.hitRate ?? 0.35;
    this.enabled = options.enabled ?? true;
    this.referenceId = options.referenceId ?? "kws-fallback";
    this.checks = 0;
  }

  get available() {
    return this.enabled === true;
  }

  check(audioBuffer) {
    if (!this.available) return null;
    if (!(audioBuffer instanceof Uint8Array) || audioBuffer.length === 0) return null;
    this.checks += 1;
    const energy = estimateEnergy(audioBuffer);
    // 能量越高越可能像语音；无真实模型时用能量 + 伪随机模拟唤醒。
    const detected = energy > 0.02 && Math.random() < this.hitRate;
    return {
      detected,
      keyword: this.keyword,
      score: detected ? 0.7 + Math.random() * 0.3 : Math.random() * 0.4,
      latencyMs: detected ? 150 + Math.random() * 200 : null,
      source: "fallback",
    };
  }
}

// 真实唤醒检测：代理到 Python KWS 服务（FunASR 加载 cFSMN 模型）。
export class KwsHttpAdapter {
  constructor(options = {}) {
    loadDotEnvIfPresent(fileURLToPath(new URL("../../.env", import.meta.url)));
    this.serviceUrl = (options.serviceUrl ?? process.env.KWS_SERVICE_URL ?? KWS_SERVICE_DEFAULT_URL).replace(/\/+$/, "");
    this.keyword = options.keyword ?? process.env.KWS_KEYWORD ?? KWS_DEFAULT_KEYWORD;
    this.timeoutMs = Number(options.timeoutMs ?? process.env.KWS_TIMEOUT_MS ?? KWS_TIMEOUT_MS_CAP);
    if (!Number.isFinite(this.timeoutMs)) this.timeoutMs = KWS_TIMEOUT_MS_CAP;
    this.enabled = options.enabled ?? parseEnabled(process.env.KWS_ENABLED);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referenceId = options.referenceId ?? "kws-xiaoyun";
    this.checks = 0;
  }

  get available() {
    return this.enabled === true && typeof this.fetchImpl === "function";
  }

  async check(audioBuffer) {
    if (!this.available) return null;
    if (!(audioBuffer instanceof Uint8Array) || audioBuffer.length === 0) return null;
    this.checks += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.serviceUrl}/kws`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: audioBuffer,
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean" || !response.ok) return null;
      const data = await response.json();
      if (!data || typeof data !== "object") return null;
      return {
        detected: data.detected === true,
        keyword: typeof data.keyword === "string" ? data.keyword : this.keyword,
        score: typeof data.score === "number" ? data.score : null,
        latencyMs: typeof data.latency_ms === "number" ? data.latency_ms : null,
        source: "python-kws",
      };
    } catch {
      // 服务不可达/超时/坏响应 → 降级 null（调用方回 fallback 或判未命中）。
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// 简单能量估计：采样字节偏置 128 的均方根，粗略判断是否为语音。
function estimateEnergy(bytes) {
  let sum = 0;
  const step = Math.max(1, Math.floor(bytes.length / 4000));
  for (let i = 0; i < bytes.length; i += step) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.ceil(bytes.length / step));
}
