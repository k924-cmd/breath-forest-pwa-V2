import test from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE_URL } from '../src/services/conversation-service.js';
import { fetchWeather, FALLBACK_WEATHER } from '../src/services/weather-service.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

test('fetchWeather 请求 /v1/weather 并携带城市参数', async () => {
  let capturedUrl = null;
  const payload = { available: true, city: '杭州', temp: '32', condition: '雨', icon: 'rain', observedAt: '2026-08-06T00:00:00.000Z' };
  const result = await fetchWeather('杭州', async (url) => {
    capturedUrl = url;
    return jsonResponse(payload);
  });
  assert.equal(capturedUrl, `${API_BASE_URL}/weather?city=${encodeURIComponent('杭州')}`);
  assert.equal(result.available, true);
  assert.equal(result.temp, '32');
  assert.equal(result.condition, '雨');
  assert.equal(result.icon, 'rain');
});

test('fetchWeather 服务端不可用时降级为默认天气', async () => {
  const result = await fetchWeather('杭州', async () => jsonResponse({ code: 'ERR' }, 503));
  assert.equal(result.available, false);
  assert.equal(result.temp, FALLBACK_WEATHER.temp);
  assert.equal(result.condition, FALLBACK_WEATHER.condition);
  assert.equal(result.icon, FALLBACK_WEATHER.icon);
});

test('fetchWeather 网络异常时降级为默认天气', async () => {
  const result = await fetchWeather('杭州', async () => { throw new Error('network'); });
  assert.equal(result.available, false);
  assert.equal(result.temp, '26');
});

test('fetchWeather 响应缺 available:true 时降级', async () => {
  const result = await fetchWeather('杭州', async () => jsonResponse({ available: false, reason: 'realtime_unavailable' }));
  assert.equal(result.available, false);
});
