/**
 * contentScript.js — injected on demand (chrome.scripting.executeScript) when
 * the user starts a full-page capture. It never runs on its own: there is no
 * content_scripts entry in the manifest, so TempShot touches a page only when
 * you explicitly capture it.
 *
 * Responsibilities:
 *  - measure page height / viewport / devicePixelRatio
 *  - scroll step-by-step and report the *actual* scroll position (pages clamp
 *    at the bottom, sticky containers exist, etc.)
 *  - hide position:fixed/sticky elements after the first frame so headers and
 *    cookie banners don't repeat in every stitched section
 *  - restore scroll position and styles when done
 */

// Guard: executeScript may inject this file more than once per page.
if (!window.__tempshotInjected) {
  window.__tempshotInjected = true;

  const state = {
    hidden: [],          // [element, previousInlineVisibility]
    savedX: 0,
    savedY: 0,
    savedBehavior: null  // html { scroll-behavior } to restore
  };

  function pageScrollHeight() {
    const de = document.documentElement;
    const body = document.body;
    return Math.max(
      de ? de.scrollHeight : 0,
      body ? body.scrollHeight : 0
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.tempshot) return;

    switch (msg.op) {
      case 'measure': {
        sendResponse({
          scrollHeight: pageScrollHeight(),
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          dpr: window.devicePixelRatio || 1,
          title: document.title,
          url: location.href
        });
        return;
      }

      case 'prepare': {
        state.savedX = window.scrollX;
        state.savedY = window.scrollY;
        // Smooth scrolling would make "scroll then screenshot" race; force
        // instant scrolling for the duration of the capture.
        state.savedBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        sendResponse({ ok: true });
        return;
      }

      case 'scrollTo': {
        window.scrollTo(0, msg.y);
        // Wait for layout, images, and lazy-loaded content to settle, then
        // one more animation frame so paint reflects the new position.
        setTimeout(() => {
          requestAnimationFrame(() => {
            sendResponse({
              y: window.scrollY,
              scrollHeight: pageScrollHeight() // may grow on lazy/infinite pages
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
        if (state.savedBehavior !== null) {
          document.documentElement.style.scrollBehavior = state.savedBehavior;
          state.savedBehavior = null;
        }
        window.scrollTo(state.savedX, state.savedY);
        sendResponse({ ok: true });
        return;
      }
    }
  });
}
