import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from './conversation-service.js?v=20260808-13';

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
