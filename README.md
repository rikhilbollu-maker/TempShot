# TempShot

**Temporary screenshots for AI workflows.** Fast, private, local, minimal.

TempShot solves one annoying problem: taking screenshots for AI chats (Claude,
ChatGPT, etc.) clutters your desktop and Downloads folder with files you'll
never open again. TempShot keeps screenshots *temporarily inside the
extension* — copy or download them only when you actually need to, and let the
rest auto-expire.

> Press shortcut → screenshot saved temporarily → paste into your AI tool → no desktop clutter.

## Features

### Temporary screenshots (core)
- **Keyboard shortcut** (`Alt+Shift+S` by default) captures the visible tab area
- Screenshots are saved to extension storage (IndexedDB), **never** auto-downloaded
- Popup gallery with thumbnail, page title, capture time, and a visible/full-page badge
- Per-screenshot actions: **Copy** (clipboard), **Download**, **Preview**, **Delete**
- **Copy latest** one-click button and **Clear all**
- **Auto-delete** after 1 hour / 24 hours / 7 days / never (default: 24 hours)
- **Auto-copy to clipboard** after capture (on by default, like macOS
  screenshots — capture, then paste straight into your AI chat). Uses the
  focused page's clipboard when possible, with an offscreen-document fallback
  for pages that block script injection

### Full-page scroll capture (secondary)
- "Capture Full Page" scrolls the page top to bottom, captures each viewport,
  and stitches the sections into one tall image
- Progress indicator ("Capturing section 3 of 12") with a **Cancel** button —
  cancelling keeps a partial capture
- Hides sticky/fixed headers after the first frame so they don't repeat
- Restores your original scroll position afterwards
- Export as **PNG** or **multi-page PDF** (dependency-free PDF writer built in)
- Very long pages are downscaled to stay within canvas limits; capture is
  capped at 40 sections so infinite-scroll pages terminate

## Privacy

- 100% local. No backend, no login, no cloud, no analytics.
- The extension makes **zero network requests**.
- Screenshots stay in your browser profile until deleted, auto-deleted, or
  exported by you.
- The content script is injected **only** when you start a full-page capture —
  TempShot never runs on pages otherwise.

## Install (unpacked)

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder
5. (Optional) Rebind the shortcut at `chrome://extensions/shortcuts`

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition, permissions, shortcut |
| `service_worker.js` | Background worker: shortcut handling, popup RPC, auto-delete alarm |
| `captureManager.js` | Visible + full-page capture orchestration |
| `contentScript.js` | On-demand injected: scrolling, measuring, sticky-element hiding |
| `stitcher.js` | Merges scroll segments with OffscreenCanvas (handles Hi-DPI) |
| `pdfExporter.js` | Minimal hand-rolled PDF writer (JPEG pages via `/DCTDecode`) |
| `storageManager.js` | IndexedDB (images) + `chrome.storage.local` (settings) |
| `popup.html/css/js` | Main dashboard |
| `options.html/css/js` | Settings page |
| `preview.html/js` | Full-size viewer |

## Known limitations (Chrome platform)

- **Restricted pages**: Chrome blocks all extensions on `chrome://` pages,
  other extensions' pages, and the Chrome Web Store. Capture there fails with
  a friendly message.
- **Chrome's built-in PDF viewer** renders in an internal surface that content
  scripts cannot scroll or measure, so *full-page* capture of browser-viewed
  PDFs is impossible for any extension. TempShot detects the PDF viewer and
  explains this instead of saving a single repeated frame. The *visible-area*
  shortcut still works there page-by-page, and HTML-based viewers (e.g.
  Google Docs preview) work fine.
- **Rate limit**: `chrome.tabs.captureVisibleTab` is capped at 2 calls/second
  by Chrome, so full-page capture speed is bounded (~0.7 s per section).
- **Clipboard auto-copy** is best-effort; some pages block clipboard writes.

## Permissions used

`activeTab` (capture the tab you invoke it on — also provides its title/URL,
so no `tabs` permission is needed), `storage` (settings), `scripting` (inject
the scroll script on demand), `alarms` (auto-delete sweep), `notifications`
(post-capture toast for shortcut captures), `clipboardWrite` (auto-copy),
`offscreen` (clipboard fallback for pages that block injection). No host
permissions. See [PRIVACY.md](PRIVACY.md).
