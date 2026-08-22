import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from './conversation-service.js?v=20260822-4';

const REQUEST_TIMEOUT_MS = 30000;

export const ASR_ERRORS = Object.freeze({
  NO_AUDIO: '未录制到有效音频',
  REQUEST_FAILED: '语音识别服务暂不可用，请稍后再试',
  EMPTY_RESULT: '未识别到语音，请重试',
  INVALID_RESPONSE: '语音识别返回异常，请重试'
});

export async function transcribeAudio(blob, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { text: null, error: ASR_ERRORS.REQUEST_FAILED };
  if (!blob || typeof blob.arrayBuffer !== 'function' || blob.size === 0) {
    return { text: null, error: ASR_ERRORS.NO_AUDIO };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${getApiBaseUrl()}/asr`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': blob.type || 'audio/webm', ...getApiKeyHeader(), ...getAuthHeader() },
      body: blob,
      signal: controller.signal
    });
    if (!response || !response.ok) return { text: null, error: ASR_ERRORS.REQUEST_FAILED };
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return { text: null, error: ASR_ERRORS.INVALID_RESPONSE };
    }
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) return { text: null, error: ASR_ERRORS.EMPTY_RESULT };
    return { text, error: null };
  } catch {
    return { text: null, error: ASR_ERRORS.REQUEST_FAILED };
  } finally {
    clearTimeout(timeout);
  }
}
