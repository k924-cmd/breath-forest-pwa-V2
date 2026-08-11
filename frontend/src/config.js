// 部署配置单一来源。发布到任意平台时，只需要在这里改 API_BASE_URL 与 API_KEY。
//   - 本地开发（localhost / 127.0.0.1）：留空，自动回退到 http://127.0.0.1:8787/v1。
//   - GitHub Pages / 公网浏览器：构建前把 API_BASE_URL 填成你的后端地址。
//   - Capacitor（安卓 APK / iOS 原生壳）：构建前把 API_BASE_URL 填成公网隧道地址，
//     并确认不为空——Capacitor 里 hostname 是 capacitor:// 或 localhost，绝不能回退到
//     127.0.0.1（那是设备自身，不是服务器）。
//
// 兼容旧部署：若 window.__API_BASE__ / window.__API_KEY__ 存在（index.html 内联注入），
// 优先读取它们；没有则用下面的常量。

const API_BASE_URL = 'https://thru-fresh-lightning-clinic.trycloudflare.com/v1'; // 例：'https://backend.你的域名.com/v1'；留空 = 本地默认
const API_KEY = 'a1c8f8037ba7ec18b698d748ec4d90cdaaa616429875ea9d3900ce049144fbfe';      // 例：'xJ0v...'；留空 = 不发送 X-Api-Key

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8787/v1';
const DEFAULT_API_KEY = '';

const isCapacitor = typeof globalThis !== 'undefined'
  && typeof globalThis.Capacitor !== 'undefined'
  && typeof globalThis.Capacitor.isNativePlatform === 'function'
  && globalThis.Capacitor.isNativePlatform();

function injected(key) {
  if (typeof globalThis === 'undefined' || !globalThis.window) return '';
  const value = globalThis.window[key];
  return typeof value === 'string' ? value : '';
}

export function getApiBaseUrl() {
  const fromInjection = injected('__API_BASE__');
  if (isCapacitor) {
    // 原生壳必须用打包时指定的公网地址；任何回退到 127.0.0.1 都是连设备自身。
    return API_BASE_URL || fromInjection || DEFAULT_API_BASE_URL;
  }
  return API_BASE_URL || fromInjection || DEFAULT_API_BASE_URL;
}

export function getApiKey() {
  return API_KEY || injected('__API_KEY__') || DEFAULT_API_KEY;
}

export function getSessionToken() {
  try {
    return (globalThis.window && globalThis.window.sessionStorage.getItem(ADMIN_SESSION_KEY)) || '';
  } catch {
    return '';
  }
}

export function getApiKeyHeader() {
  const key = getApiKey();
  return key ? { 'X-Api-Key': key } : {};
}

export function getAuthHeader() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const CONTRACT_VERSION = '1.0.0';
export const CONVERSATION_STORAGE_KEY = 'breathForestConversationIdV1';
export const ADMIN_SESSION_KEY = 'breathForestAdminSessionV3';