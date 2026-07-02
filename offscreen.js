/**
 * offscreen.js — clipboard fallback for the service worker.
 *
 * Two operations:
 *  - copy-image: copy a data-URL image (fresh visible captures)
 *  - copy-shot:  copy a stored screenshot by id, read straight from the
 *    shared extension IndexedDB (used for large full-page captures so the
 *    image bytes never have to squeeze through the message channel)
 *
 * Technique: navigator.clipboard.write() throws "Document is not focused" in
 * offscreen documents, but the legacy document.execCommand('copy') path works
 * without focus. Selecting a rendered <img> and copying places the bitmap on
 * the system clipboard. Best-effort by design — the preferred path (writing a
 * real PNG from inside the focused captured page) lives in captureManager.
 */

import { getShotBlob } from './storageManager.js';

const img = document.getElementById('stage');

async function copyImageSrc(src) {
  img.src = src;
  await img.decode();
  const range = document.createRange();
  range.selectNode(img);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  return ok;
}

/**
 * Synthesized camera-shutter click via WebAudio — no audio asset to ship,
 * and extension pages are exempt from autoplay gesture requirements.
 */
let audioCtx = null;
function playShutter() {
  audioCtx = audioCtx || new AudioContext();
  const now = audioCtx.currentTime;

  // Sharp descending click (the "shutter")…
  const osc = audioCtx.createOscillator();
  const oscGain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(2200, now);
  osc.frequency.exponentialRampToValueAtTime(320, now + 0.09);
  oscGain.gain.setValueAtTime(0.22, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
  osc.connect(oscGain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.15);

  // …plus a tiny noise tick for texture.
  const len = Math.floor(audioCtx.sampleRate * 0.03);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const noise = audioCtx.createBufferSource();
  const noiseGain = audioCtx.createGain();
  noise.buffer = buf;
  noiseGain.gain.setValueAtTime(0.12, now);
  noise.connect(noiseGain).connect(audioCtx.destination);
  noise.start(now);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.offscreen) return;

  (async () => {
    if (msg.op === 'play-sound') {
      return playShutter();
    }
    if (msg.op === 'copy-image') {
      return copyImageSrc(msg.dataUrl);
    }
    if (msg.op === 'copy-shot') {
      const blob = await getShotBlob(msg.id);
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      try {
        return await copyImageSrc(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return false;
  })()
    .then((ok) => sendResponse({ ok: !!ok }))
    .catch(() => sendResponse({ ok: false }));

  return true; // async sendResponse
});
