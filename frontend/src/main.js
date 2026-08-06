import { state, addLog, addMessage, saveState } from './app/state.js?v=20260806-9';
import { icon } from './components/icons.js?v=20260806-9';
import { homePage } from './pages/home.js?v=20260806-9';
import { devicesPage } from './pages/devices.js?v=20260806-9';
import { chatPage } from './pages/chat.js?v=20260806-9';
import { profilePage } from './pages/profile.js?v=20260806-9';
import { introPage, INTRO_SLOGAN, INTRO_SUBTITLE } from './components/intro.js?v=20260806-9';
import { loginPage } from './components/login.js?v=20260806-9';
import { login, isLoggedIn } from './auth/auth.js?v=20260806-9';
import { loadBackendSnapshot, sendConversationMessage } from './services/conversation-service.js?v=20260806-9';
import { fetchWeather } from './services/weather-service.js?v=20260806-9';
import { toggleMockDevice } from './services/device-service.js?v=20260806-9';
import { getEnvironmentSnapshot } from './services/environment-service.js?v=20260806-9';
import { createMockDevices, findDevice, getDeviceMeta, normalizeBackendDevices } from './mocks/devices.js?v=20260806-9';
import { escapeHtml } from './utils/html.js?v=20260806-9';
import { messageSignature, structuredMessageHtml } from './components/message-cards.js?v=20260806-9';
import {
  formatObservedAt,
  getDeviceStateLabel,
  getSourceLabel
} from './presentation.js?v=20260806-9';

const root = document.querySelector('#app');
let environment = await getEnvironmentSnapshot();
let activeDeviceId = null;
let weather = null;

function tabs() {
  return `<nav class="tabs"><button class="tabs-devices" data-tab="devices">全部设备 <small>›</small></button><div class="tabs-grid">${[
    ['home', 'home', '首页'], ['devices', 'devices', '设备'], ['chat', 'chat', 'AI 对话'], ['profile', 'user', '我的']
  ].map(([id, glyph, label]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div></nav>`;
}

function logsModal() {
  return `<div class="modal"><section class="log-sheet"><header><div><span class="eyebrow">ACTIVITY HISTORY</span><h2>前端状态日志</h2></div><button data-action="close">×</button></header><div class="log-list">${state.logs.map(log => `<article><i class="${escapeHtml(log.type)}"></i><div><span>${escapeHtml(log.time)} · ${log.type === 'ai' ? '联调状态' : '本地操作'}</span><b>${escapeHtml(log.text)}</b></div></article>`).join('')}</div></section></div>`;
}

function profileModal() {
  const avatar = state.profile.avatar ? `<img src="${state.profile.avatar}" alt="头像">` : icon('user');
  return `<div class="modal"><form class="profile-sheet" id="profile-form" data-avatar="${state.profile.avatar}"><header><div><span class="eyebrow">PERSONAL SPACE</span><h2>编辑资料</h2></div><button type="button" data-action="close">×</button></header><label class="avatar-picker"><span id="avatar-preview">${avatar}</span><b>更换头像</b><input id="avatar-input" type="file" accept="image/*"></label><label>昵称<input name="name" value="${escapeHtml(state.profile.name)}" maxlength="12"></label><label>家庭名称<input name="home" value="${escapeHtml(state.profile.home)}" maxlength="16"></label><label>所在城市<input name="city" value="${escapeHtml(state.profile.city)}" maxlength="16"></label><label>空气提醒<select name="reminder"><option ${state.profile.reminder === '开启' ? 'selected' : ''}>开启</option><option ${state.profile.reminder === '关闭' ? 'selected' : ''}>关闭</option></select></label><button class="save-profile" type="submit">保存资料</button></form></div>`;
}

