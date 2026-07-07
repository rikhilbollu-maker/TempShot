/**
 * stitcher.js — merges scroll-capture segments into one tall image.
 *
 * MV3 service workers have no DOM, but they DO support OffscreenCanvas and
 * createImageBitmap, so stitching can happen right in the worker without an
 * offscreen document.
 *
 * High-DPI note: chrome.tabs.captureVisibleTab returns an image in *device*
 * pixels (CSS pixels × devicePixelRatio). All layout math from the content
 * script is in CSS pixels, so every offset is multiplied by dpr here.
 *
 * Very long pages: canvases have hard dimension/area limits (~16k px per side
 * in practice, and total-area caps that vary by device memory). Instead of
 * failing, we downscale the whole stitch proportionally to fit.
 */

// Kept well under what canvases technically allow: encoding a huge PNG can
// take so long that Chrome kills the idle service worker mid-stitch, which
// looks to the user like a capture that silently never finishes. ~50 MP
// encodes in a few seconds; anything taller gets proportionally downscaled.
const MAX_DIMENSION = 12000;  // per-side canvas limit (device px)
const MAX_AREA = 50_000_000;  // total-pixel cap (~50 MP)

/**
 * @param {Array<{y:number, dataUrl:string}>} segments — y in CSS px (actual
 *        scroll position when the frame was captured), top to bottom.
 * @param {{dpr:number}} metrics
 * @returns {{blob:Blob, width:number, height:number}} stitched PNG (device px)
 */
export async function stitchSegments(segments, metrics) {
  if (!segments.length) throw new Error('No segments to stitch');
  const dpr = metrics.dpr || 1;

  const bitmaps = [];
  for (const seg of segments) {
    const blob = await (await fetch(seg.dataUrl)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }

  const width = bitmaps[0].width;
  const last = segments.length - 1;
  const totalHeight = Math.round(segments[last].y * dpr) + bitmaps[last].height;

  // Downscale if the page is too tall for a single canvas.
  const scale = Math.min(
    1,
    MAX_DIMENSION / totalHeight,
    MAX_DIMENSION / width,
    Math.sqrt(MAX_AREA / (width * totalHeight))
  );

  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(totalHeight * scale))
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw in order. Segments can overlap near the bottom (the last scroll
  // position clamps to the page end); drawing later segments on top keeps the
  // freshest pixels, which also helps with lazy-loaded content.
  for (let i = 0; i < bitmaps.length; i++) {
    const destY = Math.round(segments[i].y * dpr * scale);
    ctx.drawImage(
      bitmaps[i],
      0, destY,
      Math.round(bitmaps[i].width * scale),
      Math.round(bitmaps[i].height * scale)
    );
    bitmaps[i].close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, width: canvas.width, height: canvas.height };
}

/**
 * Create a small JPEG thumbnail for the gallery so the popup never has to
 * decode multi-megabyte full-page PNGs just to render the list.
 */
export async function makeThumbnail(fullBlob, targetWidth = 320, maxHeight = 480) {
  const bitmap = await createImageBitmap(fullBlob);
  const scale = Math.min(1, targetWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.min(maxHeight, Math.round(bitmap.height * scale)));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  // For very tall images, the thumbnail shows the top slice (cropped by maxHeight).
  ctx.drawImage(bitmap, 0, 0, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}
