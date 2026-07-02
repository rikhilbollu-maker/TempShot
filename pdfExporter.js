/**
 * pdfExporter.js — dependency-free PDF generation for TempShot.
 *
 * Rather than shipping a PDF library, this writes a minimal but valid PDF by
 * hand. The trick that keeps it tiny: JPEG data can be embedded in a PDF
 * as-is using the /DCTDecode filter, so each page is just a JPEG image object
 * plus a one-line content stream that draws it full-bleed.
 *
 * Tall full-page captures are sliced into US-Letter-proportioned pages
 * (612×792 pt). The last page is emitted at its natural (shorter) height —
 * PDF pages don't have to share a size, and it avoids padding artifacts.
 * Slicing also sidesteps browser canvas limits: each slice canvas is small
 * even when the source capture is enormous.
 */

const PAGE_WIDTH_PT = 612;   // US Letter width in points
const PAGE_HEIGHT_PT = 792;  // US Letter height in points
const JPEG_QUALITY = 0.92;

const encoder = new TextEncoder();

/**
 * Build a PDF from a full-resolution image Blob (PNG or JPEG).
 * @returns {Promise<Blob>} application/pdf
 */
export async function imageBlobToPdf(imageBlob) {
  const bitmap = await createImageBitmap(imageBlob);
  const { width: imgW, height: imgH } = bitmap;

  // How many source pixels fit on one Letter-proportioned page.
  const slicePx = Math.max(1, Math.round(imgW * (PAGE_HEIGHT_PT / PAGE_WIDTH_PT)));
  const pageCount = Math.max(1, Math.ceil(imgH / slicePx));

  // Render each slice to JPEG.
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const srcY = i * slicePx;
    const srcH = Math.min(slicePx, imgH - srcY);
    const canvas = new OffscreenCanvas(imgW, srcH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, imgW, srcH);
    ctx.drawImage(bitmap, 0, srcY, imgW, srcH, 0, 0, imgW, srcH);
    const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    pages.push({
      jpeg: new Uint8Array(await jpegBlob.arrayBuffer()),
      pxW: imgW,
      pxH: srcH,
      // Page dimensions in points, preserving the slice's aspect ratio.
      ptW: PAGE_WIDTH_PT,
      ptH: (srcH / imgW) * PAGE_WIDTH_PT
    });
  }
  bitmap.close();

  return assemblePdf(pages);
}

/**
 * Serialize PDF objects with a correct xref table. Object layout:
 *   1: Catalog, 2: Pages, then per page: Page, Contents stream, Image XObject.
 */
function assemblePdf(pages) {
  const chunks = [];   // Uint8Array chunks in output order
  const offsets = [];  // byte offset of each object, 1-indexed
  let position = 0;

  const push = (bytes) => {
    chunks.push(bytes);
    position += bytes.length;
  };
  const pushStr = (s) => push(encoder.encode(s));
  const beginObj = (num) => {
    offsets[num] = position;
    pushStr(`${num} 0 obj\n`);
  };

  const objCount = 2 + pages.length * 3;
  const pageObjNums = pages.map((_, i) => 3 + i * 3);

  pushStr('%PDF-1.4\n%ÿÿÿÿ\n');

  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObj(2);
  pushStr(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const w = page.ptW.toFixed(2);
    const h = page.ptH.toFixed(2);

    beginObj(pageNum);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );

    // Content stream: scale the unit-square image to fill the page.
    const stream = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObj(contentNum);
    pushStr(`<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

    beginObj(imageNum);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${page.pxW} /Height ${page.pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
    );
    push(page.jpeg);
    pushStr('\nendstream\nendobj\n');
  });

  // Cross-reference table: fixed-width 20-byte entries, as the spec requires.
  const xrefStart = position;
  pushStr(`xref\n0 ${objCount + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= objCount; n++) {
    pushStr(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
