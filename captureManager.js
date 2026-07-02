/**
 * captureManager.js — capture orchestration for TempShot.
 *
 * Key Chrome APIs used:
 *  - chrome.tabs.captureVisibleTab(): screenshots the visible area of the
 *    active tab as a data URL. Requires the activeTab grant (given when the
 *    user clicks the toolbar popup or presses the extension shortcut) — no
 *    broad host permissions needed. It is rate-limited by Chrome
 *    (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2), which is why the scroll
 *    capture loop enforces a minimum gap between captures.
 *  - chrome.scripting.executeScript(): injects contentScript.js on demand for
 *    scroll capture. Fails on restricted pages (chrome://, chrome-extension://,
 *    the Chrome Web Store, and Chrome's built-in PDF viewer) — we surface a
 *    friendly error instead.
 *
 * Full-page capture runs entirely in the service worker so it keeps going
 * even if the user closes the popup mid-capture. The popup re-queries state
 * (getFullCaptureState) whenever it reopens.
 */

import { saveShot, getSettings } from './storageManager.js';
import { stitchSegments, makeThumbnail } from './stitcher.js';

// Chrome caps captureVisibleTab at 2 calls/sec; stay safely under it.
const MIN_CAPTURE_INTERVAL_MS = 600;
// Hard cap on segments — protects against infinite-scroll pages that grow
// forever, and keeps the stitched canvas within memory limits.
const MAX_SEGMENTS = 40;
// Let layout + lazy-loaded content settle after each scroll step.
const SCROLL_SETTLE_MS = 350;

let lastCaptureTime = 0;

// Single in-flight full-page capture state (queryable by the popup).
const fullCapture = {
  active: false,
  cancelled: false,
  current: 0,
  total: 0,
  tabId: null,
  error: null
};

export function getFullCaptureState() {
  const { active, cancelled, current, total, error } = fullCapture;
  return { active, cancelled, current, total, error };
}

export function cancelFullCapture() {
  if (fullCapture.active) fullCapture.cancelled = true;
}

function broadcast(msg) {
  // Popup may be closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Respect Chrome's captureVisibleTab rate limit. */
async function rateLimitedCapture(windowId) {
  const wait = lastCaptureTime + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  lastCaptureTime = Date.now();
  return dataUrl;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('view-source:') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return tab;
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, { tempshot: true, ...msg });
}

/**
 * Copy a captured image to the clipboard (macOS-screenshot-style auto-copy).
 * The service worker has no DOM and therefore no clipboard, so two paths:
 *
 *  1. Preferred: run navigator.clipboard.write() inside the captured page.
 *     The page is focused (the user just pressed the shortcut there), so
 *     this puts a real PNG on the clipboard.
 *  2. Fallback: an offscreen document (chrome.offscreen, reason CLIPBOARD)
 *     that copies via execCommand — works even on pages that block script
 *     injection, like Chrome's PDF viewer and chrome:// pages.
 */
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy captured screenshots to the clipboard'
    });
  } catch (err) {
    // Another capture may have raced us to create it; that's fine.
    if (!String(err).toLowerCase().includes('single offscreen')) throw err;
  }
}

async function offscreenSend(payload) {
  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({ offscreen: true, ...payload });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * Service workers have no FileReader; base64-encode manually. Used to hand
 * full-page captures to the in-page clipboard writer.
 */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/**
 * Post-capture feedback so a shortcut capture is unmistakable without
 * opening the popup:
 *  - white flash + fading status pill injected into the page (macOS-style)
 *  - a brief ✓ badge on the toolbar icon (works even on restricted pages
 *    where injection fails)
 * Injection happens strictly AFTER captureVisibleTab so the overlay never
 * appears in the screenshot itself.
 */
async function signalCaptured(tabId, label) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1800);
  } catch { /* badge is nice-to-have */ }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [label],
      func: (text) => {
        const Z = 2147483647;
        const flash = document.createElement('div');
        flash.style.cssText =
          `position:fixed;inset:0;background:#fff;opacity:0.55;z-index:${Z};` +
          'pointer-events:none;transition:opacity 220ms ease-out';
        document.documentElement.appendChild(flash);
        requestAnimationFrame(() => {
          flash.style.opacity = '0';
          setTimeout(() => flash.remove(), 260);
        });

        const pill = document.createElement('div');
        pill.textContent = text;
        pill.style.cssText =
          `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:${Z};` +
          'background:rgba(23,24,28,.92);color:#fff;padding:8px 14px;border-radius:999px;' +
          'font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
          'pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
          'opacity:0;transition:opacity 180ms ease-out';
        document.documentElement.appendChild(pill);
        requestAnimationFrame(() => { pill.style.opacity = '1'; });
        setTimeout(() => {
          pill.style.opacity = '0';
          setTimeout(() => pill.remove(), 220);
        }, 1700);
      }
    });
  } catch { /* restricted page — badge and sound already covered it */ }
}

