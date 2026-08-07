export const AUDIO_ERRORS = Object.freeze({
  UNSUPPORTED: '当前浏览器不支持语音输入',
  PERMISSION_DENIED: '麦克风权限被拒绝，请在浏览器设置中允许后重试',
  RECORDER_ERROR: '录音失败，请重试',
  EMPTY: '录音太短，未识别到语音'
});

export const MAX_RECORD_MS = 15000;

const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4'
];

function pickAudioMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return AUDIO_MIME_CANDIDATES.find(mime => MediaRecorder.isTypeSupported(mime)) || null;
}

export function supportsRecording() {
  return typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined';
}

export class AudioRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.mimeType = null;
    this.chunks = [];
    this.stopPromise = null;
    this.hardCap = null;
    this.error = null;
  }

  get recording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  async start() {
    if (!supportsRecording()) throw new Error(AUDIO_ERRORS.UNSUPPORTED);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        throw new Error(AUDIO_ERRORS.PERMISSION_DENIED);
      }
      throw new Error(AUDIO_ERRORS.PERMISSION_DENIED);
    }
    this.stream = stream;
    this.mimeType = pickAudioMimeType();
    this.chunks = [];
    this.error = null;
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(stream, { mimeType: this.mimeType })
        : new MediaRecorder(stream);
    } catch {
      this.mimeType = null;
      this.recorder = new MediaRecorder(stream);
    }
    this.recorder.ondataavailable = event => {
      if (event?.data?.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => {
      this.error = new Error(AUDIO_ERRORS.RECORDER_ERROR);
    };
    this.stopPromise = new Promise(resolve => {
      this.recorder.onstop = () => resolve(this.#settle());
    });
    this.recorder.start(250);
    this.hardCap = setTimeout(() => {
      if (this.recorder?.state === 'recording') this.recorder.stop();
    }, MAX_RECORD_MS + 500);
  }

  async stop() {
    if (!this.recorder) return { blob: null, mimeType: null };
    if (this.recorder.state === 'recording') this.recorder.stop();
    if (this.hardCap) {
      clearTimeout(this.hardCap);
      this.hardCap = null;
    }
    return this.stopPromise;
  }

  #settle() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
    if (this.error) return { blob: null, mimeType: null, error: this.error };
    if (blob.size === 0) return { blob: null, mimeType: null, error: new Error(AUDIO_ERRORS.EMPTY) };
    return { blob, mimeType: blob.type };
  }

  cancel() {
    if (this.hardCap) {
      clearTimeout(this.hardCap);
      this.hardCap = null;
    }
    if (this.recorder && this.recorder.state === 'recording') {
      try {
        this.recorder.stop();
      } catch {
        // 忽略停止时的异常
      }
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }
}
