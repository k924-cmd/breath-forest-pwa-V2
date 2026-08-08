// Real TTS adapter backed by the Xiaomi MiMo V2.5 API, mirroring the safety
// posture of dashscope-asr.js / deepseek.js. The MiMo key is read from local
// configuration, never logged, emitted, or included in errors. Any failure —
// adapter unavailable, network error, timeout, unparsable response — degrades
// to a null result so the caller can keep the existing fallback path; it never
// throws and never leaks the key.
//
// Singing: prepend `(唱歌)` to the text (format `(唱歌)歌词`, Chinese works
// best) to have the preset voice sing instead of speak. The API returns the
// audio as base64 in choices[0].message.audio.data.

import { fileURLToPath } from "node:url";
import { loadDotEnvIfPresent } from "../config/env.js";

export const MIMO_TTS_DEFAULT_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
export const MIMO_TTS_DEFAULT_MODEL = "mimo-v2.5-tts";
export const MIMO_TTS_DEFAULT_VOICE = "冰糖";
export const MIMO_TTS_DEFAULT_FORMAT = "wav";
export const MIMO_TTS_TIMEOUT_MS_CAP = 30_000;
export const MIMO_TTS_MAX_TEXT_BYTES = 4 * 1024;
export const SINGING_TAG = "(唱歌)";

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function parseEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export class MiMoTtsAdapter {
  constructor(options = {}) {
    loadDotEnvIfPresent(fileURLToPath(new URL("../../.env", import.meta.url)));
    this.endpoint = (options.endpoint ?? process.env.MIMO_ENDPOINT ?? MIMO_TTS_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.MIMO_API_KEY ?? "";
    this.model = options.model ?? process.env.MIMO_MODEL ?? MIMO_TTS_DEFAULT_MODEL;
    this.voice = options.voice ?? process.env.MIMO_VOICE ?? MIMO_TTS_DEFAULT_VOICE;
    this.format = options.format ?? process.env.MIMO_FORMAT ?? MIMO_TTS_DEFAULT_FORMAT;
    this.timeoutMs = clampInteger(options.timeoutMs ?? process.env.MIMO_TIMEOUT_MS, MIMO_TTS_TIMEOUT_MS_CAP, 1_000, MIMO_TTS_TIMEOUT_MS_CAP);
    this.enabled = options.enabled ?? parseEnabled(process.env.MIMO_ENABLED);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referenceId = options.referenceId ?? this.model;
    this.synthesizeCalls = 0;
  }

  get available() {
    return this.enabled === true && typeof this.apiKey === "string" && this.apiKey.length > 0 && typeof this.fetchImpl === "function";
  }

  async synthesize(text, options = {}) {
    if (!this.available) return null;
    const raw = typeof text === "string" ? text : "";
    if (!raw.trim()) return null;
    const voice = typeof options.voice === "string" && options.voice.trim() ? options.voice.trim() : this.voice;
    const format = typeof options.format === "string" && options.format.trim() ? options.format.trim() : this.format;
    const sing = options.sing === true;
    const textBytes = Buffer.byteLength(raw, "utf8");
    if (textBytes > MIMO_TTS_MAX_TEXT_BYTES) return null;
    this.synthesizeCalls += 1;

    // Singing mode requires the (唱歌) tag at the very start of the text.
    const content = sing && !raw.startsWith(SINGING_TAG) ? `${SINGING_TAG}${raw}` : raw;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "user", content: "请用自然、清晰的语音合成下面的文本。" },
            { role: "assistant", content },
          ],
          audio: { format, voice },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean") return null;
      if (!response.ok) return null;
      const data = await response.json();
      const audioData = data?.choices?.[0]?.message?.audio?.data;
      if (typeof audioData !== "string" || !audioData) return null;
      const audio = Buffer.from(audioData, "base64");
      if (!audio.length) return null;
      return {
        audio,
        format,
        sing,
        text: content,
        model: this.model,
        voice,
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
