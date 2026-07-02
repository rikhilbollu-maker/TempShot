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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.offscreen) return;

  (async () => {
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
