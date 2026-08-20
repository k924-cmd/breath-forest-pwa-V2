import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from './conversation-service.js?v=20260808-20';

const REQUEST_TIMEOUT_MS = 30000;

export async function synthesizeSpeech(text, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${getApiBaseUrl()}/tts/speak`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getApiKeyHeader(), ...getAuthHeader() },
      body: JSON.stringify({ text: trimmed }),
      signal: controller.signal
    });
    if (!response || !response.ok) return null;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (payload?.available !== true || typeof payload.audio !== 'string' || !payload.audio) return null;
    return {
      available: true,
      audioBase64: payload.audio,
      format: typeof payload.format === 'string' ? payload.format : 'wav',
      voice: typeof payload.voice === 'string' ? payload.voice : null
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// 流式播报：POST /v1/tts/stream（SSE），逐句回调 onChunk({audioBase64, format, done, failed})。
// 返回 true 表示流开始；解析出错/非 2xx 时返回 null。
export async function synthesizeSpeechStream(text, { onChunk, fetchImpl } = {}) {
  const fetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetch !== 'function') return null;
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getApiBaseUrl()}/tts/stream`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...getApiKeyHeader(), ...getAuthHeader() },
      body: JSON.stringify({ text: trimmed }),
      signal: controller.signal
    });
    if (!response || !response.ok) return null;
    if (!response.body || typeof response.body.getReader !== 'function') return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // SSE 解析：只认 data: 行；一行可能被 TCP 分片，按换行累积。
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const chunk = JSON.parse(data);
          onChunk?.(chunk);
        } catch {
          // 非 JSON 行忽略
        }
      }
    }
    return true;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
