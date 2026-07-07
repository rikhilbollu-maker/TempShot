/**
 * service_worker.js — TempShot background service worker (Manifest V3).
 *
 * MV3 service workers are event-driven and can be killed at any time when
 * idle, so nothing here relies on long-lived in-memory state except the
 * single in-flight full-page capture (which keeps the worker alive because
 * it is an active async task).
 *
 * Chrome APIs used here:
 *  - chrome.commands.onCommand: the global keyboard shortcut (Alt+Shift+S by
 *    default; user-configurable at chrome://extensions/shortcuts). Pressing
 *    an extension shortcut grants activeTab, which is what allows
 *    captureVisibleTab without broad host permissions.
 *  - chrome.alarms: periodic auto-delete sweep. Alarms survive service-worker
 *    shutdown, unlike setInterval.
 *  - chrome.runtime.onMessage: RPC surface for the popup.
 */

import {
  captureVisible, startFullCapture, cancelFullCapture, getFullCaptureState,
  startRegionCapture, captureRegion, regionCancelled
} from './captureManager.js';
import { purgeExpired } from './storageManager.js';

const PURGE_ALARM = 'tempshot-purge';

function ensurePurgeAlarm() {
  // Re-creating with the same name just resets it; cheap and idempotent.
  chrome.alarms.create(PURGE_ALARM, { periodInMinutes: 15 });
}

chrome.runtime.onInstalled.addListener(ensurePurgeAlarm);
chrome.runtime.onStartup.addListener(ensurePurgeAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PURGE_ALARM) {
    purgeExpired().catch(() => {});
  }
});

// Keyboard shortcuts. Users can rebind (or bind the optional full-page
// shortcut) at chrome://extensions/shortcuts — extensions cannot change
// bindings programmatically; that page is user-controlled by design.
// Pressing a shortcut grants activeTab, so capture works without host perms.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-visible') {
    captureVisible('command').catch(() => {
      // captureVisible already surfaced a notification on failure.
    });
  } else if (command === 'capture-area') {
    startRegionCapture('command').catch(() => {
      // startRegionCapture already surfaced a notification on failure.
    });
  } else if (command === 'capture-fullpage') {
    // Popup is closed during a shortcut capture, so report the outcome via a
    // system notification instead of popup events.
    startFullCapture()
      .then((res) => notify(res.cancelled ? 'Cancelled — partial capture saved.' : 'Full page saved temporarily.'))
      .catch((err) => notify(`Full-page capture failed: ${err?.message || err}`));
  }
});

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'TempShot',
    message,
    silent: true
  });
}

// RPC for popup.js, plus messages from the region-selection overlay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return;

  const respond = (promise) => {
    promise
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // async response
  };

  switch (msg.cmd) {
    case 'captureVisible':
      return respond(captureVisible('popup'));
    case 'captureArea':
      return respond(startRegionCapture('popup'));
    case 'regionSelected':
      // From regionSelector.js in the page: user finished dragging.
      if (sender.tab) return respond(captureRegion(sender.tab, msg.rect, msg.dpr));
      return;
    case 'regionCancelled':
      if (sender.tab) regionCancelled(sender.tab.id);
      sendResponse({ ok: true });
      return;
    case 'startFullCapture':
      // Fire-and-forget: the capture outlives the popup. Progress and
      // completion are broadcast as 'capture-*' events; the popup can also
      // re-sync via getFullCaptureState after reopening.
      startFullCapture().catch(() => {});
      sendResponse({ ok: true, data: getFullCaptureState() });
      return;
    case 'cancelFullCapture':
      cancelFullCapture();
      sendResponse({ ok: true, data: getFullCaptureState() });
      return;
    case 'getFullCaptureState':
      sendResponse({ ok: true, data: getFullCaptureState() });
      return;
    case 'purgeExpired':
      return respond(purgeExpired());
  }
});
