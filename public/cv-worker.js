/* Classic web worker that owns OpenCV.js: page detection, perspective warp and cleanup filters. */
/* global cv */
importScripts('vendor/opencv.js');

let CV = null;
const ready = (async () => {
  CV = await self.cv;
  return true;
})();

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    await ready;
    let result = null;
    let transfer = [];
    switch (type) {
      case 'init':
        result = true;
        break;
      case 'detect':
        result = detect(payload.image);
        break;
      case 'warp':
        result = warp(payload.image, payload.corners, payload.targetLong || 2200);
        transfer = [result.data.buffer];
        break;
      case 'filter':
        result = applyFilter(payload.image, payload.filter);
        transfer = [result.data.buffer];
        break;
      default:
        throw new Error('Unknown op ' + type);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: describe(err) });
  }
};

function describe(err) {
  if (typeof err === 'number' && CV && CV.exceptionFromPtr) {
    try { return CV.exceptionFromPtr(err).msg; } catch (_) { /* ignore */ }
  }
  return String((err && err.message) || err);
}

/* ---------------- helpers ---------------- */

const odd = (n) => { n = Math.max(1, Math.round(n)); return n % 2 ? n : n + 1; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function toImageData(mat) {
  // mat must be CV_8UC4 (RGBA)
  return new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
}

function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted is clockwise (y points down) starting near "left"; rotate so top-left (min x+y) is first
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return Math.abs(a) / 2;
}

function angleOk(q) {
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg < 50 || deg > 130) return false;
  }
  return true;
}

function approxQuad(hull) {
  const peri = CV.arcLength(hull, true);
  for (const f of [0.015, 0.02, 0.03, 0.04, 0.05, 0.065, 0.08]) {
    const ap = new CV.Mat();
    CV.approxPolyDP(hull, ap, f * peri, true);
    const n = ap.rows;
    if (n === 4) {
      const pts = [];
      for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
      ap.delete();
      return pts;
    }
    ap.delete();
    if (n < 4) return null;
  }
  return null;
}

function collectQuads(bin, mode, out, W, H, method) {
  const frameArea = W * H;
  const margin = Math.max(2, Math.min(W, H) * 0.008);
  const contours = new CV.MatVector();
  const hier = new CV.Mat();
  CV.findContours(bin, contours, hier, mode, CV.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = CV.contourArea(c);
    if (area < frameArea * 0.1) { c.delete(); continue; }
    const hull = new CV.Mat();
    CV.convexHull(c, hull, false, true);
    const q = approxQuad(hull);
    hull.delete();
    c.delete();
    if (!q) continue;
    const quad = orderQuad(q);
    const qa = polyArea(quad);
    if (qa < frameArea * 0.12 || qa > frameArea * 0.97) continue;
    const fill = area / qa;
    if (fill < 0.82) continue;
    if (!angleOk(quad)) continue;
    // all four corners must be visible (not glued to the frame edge)
    if (quad.some((p) => p.x < margin || p.y < margin || p.x > W - 1 - margin || p.y > H - 1 - margin)) continue;
    out.push({ quad, score: qa * Math.min(1, fill), method });
  }
  contours.delete();
  hier.delete();
}

/* ---------------- detection ---------------- */

function detect(image) {
  const W = image.width, H = image.height;
  const src = CV.matFromImageData(image);
  const gray = new CV.Mat();
  CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
  src.delete();
  const blur = new CV.Mat();
  CV.GaussianBlur(gray, blur, new CV.Size(5, 5), 0);
  gray.delete();

  const candidates = [];

  // A) edges
  const edges = new CV.Mat();
  CV.Canny(blur, edges, 30, 110);
  const k3 = CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(3, 3));
  CV.dilate(edges, edges, k3, new CV.Point(-1, -1), 1);
  CV.morphologyEx(edges, edges, CV.MORPH_CLOSE, k3, new CV.Point(-1, -1), 2);
  collectQuads(edges, CV.RETR_LIST, candidates, W, H, 'edge');
  edges.delete();
  k3.delete();

  // B) bright paper region (Otsu)
  const th = new CV.Mat();
  CV.threshold(blur, th, 0, 255, CV.THRESH_BINARY + CV.THRESH_OTSU);
  const k9 = CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(9, 9));
  CV.morphologyEx(th, th, CV.MORPH_OPEN, k9);
  CV.morphologyEx(th, th, CV.MORPH_CLOSE, k9);
  collectQuads(th, CV.RETR_EXTERNAL, candidates, W, H, 'bright');
  th.delete();
  k9.delete();

  // C) adaptive threshold (low-contrast backgrounds)
  if (candidates.length === 0) {
    const ad = new CV.Mat();
    CV.adaptiveThreshold(blur, ad, 255, CV.ADAPTIVE_THRESH_MEAN_C, CV.THRESH_BINARY, odd(Math.min(W, H) / 8), 2);
    const k5 = CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(5, 5));
    CV.morphologyEx(ad, ad, CV.MORPH_OPEN, k5);
    collectQuads(ad, CV.RETR_EXTERNAL, candidates, W, H, 'adaptive');
    ad.delete();
    k5.delete();
  }
  blur.delete();

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { corners: candidates[0].quad, method: candidates[0].method };
}

/* ---------------- warp ---------------- */

