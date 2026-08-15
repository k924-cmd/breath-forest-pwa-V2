// Play base64-encoded audio payloads (e.g. MiMo TTS output) via a shared Web
// Audio context. Mobile browsers only allow audio after a user gesture unlocks
// the context, so the caller must call unlockAudio() inside a click/tap
// handler before any async work; after that, playback works even when it
// happens later (e.g. after a slow TTS round trip).
//
// Playback supports interruption: every play call returns a token; the caller
// keeps the latest token and calls stopPlayback(token) before starting the
// next clip. A token whose number is stale is ignored so a slow decode can't
// restart an interrupted clip.

let sharedContext = null;
let playbackCounter = 0;
let sharedActive = null;

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
    if (typeof audioBase64 !== 'string' || !audioBase64) {
      resolve(false);
      return;
    }
    const ctx = getAudioContext();
    if (!ctx) {
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

// Start (or restart) interruptible playback of a base64 clip. Any clip started
// via this function — including an older token's clip still decoding — is
// stopped before the new one plays. Returns a token whose playback is active,
// or null when the clip could not play.
export function playBase64Interruptible(audioBase64, format = 'wav') {
  if (typeof audioBase64 !== 'string' || !audioBase64) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;
  const token = ++playbackCounter;
  const active = { stopped: false, sources: [] };
  if (sharedActive) {
    for (const node of sharedActive.sources) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    sharedActive.sources.length = 0;
    sharedActive.stopped = true;
  }
  sharedActive = active;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  let arrayBuffer;
  try {
    arrayBuffer = base64ToArrayBuffer(audioBase64);
  } catch {
    if (sharedActive === active) sharedActive = null;
    return null;
  }
  ctx.decodeAudioData(arrayBuffer).then((buffer) => {
    if (!buffer || active.stopped || sharedActive !== active) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);
    const cleanup = () => {
      active.sources = active.sources.filter(node => node !== source);
    };
    source.addEventListener('ended', cleanup);
    active.sources.push(source);
    source.start();
  }).catch(() => {
    if (sharedActive === active) sharedActive = null;
  });
  return token;
}

// Stop the clip that is currently playing. Accepts an optional token; a token
// that no longer matches the latest playback is ignored (the clip it refers to
// is already stopped by a newer play).
export function stopPlayback(token) {
  if (sharedActive && (token === undefined || token === playbackCounter)) {
    for (const node of sharedActive.sources) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    sharedActive.sources.length = 0;
    sharedActive.stopped = true;
    sharedActive = null;
  }
}