async function copyToClipboard(tabId, dataUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [dataUrl],
      func: async (url) => {
        try {
          const blob = await (await fetch(url)).blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return true;
        } catch {
          return false;
        }
      }
    });
    if (results?.[0]?.result === true) return true;
  } catch {
    // Injection blocked (PDF viewer, chrome:// pages, Web Store) — fall through.
  }
  return offscreenSend({ op: 'copy-image', dataUrl });
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'TempShot',
    message,
    silent: true
  });
}

/**
 * Capture the visible area of the active tab and save it temporarily.
 * Default behavior is SAVE, never download — that is the whole point.
 *
 * @param {'popup'|'command'} source — commands show a system notification
 *        (the popup isn't open); popup captures show an inline toast instead.
 */
export async function captureVisible(source) {
  const tab = await getActiveTab();

  let dataUrl;
  try {
    dataUrl = await rateLimitedCapture(tab.windowId);
  } catch (err) {
    const hint = isRestrictedUrl(tab.url)
      ? 'This page is restricted by Chrome (browser pages, the Web Store, and other extensions cannot be captured).'
      : (err?.message || 'Capture failed.');
    if (source === 'command') notify(`Capture failed: ${hint}`);
    throw new Error(hint);
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const meta = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    title: tab.title || '',
    url: tab.url || '',
    kind: 'visible',
    width: bitmap.width,
    height: bitmap.height,
    thumb: await makeThumbnail(blob)
  };
  bitmap.close();
  await saveShot(meta, blob);

  const settings = await getSettings();
  let copied = false;
  if (settings.autoCopy) {
    copied = await copyToClipboard(tab.id, dataUrl);
  }

  // Flash + pill + toolbar badge — after the capture, so none of it appears
  // in the screenshot.
  await signalCaptured(
    tab.id,
    copied ? 'TempShot saved · copied to clipboard' : 'TempShot saved temporarily'
  );

  if (source === 'command') {
    notify(copied ? 'Saved temporarily and copied to clipboard.' : 'TempShot saved temporarily.');
  }
  broadcast({ evt: 'shots-updated' });
  return { id: meta.id, copied };
}

/**
 * Full-page scroll capture: inject content script → measure → scroll top to
 * bottom capturing each viewport → stitch → save to the temporary gallery.
 *
 * Limitations (by design of the Chrome platform):
 *  - Does not work on chrome:// pages, other extensions, or the Web Store.
 *  - Chrome's built-in PDF viewer is rendered in an internal surface that
 *    content scripts cannot scroll or measure, so full-page capture of
 *    browser-viewed PDFs generally fails; the visible-area shortcut still
 *    works there page-by-page. Some PDF-like pages (e.g. HTML-rendered
 *    viewers such as Google Docs' viewer) do work since they are normal DOM.
 */
