import { createMockDevices } from '../mocks/devices.js?v=20260806-8';

export const STORAGE_KEY = 'breathForestUiV2';

function readStoredState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

function createMessage(role, text, details = {}) {
  return {
    id: crypto.randomUUID?.() || `msg-${Date.now()}-${Math.random()}`,
    role,
    content: text,
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...details
  };
}

const stored = readStoredState();

export const state = {
  view: 'intro',
  loggedIn: false,
  tab: 'home',
  deviceView: stored.deviceView === 'grid' ? 'grid' : 'list',
  devices: createMockDevices(),
  messages: [createMessage('assistant', '你好，我是 Luna。正在连接本地后端；连接失败时会明确切换为本地 UI Mock。', {
    responseType: 'chat',
    sourceMode: 'ui_mock'
  })],
  connection: {
    status: 'connecting',
    mode: 'ui_mock',
    label: '正在连接本地后端'
  },
  realtime: { available: false },
  activeTask: null,
  profile: {
    name: stored.profile?.name || '林知夏',
    home: stored.profile?.home || '我的家',
    city: stored.profile?.city || '杭州',
    reminder: stored.profile?.reminder === '关闭' ? '关闭' : '开启',
    avatar: stored.profile?.avatar || ''
  },
  logs: Array.isArray(stored.logs) ? stored.logs.slice(0, 100) : [
    { time: '10:00', type: 'ai', text: 'UI Mock 已准备就绪。' },
    { time: '09:25', type: 'manual', text: '当前所有设备操作仅保存在本地。' }
  ],
  isStreaming: false
};

export function addMessage(role, content, details = {}) {
  const message = createMessage(role, content, details);
  state.messages.push(message);
  state.messages = state.messages.slice(-100);
  return message;
}

export function addLog(type, text) {
  state.logs.unshift({
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    type,
    text
  });
  state.logs = state.logs.slice(0, 100);
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    deviceView: state.deviceView,
    profile: state.profile,
    logs: state.logs
  }));
}
