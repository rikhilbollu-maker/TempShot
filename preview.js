/**
 * preview.js — full-size screenshot viewer (preview.html?id=<shotId>).
 * Loads directly from the shared IndexedDB; works after the popup closes.
 */

import { getShotMeta, getShotBlob, deleteShot } from './storageManager.js';
import { imageBlobToPdf } from './pdfExporter.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

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

function notFound() {
  $('title').textContent = 'TempShot';
  $('msg').hidden = false;
  for (const b of ['copy', 'png', 'pdf', 'del']) $(b).disabled = true;
}

(async function init() {
  const meta = id ? await getShotMeta(id) : null;
  const blob = id ? await getShotBlob(id) : null;
  if (!meta || !blob) return notFound();

  document.title = `TempShot — ${meta.title || 'preview'}`;
  $('title').textContent = meta.title || meta.url || 'Screenshot';
  const kind = meta.kind === 'fullpage' ? 'Full page' : 'Visible area';
  $('sub').textContent = `${kind} · ${meta.width}×${meta.height} · ${new Date(meta.createdAt).toLocaleString()} · ${meta.url}`;

  const img = $('img');
  img.src = URL.createObjectURL(blob);
  img.hidden = false;

  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    $('copy').textContent = 'Copied!';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  });

  $('png').addEventListener('click', () => downloadBlob(blob, `tempshot_${fileStamp(meta.createdAt)}.png`));

  $('pdf').addEventListener('click', async () => {
    $('pdf').disabled = true;
    try {
      const pdf = await imageBlobToPdf(blob);
      downloadBlob(pdf, `tempshot_${fileStamp(meta.createdAt)}.pdf`);
    } finally {
      $('pdf').disabled = false;
    }
  });

  $('del').addEventListener('click', async () => {
    if (!confirm('Delete this screenshot?')) return;
    await deleteShot(id);
    notFound();
    $('img').hidden = true;
  });
})();
