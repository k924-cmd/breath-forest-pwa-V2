import test from 'node:test';
import assert from 'node:assert/strict';
import { getApiBaseUrl } from '../src/services/conversation-service.js';
import { transcribeAudio, ASR_ERRORS } from '../src/services/asr-service.js';

function jsonResponse(payload, status = 200, ok) {
  return {
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function makeBlob(text, type = 'audio/webm') {
  return new Blob([text], { type });
}

test('transcribeAudio 请求 /v1/asr 并携带音频 blob', async () => {
  let captured = null;
  const blob = makeBlob('fake-audio-bytes', 'audio/webm');
  const result = await transcribeAudio(blob, async (url, options) => {
    captured = { url, options };
    return jsonResponse({ text: '你好，我是呼吸森林的语音助手' });
  });
  assert.equal(captured.url, `${getApiBaseUrl()}/asr`);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.body, blob);
  assert.equal(captured.options.headers['Content-Type'], 'audio/webm');
  assert.equal(result.text, '你好，我是呼吸森林的语音助手');
  assert.equal(result.error, null);
});

test('transcribeAudio 服务端不可用时降级为错误提示', async () => {
  const blob = makeBlob('fake');
  const result = await transcribeAudio(blob, async () => jsonResponse({ code: 'ERR' }, 503));
  assert.equal(result.text, null);
  assert.equal(result.error, ASR_ERRORS.REQUEST_FAILED);
});

test('transcribeAudio 网络异常时降级为错误提示', async () => {
  const blob = makeBlob('fake');
  const result = await transcribeAudio(blob, async () => { throw new Error('network'); });
  assert.equal(result.text, null);
  assert.equal(result.error, ASR_ERRORS.REQUEST_FAILED);
});

test('transcribeAudio 空音频返回 NO_AUDIO 错误', async () => {
  const result = await transcribeAudio(null, async () => { throw new Error('should not call'); });
  assert.equal(result.text, null);
  assert.equal(result.error, ASR_ERRORS.NO_AUDIO);
});

test('transcribeAudio 响应缺 text 或为空时返回 EMPTY_RESULT', async () => {
  const empty = await transcribeAudio(makeBlob('x'), async () => jsonResponse({ text: '' }));
  assert.equal(empty.text, null);
  assert.equal(empty.error, ASR_ERRORS.EMPTY_RESULT);

  const missing = await transcribeAudio(makeBlob('x'), async () => jsonResponse({ other: 1 }));
  assert.equal(missing.text, null);
  assert.equal(missing.error, ASR_ERRORS.EMPTY_RESULT);
});
