import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSendMessageRequest,
  deleteMessages,
  getApiBaseUrl,
  getConversationId,
  loadBackendSnapshot,
  sendConversationMessage
} from '../src/services/conversation-service.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

test('conversationId 在同一存储中保持稳定，请求携带契约上下文和 continuation', () => {
  const storage = memoryStorage();
  const first = getConversationId(storage);
  const second = getConversationId(storage);
  assert.equal(first, second);

  const request = createSendMessageRequest('  确认  ', {
    storage,
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    city: '杭州',
    continuation: { type: 'confirmation', id: 'confirmation-1' }
  });
  assert.equal(request.conversationId, first);
  assert.match(request.clientMessageId, /^client-message-/);
  assert.equal(request.idempotencyKey, `idempotency-${request.clientMessageId}`);
  assert.equal(request.message, '确认');
  assert.equal(request.locale, 'zh-CN');
  assert.equal(request.timezone, 'Asia/Shanghai');
  assert.equal(request.city, '杭州');
  assert.deepEqual(request.continuation, { type: 'confirmation', id: 'confirmation-1' });

  const noCity = createSendMessageRequest('你好', { storage });
  assert.equal('city' in noCity, false);
});

test('启动严格按 health 再 bootstrap 获取可信快照', async () => {
  const calls = [];
  const bootstrap = {
    contractVersion: '1.0.0',
    mode: 'local_mock',
    devices: [],
    environment: null,
    activeTask: null,
    observedAt: '2026-08-03T00:00:00.000Z'
  };
  const fetchImpl = async url => {
    calls.push(url);
    return url.endsWith('/health')
      ? jsonResponse({ status: 'ok', contractVersion: '1.0.0', mode: 'local_mock' })
      : jsonResponse(bootstrap);
  };
  const result = await loadBackendSnapshot({ fetchImpl });
  assert.deepEqual(calls, [`${getApiBaseUrl()}/health`, `${getApiBaseUrl()}/bootstrap`]);
  assert.equal(result.bootstrap, bootstrap);
});

test('对话 POST 契约请求并保留后端结构化响应', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({
      contractVersion: '1.0.0',
      requestId: 'request-1',
      conversationId: posted.body.conversationId,
      message: { id: 'reply-1', role: 'assistant', content: '请确认。', status: 'complete', createdAt: '2026-08-03T00:00:00.000Z' },
      responseType: 'confirmation',
      sources: []
    });
  };
  const response = await sendConversationMessage('打开窗户', {
    fetchImpl,
    storage: memoryStorage(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    city: '杭州'
  });
  assert.equal(posted.url, `${getApiBaseUrl()}/conversations/messages`);
  assert.equal(posted.init.method, 'POST');
  assert.equal(posted.body.locale, 'zh-CN');
  assert.equal(posted.body.timezone, 'Asia/Shanghai');
  assert.equal(posted.body.city, '杭州');
  assert.equal(response.responseType, 'confirmation');
  assert.equal(response.transportMode, 'backend');
});

test('消息批量删除 DELETE 契约请求返回删除数量', async () => {
  let posted;
  const storage = memoryStorage();
  const conversationId = getConversationId(storage);
  const fetchImpl = async (url, init) => {
    posted = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({ deleted: 2, conversationId });
  };
  const result = await deleteMessages(['msg-1', 'msg-2'], { fetchImpl, storage });
  assert.equal(posted.url, `${getApiBaseUrl()}/conversations/${conversationId}/messages`);
  assert.equal(posted.init.method, 'DELETE');
  assert.deepEqual(posted.body.messageIds, ['msg-1', 'msg-2']);
  assert.equal(result.deleted, 2);
  assert.equal(result.conversationId, conversationId);
});

test('消息批量删除失败时抛出错误', async () => {
  const fetchImpl = async () => jsonResponse({ code: 'DELETE_FAILED' }, 500);
  await assert.rejects(() => deleteMessages(['msg-1'], { fetchImpl, storage: memoryStorage() }));
});

test('API 不可用时明确降级为本地 UI Mock', async () => {
  const response = await sendConversationMessage('你好', {
    fetchImpl: async () => { throw new TypeError('network down'); },
    storage: memoryStorage()
  });
  assert.equal(response.transportMode, 'ui_mock');
  assert.match(response.message.content, /本地 UI Mock \/ 未连接后端/);
  assert.equal(response.sources[0].type, 'mock');
});

