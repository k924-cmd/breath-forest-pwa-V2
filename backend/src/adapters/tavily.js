// Real-time search adapter backed by the Tavily API, mirroring the safety
// posture of deepseek.js. The Tavily key is read from local configuration,
// never logged, emitted, or included in errors. Any failure — adapter
// unavailable, network error, timeout, unparsable response — degrades to a
// null result so the caller can keep the existing rejection path; it never
// throws and never leaks the key.

import { fileURLToPath } from "node:url";
import { loadDotEnvIfPresent } from "../config/env.js";

export const TAVILY_DEFAULT_ENDPOINT = "https://api.tavily.com/search";
export const TAVILY_TIMEOUT_MS_CAP = 10_000;
export const TAVILY_MAX_RESULTS_DEFAULT = 3;
export const TAVILY_MAX_RESULTS_CAP = 5;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function parseEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export class TavilySearchAdapter {
  constructor(options = {}) {
    loadDotEnvIfPresent(fileURLToPath(new URL("../../.env", import.meta.url)));
    this.endpoint = (options.endpoint ?? process.env.TAVILY_ENDPOINT ?? TAVILY_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.TAVILY_API_KEY ?? "";
    this.maxResults = clampInteger(options.maxResults ?? process.env.TAVILY_MAX_RESULTS, TAVILY_MAX_RESULTS_DEFAULT, 1, TAVILY_MAX_RESULTS_CAP);
    this.timeoutMs = clampInteger(options.timeoutMs ?? process.env.TAVILY_TIMEOUT_MS, TAVILY_TIMEOUT_MS_CAP, 1_000, TAVILY_TIMEOUT_MS_CAP);
    this.enabled = options.enabled ?? parseEnabled(process.env.TAVILY_ENABLED);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.referenceId = options.referenceId ?? "tavily";
    this.searchCalls = 0;
  }

  get available() {
    return this.enabled === true && typeof this.apiKey === "string" && this.apiKey.length > 0 && typeof this.fetchImpl === "function";
  }

  async search(query, options = {}) {
    if (!this.available) return null;
    const userQuery = typeof query === "string" ? query.trim() : "";
    if (!userQuery) return null;
    const maxResults = clampInteger(options.maxResults ?? this.maxResults, this.maxResults, 1, TAVILY_MAX_RESULTS_CAP);
    this.searchCalls += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: userQuery,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: true,
        }),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean") return null;
      if (!response.ok) return null;
      const data = await response.json();
      const answer = typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : "";
      const results = Array.isArray(data?.results) ? data.results.slice(0, maxResults).map((item) => ({
        title: typeof item?.title === "string" ? item.title : "",
        url: typeof item?.url === "string" ? item.url : "",
        content: typeof item?.content === "string" ? item.content : "",
      })).filter((item) => item.title || item.url || item.content) : [];
      return {
        answer,
        results,
        query: userQuery,
        source: "real_time",
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
