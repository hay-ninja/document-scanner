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
        DBG = payload.debug ? [] : null;
        result = detect(payload.image);
        if (DBG) result = { result, debug: DBG };
        break;
      case 'sharpness':
        result = sharpness(payload.image, payload.corners);
        break;
      case 'warp':
        result = warp(payload.image, payload.corners, payload.targetLong || 2200);
        transfer = [result.data.buffer];
        break;
      case 'filter':
        result = applyFilter(payload.image, payload.filter, payload.strength);
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

let DBG = null;
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
    if (!q) { DBG && DBG.push([method, 'noquad', Math.round(area / frameArea * 100)]); continue; }
    const quad = orderQuad(q);
    const qa = polyArea(quad);
    if (qa < frameArea * 0.12 || qa > frameArea * 0.97) { DBG && DBG.push([method, 'size', Math.round(qa / frameArea * 100)]); continue; }
    const fill = area / qa;
    if (fill < 0.82) { DBG && DBG.push([method, 'fill', +fill.toFixed(2), JSON.stringify(quad)]); continue; }
    if (!angleOk(quad)) { DBG && DBG.push([method, 'angle', JSON.stringify(quad)]); continue; }
    // all four corners must be visible (not glued to the frame edge)
    if (quad.some((p) => p.x < margin || p.y < margin || p.x > W - 1 - margin || p.y > H - 1 - margin)) { DBG && DBG.push([method, 'edge', JSON.stringify(quad)]); continue; }
    out.push({ quad, area: qa, method });
  }
  contours.delete();
  hier.delete();
}

/* ---------------- line-based detection ---------------- */
// Robust to fingers covering an edge, torn/spiral edges and bright backgrounds that
// merge with the paper: find long straight lines, combine them into quads, and score
// each quad by how much of its outline actually lies on image edges.

function clusterLines(segs, dim) {
  const clusters = [];
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const len = Math.hypot(dx, dy);
    let a = Math.atan2(dy, dx);
    if (a < 0) a += Math.PI; // direction mod 180
    const mx = (s[0] + s[2]) / 2, my = (s[1] + s[3]) / 2;
    let hit = null;
    for (const c of clusters) {
      let da = Math.abs(a - c.a);
      da = Math.min(da, Math.PI - da);
      if (da > 0.1) continue;
      // perpendicular distance from this midpoint to the cluster line
      const d = Math.abs(-(Math.sin(c.a)) * (mx - c.x) + Math.cos(c.a) * (my - c.y));
      if (d < dim * 0.02) { hit = c; break; }
    }
    if (hit) {
      const w = hit.len + len;
      // average angle with doubled-angle vectors to handle wrap at 0/180
      const vx = Math.cos(2 * hit.a) * hit.len + Math.cos(2 * a) * len;
      const vy = Math.sin(2 * hit.a) * hit.len + Math.sin(2 * a) * len;
      let na = Math.atan2(vy, vx) / 2;
      if (na < 0) na += Math.PI;
      hit.a = na;
      hit.x = (hit.x * hit.len + mx * len) / w;
      hit.y = (hit.y * hit.len + my * len) / w;
      hit.len = w;
    } else {
      clusters.push({ a, x: mx, y: my, len });
    }
  }
  return clusters;
}

function intersect(l1, l2) {
  const d1x = Math.cos(l1.a), d1y = Math.sin(l1.a);
  const d2x = Math.cos(l2.a), d2y = Math.sin(l2.a);
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((l2.x - l1.x) * d2y - (l2.y - l1.y) * d2x) / den;
  return { x: l1.x + t * d1x, y: l1.y + t * d1y };
}

/**
 * Fraction of the quad outline that (a) sits on an image edge and (b) has brighter
 * pixels just inside than just outside (paper is the bright thing under the screen light).
 * Returns the worst side's score blended with the average, so one fake side sinks it.
 */
