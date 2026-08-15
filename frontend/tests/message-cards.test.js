import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSignature, structuredMessageHtml } from '../src/components/message-cards.js';

function assistantMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '回答内容',
    status: 'complete',
    createdAt: '2026-08-04T00:00:00.000Z',
    responseType: 'chat',
    sources: [],
    sourceMode: 'backend',
    ...overrides
  };
}

test('DEP-003 免责声明与医疗强化句统一样式展示且不省略', () => {
  const message = assistantMessage({
    content: '空气净化器可以过滤颗粒物。Luna 是 AI 工具噢，我的回答仅供参考。以上仅为一般性信息，不构成医疗诊断，也不能替代专业医疗建议。'
  });
  const html = structuredMessageHtml(message, []);
  assert.match(html, /空气净化器可以过滤颗粒物。/);
  assert.match(html, /class="disclaimer-block"/);
  assert.match(html, /class="disclaimer general"/);
  assert.match(html, /class="disclaimer medical"/);
  assert.match(html, /Luna 是 AI 工具噢，我的回答仅供参考。/);
  assert.match(html, /以上仅为一般性信息，不构成医疗诊断，也不能替代专业医疗建议。/);
  assert.ok(html.indexOf('Luna 是 AI 工具噢') < html.indexOf('以上仅为一般性信息'));
});

test('DEP-003 无免责句时不渲染免责块', () => {
  const html = structuredMessageHtml(assistantMessage(), []);
  assert.match(html, /回答内容/);
  assert.doesNotMatch(html, /disclaimer-block/);
});

test('DEP-004 窗户明确开关响应直接展示回执而非确认卡片', () => {
  const message = assistantMessage({
    responseType: 'execution_result',
    content: '智能窗户已直接执行打开。',
    receipt: {
      receiptId: 'receipt-window', requestId: 'request-1', planId: 'plan-window',
      status: 'succeeded', source: 'mock',
      actions: [{ actionId: 'action-window', deviceId: 'window-1', requestedAction: 'open', actualState: 'open', status: 'succeeded', source: 'mock' }],
      startedAt: '2026-08-04T00:00:00.000Z', completedAt: '2026-08-04T00:01:00.000Z'
    }
  });
  const html = structuredMessageHtml(message, []);
  assert.match(html, /receipt-card/);
  assert.match(html, /执行回执/);
  assert.doesNotMatch(html, /confirmation-card/);
  assert.doesNotMatch(html, /data-continuation-type="confirmation"/);
});

test('DEP-004 任务创建确认卡片保持不变', () => {
  const message = assistantMessage({
    responseType: 'confirmation',
    content: '创建烹饪空气守护任务需要确认。',
    confirmation: {
      confirmationId: 'confirmation-cooking', conversationId: 'conversation-1',
      plan: { planId: 'plan-cooking', planHash: 'a'.repeat(64), kind: 'cooking_guard', summary: '创建烹饪守护（本地 Mock）', actions: [], requiresConfirmation: true, createdAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-04T00:02:00.000Z' },
      deviceStateVersions: {}, status: 'pending', createdAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-04T00:02:00.000Z'
    }
  });
  const html = structuredMessageHtml(message, []);
  assert.match(html, /confirmation-card/);
  assert.match(html, /data-continuation-type="confirmation"/);
  assert.match(html, /确认/);
  assert.match(html, /取消/);
});

test('DEP-005 澄清选项链路渲染为可操作按钮', () => {
  const message = assistantMessage({
    responseType: 'clarification',
    content: '一次请求包含多个设备，请拆分。',
    clarification: {
      clarificationId: 'clarification-split', originalRequestId: 'request-1', kind: 'device',
      prompt: '请选择先控制哪一个：', options: ['只打开空气净化器', '只打开智能窗户'],
      createdAt: '2026-08-04T00:00:00.000Z', expiresAt: '2026-08-04T00:02:00.000Z'
    }
  });
  const html = structuredMessageHtml(message, []);
  assert.match(html, /clarification-card/);
  assert.match(html, /data-continuation-type="clarification"/);
  assert.match(html, /data-continuation-id="clarification-split"/);
  assert.match(html, /只打开空气净化器/);
  assert.match(html, /只打开智能窗户/);
});

test('DEP-005 回执文案中文化并含可读观测时间', () => {
  const message = assistantMessage({
    responseType: 'execution_result',
    content: '部分动作完成。',
    receipt: {
      receiptId: 'receipt-partial', requestId: 'request-1', planId: 'plan-1', status: 'partial_success', source: 'mock',
      actions: [
        { actionId: 'a1', deviceId: 'p1', requestedAction: 'turn_on', actualState: 'on', status: 'succeeded', source: 'mock' },
        { actionId: 'a2', deviceId: 'h1', requestedAction: 'turn_on', status: 'failed', errorCode: 'DEVICE_UNAVAILABLE', source: 'mock' }
      ],
      startedAt: '2026-08-04T00:00:00.000Z', completedAt: '2026-08-04T00:01:00.000Z'
    }
  });
  const html = structuredMessageHtml(message, [
    { id: 'p1', name: '空气净化器' },
    { id: 'h1', name: '抽油烟机' }
  ]);
  assert.match(html, /部分成功/);
  assert.match(html, /空气净化器 · 开启/);
  assert.match(html, /抽油烟机 · 开启/);
  assert.match(html, /DEVICE_UNAVAILABLE/);
  assert.match(html, /完成于/);
});

test('DEP-005 消息块带稳定 ID，签名仅反映渲染相关字段', () => {
  const base = assistantMessage();
  assert.match(structuredMessageHtml(base, []), /data-message-id="msg-1"/);
  const same = assistantMessage();
  same.id = 'msg-2';
  assert.equal(messageSignature(base), messageSignature(same));
  assert.notEqual(messageSignature(base), messageSignature(assistantMessage({ content: 'changed' })));
  assert.notEqual(messageSignature(base), messageSignature(assistantMessage({ status: 'error' })));
  assert.notEqual(messageSignature(base), messageSignature(assistantMessage({ responseType: 'knowledge' })));
});

test('语音播报小喇叭：完成态 assistant 消息渲染播报按钮，其余不渲染', () => {
  const html = structuredMessageHtml(assistantMessage(), []);
  assert.match(html, /data-action="speak"/);
  assert.match(html, /class="speak-btn"/);
  assert.match(html, /aria-label="语音播报这条回复"/);
  // 未完成（pending）不渲染小喇叭
  const pending = structuredMessageHtml(assistantMessage({ status: 'pending', content: 'Luna 正在整理回复' }), []);
  assert.doesNotMatch(pending, /data-action="speak"/);
  // 用户消息不渲染小喇叭
  const user = structuredMessageHtml({ ...assistantMessage(), role: 'user' }, []);
  assert.doesNotMatch(user, /data-action="speak"/);
});
