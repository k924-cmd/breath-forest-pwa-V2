// 「小云小云」语音唤醒服务。
//
// 检测在后端完成：本服务复用 mic-service 的共享流，用一个 MediaRecorder
// 持续录音，每 WAKE_POLL_INTERVAL_MS 把最近积累的音频块 POST 给
// /v1/kws/check（后端跑 FunASR cFSMN 模型，或本地模拟检测器），
// 命中即回调 onWake。前端不感知真实/模拟差异。
//
// 降级：无麦克风权限 / 后端不可达 / 流不可用 → 置 wakeAvailable=false，
// 静默停用，不影响录音、播报等其他功能。

import { WAKE_KEYWORD_LABEL, WAKE_POLL_INTERVAL_MS, WAKE_WINDOW_MS } from '../config.js?v=20260808-16';
import { getApiBaseUrl, getApiKeyHeader, getAuthHeader } from '../services/conversation-service.js?v=20260808-16';
import { requestMicStream, releaseMicStream } from '../utils/mic-service.js?v=20260808-16';

export { WAKE_KEYWORD_LABEL };

let streamRef = null;
let recorder = null;
let chunks = [];
let pollTimer = null;
let windowTimer = null;
let wakeAvailable = false;
let wakeHandler = null;

export function wakeWordConfigured() {
  return Boolean(WAKE_KEYWORD_LABEL);
}

// 开启持续监听：拿共享流 → 持续录音 → 周期 POST 音频块检测。
export async function startWake({ onWake } = {}) {
  if (onWake) wakeHandler = onWake;
  if (!wakeWordConfigured()) return { ok: false, message: '未配置唤醒词' };
  try {
    if (!streamRef) streamRef = await requestMicStream();
  } catch {
    return { ok: false, message: '无法访问麦克风' };
  }
  const MediaRecorderCtor = globalThis.MediaRecorder;
  if (!MediaRecorderCtor) {
    releaseMicStream(streamRef);
    streamRef = null;
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
    stopWake();
  };
  recorder.start(250);
  wakeAvailable = true;
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

// 周期性取块并检测：每次拿自上次检测以来的新块，合并为最近 WINDOW 窗口。
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!recorder || recorder.state !== 'recording') return;
    const recent = chunks.splice(0, chunks.length);
    if (recent.length === 0) {
      schedulePoll();
      return;
    }
    const blob = new Blob(recent, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size > 0) {
      const detected = await checkWake(blob);
      if (detected && wakeHandler) wakeHandler();
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
    if (!response || !response.ok) return false;
    const payload = await response.json();
    return payload?.detected === true;
  } catch {
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
