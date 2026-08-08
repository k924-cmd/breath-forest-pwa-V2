// Play a base64-encoded audio payload (e.g. MiMo TTS singing output) via a
// transient <audio> element. Resolves when playback finishes or is stopped.

const MIME_BY_FORMAT = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'audio/wav',
  pcm16: 'audio/wav'
});

export function mimeTypeForFormat(format) {
  return MIME_BY_FORMAT[String(format).toLowerCase()] || 'audio/wav';
}

export function playBase64Audio(audioBase64, format = 'wav') {
  return new Promise((resolve) => {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext || typeof audioBase64 !== 'string' || !audioBase64) {
      resolve(false);
      return;
    }
    const mime = mimeTypeForFormat(format);
    const dataUrl = `data:${mime};base64,${audioBase64}`;
    const audio = document.createElement('audio');
    audio.src = dataUrl;
    audio.preload = 'auto';
    const cleanup = () => {
      audio.removeEventListener('ended', cleanup);
      audio.removeEventListener('error', cleanup);
      audio.src = '';
      resolve(true);
    };
    audio.addEventListener('ended', cleanup);
    audio.addEventListener('error', cleanup);
    audio.play().catch(() => {
      audio.removeEventListener('ended', cleanup);
      audio.removeEventListener('error', cleanup);
      resolve(false);
    });
  });
}
