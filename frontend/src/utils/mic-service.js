// Shared microphone stream holder. getUserMedia is a permission-gated,
// relatively expensive call, so we request the stream once per session and
// hand the same stream to every consumer (AudioRecorder, wake-word listener)
// via reference counting. The stream is only stopped when the last consumer
// releases it. This is what lets a long-press recording start without a
// permission prompt after the first warm-up.

let micStream = null;
let refCount = 0;
let pendingPromise = null;

export const MIC_ERRORS = Object.freeze({
  PERMISSION_DENIED: '麦克风权限被拒绝，请在浏览器设置中允许后重试',
  UNSUPPORTED: '当前浏览器不支持麦克风'
});

function toError(error) {
  const hint = `${String(error?.name || '')} ${String(error?.message || '')}`;
  if (hint.includes('NotAllowed') || hint.includes('Security') || hint.includes('Permission')) {
    return new Error(MIC_ERRORS.PERMISSION_DENIED);
  }
  return new Error(error?.message || MIC_ERRORS.UNSUPPORTED);
}

// Returns the shared MediaStream, creating it on first request. Rejected with
// a friendly error when the browser blocks or lacks mic support.
export async function requestMicStream() {
  if (micStream && micStream.getAudioTracks().some(track => track.readyState === 'live')) {
    refCount += 1;
    return micStream;
  }
  if (pendingPromise) return pendingPromise;
  pendingPromise = (async () => {
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      throw new Error(MIC_ERRORS.UNSUPPORTED);
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw toError(error);
    }
    refCount = 1;
    return micStream;
  })().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}

// Release a reference obtained via requestMicStream. The underlying stream is
// stopped only when every reference has been released.
export function releaseMicStream(stream) {
  if (stream && stream !== micStream) return;
  if (refCount > 0) refCount -= 1;
  if (refCount === 0 && micStream) {
    (micStream.getTracks?.() ?? micStream.getAudioTracks?.() ?? []).forEach(track => track.stop());
    micStream = null;
  }
}

// Best-effort permission introspection. Only Android Chrome reliably answers
// 'granted'; iOS Safari ignores the query entirely. Treat the result as a hint
// only — the getUserMedia result is authoritative.
export async function getMicPermissionState() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.permissions?.query !== 'function') return 'prompt';
    const { state } = await navigator.permissions.query({ name: 'microphone' });
    return state === 'granted' || state === 'denied' ? state : 'prompt';
  } catch {
    return 'prompt';
  }
}

// 强制释放并清空模块级缓存（应用退出 / 测试清理用）。
export function destroyMicStream() {
  if (micStream) {
    (micStream.getTracks?.() ?? micStream.getAudioTracks?.() ?? []).forEach(track => track.stop());
  }
  micStream = null;
  refCount = 0;
  pendingPromise = null;
}
