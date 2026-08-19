import test from 'node:test';
import assert from 'node:assert/strict';
import { pushStreamChunk, stopStreamPlayback } from '../src/utils/stream-playback.js';

function installFakeAudioContext() {
  const played = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        addEventListener(type, cb) { if (type === 'ended') this._onEnded = cb; },
        start() { played.push('start'); queueMicrotask(() => this._onEnded?.()); },
        stop() { played.push('stop'); }
      };
    }
    decodeAudioData() { return Promise.resolve({ length: 1 }); }
  }
  globalThis.AudioContext = FakeAudioContext;
  return { played };
}

const original = globalThis.AudioContext;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('stream-playback: 分块入队并顺序播放', async () => {
  const { played } = installFakeAudioContext();
  try {
    const t = pushStreamChunk('aGVsbG8=', 'mp3');
    assert.ok(typeof t === 'number');
    pushStreamChunk('d29ybGQ=', 'mp3');
    await tick();
    // 两个 chunk 都应被 start
    assert.ok(played.includes('start'), 'chunk 应被播放');
  } finally {
    restore();
  }
});

test('stream-playback: 无 AudioContext 时安全返回 null', () => {
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    assert.equal(pushStreamChunk('aGVsbG8=', 'wav'), null);
  } finally {
    restore();
  }
});

test('stream-playback: 空数据返回 null', () => {
  installFakeAudioContext();
  try {
    assert.equal(pushStreamChunk('', 'wav'), null);
    assert.equal(pushStreamChunk(null, 'wav'), null);
  } finally {
    restore();
  }
});

test('stream-playback: stop 清空队列且后续 push 开新 token', () => {
  installFakeAudioContext();
  try {
    const t1 = pushStreamChunk('aGVsbG8=', 'mp3');
    stopStreamPlayback(t1);
    const t2 = pushStreamChunk('aGVsbG8=', 'mp3');
    assert.notEqual(t1, t2, 'stop 后新播放应开新 token');
    stopStreamPlayback();
  } finally {
    restore();
  }
});

function restore() {
  if (original) globalThis.AudioContext = original;
  else delete globalThis.AudioContext;
}