test('model 来源响应原样保留 content/responseType/sources', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { body: JSON.parse(init.body) };
    return jsonResponse({
      contractVersion: '1.0.0',
      requestId: 'request-model',
      conversationId: posted.body.conversationId,
      message: {
        id: 'reply-model',
        role: 'assistant',
        content: '根据当前空气质量数据，建议开窗通风。',
        status: 'complete',
        createdAt: '2026-08-03T00:00:00.000Z'
      },
      responseType: 'knowledge',
      sources: [{ type: 'model', observedAt: '2026-08-03T00:00:00.000Z', referenceId: 'model-adapter-v1' }]
    });
  };
  const response = await sendConversationMessage('现在空气怎么样', {
    fetchImpl,
    storage: memoryStorage(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(response.transportMode, 'backend');
  assert.equal(response.message.content, '根据当前空气质量数据，建议开窗通风。');
  assert.equal(response.responseType, 'knowledge');
  assert.deepEqual(response.sources, [{ type: 'model', observedAt: '2026-08-03T00:00:00.000Z', referenceId: 'model-adapter-v1' }]);
});

test('HTTP 503 明确降级为本地 UI Mock 且不声称真实模型', async () => {
  const response = await sendConversationMessage('你好', {
    fetchImpl: async () => jsonResponse({ code: 'SERVICE_UNAVAILABLE', message: '后端暂不可用', retryable: true, requestId: 'request-503' }, 503),
    storage: memoryStorage()
  });
  assert.equal(response.transportMode, 'ui_mock');
  assert.match(response.message.content, /本地 UI Mock \/ 未连接后端/);
  assert.equal(response.sources[0].type, 'mock');
  assert.doesNotMatch(response.message.content, /真实模型|模型能力/);
});

test('后端可达但模型不可用时保留结构化公开错误，不降级为 UI Mock', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { body: JSON.parse(init.body) };
    return jsonResponse({
      contractVersion: '1.0.0',
      requestId: 'request-model-down',
      conversationId: posted.body.conversationId,
      message: {
        id: 'reply-model-down',
        role: 'assistant',
        content: '模型服务暂不可用，已按固定模板回复。',
        status: 'error',
        createdAt: '2026-08-03T00:00:00.000Z'
      },
      responseType: 'error',
      sources: [],
      error: { code: 'MODEL_UNAVAILABLE', message: '模型服务暂不可用。', retryable: true, requestId: 'request-model-down' }
    });
  };
  const response = await sendConversationMessage('讲个笑话', {
    fetchImpl,
    storage: memoryStorage(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(response.transportMode, 'backend');
  assert.equal(response.responseType, 'error');
  assert.equal(response.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(response.message.content, '模型服务暂不可用，已按固定模板回复。');
});

test('DEP-004 窗户明确开关请求透传直接执行回执，不含确认', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { body: JSON.parse(init.body) };
    return jsonResponse({
      contractVersion: '1.0.0',
      requestId: 'request-window',
      conversationId: posted.body.conversationId,
      message: { id: 'reply-window', role: 'assistant', content: '智能窗户已直接执行打开。', status: 'complete', createdAt: '2026-08-04T00:00:00.000Z' },
      responseType: 'execution_result',
      sources: [],
      receipt: {
        receiptId: 'receipt-window', requestId: 'request-window', planId: 'plan-window', status: 'succeeded', source: 'mock',
        actions: [{ actionId: 'a1', deviceId: 'window-1', requestedAction: 'open', actualState: 'open', status: 'succeeded', source: 'mock' }],
        startedAt: '2026-08-04T00:00:00.000Z', completedAt: '2026-08-04T00:01:00.000Z'
      }
    });
  };
  const response = await sendConversationMessage('打开窗户', {
    fetchImpl,
    storage: memoryStorage(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(response.transportMode, 'backend');
  assert.equal(response.responseType, 'execution_result');
  assert.equal(response.confirmation, undefined);
  assert.equal(response.receipt.status, 'succeeded');
  assert.equal(response.receipt.actions[0].requestedAction, 'open');
});

test('DEP-005 多设备澄清选项链路透传 options 且不新增字段', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { body: JSON.parse(init.body) };
    return jsonResponse({
      contractVersion: '1.0.0',
      requestId: 'request-split',
      conversationId: posted.body.conversationId,
      message: { id: 'reply-split', role: 'assistant', content: 'V1 只支持单设备即时控制，请先拆分请求。', status: 'complete', createdAt: '2026-08-04T00:00:00.000Z' },
      responseType: 'clarification',
      sources: [],
      clarification: {
        clarificationId: 'clarification-split', originalRequestId: 'request-original', kind: 'device',
        prompt: '请选择先控制哪一个：', options: ['只打开空气净化器', '只打开智能窗户'],
        createdAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-04T00:02:00.000Z'
      }
    });
  };
  const response = await sendConversationMessage('打开净化器和窗户', {
    fetchImpl,
    storage: memoryStorage(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(response.transportMode, 'backend');
  assert.equal(response.responseType, 'clarification');
  assert.deepEqual(response.clarification.options, ['只打开空气净化器', '只打开智能窗户']);
  assert.equal(response.clarification.clarificationId, 'clarification-split');
});
