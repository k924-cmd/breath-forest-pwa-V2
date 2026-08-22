// 「小云小云」语音唤醒服务。
//
// 检测在后端完成：本服务复用 mic-service 的共享流，用一个 MediaRecorder
// 持续录音，每 WAKE_POLL_INTERVAL_MS 把最近积累的音频块 POST 给
// /v1/kws/check（后端跑 FunASR cFSMN 模型，或本地模拟检测器），
// 命中即回调 onWake。前端不感知真实/模拟差异。
//
// 降级：无麦克风权限 / 后端不可达 / 流不可用 → 置 wakeAvailable=false，
// 静默停用，不影响录音、播报等其他功能。

import { WAKE_KEYWORD_LABEL, WAKE_POLL_INTERVAL_MS, WAKE_WINDOW_MS } from '../config.js?v=20260808-24';
import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from '../services/conversation-service.js?v=20260808-24';
import { requestMicStream, releaseMicStream } from '../utils/mic-service.js?v=20260808-24';

export { WAKE_KEYWORD_LABEL };

let streamRef = null;
let recorder = null;
let chunks = [];
let pollTimer = null;
let windowTimer = null;
let wakeAvailable = false;
let wakeHandler = null;
let wakeLogger = () => {};

// 注入诊断日志回调（main.js 传 addLog），避免 wake-service 直接依赖 state.js
// 的顶层副作用（测试环境无 localStorage 会崩）。
export function setWakeLogger(fn) {
  wakeLogger = typeof fn === 'function' ? fn : () => {};
}

export function wakeWordConfigured() {
  return Boolean(WAKE_KEYWORD_LABEL);
}

// 开启持续监听：拿共享流 → 持续录音 → 周期 POST 音频块检测。
export async function startWake({ onWake } = {}) {
  if (onWake) wakeHandler = onWake;
  if (!wakeWordConfigured()) {
    wakeLogger('manual', '唤醒未配置：缺唤醒词标签');
    return { ok: false, message: '未配置唤醒词' };
  }
  try {
    if (!streamRef) streamRef = await requestMicStream();
  } catch {
    wakeLogger('manual', '唤醒失败：无法访问麦克风（权限被拒）');
    return { ok: false, message: '无法访问麦克风' };
  }
  const MediaRecorderCtor = globalThis.MediaRecorder;
  if (!MediaRecorderCtor) {
    releaseMicStream(streamRef);
    streamRef = null;
    wakeLogger('manual', '唤醒失败：浏览器不支持录音');
    return { ok: false, message: '当前浏览器不支持录音' };
  }
  chunks = [];
  try {
    recorder = new MediaRecorderCtor(streamRef, { mimeType: pickMime() || undefined });
  } catch {
    recorder = new MediaRecorderCtor(streamRef);
  }
  recorder.ondataavailable = event => {
    if (event?.data?.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    wakeLogger('manual', '唤醒录音出错，已停止监听');
    stopWake();
  };
  recorder.start(250);
  wakeAvailable = true;
  wakeLogger('manual', `唤醒监听已启动，每 ${WAKE_POLL_INTERVAL_MS}ms 检测（窗口 ${WAKE_WINDOW_MS}ms），说「${WAKE_KEYWORD_LABEL}」`);
  schedulePoll();
  return { ok: true, message: `唤醒已开启，说「${WAKE_KEYWORD_LABEL}」` };
}

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch { /* ignore */ }
  }
  return null;
}

// 周期性取块并检测：MediaRecorder 每 250ms 产一帧累积在 chunks，这里按
// WAKE_WINDOW_MS 取最近 N 帧合成一个滑动窗口 POST 给后端，窗口内的帧保留
// 供下次继续。窗口必须够长容纳完整唤醒词（「小云小云」约 1s，1500ms 窗口
// 实测检测率 100% vs 500ms 的 0%），否则唤醒词被切碎导致漏检。
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!recorder || recorder.state !== 'recording') return;
    if (chunks.length === 0) {
      schedulePoll();
      return;
    }
    const frameMs = 250;
    const maxFrames = Math.max(1, Math.ceil(WAKE_WINDOW_MS / frameMs));
    const windowed = chunks.slice(-maxFrames);
    const blob = new Blob(windowed, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size > 0) {
      const detected = await checkWake(blob);
      if (detected) {
        wakeLogger('ai', `唤醒命中「${WAKE_KEYWORD_LABEL}」`);
        if (wakeHandler) wakeHandler();
      }
    }
    schedulePoll();
  }, WAKE_POLL_INTERVAL_MS);
}

async function checkWake(blob) {
  try {
    const response = await fetch(`${getApiBaseUrl()}/kws/check`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', ...getApiKeyHeader(), ...getAuthHeader() },
      body: blob,
    });
    if (!response || !response.ok) {
      wakeLogger('manual', `唤醒检测请求失败 HTTP ${response?.status ?? '?'}`);
      return false;
    }
    const payload = await response.json();
    return payload?.detected === true;
  } catch {
    wakeLogger('manual', '唤醒检测请求异常（网络/后端不可达）');
    return false;
  }
}

// 关闭持续监听：停录音 + 释放共享流引用。
export async function stopWake() {
  clearTimeout(pollTimer);
  clearTimeout(windowTimer);
  pollTimer = null;
  windowTimer = null;
  if (recorder) {
    try {
      if (recorder.state === 'recording') recorder.stop();
    } catch { /* ignore */ }
    recorder = null;
  }
  chunks = [];
  if (streamRef) {
    releaseMicStream(streamRef);
    streamRef = null;
  }
  wakeAvailable = false;
}

export function isWakeActive() {
  return wakeAvailable;
}

// 供主流程查询（兼容旧接口名）。
export function initWake() {
  return Promise.resolve(wakeAvailable);
}
