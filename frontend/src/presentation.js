const TASK_PRESENTATIONS = {
  scheduled: { icon: '◷', label: '待运行', tone: 'scheduled' },
  running: { icon: '▶', label: '运行中', tone: 'running' },
  paused: { icon: 'Ⅱ', label: '已暂停', tone: 'paused' },
  stopped: { icon: '■', label: '已停止', tone: 'stopped' },
  failed: { icon: '!', label: '失败', tone: 'failed' }
};

const RESPONSE_PRESENTATIONS = {
  knowledge: { icon: 'i', label: '知识回复', tone: 'info' },
  environment_status: { icon: '⌁', label: '环境状态', tone: 'info' },
  device_status: { icon: '⌂', label: '设备状态', tone: 'info' },
  real_time: { icon: '↗', label: '实时信息', tone: 'realtime' },
  clarification: { icon: '?', label: '需要澄清', tone: 'clarification' },
  confirmation: { icon: '✓', label: '待确认', tone: 'confirmation' },
  task_status: { icon: '◷', label: '任务状态', tone: 'task' },
  execution_result: { icon: '↳', label: '执行回执', tone: 'receipt' },
  rejection: { icon: '×', label: '已拒绝', tone: 'rejection' },
  error: { icon: '!', label: '错误', tone: 'error' }
};

const RECEIPT_PRESENTATIONS = {
  succeeded: { icon: '✓', label: '成功', tone: 'success' },
  noop: { icon: '↺', label: '已处于目标状态', tone: 'noop' },
  partial_success: { icon: '◐', label: '部分成功', tone: 'partial' },
  failed: { icon: '×', label: '失败', tone: 'failed' },
  timed_out: { icon: '⌛', label: '超时，最终状态未知', tone: 'failed' },
  unknown: { icon: '?', label: '状态未知', tone: 'unknown' }
};

const DEVICE_STATE_LABELS = {
  on: '已开启',
  off: '已关闭',
  open: '已打开',
  closed: '已关闭',
  unknown: '状态未知'
};

const ACTION_LABELS = {
  turn_on: '开启',
  turn_off: '关闭',
  open: '打开',
  close: '关闭'
};

export function getConnectionPresentation(connection) {
  if (connection?.status === 'connected') {
    return { icon: '●', label: '已连接本地后端 Mock', detail: '设备、环境与任务来自后端快照', tone: 'connected' };
  }
  if (connection?.status === 'connecting') {
    return { icon: '…', label: '正在连接本地后端', detail: '尚未取得可信快照', tone: 'connecting' };
  }
  return { icon: '○', label: '本地 UI Mock / 未连接后端', detail: '当前状态仅用于浏览器界面演示', tone: 'disconnected' };
}

export function getTaskPresentation(status) {
  return TASK_PRESENTATIONS[status] || { icon: '?', label: '未知任务状态', tone: 'unknown' };
}

export function getResponsePresentation(type) {
  return RESPONSE_PRESENTATIONS[type] || null;
}

export function getReceiptPresentation(status) {
  return RECEIPT_PRESENTATIONS[status] || RECEIPT_PRESENTATIONS.unknown;
}

export function getDeviceStateLabel(state) {
  return DEVICE_STATE_LABELS[state] || '状态未知';
}

export function getActionLabel(action) {
  return ACTION_LABELS[action] || action || '未知动作';
}

export function getSourceLabel(source) {
  return ({ mock: 'Mock', replay: 'Replay', sensor: '传感器', device: '设备', rule: '规则', model: '模型', template: '模板', real_time: '实时' })[source] || '未知来源';
}

export function getTaskName(task) {
  if (!task) return '自动化任务';
  if (task.type === 'cooking_guard') return '烹饪空气守护';
  const modes = { comfort: '舒适优先', balanced: '均衡自动', eco: '低碳优先' };
  return `${modes[task.mode] || '优化'} · 模拟优化`;
}

export function formatObservedAt(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export const GENERAL_DISCLAIMER = 'Luna 是 AI 工具噢，我的回答仅供参考。';
export const MEDICAL_DISCLAIMER = '以上仅为一般性信息，不构成医疗诊断，也不能替代专业医疗建议。';

export function splitDisclaimerContent(content) {
  const text = String(content ?? '');
  const candidates = [
    { kind: 'general', text: GENERAL_DISCLAIMER },
    { kind: 'medical', text: MEDICAL_DISCLAIMER }
  ];
  const found = [];
  let remaining = text;
  for (const candidate of candidates) {
    if (remaining.includes(candidate.text)) {
      remaining = remaining.split(candidate.text).join('');
      found.push(candidate);
    }
  }
  found.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
  return { main: remaining.trim(), items: found };
}
