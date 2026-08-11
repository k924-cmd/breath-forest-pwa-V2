import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from './conversation-service.js?v=20260808-7';

const REQUEST_TIMEOUT_MS = 30000;

export const EASTER_ERRORS = Object.freeze({
  REQUEST_FAILED: '唱歌彩蛋暂不可用，请稍后再试',
  INVALID_RESPONSE: '唱歌彩蛋返回异常，请重试'
});

export async function runSingingEasterEgg(text, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { available: false, error: EASTER_ERRORS.REQUEST_FAILED };
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { available: false, error: EASTER_ERRORS.REQUEST_FAILED };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${getApiBaseUrl()}/tts/easter-egg`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getApiKeyHeader(), ...getAuthHeader() },
      body: JSON.stringify({ text: trimmed }),
      signal: controller.signal
    });
    if (!response || !response.ok) return { available: false, error: EASTER_ERRORS.REQUEST_FAILED };
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return { available: false, error: EASTER_ERRORS.INVALID_RESPONSE };
    }
    if (payload?.available !== true) return { available: false, error: null, reason: payload?.reason ?? 'not_singing' };
    const audio = typeof payload.audio === 'string' ? payload.audio : '';
    const continuation = typeof payload.continuation === 'string' ? payload.continuation : '';
    if (!audio || !continuation) return { available: false, error: EASTER_ERRORS.INVALID_RESPONSE };
    return {
      available: true,
      error: null,
      songName: typeof payload.songName === 'string' ? payload.songName : null,
      continuation,
      replyText: typeof payload.replyText === 'string' ? payload.replyText : continuation,
      format: typeof payload.format === 'string' ? payload.format : 'wav',
      voice: typeof payload.voice === 'string' ? payload.voice : null,
      audioBase64: audio
    };
  } catch {
    return { available: false, error: EASTER_ERRORS.REQUEST_FAILED };
  } finally {
    clearTimeout(timeout);
  }
}
