/**
 * contentScript.js — injected on demand (chrome.scripting.executeScript) when
 * the user starts a full-page capture. It never runs on its own: there is no
 * content_scripts entry in the manifest, so TempShot touches a page only when
 * you explicitly capture it.
 *
 * Responsibilities:
 *  - detect Chrome's built-in PDF viewer (cannot be scrolled by extensions)
 *  - find what actually scrolls: the window, or an inner container (many
 *    modern apps — docs, dashboards, SPAs — scroll a div, not the window)
 *  - scroll step-by-step and report the *actual* position (pages clamp at the
 *    bottom, containers have their own limits)
 *  - hide position:fixed/sticky elements after the first frame so headers and
 *    cookie banners don't repeat in every stitched section
 *  - restore scroll position and styles when done
 */

// Guard: executeScript may inject this file more than once per page.
if (!window.__tempshotInjected) {
  window.__tempshotInjected = true;

  const state = {
    hidden: [],          // [element, previousInlineVisibility]
    scroller: null,      // null = the window scrolls; else the inner container
    savedX: 0,
    savedY: 0,
    savedBehavior: null  // inline scroll-behavior to restore [element, value]
  };

  function rootScrollHeight() {
    const root = document.scrollingElement || document.documentElement;
    return root ? root.scrollHeight : 0;
  }

  /**
   * Chrome's PDF viewer: the top-level document (when scriptable at all) is a
   * thin wrapper around a full-viewport <embed> of the internal PDF plugin.
   * The wrapper itself never scrolls, so scroll capture is impossible.
   */
  function detectPdfViewer() {
    const embed = document.querySelector(
      'embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"]'
    );
    if (!embed) return false;
    const r = embed.getBoundingClientRect();
    // The PDF embed fills essentially the whole viewport in the viewer.
    return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
  }

  /**
   * Figure out what scrolls. If the root element overflows the viewport, the
   * window scrolls (the common case). Otherwise hunt for the largest
   * scrollable container — SPA layouts often pin <body> to 100vh and scroll
   * an inner <div> instead, which is why naive window.scrollTo "does nothing"
   * on those sites.
   */
  function findScroller() {
    if (rootScrollHeight() > window.innerHeight + 1) return null; // window scrolls
    let best = null;
    let bestArea = 0;
    let scanned = 0;
    const MAX_SCAN = 4000;
    for (const el of document.querySelectorAll('body *')) {
      if (++scanned > MAX_SCAN) break;
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  const getScrollTop = () => (state.scroller ? state.scroller.scrollTop : window.scrollY);
  const setScrollTop = (y) => {
    if (state.scroller) state.scroller.scrollTop = y;
    else window.scrollTo(0, y);
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.tempshot) return;

    switch (msg.op) {
      case 'measure': {
        state.scroller = findScroller();
        const s = state.scroller;
        sendResponse({
          scrollHeight: s ? s.scrollHeight : rootScrollHeight(),
          viewportHeight: s ? s.clientHeight : window.innerHeight,
          viewportWidth: window.innerWidth,
          dpr: window.devicePixelRatio || 1,
          isPdf: detectPdfViewer(),
          usesInnerScroller: !!s,
          title: document.title,
          url: location.href
        });
        return;
      }

      case 'prepare': {
        state.savedX = window.scrollX;
        state.savedY = getScrollTop();
        // Smooth scrolling would make "scroll then screenshot" race; force
        // instant scrolling on whichever element actually scrolls.
        const target = state.scroller || document.documentElement;
        state.savedBehavior = [target, target.style.scrollBehavior];
        target.style.scrollBehavior = 'auto';
        sendResponse({ ok: true });
        return;
      }

      case 'scrollTo': {
        setScrollTop(msg.y);
        // Wait for layout, images, and lazy-loaded content to settle, then
        // one more animation frame so paint reflects the new position.
        setTimeout(() => {
          requestAnimationFrame(() => {
            sendResponse({
              y: getScrollTop(),
              // May grow on lazy/infinite pages; the worker caps segments.
              scrollHeight: state.scroller ? state.scroller.scrollHeight : rootScrollHeight()
            });
          });
        }, msg.settleMs || 300);
        return true; // keep the message channel open for the async response
      }

      case 'hideFixed': {
        // Best-effort sticky/fixed suppression. Scanning every element's
        // computed style is O(n); cap it so giant DOMs don't stall.
        const MAX_SCAN = 6000;
        const els = document.querySelectorAll('body *');
        let scanned = 0;
        for (const el of els) {
          if (++scanned > MAX_SCAN) break;
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            state.hidden.push([el, el.style.visibility]);
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        }
        sendResponse({ hidden: state.hidden.length });
        return;
      }

      case 'cleanup': {
        for (const [el, prev] of state.hidden) {
          if (prev) el.style.setProperty('visibility', prev);
          else el.style.removeProperty('visibility');
        }
        state.hidden = [];
        if (state.savedBehavior) {
          const [target, value] = state.savedBehavior;
          if (value) target.style.scrollBehavior = value;
          else target.style.removeProperty('scroll-behavior');
          state.savedBehavior = null;
        }
        setScrollTop(state.savedY);
        if (!state.scroller) window.scrollTo(state.savedX, state.savedY);
        sendResponse({ ok: true });
        return;
      }
    }
  });
}