function detailModal(kind) {
  const details = {
    home: ['家庭空间', state.profile.home, '个人资料保存在本机；设备、环境和任务仅在连接后采用后端快照。'],
    notice: ['通知提醒', `空气提醒已${state.profile.reminder}`, '通知能力尚未接入后端。'],
    energy: ['我的能量树', '当前为演示数据', '节能和碳减排数字不代表真实统计结果。'],
    about: ['关于呼吸森林', 'AI 小助手 V1 联调', '当前仅连接本地 Mock 后端，不连接真实模型、第三方服务或真实设备。']
  };
  const [title, headline, copy] = details[kind];
  return `<div class="modal"><section class="detail-sheet"><button data-action="close">×</button><span>${icon(kind === 'energy' ? 'leaf' : kind === 'notice' ? 'chat' : kind === 'home' ? 'home' : 'spark')}</span><h2>${title}</h2><b>${escapeHtml(headline)}</b><p>${copy}</p></section></div>`;
}

function deviceDetailModal(deviceId) {
  const device = findDevice(deviceId, state.devices);
  if (!device) return '';
  const meta = getDeviceMeta(device);
  const localInteractive = state.connection.status !== 'connected' && device.controlSupport === 'supported';
  const source = getSourceLabel(device.source);
  const connection = device.connectionStatus === 'online' ? '在线' : device.connectionStatus === 'offline' ? '离线' : '不可用';
  const support = device.controlSupport === 'supported' ? 'V1 支持' : device.controlSupport === 'read_only' ? '只读' : '待接入';
  return `<div class="modal device-detail-modal"><section class="device-detail-sheet" role="dialog" aria-modal="true"><header><span class="device-detail-icon">${icon(meta.icon)}</span><div><span class="eyebrow">${escapeHtml(device.room.toUpperCase())} DEVICE</span><h2>${escapeHtml(device.name)}</h2><span class="connection-pill ${device.connectionStatus === 'online' ? 'connected' : ''}">${source} · ${connection}</span></div><button data-action="close" aria-label="关闭设备详情">×</button></header><p class="device-detail-copy">${state.connection.status === 'connected' ? '这是本地后端返回的可信 Mock 快照。设备控制请通过 AI 对话进入策略与回执链路。' : '这是本地 UI Mock，仅供浏览器界面演示，不连接后端或真实设备。'}</p><div class="device-detail-grid"><article><span>设备状态</span><b>${getDeviceStateLabel(device.state)}</b></article><article><span>数据来源</span><b>${source}</b></article><article><span>连接状态</span><b>${connection}</b></article><article><span>控制能力</span><b>${support}</b></article></div><div class="device-constraint-panel"><span class="constraint-chip">${state.connection.status === 'connected' ? '后端快照' : 'UI Mock'}</span><div><span>观测时间</span><b>${formatObservedAt(device.observedAt)}</b></div></div>${localInteractive ? `<div class="device-detail-actions"><button data-device-action="toggle" data-device-id="${escapeHtml(device.id)}">切换本地演示状态</button></div>` : '<div class="device-unavailable-note">当前页面不直接创建或映射后端任务。</div>'}</section></div>`;
}

const renderedMessageSignatures = new Map();

function loadLottie(container, path, { loop = true, autoplay = true } = {}) {
  if (!container || container.dataset.lottieReady === 'true') return;
  const lottie = window.lottie;
  if (!lottie || typeof lottie.loadAnimation !== 'function') {
    container.classList.add('lottie-fallback');
    container.dataset.lottieReady = 'true';
    return;
  }
  container.dataset.lottieReady = 'true';
  lottie.loadAnimation({
    container,
    renderer: 'svg',
    loop,
    autoplay,
    path
  });
}

function initIntroLottie() {
  const container = document.querySelector('#intro-stage');
  if (container) loadLottie(container, 'assets/start-robot.json', { loop: false, autoplay: true });
}

function initHomeLottie() {
  const container = document.querySelector('#lottie-stage');
  if (container) loadLottie(container, 'assets/start-robot.json');
}

function initNoteLottie() {
  const container = document.querySelector('#note-lottie');
  if (container) loadLottie(container, 'assets/ai-flow.json');
}

