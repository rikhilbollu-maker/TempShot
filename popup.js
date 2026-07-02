/**
 * popup.js — TempShot popup dashboard.
 *
 * The popup is a full extension page: it shares the extension origin with the
 * service worker, so it reads screenshots straight out of the same IndexedDB
 * (no image bytes ever cross the message channel). Captures themselves are
 * delegated to the service worker so a full-page capture keeps running even
 * if the popup closes mid-way — on reopen we re-sync via getFullCaptureState.
 *
 * Clipboard: navigator.clipboard.write with a ClipboardItem works here
 * because the popup document is focused when the user clicks Copy.
 * Downloads: created with URL.createObjectURL + <a download> — no
 * "downloads" permission needed, and nothing is saved unless you click.
 */

import { listShots, getShotBlob, deleteShot, clearAllShots, purgeExpired, getSettings } from './storageManager.js';
import { imageBlobToPdf } from './pdfExporter.js';

const $ = (id) => document.getElementById(id);
const gallery = $('gallery');
const objectUrls = []; // revoked on re-render to avoid leaking blob URLs

let settings = null;
let toastTimer = null;

/* ---------- helpers ---------- */

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ cmd, ...extra });
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function copyShot(id) {
  const blob = await getShotBlob(id);
  if (!blob) throw new Error('Screenshot not found.');
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

async function exportShot(id, format, meta) {
  const blob = await getShotBlob(id);
  if (!blob) throw new Error('Screenshot not found.');
  const stamp = fileStamp(meta.createdAt);
  if (format === 'pdf') {
    const pdf = await imageBlobToPdf(blob);
    downloadBlob(pdf, `tempshot_${stamp}.pdf`);
  } else {
    downloadBlob(blob, `tempshot_${stamp}.png`);
  }
}

/* ---------- gallery rendering ---------- */

async function render() {
  const shots = await listShots();

  for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u);
  gallery.textContent = '';
  $('empty').classList.toggle('hidden', shots.length > 0);
  $('btn-copy-latest').disabled = shots.length === 0;
  $('btn-clear').disabled = shots.length === 0;

  for (const shot of shots) {
    const li = document.createElement('li');
    li.className = 'card';

    // Thumbnail (click → full preview page)
    const thumbLink = document.createElement('a');
    thumbLink.className = 'thumb';
    thumbLink.title = 'Open full preview';
    const img = document.createElement('img');
    if (shot.thumb) {
      const u = URL.createObjectURL(shot.thumb);
      objectUrls.push(u);
      img.src = u;
    }
    img.alt = shot.title || 'screenshot';
    thumbLink.appendChild(img);
    thumbLink.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${shot.id}`) });
    });
    li.appendChild(thumbLink);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = shot.title || shot.url || 'Untitled';
    title.title = shot.url || '';
    meta.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'sub';
    const badge = document.createElement('span');
    badge.className = `badge ${shot.kind}`;
    badge.textContent = shot.kind === 'fullpage'
      ? `Full page · ${shot.width}×${shot.height}`
      : 'Visible';
    sub.appendChild(badge);
    sub.appendChild(document.createTextNode(relativeTime(shot.createdAt)));
    meta.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const addBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', async () => {
        try { await fn(); } catch (err) { toast(err.message || String(err), true); }
      });
      actions.appendChild(b);
    };

    addBtn('Copy', '', async () => {
      await copyShot(shot.id);
      toast('Copied to clipboard.');
    });

    if (shot.kind === 'fullpage') {
      // Full-page shots get both export formats; the settings default decides
      // the button order so your preferred one is first.
      const order = settings.defaultExport === 'pdf' ? ['pdf', 'png'] : ['png', 'pdf'];
      for (const fmt of order) {
        addBtn(fmt.toUpperCase(), '', () => exportShot(shot.id, fmt, shot));
      }
    } else {
      addBtn('Download', '', () => exportShot(shot.id, 'png', shot));
    }

    addBtn('Preview', '', async () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${shot.id}`) });
    });
    addBtn('Delete', 'del', async () => {
      await deleteShot(shot.id);
      await render();
    });

    meta.appendChild(actions);
    li.appendChild(meta);
    gallery.appendChild(li);
  }
}

/* ---------- full-page capture progress ---------- */

function showProgress(current, total) {
  $('progress').classList.remove('hidden');
  $('btn-fullpage').disabled = true;
  $('progress-label').textContent = total
    ? `Capturing section ${Math.min(current + 1, total)} of ${total}…`
    : 'Preparing capture…';
  $('progress-bar').style.width = total ? `${Math.round((current / total) * 100)}%` : '0%';
}

function hideProgress() {
  $('progress').classList.add('hidden');
  $('btn-fullpage').disabled = false;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.evt) return;
  switch (msg.evt) {
    case 'shots-updated':
      render();
      break;
    case 'capture-progress':
      showProgress(msg.current, msg.total);
      break;
    case 'capture-done':
      hideProgress();
      toast(msg.cancelled ? 'Cancelled — partial capture saved.' : 'Full page saved temporarily.');
      break;
    case 'capture-error':
      hideProgress();
      toast(msg.message || 'Full-page capture failed.', true);
      break;
  }
});

/* ---------- wire up controls ---------- */

$('btn-capture').addEventListener('click', async () => {
  $('btn-capture').disabled = true;
  try {
    const res = await send('captureVisible');
    if (!res?.ok) throw new Error(res?.error || 'Capture failed.');
    toast(res.data.copied ? 'Saved temporarily and copied.' : 'TempShot saved temporarily.');
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    $('btn-capture').disabled = false;
  }
});

$('btn-fullpage').addEventListener('click', async () => {
  showProgress(0, 0);
  const res = await send('startFullCapture');
  if (!res?.ok) {
    hideProgress();
    toast(res?.error || 'Could not start capture.', true);
  }
});

$('btn-cancel').addEventListener('click', () => send('cancelFullCapture'));

$('btn-copy-latest').addEventListener('click', async () => {
  try {
    const shots = await listShots();
    if (!shots.length) return;
    await copyShot(shots[0].id);
    toast('Latest screenshot copied.');
  } catch (err) {
    toast(err.message || String(err), true);
  }
});

$('btn-clear').addEventListener('click', async () => {
  if (!confirm('Delete all temporary screenshots?')) return;
  await clearAllShots();
  await render();
  toast('All screenshots cleared.');
});

$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Deep-link into Chrome's protected shortcut editor — extensions can open it,
// but only the user can change bindings there (anti-hijacking rule).
$('edit-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

/* ---------- init ---------- */

(async function init() {
  settings = await getSettings();

  // Show the user's actual shortcut (they may have rebound it at
  // chrome://extensions/shortcuts).
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'capture-visible');
    $('shortcut-hint').textContent = cmd?.shortcut
      ? `Shortcut: ${cmd.shortcut}`
      : 'No shortcut set — configure one at chrome://extensions/shortcuts';
  } catch { /* keep default hint */ }

  // Sweep expired shots on open so the gallery never shows stale items.
  await purgeExpired().catch(() => {});
  await render();

  // If a full-page capture is mid-flight (popup was closed and reopened),
  // resume showing its progress.
  const state = await send('getFullCaptureState');
  if (state?.ok && state.data.active) {
    showProgress(state.data.current, state.data.total);
  }
})();