function warp(image, corners, targetLong) {
  const [tl, tr, br, bl] = corners;
  const w = Math.max(dist(tl, tr), dist(bl, br));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  const scale = Math.max(1, Math.min(2.5, targetLong / Math.max(w, h)));
  const W = Math.max(8, Math.round(w * scale));
  const H = Math.max(8, Math.round(h * scale));

  const src = CV.matFromImageData(image);
  const s = CV.matFromArray(4, 1, CV.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const d = CV.matFromArray(4, 1, CV.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = CV.getPerspectiveTransform(s, d);
  const dst = new CV.Mat();
  CV.warpPerspective(src, dst, M, new CV.Size(W, H), CV.INTER_CUBIC, CV.BORDER_REPLICATE, new CV.Scalar());
  const out = toImageData(dst);
  [src, s, d, M, dst].forEach((m) => m.delete());
  return out;
}

/* ---------------- filters ---------------- */

// Divide a single channel by its estimated paper/lighting background -> paper becomes uniform white.
function normalizeChannel(ch) {
  const f = 4;
  const small = new CV.Mat();
  CV.resize(ch, small, new CV.Size(Math.max(1, Math.round(ch.cols / f)), Math.max(1, Math.round(ch.rows / f))), 0, 0, CV.INTER_AREA);
  const ks = Math.max(7, odd(Math.max(small.cols, small.rows) / 28));
  const k = CV.getStructuringElement(CV.MORPH_ELLIPSE, new CV.Size(ks, ks));
  CV.dilate(small, small, k);
  CV.medianBlur(small, small, Math.min(255, odd(ks * 1.5)));
  const bg = new CV.Mat();
  CV.resize(small, bg, new CV.Size(ch.cols, ch.rows), 0, 0, CV.INTER_LINEAR);
  const out = new CV.Mat();
  CV.divide(ch, bg, out, 255);
  [small, k, bg].forEach((m) => m.delete());
  return out;
}

function levels(mat, lo, hi) {
  const a = 255 / (hi - lo);
  mat.convertTo(mat, -1, a, -lo * a);
}

function sharpen(mat, sigma, amount) {
  const blur = new CV.Mat();
  CV.GaussianBlur(mat, blur, new CV.Size(0, 0), sigma);
  CV.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
  blur.delete();
}

function applyFilter(image, filter) {
  const src = CV.matFromImageData(image);
  let out;
  if (filter === 'magic') out = magic(src);
  else if (filter === 'gray') out = grayscale(src);
  else if (filter === 'bw') out = blackWhite(src);
  else { out = src.clone(); }
  src.delete();
  const res = toImageData(out);
  out.delete();
  return res;
}

function magic(src) {
  const rgb = new CV.Mat();
  CV.cvtColor(src, rgb, CV.COLOR_RGBA2RGB);
  const chans = new CV.MatVector();
  CV.split(rgb, chans);
  const norm = new CV.MatVector();
  for (let i = 0; i < 3; i++) {
    const c = chans.get(i);
    const n = normalizeChannel(c);
    norm.push_back(n);
    c.delete();
    n.delete();
  }
  CV.merge(norm, rgb);
  chans.delete();
  norm.delete();

  levels(rgb, 40, 238);

  // boost saturation so pen / highlighter colours survive the whitening
  const hsv = new CV.Mat();
  CV.cvtColor(rgb, hsv, CV.COLOR_RGB2HSV);
  const hs = new CV.MatVector();
  CV.split(hsv, hs);
  const sat = hs.get(1);
  sat.convertTo(sat, -1, 1.35, 0);
  const rebuilt = new CV.MatVector();
  const h0 = hs.get(0), v2 = hs.get(2);
  rebuilt.push_back(h0);
  rebuilt.push_back(sat);
  rebuilt.push_back(v2);
  CV.merge(rebuilt, hsv);
  CV.cvtColor(hsv, rgb, CV.COLOR_HSV2RGB);
  [h0, sat, v2, hsv].forEach((m) => m.delete());
  hs.delete();
  rebuilt.delete();

  sharpen(rgb, 1.2, 0.6);
  const out = new CV.Mat();
  CV.cvtColor(rgb, out, CV.COLOR_RGB2RGBA);
  rgb.delete();
  return out;
}

function grayscale(src) {
  const g = new CV.Mat();
  CV.cvtColor(src, g, CV.COLOR_RGBA2GRAY);
  const n = normalizeChannel(g);
  g.delete();
  levels(n, 35, 238);
  sharpen(n, 1.2, 0.6);
  const out = new CV.Mat();
  CV.cvtColor(n, out, CV.COLOR_GRAY2RGBA);
  n.delete();
  return out;
}

function blackWhite(src) {
  const g = new CV.Mat();
  CV.cvtColor(src, g, CV.COLOR_RGBA2GRAY);
  const n = normalizeChannel(g);
  g.delete();
  CV.GaussianBlur(n, n, new CV.Size(3, 3), 0);
  const block = Math.max(15, odd(Math.max(n.cols, n.rows) / 55));
  const bw = new CV.Mat();
  CV.adaptiveThreshold(n, bw, 255, CV.ADAPTIVE_THRESH_GAUSSIAN_C, CV.THRESH_BINARY, block, 14);
  // anything clearly paper-white stays white (kills speckle noise)
  const white = new CV.Mat();
  CV.threshold(n, white, 222, 255, CV.THRESH_BINARY);
  CV.bitwise_or(bw, white, bw);
  // anything clearly ink-dark stays black (keeps solid regions solid)
  const dark = new CV.Mat();
  CV.threshold(n, dark, 110, 255, CV.THRESH_BINARY);
  CV.bitwise_and(bw, dark, bw);
  const out = new CV.Mat();
  CV.cvtColor(bw, out, CV.COLOR_GRAY2RGBA);
  [n, bw, white, dark].forEach((m) => m.delete());
  return out;
}