function renderMessages() {
  const container = document.querySelector('.messages');
  if (!container) return;
  const messages = state.messages;
  if (container.childElementCount === 0) {
    container.innerHTML = messages.map(message => structuredMessageHtml(message, state.devices)).join('');
    renderedMessageSignatures.clear();
    for (const message of messages) renderedMessageSignatures.set(message.id, messageSignature(message));
    return;
  }
  const children = Array.from(container.children);
  const nextSignatures = new Map();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const signature = messageSignature(message);
    const element = children[index];
    if (element?.dataset.messageId === message.id && renderedMessageSignatures.get(message.id) === signature) {
      nextSignatures.set(message.id, signature);
      continue;
    }
    const fragment = document.createRange().createContextualFragment(messages.slice(index).map(item => structuredMessageHtml(item, state.devices)).join(''));
    if (element) {
      const stale = [];
      let sibling = element.nextSibling;
      while (sibling) {
        stale.push(sibling);
        sibling = sibling.nextSibling;
      }
      element.replaceWith(fragment);
      stale.forEach(node => node.remove());
    } else {
      container.appendChild(fragment);
    }
    for (const item of messages.slice(index)) nextSignatures.set(item.id, messageSignature(item));
    break;
  }
  renderedMessageSignatures.clear();
  for (const [id, signature] of nextSignatures) renderedMessageSignatures.set(id, signature);
}

function render() {
  if (state.view === 'intro') {
    root.innerHTML = introPage();
    bind();
    initIntroLottie();
    return;
  }
  if (state.view === 'login') {
    root.innerHTML = loginPage();
    bind();
    return;
  }
  root.innerHTML = `<main class="app ${state.tab === 'home' ? 'home-mode' : ''} ${state.tab === 'chat' ? 'chat-mode' : ''}">${homePage(state, environment, state.realtime, weather)}${devicesPage(state)}${chatPage(state)}${profilePage(state)}</main>${tabs()}<div id="toast" class="toast"></div><div id="modal-root"></div><div id="effect-root"></div>`;
  renderMessages();
  bind();
  initHomeLottie();
  initNoteLottie();
  if (activeDeviceId) openDeviceDetail(activeDeviceId);
  if (state.tab === 'chat') requestAnimationFrame(() => scrollChat(true));
}

function toast(text) {
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = text;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2200);
}

function scrollChat(force = false) {
  const messages = document.querySelector('.messages');
  if (!messages) return;
  const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  if (force || distance < 80) messages.scrollTop = messages.scrollHeight;
}

function openDeviceDetail(deviceId) {
  activeDeviceId = deviceId;
  const modalRoot = document.querySelector('#modal-root');
  modalRoot.innerHTML = deviceDetailModal(deviceId);
  bindModal();
}

async function useUiMockSnapshot() {
  state.connection = { status: 'disconnected', mode: 'ui_mock', label: '本地 UI Mock / 未连接后端' };
  state.devices = createMockDevices();
  state.activeTask = null;
  state.realtime = { available: false };
  environment = await getEnvironmentSnapshot();
  const intro = state.messages[0];
  if (intro?.role === 'assistant') {
    intro.content = '你好，我是 Luna。当前为本地 UI Mock / 未连接后端，不会把浏览器旧状态当作后端事实。';
    intro.sourceMode = 'ui_mock';
    intro.sources = [];
  }
}

async function connectBackend({ quiet = false } = {}) {
  try {
    const { bootstrap } = await loadBackendSnapshot();
    state.connection = { status: 'connected', mode: bootstrap.mode, label: '已连接本地后端 Mock' };
    state.devices = normalizeBackendDevices(bootstrap.devices);
    environment = bootstrap.environment ? { ...bootstrap.environment, uiMockOnly: false } : null;
    state.activeTask = bootstrap.activeTask;
    state.realtime = bootstrap.realtime || { available: false };
    const intro = state.messages[0];
    if (intro?.role === 'assistant') {
      intro.content = '你好，我是 Luna。已连接本地后端 Mock，设备、环境与任务已从后端快照同步。';
      intro.sourceMode = 'backend';
      intro.sources = [];
    }
    if (!quiet) addLog('ai', '已从本地后端同步设备、环境与活动任务快照。');
  } catch {
    await useUiMockSnapshot();
    if (!quiet) addLog('ai', '后端不可用，已降级为本地 UI Mock；未沿用旧设备或任务状态。');
  }
  saveState();
  render();
  refreshWeather();
}

