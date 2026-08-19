import { getMockReply } from '../mocks/conversation.js?v=20260808-16';
import {
  getApiBaseUrl,
  getApiKeyHeader,
  getAuthHeader,
  getSessionToken,
  CONTRACT_VERSION,
  ADMIN_SESSION_KEY,
  CONVERSATION_STORAGE_KEY,
} from '../config.js?v=20260808-16';

export { getApiBaseUrl, getApiKeyHeader, getAuthHeader, getSessionToken, CONTRACT_VERSION, ADMIN_SESSION_KEY, CONVERSATION_STORAGE_KEY };
const REQUEST_TIMEOUT_MS = 15000;

function createId(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function getStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function getConversationId(storage) {
  const target = getStorage(storage);
  try {
    const saved = target?.getItem(CONVERSATION_STORAGE_KEY);
    if (saved) return saved;
    const created = createId('conversation');
    target?.setItem(CONVERSATION_STORAGE_KEY, created);
    return created;
  } catch {
    return createId('conversation');
  }
}

function getLocale() {
  const candidate = globalThis.navigator?.language || 'zh-CN';
  return /^[a-z]{2,3}(-[A-Z]{2})?$/.test(candidate) ? candidate : 'zh-CN';
}

function getTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function createSendMessageRequest(message, options = {}) {
  const clientMessageId = options.clientMessageId || createId('client-message');
  const request = {
    contractVersion: CONTRACT_VERSION,
    conversationId: options.conversationId || getConversationId(options.storage),
    clientMessageId,
    idempotencyKey: options.idempotencyKey || `idempotency-${clientMessageId}`,
    message: String(message).trim(),
    locale: options.locale || getLocale(),
    timezone: options.timezone || getTimezone()
  };
  if (options.continuation?.type && options.continuation?.id) {
    request.continuation = {
      type: options.continuation.type,
      id: options.continuation.id
    };
  }
  const city = typeof options.city === 'string' ? options.city.trim() : '';
  if (city) request.city = city;
  return request;
}

async function fetchJson(path, init = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${getApiBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...getApiKeyHeader(),
        ...getAuthHeader(),
        ...(init.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...init.headers
      }
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error('INVALID_JSON_RESPONSE');
    }
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadBackendSnapshot(options = {}) {
  const healthResult = await fetchJson('/health', {}, options.fetchImpl);
  if (!healthResult.response.ok
    || healthResult.payload?.status !== 'ok'
    || healthResult.payload?.contractVersion !== CONTRACT_VERSION
    || healthResult.payload?.mode !== 'local_mock') {
    throw new Error('HEALTH_UNAVAILABLE');
  }
  const bootstrapResult = await fetchJson('/bootstrap', {}, options.fetchImpl);
  const bootstrap = bootstrapResult.payload;
  if (!bootstrapResult.response.ok
    || bootstrap?.contractVersion !== CONTRACT_VERSION
    || bootstrap?.mode !== 'local_mock'
    || !Array.isArray(bootstrap?.devices)) {
    throw new Error('BOOTSTRAP_INVALID');
  }
  return { health: healthResult.payload, bootstrap };
}

function createTransportError(payload, request, status) {
  const publicError = payload?.error || payload || {};
  const code = typeof publicError.code === 'string' ? publicError.code : 'SERVICE_UNAVAILABLE';
  const message = typeof publicError.message === 'string'
    ? publicError.message
    : `本地后端拒绝了请求（HTTP ${status}）。`;
  const requestId = publicError.requestId || createId('frontend-error');
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    conversationId: request.conversationId,
    message: {
      id: createId('assistant-message'),
      role: 'assistant',
      content: message,
      status: 'error',
      createdAt: new Date().toISOString()
    },
    responseType: 'error',
    sources: [],
    error: {
      code,
      message,
      retryable: Boolean(publicError.retryable),
      requestId
    },
    transportMode: 'backend'
  };
}

async function createUiMockFallback(message, request) {
  const content = await getMockReply(message);
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: createId('ui-mock-request'),
    conversationId: request.conversationId,
    message: {
      id: createId('ui-mock-message'),
      role: 'assistant',
      content: `本地 UI Mock / 未连接后端：${content}`,
      status: 'complete',
      createdAt: new Date().toISOString()
    },
    responseType: 'chat',
    sources: [{ type: 'mock', observedAt: new Date().toISOString(), referenceId: 'frontend-ui-mock' }],
    transportMode: 'ui_mock'
  };
}

export async function sendConversationMessage(message, options = {}) {
  const request = createSendMessageRequest(message, options);
  try {
    const { response, payload } = await fetchJson('/conversations/messages', {
      method: 'POST',
      body: JSON.stringify(request)
    }, options.fetchImpl);
    if (!response.ok) {
      if (response.status === 503) return createUiMockFallback(message, request);
      return createTransportError(payload, request, response.status);
    }
    if (payload?.contractVersion !== CONTRACT_VERSION
      || payload?.conversationId !== request.conversationId
      || typeof payload?.message?.content !== 'string'
      || typeof payload?.responseType !== 'string') {
      throw new Error('CONTRACT_RESPONSE_INVALID');
    }
    return { ...payload, transportMode: 'backend' };
  } catch {
    return createUiMockFallback(message, request);
  }
}

export async function deleteMessages(messageIds, options = {}) {
  const ids = Array.isArray(messageIds) ? messageIds : [];
  const conversationId = options.conversationId || getConversationId(options.storage);
  const { response, payload } = await fetchJson(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'DELETE',
    body: JSON.stringify({ messageIds: ids })
  }, options.fetchImpl);
  if (!response.ok) throw new Error('DELETE_FAILED');
  return payload;
}
