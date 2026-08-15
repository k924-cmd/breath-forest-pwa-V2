// Admin gate backed by the backend. Credentials no longer live in this file:
// login calls the backend /v1/auth/login, which verifies against an SCrypt hash
// and returns a session token. The token is kept in sessionStorage so a refresh
// keeps you signed in but closing the tab logs out.

import { getApiBaseUrl, getApiKeyHeader, getSessionToken, ADMIN_SESSION_KEY } from '../services/conversation-service.js?v=20260808-13';

const REQUEST_TIMEOUT_MS = 10000;

export { getSessionToken };

export async function login(username, password) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getApiKeyHeader() },
      body: JSON.stringify({ username: String(username ?? ''), password: String(password ?? '') }),
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload && typeof payload.message === 'string' ? payload.message : '登录失败，请稍后再试';
      return { ok: false, error: message };
    }
    if (typeof payload?.token !== 'string' || !payload.token) {
      return { ok: false, error: '登录响应异常，请重试' };
    }
    try {
      sessionStorage.setItem(ADMIN_SESSION_KEY, payload.token);
    } catch {
      // sessionStorage unavailable — token stays in memory for this session.
    }
    return { ok: true, token: payload.token };
  } catch {
    return { ok: false, error: '无法连接后端服务，请确认服务已启动' };
  } finally {
    clearTimeout(timeout);
  }
}

export function isLoggedIn() {
  return Boolean(getSessionToken());
}

export async function logout() {
  const token = getSessionToken();
  try {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    // ignore
  }
  if (!token) return;
  try {
    await fetch(`${getApiBaseUrl()}/auth/logout`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
  } catch {
    // best-effort: server session will expire on its own
  }
}