async function refreshWeather() {
  const city = state.profile?.city || '杭州';
  weather = await fetchWeather(city);
  const home = document.querySelector('.home-weather');
  if (home) render();
}

async function updateDevice(deviceId) {
  const device = findDevice(deviceId, state.devices);
  if (!device || state.connection.status === 'connected') {
    toast('后端快照只读，请通过 AI 对话操作');
    return;
  }
  if (device.controlSupport !== 'supported') {
    toast('该设备仅展示待接入状态');
    return;
  }
  const updated = await toggleMockDevice(device);
  state.devices = state.devices.map(item => item.id === deviceId ? updated : item);
  addLog('manual', `${device.name}本地 UI Mock 已切换为${getDeviceStateLabel(updated.state)}`);
  saveState();
  render();
  toast('仅更新本地 UI Mock');
}

function applyReceipt(receipt) {
  if (!receipt?.actions || state.connection.status !== 'connected') return;
  const states = new Map(receipt.actions.filter(action => action.actualState).map(action => [action.deviceId, action.actualState]));
  state.devices = state.devices.map(device => states.has(device.id)
    ? { ...device, state: states.get(device.id), stateVersion: device.stateVersion + 1, observedAt: receipt.completedAt, source: receipt.source }
    : device);
}

function applyConversationResponse(pending, response) {
  const reply = response.message || {};
  Object.assign(pending, {
    id: reply.id || pending.id,
    content: reply.content || '后端没有返回可展示内容。',
    status: reply.status || 'complete',
    createdAt: reply.createdAt || new Date().toISOString(),
    responseType: response.responseType,
    sources: response.sources || [],
    realtime: response.realtime,
    clarification: response.clarification,
    confirmation: response.confirmation,
    task: response.task,
    receipt: response.receipt,
    error: response.error,
    sourceMode: response.transportMode
  });
  if (response.task) state.activeTask = response.task;
  applyReceipt(response.receipt);
}

function resolveContinuation(continuation, response, submittedText) {
  if (!continuation?.id) return;
  if (continuation.type === 'confirmation') {
    const owner = state.messages.find(message => message.confirmation?.confirmationId === continuation.id);
    if (!owner?.confirmation) return;
    const errorStatus = {
      CONFIRMATION_EXPIRED: 'expired',
      CONFIRMATION_INVALIDATED: 'invalidated',
      CONFIRMATION_NOT_FOUND: 'invalidated'
    }[response.error?.code];
    owner.confirmation.status = errorStatus || (submittedText === '取消' ? 'cancelled' : 'confirmed');
  }
  if (continuation.type === 'clarification') {
    const owner = state.messages.find(message => message.clarification?.clarificationId === continuation.id);
    if (owner?.clarification) owner.clarification.resolved = true;
  }
}

function setStreamingUi(isStreaming) {
  const input = document.querySelector('#chat-input');
  if (input) input.disabled = isStreaming;
  const submit = document.querySelector('#chat-form button[type="submit"]');
  if (submit) submit.disabled = isStreaming;
}

