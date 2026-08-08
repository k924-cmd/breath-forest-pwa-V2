import { escapeHtml } from '../utils/html.js?v=20260808-4';
import {
  formatObservedAt,
  getActionLabel,
  getDeviceStateLabel,
  getReceiptPresentation,
  getResponsePresentation,
  getSourceLabel,
  getTaskName,
  getTaskPresentation,
  splitDisclaimerContent
} from '../presentation.js?v=20260808-4';

function findDevice(deviceId, devices) {
  return (Array.isArray(devices) ? devices : []).find(device => device.id === deviceId);
}

export function taskHtml(task) {
  if (!task) return '';
  const status = getTaskPresentation(task.status);
  const schedule = task.scheduledFor ? `<small>计划时间：${formatObservedAt(task.scheduledFor)}</small>` : '';
  return `<section class="message-card task-message ${status.tone}"><header><span>${status.icon}</span><b>${getTaskName(task)}</b><strong>${status.icon} ${status.label}</strong></header>${schedule}<small>版本 ${task.taskVersion} · 来源 ${getSourceLabel(task.executionSource)}${task.isSimulation ? ' · 模拟优化' : ''}</small></section>`;
}

export function confirmationHtml(confirmation) {
  if (!confirmation) return '';
  const pending = confirmation.status === 'pending';
  const resolution = {
    pending: '✓ 待确认',
    confirmed: '✓ 已确认',
    cancelled: '× 已取消',
    expired: '⌛ 已过期',
    invalidated: '! 已失效'
  }[confirmation.status] || '? 状态未知';
  return `<section class="message-card confirmation-card"><header><span>✓</span><b>确认计划</b><strong>${resolution}</strong></header><p>${escapeHtml(confirmation.plan?.summary || '请确认是否继续。')}</p><small>有效至 ${formatObservedAt(confirmation.expiresAt)}</small>${pending ? `<div class="message-actions"><button data-continuation-type="confirmation" data-continuation-id="${escapeHtml(confirmation.confirmationId)}" data-continuation-message="确认">确认</button><button class="secondary" data-continuation-type="confirmation" data-continuation-id="${escapeHtml(confirmation.confirmationId)}" data-continuation-message="取消">取消</button></div>` : ''}</section>`;
}

export function clarificationHtml(clarification) {
  if (!clarification) return '';
  const options = Array.isArray(clarification.options) ? clarification.options : [];
  return `<section class="message-card clarification-card"><header><span>?</span><b>需要补充信息</b><strong>${clarification.resolved ? '✓ 已补充' : '? 待澄清'}</strong></header><p>${escapeHtml(clarification.prompt)}</p>${options.length && !clarification.resolved ? `<div class="message-actions option-actions">${options.map(option => `<button data-continuation-type="clarification" data-continuation-id="${escapeHtml(clarification.clarificationId)}" data-continuation-message="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div>` : ''}</section>`;
}

export function receiptHtml(receipt, devices) {
  if (!receipt) return '';
  const result = getReceiptPresentation(receipt.status);
  const actions = Array.isArray(receipt.actions) ? receipt.actions : [];
  return `<section class="message-card receipt-card ${result.tone}"><header><span>${result.icon}</span><b>执行回执</b><strong>${result.icon} ${result.label}</strong></header><div class="receipt-actions">${actions.map(action => {
    const actionResult = getReceiptPresentation(action.status);
    const device = findDevice(action.deviceId, devices);
    return `<article><span>${actionResult.icon}</span><div><b>${escapeHtml(device?.name || action.deviceId)} · ${escapeHtml(getActionLabel(action.requestedAction))}</b><small>${actionResult.label}${action.actualState ? ` · ${getDeviceStateLabel(action.actualState)}` : ''}${action.errorCode ? ` · ${escapeHtml(action.errorCode)}` : ''}</small></div></article>`;
  }).join('')}</div><small>来源 ${getSourceLabel(receipt.source)} · 完成于 ${formatObservedAt(receipt.completedAt)}</small></section>`;
}

export function errorHtml(error, responseType) {
  if (!error && !['rejection', 'error'].includes(responseType)) return '';
  const isRejection = responseType === 'rejection';
  return `<section class="message-card error-card ${isRejection ? 'rejection' : 'error'}"><header><span>${isRejection ? '×' : '!'}</span><b>${isRejection ? '请求已拒绝' : '请求出错'}</b><strong>${escapeHtml(error?.code || (isRejection ? 'REJECTED' : 'ERROR'))}</strong></header>${error?.message ? `<p>${escapeHtml(error.message)}</p>` : ''}${error?.retryable ? '<small>可以稍后重试</small>' : '<small>请调整请求后重试</small>'}</section>`;
}

export function sourcesHtml(sources, sourceMode) {
  const items = Array.isArray(sources) ? sources : [];
  if (!items.length && sourceMode !== 'ui_mock') return '';
  return `<div class="source-chips">${sourceMode === 'ui_mock' ? '<span>本地 UI Mock · 未连接后端</span>' : ''}${items.map(source => `<span>${getSourceLabel(source.type)} · ${formatObservedAt(source.observedAt)}</span>`).join('')}</div>`;
}

export function contentHtml(content) {
  const { main, items } = splitDisclaimerContent(content);
  const disclaimerBlock = items.length
    ? `<div class="disclaimer-block">${items.map(item => `<small class="disclaimer ${item.kind}">${escapeHtml(item.text)}</small>`).join('')}</div>`
    : '';
  return `<p>${escapeHtml(main)}</p>${disclaimerBlock}`;
}

export function realTimeHtml(realtime) {
  if (!realtime) return '';
  const results = Array.isArray(realtime.results) ? realtime.results : [];
  return `<section class="message-card realtime-card"><header><span>↗</span><b>实时引擎 · Tavily</b><strong>${formatObservedAt(realtime.observedAt)}</strong></header>${realtime.query ? `<small>查询：${escapeHtml(realtime.query)}</small>` : ''}${results.length ? `<div class="realtime-results">${results.slice(0, 3).map(item => item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || item.url)}</a>` : `<span>${escapeHtml(item.title || '')}</span>`).join('')}</div>` : ''}</section>`;
}

export function structuredMessageHtml(message, devices) {
  const presentation = message.role === 'assistant' ? getResponsePresentation(message.responseType) : null;
  return `<div class="message-block ${message.role === 'user' ? 'user' : 'assistant'}" data-message-id="${escapeHtml(message.id)}"><div class="bubble ${message.role === 'user' ? 'user' : ''}${message.status === 'pending' ? ' streaming' : ''}${message.status === 'error' ? ' bubble-error' : ''}">${presentation ? `<span class="response-label ${presentation.tone}">${presentation.icon} ${presentation.label}</span>` : ''}${contentHtml(message.content)}</div>${confirmationHtml(message.confirmation)}${clarificationHtml(message.clarification)}${taskHtml(message.task)}${receiptHtml(message.receipt, devices)}${realTimeHtml(message.realtime)}${errorHtml(message.error, message.responseType)}${sourcesHtml(message.sources, message.sourceMode)}</div>`;
}

export function messageSignature(message) {
  return JSON.stringify([
    message.content,
    message.status,
    message.responseType,
    message.sourceMode,
    message.confirmation?.status,
    message.clarification?.resolved,
    message.task?.status,
    message.receipt?.status,
    message.error?.code,
    message.sources
  ]);
}