function edgeSupport(edgeData, grayData, W, H, quad, off) {
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const len = dist(a, b);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len; // inward normal (clockwise quad, y down)
    const n = Math.max(12, Math.round(len / 4));
    let hits = 0;
    for (let k = 1; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const y = a.y + ((b.y - a.y) * k) / n;
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H || !edgeData[yi * W + xi]) continue;
      const ix = Math.round(x + nx * off), iy = Math.round(y + ny * off);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      const inside = grayData[iy * W + ix];
      // outside must be darker both just past the edge and further out — a thick dark bar
      // printed on the page is dark right next to the edge but paper-bright beyond it
      // (full credit if darker at both distances, partial if only right next to the edge)
      let credit = 1;
      for (const f of [1, 3]) {
        const ox = Math.round(x - nx * off * f), oy = Math.round(y - ny * off * f);
        if (ox < 0 || oy < 0 || ox >= W || oy >= H) break; // outside the frame counts as background
        if (inside - grayData[oy * W + ox] <= 6) { credit = f === 1 ? 0 : 0.6; break; }
      }
      hits += credit;
    }
    sides.push(hits / (n - 1));
  }
  const avg = sides.reduce((s, v) => s + v, 0) / 4;
  return 0.5 * avg + 0.5 * Math.min(...sides);
}

function lineQuads(blur, out, W, H) {
  const dim = Math.min(W, H);
  const frameArea = W * H;
  const margin = Math.max(2, dim * 0.008);
  const edges = new CV.Mat();
  CV.Canny(blur, edges, 25, 90);
  const lines = new CV.Mat();
  CV.HoughLinesP(edges, lines, 1, Math.PI / 180, 30, dim * 0.1, dim * 0.04);
  const segs = [];
  // layout differs between builds (N×1 or 1×N), so walk the raw buffer
  const p = lines.data32S;
  for (let i = 0; i + 3 < p.length; i += 4) segs.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  lines.delete();
  // dilated edge map for support scoring
  const k = CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(3, 3));
  CV.dilate(edges, edges, k, new CV.Point(-1, -1), 2);
  k.delete();
  const edgeData = edges.data.slice();
  const grayData = blur.data;
  edges.delete();

  const clusters = clusterLines(segs.sort((a, b) => Math.hypot(b[2] - b[0], b[3] - b[1]) - Math.hypot(a[2] - a[0], a[3] - a[1])), dim)
    .filter((c) => c.len > dim * 0.15)
    .sort((a, b) => b.len - a.len);
  const horiz = clusters.filter((c) => Math.abs(Math.cos(c.a)) >= Math.abs(Math.sin(c.a))).slice(0, 10);
  const vert = clusters.filter((c) => Math.abs(Math.cos(c.a)) < Math.abs(Math.sin(c.a))).slice(0, 10);

  for (let i = 0; i < horiz.length; i++) {
    for (let j = i + 1; j < horiz.length; j++) {
      if (Math.abs(horiz[i].y - horiz[j].y) < H * 0.2) continue;
      for (let m = 0; m < vert.length; m++) {
        for (let n = m + 1; n < vert.length; n++) {
          if (Math.abs(vert[m].x - vert[n].x) < W * 0.2) continue;
          const pts = [intersect(horiz[i], vert[m]), intersect(horiz[i], vert[n]), intersect(horiz[j], vert[n]), intersect(horiz[j], vert[m])];
          if (pts.some((p) => !p || p.x < margin || p.y < margin || p.x > W - 1 - margin || p.y > H - 1 - margin)) continue;
          const quad = orderQuad(pts);
          const qa = polyArea(quad);
          if (qa < frameArea * 0.12 || qa > frameArea * 0.95) continue;
          if (!angleOk(quad)) continue;
          const support = edgeSupport(edgeData, grayData, W, H, quad, Math.max(3, dim * 0.012));
          if (support < 0.3) continue;
          out.push({ quad, area: qa, method: 'lines', support });
        }
      }
    }
  }
  DBG && DBG.push(['lines', 'segs', segs.length, 'clusters', horiz.length, vert.length]);
  return { edgeData, grayData, off: Math.max(3, dim * 0.012) };
}

