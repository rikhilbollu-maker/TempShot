/**
 * storageManager.js — local-only persistence for TempShot.
 *
 * Screenshots are stored in IndexedDB, NOT chrome.storage.local, because
 * chrome.storage.local has a 10 MB quota by default and serializes values
 * to JSON (no Blob support). IndexedDB stores Blobs natively and has a much
 * larger quota, which matters for full-page captures that can be many MB.
 *
 * Two object stores:
 *   - "shots": lightweight metadata + a small thumbnail Blob (fast gallery)
 *   - "blobs": the full-resolution image Blob, keyed by the same id
 *
 * Settings (tiny JSON) live in chrome.storage.local, which is the right tool
 * for small key/value config and is synchronously available to all contexts.
 *
 * Everything here is local to the browser profile. Nothing is uploaded.
 */

const DB_NAME = 'tempshot';
const DB_VERSION = 1;

export const DEFAULT_SETTINGS = {
  // Auto-delete window in milliseconds. 0 = never auto-delete.
  autoDeleteMs: 24 * 60 * 60 * 1000, // default: 24 hours ("temporary" by design)
  // Copy the screenshot to the clipboard immediately after capture.
  // On by default to match the macOS screenshot-to-clipboard workflow.
  autoCopy: true,
  // Default export format for full-page captures: 'png' | 'pdf'.
  defaultExport: 'png'
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shots')) {
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    t.onerror = () => reject(t.error);
  });
  return { t, done };
}

/**
 * Save a screenshot. `meta` holds id/createdAt/title/url/kind/width/height/thumb,
 * `blob` is the full-resolution PNG.
 */
export async function saveShot(meta, blob) {
  const db = await openDb();
  const { t, done } = tx(db, ['shots', 'blobs'], 'readwrite');
  t.objectStore('shots').put(meta);
  t.objectStore('blobs').put({ id: meta.id, blob });
  await done;
}

/** List all shot metadata (with thumbnails), newest first. */
export async function listShots() {
  const db = await openDb();
  const { t, done } = tx(db, ['shots'], 'readonly');
  const req = t.objectStore('shots').getAll();
  await done;
  const shots = req.result || [];
  shots.sort((a, b) => b.createdAt - a.createdAt);
  return shots;
}

/** Get the full-resolution Blob for one shot. */
export async function getShotBlob(id) {
  const db = await openDb();
  const { t, done } = tx(db, ['blobs'], 'readonly');
  const req = t.objectStore('blobs').get(id);
  await done;
  return req.result ? req.result.blob : null;
}

/** Get metadata for one shot. */
export async function getShotMeta(id) {
  const db = await openDb();
  const { t, done } = tx(db, ['shots'], 'readonly');
  const req = t.objectStore('shots').get(id);
  await done;
  return req.result || null;
}

export async function deleteShot(id) {
  const db = await openDb();
  const { t, done } = tx(db, ['shots', 'blobs'], 'readwrite');
  t.objectStore('shots').delete(id);
  t.objectStore('blobs').delete(id);
  await done;
}

export async function clearAllShots() {
  const db = await openDb();
  const { t, done } = tx(db, ['shots', 'blobs'], 'readwrite');
  t.objectStore('shots').clear();
  t.objectStore('blobs').clear();
  await done;
}

/**
 * Delete shots older than the configured auto-delete window.
 * Called from a chrome.alarms handler and on popup open, so expired shots
 * disappear even if the service worker was asleep at the exact expiry time.
 */
export async function purgeExpired() {
  const settings = await getSettings();
  if (!settings.autoDeleteMs) return 0; // 0 = never
  const cutoff = Date.now() - settings.autoDeleteMs;
  const shots = await listShots();
  const expired = shots.filter((s) => s.createdAt < cutoff);
  for (const s of expired) await deleteShot(s.id);
  return expired.length;
}

/** Settings live in chrome.storage.local — small JSON only, never images. */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
