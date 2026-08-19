import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from './conversation-service.js?v=20260808-16';

const REQUEST_TIMEOUT_MS = 5000;

export const FALLBACK_WEATHER = Object.freeze({ available: false, temp: '26', condition: '晴', icon: 'sun' });

export async function fetchWeather(city, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { ...FALLBACK_WEATHER };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = typeof city === 'string' && city.trim() ? encodeURIComponent(city.trim()) : encodeURIComponent('杭州');
    const response = await fetchImpl(`${getApiBaseUrl()}/weather?city=${query}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...getApiKeyHeader(), ...getAuthHeader() }
    });
    if (!response || !response.ok) return { ...FALLBACK_WEATHER };
    const payload = await response.json();
    if (!payload || payload.available !== true) return { ...FALLBACK_WEATHER };
    return {
      available: true,
      city: payload.city || city,
      temp: payload.temp || '26',
      condition: payload.condition || '晴',
      icon: payload.icon || 'sun',
      observedAt: payload.observedAt
    };
  } catch {
    return { ...FALLBACK_WEATHER };
  } finally {
    clearTimeout(timeout);
  }
}
