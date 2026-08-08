import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeTypeForFormat, playBase64Audio, unlockAudio } from '../src/utils/play-audio.js';

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
