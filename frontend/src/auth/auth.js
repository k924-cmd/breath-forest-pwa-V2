// Session-scoped admin gate. Credentials live here (initial admin account),
// and the session is kept in sessionStorage so a refresh keeps you signed in
// but closing the tab logs out.

const SESSION_KEY = 'breathForestAdminSessionV2';
export const ADMIN_CREDENTIALS = Object.freeze({ username: 'admin', password: '123' });

export function login(username, password) {
  if (String(username ?? '').trim() !== ADMIN_CREDENTIALS.username) {
    return { ok: false, error: '账号不存在' };
  }
  if (String(password ?? '') !== ADMIN_CREDENTIALS.password) {
    return { ok: false, error: '密码不正确' };
  }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ signedInAt: new Date().toISOString() }));
  } catch {
    // sessionStorage unavailable — treat as signed in for this session only.
  }
  return { ok: true };
}

export function isLoggedIn() {
  try {
    return Boolean(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return false;
  }
}

export function logout() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}
