import { icon } from '../components/icons.js?v=20260808-6';
import { getConnectionPresentation, getSourceLabel, getTaskName, getTaskPresentation } from '../presentation.js?v=20260808-6';

function activeTaskCard(task) {
  if (!task) return '';
  const status = getTaskPresentation(task.status);
  return `<section class="active-task-card ${status.tone}" aria-label="当前任务状态"><span class="task-status-icon">${status.icon}</span><div><small>CURRENT TASK · ${getSourceLabel(task.executionSource)}</small><b>${getTaskName(task)}</b></div><strong>${status.icon} ${status.label}</strong></section>`;
}

export function chatPage(state) {
  const connection = getConnectionPresentation(state.connection);
  return `<section class="page chat-page ${state.tab === 'chat' ? 'active' : ''}">
    <header class="chat-header"><div class="chat-bot-avatar" role="img" aria-label="AI 助手"></div><div><span class="eyebrow">LUNA · BREATH COMPANION</span><h1>和 Luna 聊聊</h1><p class="connection-copy ${connection.tone}">${connection.icon} ${connection.label}</p></div><button class="circle-btn" data-toast="${connection.detail}">${icon('more')}</button></header>
    <div class="active-task-slot">${activeTaskCard(state.activeTask)}</div>
    <div class="messages" aria-live="polite"></div>
    <div class="prompt-row"><button class="prompt">你好 Luna</button><button class="prompt">现在空气怎么样</button><button class="prompt">设备可以使用吗</button></div>
    <form id="chat-form" class="composer glass"><input id="chat-input" maxlength="4000" autocomplete="off" placeholder="告诉 Luna 你的需求…" ${state.isStreaming ? 'disabled' : ''}><button type="submit" aria-label="发送消息" ${state.isStreaming ? 'disabled' : ''}>${icon('arrow')}</button></form>
  </section>`;
}