async function sendMessage(text, continuation) {
  if (state.isStreaming) return;
  addMessage('user', text, { continuation });
  const pending = addMessage('assistant', 'Luna 正在整理回复', { responseType: 'chat' });
  pending.status = 'pending';
  state.isStreaming = true;
  setStreamingUi(true);
  renderMessages();
  bind();
  scrollChat(true);
  try {
    const response = await sendConversationMessage(text, { continuation });
    if (response.transportMode === 'ui_mock') {
      await useUiMockSnapshot();
    } else if (state.connection.status !== 'connected') {
      await connectBackend({ quiet: true });
    }
    if (response.transportMode === 'backend') resolveContinuation(continuation, response, text);
    applyConversationResponse(pending, response);
    renderMessages();
    bind();
    scrollChat(true);
  } catch {
    await useUiMockSnapshot();
    pending.content = '本地 UI Mock / 未连接后端：暂时无法生成演示回复，请稍后再试。';
    pending.status = 'error';
    pending.responseType = 'error';
    pending.sourceMode = 'ui_mock';
    renderMessages();
    bind();
    scrollChat(true);
  } finally {
    state.isStreaming = false;
    setStreamingUi(false);
    saveState();
    if (state.tab === 'chat') scrollChat(true);
  }
}

function showSceneEffect(scene) {
  const styles = {
    '回家模式': ['home', '回家模式 · UI Mock', '未创建后端任务'],
    '深呼吸模式': ['breathe', '深呼吸 · UI Mock', '未创建后端任务'],
    '睡眠模式': ['sleep', '静享睡眠 · UI Mock', '未创建后端任务'],
    '低碳模式': ['eco', '低碳模式 · UI Mock', '未创建后端任务']
  };
  const [kind, title, copy] = styles[scene];
  const button = document.querySelector(`.scene-grid button[data-scene="${CSS.escape(scene)}"]`);
  button?.classList.add('glow');
  document.querySelector('#effect-root').innerHTML = `<div class="scene-effect ${kind}"><div><span>${icon(kind === 'sleep' ? 'leaf' : kind === 'eco' ? 'spark' : kind === 'breathe' ? 'wind' : 'home')}</span><b>${title}</b><small>${copy}</small></div></div>`;
  setTimeout(() => { button?.classList.remove('glow'); document.querySelector('#effect-root').innerHTML = ''; }, 1700);
}

