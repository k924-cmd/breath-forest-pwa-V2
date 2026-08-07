// Real ASR (speech-to-text) adapter backed by DashScope qwen3-asr-flash,
// mirroring the safety posture of tavily.js / deepseek.js. The DashScope key
// is read from local configuration, never logged, emitted, or included in
// errors. Any failure — adapter unavailable, network error, timeout,
// unparsable response — degrades to a null result so the caller can keep the
// existing rejection path; it never throws and never leaks the key.

import { fileURLToPath } from "node:url";
import { loadDotEnvIfPresent } from "../config/env.js";

export const DASHSCOPE_ASR_DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
export const DASHSCOPE_ASR_DEFAULT_MODEL = "qwen3-asr-flash";
export const DASHSCOPE_ASR_TIMEOUT_MS_CAP = 30_000;
export const DASHSCOPE_ASR_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function parseEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export class DashScopeAsrAdapter {
  constructor(options = {}) {
    loadDotEnvIfPresent(fileURLToPath(new URL("../../.env", import.meta.url)));
    this.endpoint = (options.endpoint ?? process.env.DASHSCOPE_ASR_ENDPOINT ?? DASHSCOPE_ASR_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
    this.model = options.model ?? process.env.DASHSCOPE_ASR_MODEL ?? DASHSCOPE_ASR_DEFAULT_MODEL;
    this.timeoutMs = clampInteger(options.timeoutMs ?? process.env.DASHSCOPE_ASR_TIMEOUT_MS, DASHSCOPE_ASR_TIMEOUT_MS_CAP, 1_000, DASHSCOPE_ASR_TIMEOUT_MS_CAP);
    this.enabled = options.enabled ?? parseEnabled(process.env.DASHSCOPE_ENABLED);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referenceId = options.referenceId ?? this.model;
    this.transcribeCalls = 0;
  }

  get available() {
    return this.enabled === true && typeof this.apiKey === "string" && this.apiKey.length > 0 && typeof this.fetchImpl === "function";
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.available) return null;
    if (!(audioBuffer instanceof Uint8Array) || audioBuffer.length === 0) return null;
    if (audioBuffer.length > DASHSCOPE_ASR_MAX_AUDIO_BYTES) return null;
    const mimeType = typeof options.mimeType === "string" && options.mimeType.trim() ? options.mimeType.trim() : "audio/wav";
    this.transcribeCalls += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const dataUri = `data:${mimeType};base64,${Buffer.from(audioBuffer).toString("base64")}`;
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "user", content: [{ type: "input_audio", input_audio: { data: dataUri } }] },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean") return null;
      if (!response.ok) return null;
      const data = await response.json();
      const text = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
      if (!text) return null;
      return {
        text,
        language: data?.choices?.[0]?.message?.annotations?.[0]?.language || null,
        referenceId: this.referenceId,
        observedAt: new Date().toISOString(),
      };
    } catch {
      // Never leak the key, request body or provider details.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
