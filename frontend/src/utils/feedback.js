// 全按键反馈：点击音（WebAudio）+ 触感震动，设置由「我的」页开关控制。
// 顶层不引用 window/document/navigator，Node 测试环境安全降级。

export const MATCH_SELECTOR = [
  'button',
  'a[href]',
  'label.switch',
  '[data-tab]',
  '[data-action]',
  '[data-scene]',
  '[data-device]',
  '[data-device-detail]',
  '[data-continuation-id]'
].join(', ');

// 语音按钮是长按操作，短按无功能动作，不应触发普通按键音；录音提示音由 playDing 承担
export const EXCLUDE_SELECTOR = '.voice-tab, [data-action="voice"]';

let boundRoot = null;
let boundHandler = null;
let audioCtx = null;

export function playClickSound() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;

    // 噪声瞬态经低通滤波：保留「嗒」的触感，但切掉高频让它不发尖
    const tickLen = Math.max(1, Math.floor(audioCtx.sampleRate * 0.01));
    const tickBuf = audioCtx.createBuffer(1, tickLen, audioCtx.sampleRate);
    const tickData = tickBuf.getChannelData(0);
    for (let i = 0; i < tickLen; i++) {
      tickData[i] = (Math.random() * 2 - 1) * (1 - i / tickLen);
    }
    const tick = audioCtx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = audioCtx.createBiquadFilter();
    tickFilter.type = 'lowpass';
    tickFilter.frequency.setValueAtTime(700, now);
    const tickGain = audioCtx.createGain();
    tickGain.gain.setValueAtTime(0.0001, now);
    tickGain.gain.exponentialRampToValueAtTime(0.05, now + 0.002);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.01);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(audioCtx.destination);
    tick.start(now);

    // 更低频正弦体：柔和「嘟」底音，听感厚重不尖
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.05);
    oscGain.gain.setValueAtTime(0.0001, now);
    oscGain.gain.exponentialRampToValueAtTime(0.1, now + 0.006);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.075);
    return true;
  } catch {
    return false;
  }
}

export function vibrate(pattern = 15) {
  try {
    const nav = globalThis.navigator;
    if (!nav || typeof nav.vibrate !== 'function') return false;
    return nav.vibrate(pattern);
  } catch {
    return false;
  }
}

export function initFeedback(getSettings, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.addEventListener !== 'function' || typeof getSettings !== 'function') return false;
  if (boundRoot === doc) return true;
  boundHandler = event => {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest(EXCLUDE_SELECTOR)) return;
    if (!target.closest(MATCH_SELECTOR)) return;
    const settings = getSettings() || {};
    if (settings.sound !== false) playClickSound();
    if (settings.vibrate !== false) vibrate();
  };
  doc.addEventListener('click', boundHandler, true);
  boundRoot = doc;
  return true;
}

export function destroyFeedback(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (doc && boundRoot === doc && boundHandler) {
    doc.removeEventListener('click', boundHandler, true);
    boundRoot = null;
    boundHandler = null;
    audioCtx = null;
  }
}
