/**
 * options.js — TempShot settings page.
 * Settings save immediately on change (no Save button to forget).
 */

import { getSettings, setSettings, clearAllShots } from './storageManager.js';

const $ = (id) => document.getElementById(id);
let statusTimer = null;

function flash(message) {
  $('status').textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2000);
}

(async function init() {
  const settings = await getSettings();
  $('autoDelete').value = String(settings.autoDeleteMs);
  $('autoCopy').checked = settings.autoCopy;
  $('defaultExport').value = settings.defaultExport;

  // Reflect the user's actual shortcut binding, if any.
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'capture-visible');
    if (cmd?.shortcut) $('shortcut').textContent = cmd.shortcut;
    else $('shortcut').textContent = 'not set';
  } catch { /* keep default */ }

  $('autoDelete').addEventListener('change', async (e) => {
    await setSettings({ autoDeleteMs: Number(e.target.value) });
    flash('Saved.');
  });

  $('autoCopy').addEventListener('change', async (e) => {
    await setSettings({ autoCopy: e.target.checked });
    flash('Saved.');
  });

  $('defaultExport').addEventListener('change', async (e) => {
    await setSettings({ defaultExport: e.target.value });
    flash('Saved.');
  });

  $('clearAll').addEventListener('click', async () => {
    if (!confirm('Delete ALL temporary screenshots? This cannot be undone.')) return;
    await clearAllShots();
    flash('All screenshot data cleared.');
  });
})();
