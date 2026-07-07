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

  // Reflect the user's actual shortcut bindings. Chrome forbids extensions
  // from *setting* shortcuts (anti-hijacking rule), but we can read them and
  // deep-link into Chrome's shortcut editor.
  async function refreshShortcuts() {
    try {
      const commands = await chrome.commands.getAll();
      const label = (name) => {
        const cmd = commands.find((c) => c.name === name);
        return cmd?.shortcut || 'not set';
      };
      $('shortcut-area').textContent = label('capture-area');
      $('shortcut-visible').textContent = label('capture-visible');
      $('shortcut-fullpage').textContent = label('capture-fullpage');
    } catch { /* keep defaults */ }
  }
  await refreshShortcuts();
  // Re-read when the user comes back from the shortcut editor, so their new
  // binding shows up here without a reload.
  window.addEventListener('focus', refreshShortcuts);

  $('editShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

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
