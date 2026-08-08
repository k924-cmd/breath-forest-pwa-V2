// Play a base64-encoded audio payload (e.g. MiMo TTS singing output) via a
// shared Web Audio context. Mobile browsers only allow audio after a user
// gesture unlocks the context, so the caller must call unlockAudio() inside
// a click/tap handler before any async work; after that, playback works even
// when it happens later (e.g. after a slow TTS round trip).

let sharedContext = null;

export function getAudioContext() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new Ctor();
  }
  return sharedContext;
}

// Call inside a user gesture (pointerdown / click) to unlock audio playback.
// On iOS Safari the context must be created/resumed during a gesture or all
// later playback is blocked.
export function unlockAudio() {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running' || ctx.state === 'suspended';
}

export function mimeTypeForFormat(format) {
  return {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    pcm: 'audio/wav',
    pcm16: 'audio/wav'
  }[String(format).toLowerCase()] || 'audio/wav';
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Play a base64-encoded audio payload via the shared Web Audio context.
// Resolves true when playback started/finished, false when it could not play.
export function playBase64Audio(audioBase64, format = 'wav') {
  return new Promise((resolve) => {
    const ctx = getAudioContext();
    if (!ctx || typeof audioBase64 !== 'string' || !audioBase64) {
      resolve(false);
      return;
    }
    if (ctx.state === 'suspended') {
      // The context wasn't unlocked by a gesture — attempt to resume anyway;
      // if the browser still blocks it, report failure so the caller can show
      // a fallback instead of silent silence.
      ctx.resume().catch(() => {});
    }
    let audioBuffer;
    try {
      const arrayBuffer = base64ToArrayBuffer(audioBase64);
      audioBuffer = ctx.decodeAudioData(arrayBuffer);
    } catch {
      resolve(false);
      return;
    }
    audioBuffer.then((buffer) => {
      if (!buffer) { resolve(false); return; }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1, ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      const finished = () => {
        source.removeEventListener('ended', finished);
        resolve(true);
      };
      source.addEventListener('ended', finished);
      source.start();
    }).catch(() => resolve(false));
  });
}