export async function startFullCapture() {
  if (fullCapture.active) throw new Error('A full-page capture is already running.');

  const tab = await getActiveTab();
  if (isRestrictedUrl(tab.url)) {
    throw new Error('This page is restricted by Chrome and cannot be scroll-captured.');
  }

  Object.assign(fullCapture, {
    active: true, cancelled: false, current: 0, total: 0, tabId: tab.id, error: null
  });

  const segments = [];
  let metrics = null;
  let injected = false;

  try {
    // Inject on demand — contentScript.js guards against double injection.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScript.js'] });
      injected = true;
    } catch (err) {
      throw new Error(
        'Could not access this page. Chrome blocks extensions on browser pages, ' +
        'the Web Store, and its built-in PDF viewer. ' + (err?.message || '')
      );
    }

    metrics = await sendToTab(tab.id, { op: 'measure' });
    if (!metrics || !metrics.viewportHeight) throw new Error('Could not measure the page.');

    // Chrome's built-in PDF viewer renders inside an internal <embed> that no
    // extension can scroll or read — scroll capture there would just repeat
    // the same frame. Fail fast with actionable guidance instead.
    if (metrics.isPdf) {
      throw new Error(
        "This is Chrome's built-in PDF viewer, which extensions cannot scroll. " +
        'Options: capture each page with the visible-area shortcut, or press ' +
        '⌘P / Ctrl+P and "Save as PDF" to keep the original file.'
      );
    }

    const total = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(metrics.scrollHeight / metrics.viewportHeight)));
    fullCapture.total = total;
    broadcast({ evt: 'capture-progress', current: 0, total });

    await sendToTab(tab.id, { op: 'prepare' });

    let prevY = -1;
    for (let i = 0; i < total; i++) {
      if (fullCapture.cancelled) break;

      const targetY = i * metrics.viewportHeight;
      const pos = await sendToTab(tab.id, { op: 'scrollTo', y: targetY, settleMs: SCROLL_SETTLE_MS });

      // Page was shorter than measured (or stopped growing): we're at the
      // bottom when the scroll position stops advancing.
      if (pos.y <= prevY) break;
      prevY = pos.y;

      const dataUrl = await rateLimitedCapture(tab.windowId);
      segments.push({ y: pos.y, dataUrl });

      // After the first frame, hide fixed/sticky elements so headers and
      // cookie bars don't repeat in every stitched section.
      if (i === 0 && total > 1) {
        await sendToTab(tab.id, { op: 'hideFixed' }).catch(() => {});
      }

      fullCapture.current = segments.length;
      broadcast({ evt: 'capture-progress', current: segments.length, total });
    }

    if (!segments.length) {
      throw new Error(fullCapture.cancelled ? 'Capture cancelled.' : 'No sections were captured.');
    }

    const stitched = await stitchSegments(segments, metrics);
    const meta = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      title: (metrics.title || tab.title || '') + (fullCapture.cancelled ? ' (partial)' : ''),
      url: metrics.url || tab.url || '',
      kind: 'fullpage',
      width: stitched.width,
      height: stitched.height,
      thumb: await makeThumbnail(stitched.blob)
    };
    await saveShot(meta, stitched.blob);

    // Auto-copy applies to full-page captures too, using the same reliable
    // in-page clipboard path as visible captures (full-page only works on
    // normal pages, so injection is available). Very large stitches skip the
    // base64 round-trip and fall back to the offscreen document, which reads
    // the blob back from IndexedDB by id.
    const settings = await getSettings();
    let copied = false;
    if (settings.autoCopy) {
      const MAX_INLINE_COPY_BYTES = 24 * 1024 * 1024;
      if (stitched.blob.size <= MAX_INLINE_COPY_BYTES) {
        copied = await copyToClipboard(tab.id, await blobToDataUrl(stitched.blob));
      } else {
        copied = await offscreenSend({ op: 'copy-shot', id: meta.id });
      }
    }

    // Same unmistakable feedback as visible captures (flash, pill, badge) —
    // the popup may be closed, especially for shortcut captures.
    await signalCaptured(
      tab.id,
      copied ? 'Full page saved · copied to clipboard' : 'Full page saved temporarily'
    );

    broadcast({ evt: 'shots-updated' });
    broadcast({ evt: 'capture-done', id: meta.id, cancelled: fullCapture.cancelled });
    return { id: meta.id, cancelled: fullCapture.cancelled };
  } catch (err) {
    fullCapture.error = err?.message || String(err);
    broadcast({ evt: 'capture-error', message: fullCapture.error });
    throw err;
  } finally {
    // Always restore the page: unhide fixed elements, restore scroll position.
    if (injected) {
      try { await sendToTab(tab.id, { op: 'cleanup' }); } catch { /* tab may be gone */ }
    }
    fullCapture.active = false;
    fullCapture.cancelled = false;
  }
}
