export const AUDIO_ERRORS = Object.freeze({
  UNSUPPORTED: '当前浏览器不支持语音输入',
  PERMISSION_DENIED: '麦克风权限被拒绝，请在浏览器设置中允许后重试',
  RECORDER_ERROR: '录音失败，请重试',
  EMPTY: '录音太短，未识别到语音'
});

export const MAX_RECORD_MS = 8000;
// VAD 静音检测：低于该音量视为静音，连续静音超过 vadSilenceMs 自动停止。
export const VAD_THRESHOLD = 0.02;
export const VAD_SILENCE_MS = 1200;

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
  constructor(options = {}) {
    this.stream = null;
    this.recorder = null;
    this.mimeType = null;
    this.chunks = [];
    this.stopPromise = null;
    this.hardCap = null;
    this.error = null;
    // true 表示本实例自己申请了 stream（非共享流），stop 时必须 stop tracks。
    this.ownsStream = false;
    // VAD 静音检测：默认开启；开启后检测到连续静音自动停止录音。
    this.enableVad = options.enableVad !== false;
    this.vadThreshold = options.vadThreshold ?? VAD_THRESHOLD;
    this.vadSilenceMs = options.vadSilenceMs ?? VAD_SILENCE_MS;
    this.analyser = null;
    this.vadTimer = null;
    this.vadContext = null;
    this.silenceStart = null;
  }

  get recording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  async start(options = {}) {
    if (!supportsRecording()) throw new Error(AUDIO_ERRORS.UNSUPPORTED);
    let stream;
    if (options.stream) {
      // 复用外部提供的共享流（由 mic-service 持有），本实例不拥有它。
      stream = options.stream;
      this.ownsStream = false;
    } else {
      const { requestMicStream } = await import('./mic-service.js?v=20260808-19');
      try {
        stream = await requestMicStream();
      } catch (error) {
        if (error?.message === '当前浏览器不支持麦克风') throw new Error(AUDIO_ERRORS.UNSUPPORTED);
        throw new Error(AUDIO_ERRORS.PERMISSION_DENIED);
      }
      this.ownsStream = true;
    }
    this.stream = stream;
    this.mimeType = pickAudioMimeType();
    this.chunks = [];
    this.error = null;
    // 固定低码率：语音 ASR 只需 16kHz 清晰度，webm/opus 默认 128kbps 会让
    // 15s 录音达数百 KB，真机经隧道上传慢（实测 18s）。16kbps 语音足够且
    // 上传体积缩小 8 倍。
    const bitsPerSecond = 16000;
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(stream, { mimeType: this.mimeType, audioBitsPerSecond: bitsPerSecond })
        : new MediaRecorder(stream, { audioBitsPerSecond: bitsPerSecond });
    } catch {
      this.mimeType = null;
      this.recorder = new MediaRecorder(stream, { audioBitsPerSecond: bitsPerSecond });
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
    if (this.enableVad) this.#startVad();
  }

  // VAD：用 Web Audio 分析器周期性读取音量，连续静音超过 vadSilenceMs 自动停止。
  #startVad() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor || typeof this.stream?.getAudioTracks !== 'function' || !this.stream.getAudioTracks().length) return;
    try {
      this.vadContext = new Ctor();
      const source = this.vadContext.createMediaStreamSource(this.stream);
      this.analyser = this.vadContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      this.silenceStart = null;
      this.vadTimer = setInterval(() => {
        if (!this.recorder || this.recorder.state !== 'recording') {
          this.#stopVad();
          return;
        }
        const data = new Uint8Array(this.analyser.fftSize);
        this.analyser.getByteTimeDomainData(data);
        const rms = this.#rms(data);
        if (rms < this.vadThreshold) {
          if (this.silenceStart === null) this.silenceStart = Date.now();
          else if (Date.now() - this.silenceStart >= this.vadSilenceMs) {
            if (this.recorder.state === 'recording') {
              this.#stopVad();
              this.recorder.stop();
            }
          }
        } else {
          this.silenceStart = null;
        }
      }, 200);
    } catch {
      this.#stopVad();
    }
  }

  #rms(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  #stopVad() {
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
    this.silenceStart = null;
    if (this.vadContext) { try { this.vadContext.close(); } catch { /* ignore */ } this.vadContext = null; }
    this.analyser = null;
  }

  async stop() {
    if (!this.recorder) return { blob: null, mimeType: null };
    this.#stopVad();
    if (this.recorder.state === 'recording') this.recorder.stop();
    if (this.hardCap) {
      clearTimeout(this.hardCap);
      this.hardCap = null;
    }
    return this.stopPromise;
  }

  async #settle() {
    if (this.ownsStream) {
      this.stream?.getTracks().forEach(track => track.stop());
    } else {
      // 共享流：只释放引用，不 stop tracks（由 mic-service 归零后统一停）。
      const { releaseMicStream } = await import('./mic-service.js?v=20260808-19');
      if (this.stream) releaseMicStream(this.stream);
    }
    this.stream = null;
    const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
    if (this.error) return { blob: null, mimeType: null, error: this.error };
    if (blob.size === 0) return { blob: null, mimeType: null, error: new Error(AUDIO_ERRORS.EMPTY) };
    return { blob, mimeType: blob.type };
  }

  async cancel() {
    this.#stopVad();
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
    if (this.ownsStream) {
      this.stream?.getTracks().forEach(track => track.stop());
    } else if (this.stream) {
      const { releaseMicStream } = await import('./mic-service.js?v=20260808-19');
      releaseMicStream(this.stream);
    }
    this.stream = null;
  }
}