function bindModal() {
  document.querySelectorAll('[data-action="close"]').forEach(button => {
    button.onclick = () => { activeDeviceId = null; document.querySelector('#modal-root').innerHTML = ''; };
  });
  document.querySelectorAll('[data-device-action="toggle"]').forEach(button => {
    button.onclick = () => updateDevice(button.dataset.deviceId);
  });
  document.querySelector('#avatar-input')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 180;
        const side = Math.min(image.width, image.height);
        canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 180, 180);
        const avatar = canvas.toDataURL('image/jpeg', .82);
        document.querySelector('#profile-form').dataset.avatar = avatar;
        document.querySelector('#avatar-preview').innerHTML = `<img src="${avatar}" alt="新头像">`;
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  document.querySelector('#profile-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    state.profile = {
      name: form.elements.name.value.trim() || '林知夏',
      home: form.elements.home.value.trim() || '我的家',
      city: form.elements.city.value.trim() || '杭州',
      reminder: form.elements.reminder.value,
      avatar: form.dataset.avatar || state.profile.avatar
    };
    activeDeviceId = null;
    saveState();
    render();
    toast('资料已保存');
  });
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.onclick = () => {
      const next = button.dataset.tab;
      if (next === state.tab) return;
      state.tab = next;
      render();
      if (next === 'home') refreshWeather();
    };
  });
  document.querySelectorAll('[data-device]').forEach(input => {
    input.onchange = () => updateDevice(input.dataset.device);
  });
  document.querySelectorAll('[data-device-detail]').forEach(card => {
    const open = event => {
      if (event.target.closest('.switch')) return;
      openDeviceDetail(card.dataset.deviceDetail);
    };
    card.onclick = open;
    card.onkeydown = event => {
      if (['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        open(event);
      }
    };
  });
  document.querySelectorAll('[data-scene]').forEach(button => {
    button.onclick = () => showSceneEffect(button.dataset.scene);
  });
  document.querySelector('[data-action="device-view"]')?.addEventListener('click', () => {
    state.deviceView = state.deviceView === 'list' ? 'grid' : 'list';
    saveState();
    render();
  });
  document.querySelectorAll('[data-action="logs"]').forEach(button => {
    button.onclick = () => { document.querySelector('#modal-root').innerHTML = logsModal(); bindModal(); };
  });
  document.querySelectorAll('[data-action="profile"]').forEach(button => {
    button.onclick = () => { document.querySelector('#modal-root').innerHTML = profileModal(); bindModal(); };
  });
  [['home-detail', 'home'], ['notice-detail', 'notice'], ['energy-detail', 'energy'], ['about-detail', 'about']].forEach(([action, kind]) => {
    document.querySelectorAll(`[data-action="${action}"]`).forEach(button => {
      button.onclick = () => { document.querySelector('#modal-root').innerHTML = detailModal(kind); bindModal(); };
    });
  });
  document.querySelectorAll('[data-action="luna"]').forEach(button => {
    button.onclick = () => {
      const anchor = button.closest('.home-bot') || button.closest('.luna-anchor');
      if (!anchor) return;
      anchor.classList.remove('luna-hop');
      // 强制回流以重启动画
      void anchor.offsetWidth;
      anchor.classList.add('luna-hop');
      toast('Luna 和你打招呼');
    };
  });
  document.querySelectorAll('.prompt').forEach(button => {
    button.onclick = () => sendMessage(button.textContent);
  });
  document.querySelectorAll('[data-continuation-id]').forEach(button => {
    button.onclick = () => sendMessage(button.dataset.continuationMessage, {
      type: button.dataset.continuationType,
      id: button.dataset.continuationId
    });
  });
  document.querySelector('#chat-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = document.querySelector('#chat-input');
    const text = input.value.trim();
    if (text) {
      sendMessage(text);
      input.value = '';
    }
  });
  document.querySelector('#login-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = login(form.elements.username.value, form.elements.password.value);
    const error = document.querySelector('#login-error');
    if (!result.ok) {
      if (error) error.textContent = result.error;
      form.classList.add('shake');
      setTimeout(() => form.classList.remove('shake'), 500);
      return;
    }
    if (error) error.textContent = '';
    state.loggedIn = true;
    state.view = 'app';
    render();
    connectBackend();
  });
  document.querySelectorAll('[data-toast]').forEach(button => {
    button.onclick = () => toast(button.dataset.toast);
  });

  // 对话气泡：长按放大 + 波动，达到阈值松手后跳转 AI 对话
  document.querySelectorAll('.home-note').forEach(note => {
    const lottie = note.querySelector('.note-lottie');
    let pressTimer = null;
    let longPressTriggered = false;
    const start = (event) => {
      if (event.cancelable) event.preventDefault();
      longPressTriggered = false;
      lottie?.classList.remove('released');
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longPressTriggered = true;
        lottie?.classList.add('pressed');
      }, 500);
    };
    const end = (event) => {
      clearTimeout(pressTimer);
      if (longPressTriggered) {
        lottie?.classList.remove('pressed');
        lottie?.classList.add('released');
        state.tab = 'chat';
        render();
      }
    };
    note.addEventListener('pointerdown', start);
    note.addEventListener('pointerup', end);
    note.addEventListener('pointercancel', end);
    note.addEventListener('pointerleave', end);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    if (!local) {
      navigator.serviceWorker.register('./sw.js');
    }
  });
}

function startIntro() {
  state.view = 'intro';
  render();
  const slogan = document.querySelector('.intro-slogan');
  setTimeout(() => slogan?.classList.add('show'), 700);
  setTimeout(() => {
    state.view = isLoggedIn() ? 'app' : 'login';
    if (state.view === 'app') state.loggedIn = true;
    render();
    if (state.view === 'app') connectBackend();
  }, 3200);
}

if (isLoggedIn()) {
  state.loggedIn = true;
  state.view = 'app';
  render();
  await connectBackend();
} else {
  startIntro();
}
