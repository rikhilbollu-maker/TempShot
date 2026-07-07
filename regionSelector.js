/**
 * regionSelector.js — drag-to-select area capture (macOS ⌘⇧4-style).
 *
 * Injected on demand when the user starts an area capture. Draws a
 * crosshair overlay; the user drags a rectangle over exactly what they want.
 * On mouseup the overlay removes itself, waits for the page to repaint
 * (double rAF + a small delay) so the overlay can never appear in the shot,
 * then sends the selection rect to the service worker, which captures the
 * visible tab and crops to the rect (scaled by devicePixelRatio).
 *
 * Esc cancels. A sub-5px drag is treated as an accidental click and cancels.
 */

(() => {
  // Guard: pressing the shortcut twice shouldn't stack overlays.
  if (window.__tempshotRegionActive) return;
  window.__tempshotRegionActive = true;

  const Z = 2147483647;
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const root = document.createElement('div');
  root.style.cssText =
    `position:fixed;inset:0;z-index:${Z};cursor:crosshair;user-select:none;-webkit-user-select:none;`;

  // Gentle dim + hint before the drag starts.
  const dim = document.createElement('div');
  dim.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.25);';

  const hint = document.createElement('div');
  hint.textContent = 'Drag to select an area · Esc to cancel';
  hint.style.cssText =
    'position:fixed;top:18px;left:50%;transform:translateX(-50%);' +
    'background:rgba(23,24,28,.92);color:#fff;padding:7px 14px;border-radius:999px;' +
    `font:600 13px/1.2 ${FONT};pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.3);`;

  // Selection rectangle: transparent inside, giant box-shadow dims the rest.
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;display:none;border:1.5px solid #818cf8;' +
    'box-shadow:0 0 0 99999px rgba(0,0,0,0.35);';

  const sizeLabel = document.createElement('div');
  sizeLabel.style.cssText =
    'position:fixed;display:none;background:rgba(23,24,28,.92);color:#fff;' +
    `padding:2px 8px;border-radius:6px;font:600 11px/1.4 ${FONT};pointer-events:none;`;

  root.append(dim, box, sizeLabel, hint);
  document.documentElement.appendChild(root);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  const rectFrom = (e) => ({
    x: Math.min(startX, e.clientX),
    y: Math.min(startY, e.clientY),
    w: Math.abs(e.clientX - startX),
    h: Math.abs(e.clientY - startY)
  });

  function cleanup() {
    root.remove();
    window.removeEventListener('keydown', onKey, true);
    window.__tempshotRegionActive = false;
  }

  function cancel() {
    cleanup();
    chrome.runtime.sendMessage({ cmd: 'regionCancelled' }).catch(() => {});
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  window.addEventListener('keydown', onKey, true);

  function update(e) {
    const r = rectFrom(e);
    box.style.left = r.x + 'px';
    box.style.top = r.y + 'px';
    box.style.width = r.w + 'px';
    box.style.height = r.h + 'px';
    sizeLabel.style.display = 'block';
    sizeLabel.textContent = `${r.w} × ${r.h}`;
    sizeLabel.style.left = r.x + 'px';
    sizeLabel.style.top = Math.max(4, r.y - 24) + 'px';
  }

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    dim.style.display = 'none';   // the box's shadow takes over the dimming
    hint.style.display = 'none';
    box.style.display = 'block';
    update(e);
  });

  root.addEventListener('mousemove', (e) => {
    if (dragging) update(e);
  });

  root.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const r = rectFrom(e);
    cleanup();

    if (r.w < 5 || r.h < 5) {
      cancel(); // accidental click, not a selection
      return;
    }

    // Let the page repaint WITHOUT the overlay before the tab is captured.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          cmd: 'regionSelected',
          rect: r,
          dpr: window.devicePixelRatio || 1
        }).catch(() => {});
      }, 60);
    }));
  });
})();
