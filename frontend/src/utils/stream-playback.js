// Chunked (pseudo-streaming) playback. The backend synthesizes sentence by
// sentence and pushes base64 chunks over SSE; here we enqueue them and play
// them sequentially through a shared Web Audio context, decodable and
// interruptible like playBase64Interruptible. This cuts perceived latency:
// the first sentence plays while later ones are still being synthesized.

import { getAudioContext } from './play-audio.js?v=20260808-20';

let playbackCounter = 0;
let activeQueue = null;
let activeSource = null;

// Enqueue one base64 chunk for sequential playback. Returns the shared token
// for this playback run, or null when nothing can play.
export function pushStreamChunk(audioBase64, format = 'wav') {
  if (typeof audioBase64 !== 'string' || !audioBase64) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (!activeQueue) {
    playbackCounter += 1;
    activeQueue = { token: playbackCounter, stopped: false, queue: [], playing: false };
  }
  activeQueue.queue.push({ audioBase64, format });
  pumpChunk(ctx);
  return activeQueue.token;
}

function pumpChunk(ctx) {
  if (!activeQueue || activeQueue.playing || activeQueue.stopped) return;
  const next = activeQueue.queue.shift();
  if (!next) return;
  activeQueue.playing = true;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  let arrayBuffer;
  try {
    arrayBuffer = base64ToArrayBuffer(next.audioBase64);
  } catch {
    activeQueue.playing = false;
    pumpChunk(ctx);
    return;
  }
  ctx.decodeAudioData(arrayBuffer).then((buffer) => {
    if (!activeQueue || activeQueue.stopped || !buffer) {
      activeQueue = null;
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);
    activeSource = source;
    source.addEventListener('ended', () => {
      activeSource = null;
      activeQueue.playing = false;
      pumpChunk(ctx);
    });
    source.start();
  }).catch(() => {
    activeQueue.playing = false;
    pumpChunk(ctx);
  });
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Stop all queued and current playback. Accepts an optional token; a token
// that no longer matches the latest playback is ignored.
export function stopStreamPlayback(token) {
  if (!activeQueue) return;
  if (token !== undefined && token !== activeQueue.token) return;
  activeQueue.stopped = true;
  activeQueue.queue.length = 0;
  if (activeSource) {
    try { activeSource.stop(); } catch { /* already stopped */ }
    activeSource = null;
  }
  activeQueue = null;
}
