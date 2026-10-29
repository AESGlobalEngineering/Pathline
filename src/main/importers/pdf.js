// PDF import: walks each page's drawing operators with pdf.js and keeps the
// vector paths (lines, curves, rectangles) with their stroke or fill colour.
// Text and raster images are not converted.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const CC = require('../../shared/core');

let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    // in the installed app pdf.js is unpacked from app.asar (ES modules load from real files)
    const base = path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    pdfjsP = import(pathToFileURL(path.join(base, 'legacy/build/pdf.mjs')).href).then((m) => {
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(base, 'legacy/build/pdf.worker.mjs')).href;
      return m;
    });
  }
  return pdfjsP;
}

const PT = 25.4 / 72; // PDF points → mm
const STEPS = 16;

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function rgbArgs(args) {
  if (!args) return [0, 0, 0];
  if (typeof args[0] === 'string') return CC.hexToRgb(args[0]);
  return [args[0], args[1], args[2]].map((v) => (v <= 1 && !Number.isInteger(v) ? Math.round(v * 255) : v));
}

async function importPdf(buffer, opts) {
  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pageNo = Math.min(Math.max(1, (opts && opts.page) || 1), doc.numPages);
  const page = await doc.getPage(pageNo);
  const view = page.view; // [x0, y0, x1, y1] in points
  const ops = await page.getOperatorList();
  const raw = [];
  let skippedImages = 0;

  let ctm = [1, 0, 0, 1, 0, 0];
  let stroke = [0, 0, 0], fill = [0, 0, 0];
  const stack = [];
  let pending = []; // subpaths of the current path, in page space
  let cur = null, cx = 0, cy = 0, sx = 0, sy = 0;

  const startSub = (x, y) => { if (cur && cur.pts.length > 1) pending.push(cur); cur = { pts: [ap(ctm, x, y)], closed: false }; cx = sx = x; cy = sy = y; };
  const lineTo = (x, y) => { if (!cur) startSub(cx, cy); cur.pts.push(ap(ctm, x, y)); cx = x; cy = y; };
  const curve = (x1, y1, x2, y2, x3, y3) => {
    const x0 = cx, y0 = cy;
    for (let k = 1; k <= STEPS; k++) {
      const t = k / STEPS, u = 1 - t;
      lineTo(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  };
  const closeSub = () => { if (cur) { cur.closed = true; pending.push(cur); cur = null; cx = sx; cy = sy; } };
  const paint = (useStroke, useFill) => {
    if (cur && cur.pts.length > 1) pending.push(cur);
    cur = null;
    const col = useStroke ? stroke : useFill ? fill : null;
    if (col) {
      // white fills are usually page backgrounds — skip them
      const white = col[0] > 250 && col[1] > 250 && col[2] > 250;
      if (!(white && !useStroke)) {
        const aci = CC.rgbToAci(col);
        for (const p of pending) raw.push({ pts: p.pts, closed: p.closed || (useFill && !useStroke), aci, kind: 'Path' });
      }
    }
    pending = [];
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm, stroke, fill }); break;
      case OPS.restore: if (stack.length) ({ ctm, stroke, fill } = stack.pop()); break;
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ctm, stroke, fill });
        if (args && args[0]) ctm = mul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd: if (stack.length) ({ ctm, stroke, fill } = stack.pop()); break;
      case OPS.setStrokeRGBColor: stroke = rgbArgs(args); break;
      case OPS.setFillRGBColor: fill = rgbArgs(args); break;
      case OPS.setStrokeGray: stroke = [0, 0, 0].map(() => Math.round((args[0] || 0) * 255)); break;
      case OPS.setFillGray: fill = [0, 0, 0].map(() => Math.round((args[0] || 0) * 255)); break;
      case OPS.constructPath: {
        const [sub, coords] = args;
        let k = 0;
        for (const op of sub) {
          switch (op) {
            case OPS.moveTo: startSub(coords[k++], coords[k++]); break;
            case OPS.lineTo: lineTo(coords[k++], coords[k++]); break;
            case OPS.curveTo: curve(coords[k++], coords[k++], coords[k++], coords[k++], coords[k++], coords[k++]); break;
            case OPS.curveTo2: { const x0 = cx, y0 = cy; const a = [coords[k++], coords[k++], coords[k++], coords[k++]]; curve(x0, y0, a[0], a[1], a[2], a[3]); break; }
            case OPS.curveTo3: { const a = [coords[k++], coords[k++], coords[k++], coords[k++]]; curve(a[0], a[1], a[2], a[3], a[2], a[3]); break; }
            case OPS.closePath: closeSub(); break;
            case OPS.rectangle: {
              const x = coords[k++], y = coords[k++], w = coords[k++], h = coords[k++];
              startSub(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); closeSub();
              break;
            }
          }
        }
        break;
      }
      case OPS.stroke: paint(true, false); break;
      case OPS.closeStroke: closeSub(); paint(true, false); break;
      case OPS.fill: case OPS.eoFill: paint(false, true); break;
      case OPS.fillStroke: case OPS.eoFillStroke: paint(true, true); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: closeSub(); paint(true, true); break;
      case OPS.endPath: pending = []; cur = null; break;
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject: skippedImages++; break;
    }
  }
  // points → mm, keep page Y-up orientation for the common flip
  const out = raw.map((r) => ({ ...r, pts: r.pts.map(([x, y]) => [(x - view[0]) * PT, (y - view[1]) * PT]) }));
  await doc.destroy();
  const skipped = {};
  if (skippedImages) skipped['raster image'] = skippedImages;
  return { raw: out, yUp: true, skipped, pages: doc.numPages, page: pageNo };
}

module.exports = { importPdf };
