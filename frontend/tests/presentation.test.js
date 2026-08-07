import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPage } from '../src/pages/chat.js';
import { devicesPage } from '../src/pages/devices.js';
import { homePage } from '../src/pages/home.js';
import { profilePage } from '../src/pages/profile.js';
import { GENERAL_DISCLAIMER, getReceiptPresentation, getSourceLabel, getTaskPresentation, MEDICAL_DISCLAIMER, splitDisclaimerContent } from '../src/presentation.js';
import { createMockDevices } from '../src/mocks/devices.js';

const state = {
  tab: 'home',
  deviceView: 'list',
  devices: createMockDevices(),
  messages: [],
  connection: { status: 'disconnected', mode: 'ui_mock' },
  activeTask: null,
  isStreaming: false,
  profile: { name: '测试用户', home: '测试家庭', reminder: '开启', avatar: '', city: '杭州' }
};

test('四页面均显示后端断开边界，快捷场景不映射后端任务', () => {
  const environment = { score: 84, status: '空气良好', pm25: 12, co2: 650, humidity: 60, temperature: 26, source: 'mock', observedAt: '2026-08-03T00:00:00.000Z' };
  assert.match(homePage(state, environment), /本地 UI Mock \/ 未连接后端/);
  assert.match(homePage(state, environment), /实时情况 · 本地模拟/);
  assert.match(homePage(state, environment), /home-cards/);
  assert.doesNotMatch(homePage(state, environment), /home-nav-card/);
  assert.match(homePage(state, environment), /home-weather/);
  assert.match(homePage(state, environment), /26℃/);
  assert.match(homePage(state, environment), /清新自在/);
  assert.match(homePage(state, environment), /weather-city/);
  assert.match(devicesPage({ ...state, tab: 'devices' }), /本地 UI Mock \/ 未连接后端/);
  assert.match(devicesPage({ ...state, tab: 'devices' }), /device-dot/);
  assert.match(chatPage({ ...state, tab: 'chat' }), /本地 UI Mock \/ 未连接后端/);
  assert.match(profilePage({ ...state, tab: 'profile' }), /本地 UI Mock \/ 未连接后端/);
});

test('设备卡片按接入状态排序：已接入在前、未接入在后', () => {
  const statuses = state.devices.map(d => d.connectionStatus);
  assert.equal(statuses.includes('online'), true);
  assert.equal(statuses.includes('unavailable'), true);
  const firstUnavailable = statuses.indexOf('unavailable');
  const afterUnavailable = statuses.slice(firstUnavailable).every(s => s !== 'online');
  assert.equal(afterUnavailable, true);
});

test('任务状态以不同文字和图标呈现', () => {
  const presentations = ['scheduled', 'running', 'paused', 'stopped', 'failed'].map(getTaskPresentation);
  assert.deepEqual(presentations.map(item => item.label), ['待运行', '运行中', '已暂停', '已停止', '失败']);
  assert.equal(new Set(presentations.map(item => item.icon)).size, 5);
});

test('部分成功回执具有独立文案和图标', () => {
  const partial = getReceiptPresentation('partial_success');
  assert.equal(partial.label, '部分成功');
  assert.equal(partial.icon, '◐');
});

test('model 来源显示为模型标识，Mock 降级不冒充模型', () => {
  assert.equal(getSourceLabel('model'), '模型');
  assert.equal(getSourceLabel('mock'), 'Mock');
});

test('DEP-003 免责声明拆分为统一展示块且顺序保留', () => {
  const result = splitDisclaimerContent(`回答。${GENERAL_DISCLAIMER}${MEDICAL_DISCLAIMER}`);
  assert.equal(result.main, '回答。');
  assert.deepEqual(result.items.map(item => item.kind), ['general', 'medical']);
});

test('DEP-003 无免责句时不改变原文本', () => {
  const result = splitDisclaimerContent('普通回答');
  assert.equal(result.main, '普通回答');
  assert.deepEqual(result.items, []);
});
