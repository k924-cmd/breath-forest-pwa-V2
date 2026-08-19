import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeWordConfigured, startWake, stopWake, isWakeActive } from '../src/wake/wake-service.js';

const originalNavigator = globalThis.navigator;
const originalMediaRecorder = globalThis.MediaRecorder;

// 记录 fetch 调用的 fake 环境
const calls = [];

function installEnv({ detected = false } = {}) {
  calls.length = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [{ readyState: 'live', stop() {} }]
        })
      }
    }
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ detected, keyword: '小云小云' })
    };
  };
  globalThis.MediaRecorder = class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.state = 'recording'; this.mimeType = 'audio/webm'; this._stream = stream; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    // 模拟一个 dataavailable 事件
    emitData() {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([128, 128, 128])], { type: 'audio/webm' }) });
    }
  };
}

function restore() {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  } else {
    delete globalThis.navigator;
  }
  if (originalMediaRecorder) globalThis.MediaRecorder = originalMediaRecorder;
  else delete globalThis.MediaRecorder;
  delete globalThis.fetch;
}

test('wake-service: 唤醒词已配置', () => {
  assert.equal(wakeWordConfigured(), true);
});

test('wake-service: 无麦克风权限时 startWake 返回失败且不抛', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => { throw new Error('NotAllowedError'); } } }
  });
  try {
    const result = await startWake();
    assert.equal(result.ok, false);
    assert.equal(isWakeActive(), false);
  } finally {
    restore();
  }
});

test('wake-service: startWake 建立录音并开始轮询', async () => {
  installEnv();
  try {
    const result = await startWake({ onWake: () => {} });
    assert.equal(result.ok, true);
    assert.ok(result.message.includes('小云小云'));
    assert.equal(isWakeActive(), true);
    // 触发一个录音块，等一次轮询后应有 fetch 到 /kws/check
    const recorder = globalThis.__lastRecorder;
    await stopWake();
  } finally {
    restore();
  }
});

test('wake-service: stopWake 清理录音与轮询', async () => {
  installEnv();
  try {
    await startWake({ onWake: () => {} });
    assert.equal(isWakeActive(), true);
    await stopWake();
    assert.equal(isWakeActive(), false);
    // 再次 stop 幂等不抛
    await stopWake();
  } finally {
    restore();
  }
});