/** Paper should be brighter than its surroundings: penalise quads that aren't. */
function brightnessFactor(gray, quad) {
  const mask = CV.Mat.zeros(gray.rows, gray.cols, CV.CV_8UC1);
  const pts = CV.matFromArray(4, 1, CV.CV_32SC2, quad.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
  const vec = new CV.MatVector();
  vec.push_back(pts);
  CV.fillPoly(mask, vec, new CV.Scalar(255));
  const inside = CV.mean(gray, mask)[0];
  CV.bitwise_not(mask, mask);
  const outside = CV.mean(gray, mask)[0];
  [mask, pts, vec].forEach((m) => m.delete());
  return Math.max(0.5, Math.min(1.3, (inside + 1) / (outside + 1)));
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

  // D) straight-line quads (handles occluded / ragged edges)
  const ctx = lineQuads(blur, candidates, W, H);

  if (!candidates.length) {
    blur.delete();
    return null;
  }
  // One scoring rule for every pass: edge support (on an edge, brighter inside) dominates,
  // area only breaks ties (so inner tables / boxes drawn on the page don't win).
  for (const c of candidates) {
    if (c.support === undefined) c.support = Math.max(0.4, edgeSupport(ctx.edgeData, ctx.grayData, W, H, c.quad, ctx.off));
    c.score = Math.sqrt(c.area) * c.support ** 3;
  }
  candidates.sort((a, b) => b.score - a.score);
  // re-rank the best few by how much brighter than the surroundings they are
  const top = candidates.slice(0, 6);
  for (const c of top) c.score *= brightnessFactor(blur, c.quad);
  blur.delete();
  top.sort((a, b) => b.score - a.score);
  DBG && DBG.push(['top', top.map((c) => [c.method, Math.round(c.score), JSON.stringify(c.quad.map((p) => [Math.round(p.x), Math.round(p.y)]))])]);
  const best = top[0];
  return { corners: best.quad, method: best.method, ...frameStats(image, best.quad) };
}

/** Exposure info for the live hints: how much of the page is blown out / how dark it is. */
function frameStats(image, quad) {
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(image.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(image.height - 1, Math.ceil(Math.max(...ys)));
  const d = image.data;
  let n = 0, clipped = 0, sum = 0;
  for (let y = y0; y <= y1; y += 3) {
    for (let x = x0; x <= x1; x += 3) {
      const i = (y * image.width + x) * 4;
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += v;
      if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) clipped++;
      n++;
    }
  }
  return { clipped: n ? clipped / n : 0, brightness: n ? sum / n / 255 : 0, area: polyArea(quad) / (image.width * image.height) };
}

/* ---------------- sharpness (burst frame picking) ---------------- */

/** Variance of the Laplacian inside the page's bounding box: higher = sharper (less motion blur). */
function sharpness(image, corners) {
  const src = CV.matFromImageData(image);
  let x0 = 0, y0 = 0, x1 = image.width, y1 = image.height;
  if (corners) {
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    x0 = Math.max(0, Math.floor(Math.min(...xs)));
    y0 = Math.max(0, Math.floor(Math.min(...ys)));
    x1 = Math.min(image.width, Math.ceil(Math.max(...xs)));
    y1 = Math.min(image.height, Math.ceil(Math.max(...ys)));
  }
  // central 70% of the page avoids fingers and the background
  const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.15;
  const rect = new CV.Rect(Math.round(x0 + mx), Math.round(y0 + my), Math.max(8, Math.round(x1 - x0 - 2 * mx)), Math.max(8, Math.round(y1 - y0 - 2 * my)));
  const roi = src.roi(rect);
  const gray = new CV.Mat();
  CV.cvtColor(roi, gray, CV.COLOR_RGBA2GRAY);
  const lap = new CV.Mat();
  CV.Laplacian(gray, lap, CV.CV_32F, 3);
  const mean = new CV.Mat(), std = new CV.Mat();
  CV.meanStdDev(lap, mean, std);
  const v = std.data64F[0] ** 2;
  [src, roi, gray, lap, mean, std].forEach((m) => m.delete());
  return v;
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
  // trim a hair off every edge so no background sliver survives slightly-loose corners
  const inset = Math.round(Math.min(W, H) * 0.007);
  let out;
  if (inset > 0 && W > inset * 4 && H > inset * 4) {
    const roi = dst.roi(new CV.Rect(inset, inset, W - inset * 2, H - inset * 2));
    const cropped = new CV.Mat();
    roi.copyTo(cropped); // copyTo gives a continuous buffer (clone of an ROI may keep the parent stride)
    out = toImageData(cropped);
    roi.delete();
    cropped.delete();
  } else {
    out = toImageData(dst);
  }
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

/**
 * Tone curve applied after background normalisation: pushes near-white paper to pure white
 * and darkens faint strokes (pencil) according to strength 0..1.
 */
function inkCurve(mat, strength) {
  const lo = 25, hi = 236;
  const g = 1 + 2.2 * strength;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = Math.round(255 * Math.pow(x, g));
  }
  const d = mat.data;
  for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
}

function sharpen(mat, sigma, amount) {
  const blur = new CV.Mat();
  CV.GaussianBlur(mat, blur, new CV.Size(0, 0), sigma);
  CV.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
  blur.delete();
}

/** Smooth colour noise (webcam speckle) while keeping luminance detail. */
function chromaDenoise(rgb) {
  const ycc = new CV.Mat();
  CV.cvtColor(rgb, ycc, CV.COLOR_RGB2YCrCb);
  const ch = new CV.MatVector();
  CV.split(ycc, ch);
  const y = ch.get(0), cr = ch.get(1), cb = ch.get(2);
  const sigma = Math.max(1.5, Math.max(rgb.cols, rgb.rows) / 900);
  CV.GaussianBlur(cr, cr, new CV.Size(0, 0), sigma);
  CV.GaussianBlur(cb, cb, new CV.Size(0, 0), sigma);
  CV.GaussianBlur(y, y, new CV.Size(0, 0), 0.7);
  const mv = new CV.MatVector();
  mv.push_back(y);
  mv.push_back(cr);
  mv.push_back(cb);
  CV.merge(mv, ycc);
  CV.cvtColor(ycc, rgb, CV.COLOR_YCrCb2RGB);
  [y, cr, cb, ycc].forEach((m) => m.delete());
  ch.delete();
  mv.delete();
}

function applyFilter(image, filter, strength) {
  const k = typeof strength === 'number' ? Math.max(0, Math.min(1, strength)) : 0.5;
  const src = CV.matFromImageData(image);
  let out;
  if (filter === 'magic') out = magic(src, k);
  else if (filter === 'gray') out = grayscale(src, k);
  else if (filter === 'bw') out = blackWhite(src, k);
  else { out = src.clone(); }
  src.delete();
  const res = toImageData(out);
  out.delete();
  return res;
}

function magic(src, strength) {
  const rgb = new CV.Mat();
  CV.cvtColor(src, rgb, CV.COLOR_RGBA2RGB);
  chromaDenoise(rgb);
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

  inkCurve(rgb, strength);

  // boost real colour (pen / highlighter) but squash faint colour noise
  const hsv = new CV.Mat();
  CV.cvtColor(rgb, hsv, CV.COLOR_RGB2HSV);
  const hs = new CV.MatVector();
  CV.split(hsv, hs);
  const sat = hs.get(1);
  const sd = sat.data;
  for (let i = 0; i < sd.length; i++) {
    const v = sd[i];
    sd[i] = v < 28 ? v * 0.4 : Math.min(255, v * 1.35);
  }
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

function grayscale(src, strength) {
  const g = new CV.Mat();
  CV.cvtColor(src, g, CV.COLOR_RGBA2GRAY);
  CV.GaussianBlur(g, g, new CV.Size(0, 0), 0.7);
  const n = normalizeChannel(g);
  g.delete();
  inkCurve(n, strength);
  sharpen(n, 1.2, 0.6);
  const out = new CV.Mat();
  CV.cvtColor(n, out, CV.COLOR_GRAY2RGBA);
  n.delete();
  return out;
}

function blackWhite(src, strength) {
  const g = new CV.Mat();
  CV.cvtColor(src, g, CV.COLOR_RGBA2GRAY);
  const n = normalizeChannel(g);
  g.delete();
  CV.GaussianBlur(n, n, new CV.Size(3, 3), 0);
  const block = Math.max(15, odd(Math.max(n.cols, n.rows) / 55));
  const bw = new CV.Mat();
  CV.adaptiveThreshold(n, bw, 255, CV.ADAPTIVE_THRESH_GAUSSIAN_C, CV.THRESH_BINARY, block, Math.round(18 - 12 * strength));
  // anything clearly paper-white stays white (kills speckle noise)
  const white = new CV.Mat();
  CV.threshold(n, white, 222, 255, CV.THRESH_BINARY);
  CV.bitwise_or(bw, white, bw);
  // anything clearly ink-dark stays black (keeps solid regions solid)
  const dark = new CV.Mat();
  CV.threshold(n, dark, Math.round(100 + 70 * strength), 255, CV.THRESH_BINARY);
  CV.bitwise_and(bw, dark, bw);
  const out = new CV.Mat();
  CV.cvtColor(bw, out, CV.COLOR_GRAY2RGBA);
  [n, bw, white, dark].forEach((m) => m.delete());
  return out;
}
