import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeTypeForFormat, playBase64Audio, playBase64Interruptible, stopPlayback, unlockAudio } from '../src/utils/play-audio.js';

test('mimeTypeForFormat 映射已知与未知格式', () => {
  assert.equal(mimeTypeForFormat('wav'), 'audio/wav');
  assert.equal(mimeTypeForFormat('mp3'), 'audio/mpeg');
  assert.equal(mimeTypeForFormat('WAV'), 'audio/wav');
  assert.equal(mimeTypeForFormat('pcm16'), 'audio/wav');
  assert.equal(mimeTypeForFormat('unknown'), 'audio/wav');
});

test('playBase64Audio 无 AudioContext 时安全降级', async () => {
  const original = globalThis.AudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    const result = await playBase64Audio('aGVsbG8=', 'wav');
    assert.equal(result, false);
  } finally {
    if (original) globalThis.AudioContext = original;
  }
});

test('playBase64Audio 空 base64 时安全降级', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = class {};
  try {
    const result = await playBase64Audio('', 'wav');
    assert.equal(result, false);
  } finally {
    if (original) globalThis.AudioContext = original;
    else delete globalThis.AudioContext;
  }
});

test('playBase64Interruptible 无 AudioContext 或空数据返回 null', () => {
  const original = globalThis.AudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    assert.equal(playBase64Interruptible('aGVsbG8=', 'wav'), null);
  } finally {
    if (original) globalThis.AudioContext = original;
  }
  globalThis.AudioContext = class {};
  try {
    assert.equal(playBase64Interruptible('', 'wav'), null);
  } finally {
    delete globalThis.AudioContext;
  }
});

test('playBase64Interruptible 正常路径返回递增 token', () => {
  const original = globalThis.AudioContext;
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
    createBufferSource() { return { buffer: null, connect() {}, addEventListener() {}, start() {}, stop() {} }; }
    decodeAudioData() { return Promise.resolve({}); }
  }
  globalThis.AudioContext = FakeAudioContext;
  try {
    const t1 = playBase64Interruptible('aGVsbG8=', 'wav');
    const t2 = playBase64Interruptible('aGVsbG8=', 'wav');
    assert.ok(typeof t1 === 'number');
    assert.ok(typeof t2 === 'number');
    assert.notEqual(t1, t2);
    stopPlayback(t2);
    stopPlayback(t1); // stale token ignored, must not throw
  } finally {
    if (original) globalThis.AudioContext = original;
    else delete globalThis.AudioContext;
  }
});

test('unlockAudio 无 AudioContext 时返回 false', () => {
  const original = globalThis.AudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    assert.equal(unlockAudio(), false);
  } finally {
    if (original) globalThis.AudioContext = original;
  }
});
