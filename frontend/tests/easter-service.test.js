import test from 'node:test';
import assert from 'node:assert/strict';
import { getApiBaseUrl } from '../src/services/conversation-service.js';
import { runSingingEasterEgg, EASTER_ERRORS } from '../src/services/easter-service.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

test('runSingingEasterEgg 请求 /v1/tts/easter-egg 并携带文本', async () => {
  let captured = null;
  const audioBase64 = Buffer.from('fake-sing-wav').toString('base64');
  const result = await runSingingEasterEgg('用户哼唱的模糊歌词转写', async (url, options) => {
    captured = { url, options };
    return jsonResponse({
      available: true,
      songName: '晴天',
      continuation: '故事的小黄花 从出生那年就飘着',
      replyText: '🎵 让我跟着哼两句：故事的小黄花 从出生那年就飘着\n唱得不错～不过我是你的空气小助手 Luna',
      audio: audioBase64,
      format: 'wav',
      voice: '冰糖'
    });
  });
  assert.equal(captured.url, `${getApiBaseUrl()}/tts/easter-egg`);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(captured.options.body).text, '用户哼唱的模糊歌词转写');
  assert.equal(result.available, true);
  assert.equal(result.songName, '晴天');
  assert.equal(result.continuation, '故事的小黄花 从出生那年就飘着');
  assert.equal(result.audioBase64, audioBase64);
  assert.equal(result.format, 'wav');
  assert.equal(result.voice, '冰糖');
  assert.equal(result.error, null);
});

test('runSingingEasterEgg 非唱歌返回 available:false 且无 error', async () => {
  const result = await runSingingEasterEgg('今天天气怎么样', async () => jsonResponse({ available: false, reason: 'not_singing' }));
  assert.equal(result.available, false);
  assert.equal(result.error, null);
  assert.equal(result.reason, 'not_singing');
});

test('runSingingEasterEgg 服务端不可用时降级为错误提示', async () => {
  const result = await runSingingEasterEgg('唱歌', async () => jsonResponse({ code: 'ERR' }, 503));
  assert.equal(result.available, false);
  assert.equal(result.error, EASTER_ERRORS.REQUEST_FAILED);
});

test('runSingingEasterEgg 网络异常时降级为错误提示', async () => {
  const result = await runSingingEasterEgg('唱歌', async () => { throw new Error('network'); });
  assert.equal(result.available, false);
  assert.equal(result.error, EASTER_ERRORS.REQUEST_FAILED);
});

test('runSingingEasterEgg 空文本返回错误且不请求', async () => {
  const result = await runSingingEasterEgg('', async () => { throw new Error('should not call'); });
  assert.equal(result.available, false);
  assert.equal(result.error, EASTER_ERRORS.REQUEST_FAILED);
});

test('runSingingEasterEgg 响应缺音频或 continuation 时返回 INVALID_RESPONSE', async () => {
  const noAudio = await runSingingEasterEgg('唱歌', async () => jsonResponse({ available: true, continuation: '歌词', audio: '' }));
  assert.equal(noAudio.available, false);
  assert.equal(noAudio.error, EASTER_ERRORS.INVALID_RESPONSE);

  const noContinuation = await runSingingEasterEgg('唱歌', async () => jsonResponse({ available: true, audio: Buffer.from('x').toString('base64') }));
  assert.equal(noContinuation.available, false);
  assert.equal(noContinuation.error, EASTER_ERRORS.INVALID_RESPONSE);
});
