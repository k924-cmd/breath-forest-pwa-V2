import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initFeedback,
  destroyFeedback,
  vibrate,
  MATCH_SELECTOR,
  EXCLUDE_SELECTOR
} from '../src/utils/feedback.js';

function makeMockDoc() {
  const listeners = new Map();
  return {
    addEventListener(type, fn, capture) {
      listeners.set(`${type}:${capture}`, fn);
    },
    removeEventListener(type, fn, capture) {
      if (listeners.get(`${type}:${capture}`) === fn) listeners.delete(`${type}:${capture}`);
    },
    listeners,
    count(type) {
      return Array.from(listeners.keys()).filter(key => key.startsWith(`${type}:`)).length;
    }
  };
}

function makeMockTarget(closestResult) {
  return { closest: selector => closestResult(selector) };
}

function plainTarget() {
  return makeMockTarget(sel => (sel === EXCLUDE_SELECTOR ? null : sel === MATCH_SELECTOR ? {} : null));
}

function excludedTarget() {
  return makeMockTarget(sel => (sel === EXCLUDE_SELECTOR ? {} : null));
}

function withNavigatorVibrate(fn) {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  const mockNav = { vibrate: pattern => { calls.push(pattern); return true; } };
  Object.defineProperty(globalThis, 'navigator', { value: mockNav, configurable: true, writable: true });
  try {
    return { calls, result: fn() };
  } finally {
    if (prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor);
    else delete globalThis.navigator;
  }
}

function makeMockAudioContextClass() {
  const instances = [];
  return class {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.osc = null;
      instances.push(this);
    }
    createOscillator() {
      this.osc = { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} };
      return this.osc;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    resume() {}
    static all() {
      return instances;
    }
  };
}

function withMockAudioContext(fn) {
  const prev = globalThis.AudioContext;
  const AC = makeMockAudioContextClass();
  globalThis.AudioContext = AC;
  try {
    const result = fn();
    return { ctxs: AC.all(), result };
  } finally {
    if (prev) globalThis.AudioContext = prev;
    else delete globalThis.AudioContext;
  }
}

function handlerFor(doc) {
  return doc.listeners.get('click:true');
}

test('initFeedback 幂等，destroyFeedback 可逆', () => {
  const doc = makeMockDoc();
  assert.equal(initFeedback(() => ({}), doc), true);
  assert.equal(doc.count('click'), 1);
  assert.equal(initFeedback(() => ({}), doc), true);
  assert.equal(doc.count('click'), 1);
  destroyFeedback(doc);
  assert.equal(doc.count('click'), 0);
  assert.equal(initFeedback(() => ({}), doc), true);
  destroyFeedback(doc);
});

test('vibrate 调用传参；无 navigator 时安全降级', () => {
  const withNav = withNavigatorVibrate(() => vibrate(30));
  assert.equal(withNav.result, true);
  assert.deepEqual(withNav.calls, [30]);

  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  delete globalThis.navigator;
  try {
    assert.equal(vibrate(30), false);
  } finally {
    if (prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor);
    else delete globalThis.navigator;
  }
});

test('委托命中按钮：声音震动按设置独立开关', () => {
  const doc = makeMockDoc();
  let current = { sound: true, vibrate: true };
  initFeedback(() => current, doc);
  const handler = handlerFor(doc);

  const both = withMockAudioContext(() => withNavigatorVibrate(() => handler({ target: plainTarget() })));
  assert.equal(both.ctxs.length, 1, '声音开启应创建 AudioContext');
  assert.equal(both.ctxs[0].osc !== null, true, '应启动振荡器');
  assert.equal(both.result.calls.length, 1, '震动开启应调用 vibrate');
  destroyFeedback(doc);

  initFeedback(() => current, doc);
  current = { sound: true, vibrate: false };
  const soundOnly = withMockAudioContext(() => withNavigatorVibrate(() => handlerFor(doc)({ target: plainTarget() })));
  assert.equal(soundOnly.ctxs.length, 1, '声音开启仍创建 AudioContext');
  assert.deepEqual(soundOnly.result.calls, [], '震动关闭不调用 vibrate');
  destroyFeedback(doc);

  initFeedback(() => current, doc);
  current = { sound: false, vibrate: true };
  const vibOnly = withMockAudioContext(() => withNavigatorVibrate(() => handlerFor(doc)({ target: plainTarget() })));
  assert.equal(vibOnly.ctxs.length, 0, '声音关闭不创建 AudioContext');
  assert.equal(vibOnly.result.calls.length, 1, '震动开启调用 vibrate');
  destroyFeedback(doc);
});

test('getSettings 返回 undefined 视为默认全开', () => {
  const doc = makeMockDoc();
  initFeedback(() => undefined, doc);
  const handler = handlerFor(doc);
  const out = withMockAudioContext(() => withNavigatorVibrate(() => handler({ target: plainTarget() })));
  assert.equal(out.ctxs.length, 1, '默认应响音');
  assert.equal(out.ctxs[0].osc !== null, true);
  assert.equal(out.result.calls.length, 1, '默认应震动');
  destroyFeedback(doc);
});

test('voice 按钮（EXCLUDE_SELECTOR）不触发反馈', () => {
  const doc = makeMockDoc();
  initFeedback(() => ({ sound: true, vibrate: true }), doc);
  const handler = handlerFor(doc);
  const out = withMockAudioContext(() => withNavigatorVibrate(() => handler({ target: excludedTarget() })));
  assert.equal(out.ctxs.length, 0, '排除元素不应创建 AudioContext');
  assert.deepEqual(out.result.calls, [], '排除元素不应震动');
  destroyFeedback(doc);
});

test('Node 无 document 时 initFeedback 安全返回 false', () => {
  const prevDoc = globalThis.document;
  delete globalThis.document;
  try {
    assert.equal(initFeedback(() => ({})), false);
  } finally {
    if (prevDoc) globalThis.document = prevDoc;
  }
});
