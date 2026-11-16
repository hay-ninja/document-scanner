import './style.css';
import { Camera } from './camera';
import { cvCall, cvReady } from './cv';
import * as history from './history';
import { compact, fullQuad, invalidateWarp, makeThumb, newPage, renderPage, toOutPages } from './pages';
import { canvasToBlob, defaultName, pickTarget, writeOutput } from './save';
import { saveSettings, settings } from './settings';
import { FILTERS, type FilterName, type Format, type Mode, type OutPage, type Page, type Pt, type Quad, type Rotation } from './types';

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

const liveEl = $('#live');
const video = $<HTMLVideoElement>('#video');
const overlay = $<HTMLCanvasElement>('#overlay');
const octx = overlay.getContext('2d')!;
const stage = $('#stage');
const mirrorEl = $('#mirror');
const ring = $('#ring');
const ringFg = $('#ringFg');
const flashEl = $('#flash');
const camMsg = $('#camMsg');
const hintEl = $('#hint');
const multiBar = $('#multiBar');
const strip = $('#strip');
const pageCount = $('#pageCount');
const multiSave = $<HTMLButtonElement>('#multiSave');
const reviewEl = $('#review');
const reviewCanvas = $<HTMLCanvasElement>('#reviewCanvas');
const cornerCanvas = $<HTMLCanvasElement>('#cornerCanvas');
const reviewSpin = $('#reviewSpin');
const reviewTitle = $('#reviewTitle');
const reviewActions = $('#reviewActions');
const saveGroup = $('#saveGroup');
const cornersBtn = $<HTMLButtonElement>('#cornersBtn');
const historyPanel = $('#historyPanel');
const helpPanel = $('#helpPanel');
const historyList = $('#historyList');
const busyEl = $('#busy');
const busyText = $('#busyText');
const cameraSel = $<HTMLSelectElement>('#cameraSel');

const camera = new Camera(video);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const HOLD_MS = 450; // page must be found this long (roughly in one place) before auto-capture
const STABLE_TOL = 0.1; // generous: hands shake, only a big move restarts the countdown
const BURST_FRAMES = 4; // frames grabbed per capture; the sharpest one wins
const DETECT_WIDTH = 640;
const DETECT_INTERVAL = 50;

const state = {
  mode: 'single' as Mode,
  view: 'live' as 'live' | 'review',
  pages: [] as Page[],
  retakeIndex: null as number | null,
  cvLoaded: false,
  cvFailed: false,
  busy: false,
};

const live = {
  quad: null as Quad | null, // smoothed, normalised 0..1
  raw: null as Quad | null, // latest raw detection, normalised
  anchor: null as Quad | null, // where the page was when the current hold started
  stats: null as null | { clipped: number; brightness: number; area: number },
  capturing: false,
  lastSeen: 0,
  stableSince: 0,
  progress: 0,
  armed: true,
  capturedQuad: null as Quad | null,
  lastCaptureAt: 0,
  detecting: false,
  lastDetect: 0,
  area: null as { x0: number; y0: number; x1: number; y1: number } | null,
  areaDrag: null as null | { kind: 'new' | 'move' | 'corner'; start: Pt; orig: { x0: number; y0: number; x1: number; y1: number } | null; corner?: number },
};

const review = {
  page: null as Page | null,
  kind: 'single' as 'single' | 'multi',
  editing: false,
  editCorners: null as Quad | null,
  drag: -1,
  srcCanvas: null as HTMLCanvasElement | null,
  srcFor: null as Page | null,
  loupe: null as Pt | null,
};

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */

function toast(msg: string, error: boolean | 'ok' = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error === 'ok' ? ' ok' : error ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), error ? 6000 : 3200);
}

function showBusy(msg: string) {
  state.busy = true;
  busyText.textContent = msg;
  busyEl.classList.remove('hidden');
}
function hideBusy() {
  state.busy = false;
  busyEl.classList.add('hidden');
}

function anyPanelOpen() {
  return !historyPanel.classList.contains('hidden') || !helpPanel.classList.contains('hidden');
}

/**
 * Copy an image to the clipboard as PNG. The ClipboardItem is created synchronously
 * (with a promised blob) so the click / keypress still counts as the user gesture.
 */
function copyImage(getCanvas: () => HTMLCanvasElement | Promise<HTMLCanvasElement>, label: string) {
  const CI = (window as any).ClipboardItem;
  if (!CI || !navigator.clipboard?.write) {
    toast('Copying images needs Chrome or Edge', true);
    return;
  }
  const blob = Promise.resolve()
    .then(getCanvas)
    .then((c) => canvasToBlob(c, 'image/png'));
  navigator.clipboard
    .write([new CI({ 'image/png': blob })])
    .then(() => toast(`${label} copied — paste it anywhere with Ctrl+V`, 'ok'))
    .catch((err: any) => toast(`Copy failed: ${err?.message || err}`, true));
}

function doFlash() {
  flashEl.classList.remove('go');
  void flashEl.offsetWidth;
  flashEl.classList.add('go');
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const maxDist = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
const lerpQuad = (a: Quad, b: Quad, t: number) =>
  a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t })) as Quad;

/* ------------------------------------------------------------------ */
/* Light panel + settings controls                                     */
/* ------------------------------------------------------------------ */

function applyLight() {
  const b = settings.brightness / 100;
  const w = settings.warmth / 100;
  const warm = [255, 206, 150];
  const c = [255, 255, 255].map((v, i) => Math.round((v + (warm[i] - v) * w) * b));
  document.documentElement.style.setProperty('--light', `rgb(${c.join(',')})`);
  document.documentElement.classList.toggle('dim', b < 0.55);
}

function syncControls() {
  $<HTMLInputElement>('#brightness').value = String(settings.brightness);
  $<HTMLInputElement>('#warmth').value = String(settings.warmth);
  $<HTMLInputElement>('#autoChk').checked = settings.autoCapture;
  $<HTMLInputElement>('#mergeChk').checked = settings.mergeFrames;
  $<HTMLInputElement>('#mirrorChk').checked = settings.mirror;
  mirrorEl.classList.toggle('mirrored', settings.mirror);
  for (const box of $$('.format-chips')) {
    box.innerHTML = '';
    for (const f of ['pdf', 'jpg', 'png'] as Format[]) {
      const b = document.createElement('button');
      b.className = 'chip' + (settings.format === f ? ' active' : '');
      b.textContent = f.toUpperCase();
      b.onclick = () => {
        settings.format = f;
        saveSettings();
        syncControls();
      };
      box.appendChild(b);
    }
  }
  for (const chk of $$<HTMLInputElement>('.ocr-chk')) {
    chk.checked = settings.ocr;
    chk.disabled = settings.format !== 'pdf';
    (chk.parentElement as HTMLElement).style.opacity = settings.format === 'pdf' ? '1' : '0.45';
    (chk.parentElement as HTMLElement).title = settings.format === 'pdf' ? 'Adds an invisible text layer so the PDF is searchable / copyable' : 'Only for PDF';
  }
}

$<HTMLInputElement>('#brightness').addEventListener('input', (e) => {
  settings.brightness = Number((e.target as HTMLInputElement).value);
  applyLight();
  saveSettings();
});
$<HTMLInputElement>('#warmth').addEventListener('input', (e) => {
  settings.warmth = Number((e.target as HTMLInputElement).value);
  applyLight();
  saveSettings();
});
$<HTMLInputElement>('#mergeChk').addEventListener('change', (e) => {
  settings.mergeFrames = (e.target as HTMLInputElement).checked;
  saveSettings();
});
$<HTMLInputElement>('#autoChk').addEventListener('change', (e) => {
  settings.autoCapture = (e.target as HTMLInputElement).checked;
  saveSettings();
});
$<HTMLInputElement>('#mirrorChk').addEventListener('change', (e) => {
  settings.mirror = (e.target as HTMLInputElement).checked;
  saveSettings();
  syncControls();
});
for (const chk of $$<HTMLInputElement>('.ocr-chk')) {
  chk.addEventListener('change', () => {
    settings.ocr = chk.checked;
    saveSettings();
    syncControls();
  });
}
$('#fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
$('#captureBtn').addEventListener('click', () => capture(true));
$('#historyBtn').addEventListener('click', () => openHistory());
$('#helpBtn').addEventListener('click', () => helpPanel.classList.remove('hidden'));
for (const btn of $$('[data-close]')) {
  btn.addEventListener('click', () => (btn.closest('.panel') as HTMLElement).classList.add('hidden'));
}
for (const panel of [historyPanel, helpPanel]) {
  panel.addEventListener('click', (e) => {
    if (e.target === panel) panel.classList.add('hidden');
  });
}
// keep keyboard shortcuts from re-triggering focused buttons / checkboxes
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button, input[type=checkbox]') as HTMLElement | null;
  el?.blur();
});
document.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type === 'range') return;
  if (t instanceof HTMLSelectElement) t.blur();
});

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

const MODE_DESC: Record<Mode, string> = {
  single: 'Hold one page up to the camera. As soon as it is outlined it captures — then copy or save it.',
  multi: 'Scan several pages in a row: each is captured when still, then swap in the next. Copy pages one by one, or finish to save them together.',
  area: 'Drag a box over the camera view to scan just that region (resize from its corners), then press Enter.',
};

function setMode(m: Mode) {
  if (state.view !== 'live') return;
  state.mode = m;
  for (const b of $$('#modes button')) b.classList.toggle('active', b.dataset.mode === m);
  $('#modeDesc').textContent = MODE_DESC[m];
  multiBar.classList.toggle('hidden', m !== 'multi');
  liveEl.classList.toggle('has-strip', m === 'multi');
  stage.classList.toggle('area-mode', m === 'area');
  live.quad = null;
  live.raw = null;
  live.armed = true;
  live.progress = 0;
  if (m !== 'multi') state.retakeIndex = null;
  renderStrip();
}
for (const b of $$('#modes button')) b.addEventListener('click', () => setMode(b.dataset.mode as Mode));

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

function onVideoSize() {
  if (!video.videoWidth) return;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  stage.style.setProperty('--aspect', String(video.videoWidth / video.videoHeight));
}
video.addEventListener('loadedmetadata', onVideoSize);
video.addEventListener('resize', onVideoSize);

let cameraOn = true;

function setCameraButton() {
  $('#camToggle').innerHTML = cameraOn ? 'Turn camera off <kbd>O</kbd>' : 'Turn camera on <kbd>O</kbd>';
  $('#camToggle').classList.toggle('primary', !cameraOn);
}

async function toggleCamera(on = !cameraOn) {
  cameraOn = on;
  setCameraButton();
  if (!on) {
    camera.stop();
    video.srcObject = null;
    live.quad = live.raw = live.anchor = null;
    live.progress = 0;
    camMsg.classList.remove('hidden');
    camMsg.innerHTML = '<div>Camera is off<br><span class="small">Click here or press O to turn it back on</span></div>';
    $('#camRes').textContent = '';
    return;
  }
  await startCamera(settings.deviceId || undefined);
}

$('#camToggle').addEventListener('click', () => toggleCamera());
camMsg.addEventListener('click', () => {
  if (!cameraOn) toggleCamera(true);
});

async function startCamera(deviceId?: string) {
  camMsg.classList.remove('hidden');
  camMsg.textContent = 'Starting camera…';
  try {
    await camera.start(deviceId);
    camMsg.classList.add('hidden');
    onVideoSize();
    await applySavedCamControls();
    await populateCameras();
    renderCamControls();
  } catch (err: any) {
    const denied = err?.name === 'NotAllowedError';
    camMsg.textContent = denied
      ? 'Camera permission was blocked. Click the camera icon in the address bar, allow it, then reload.'
      : `Could not start the camera (${err?.message || err}). Is another app using it?`;
  }
}

/* ---------- webcam image controls (exposure, contrast, focus…) ---------- */

async function applySavedCamControls() {
  const avail = new Set(camera.controls().map((c) => c.name));
  for (const [name, v] of Object.entries(settings.camControls)) {
    if (avail.has(name)) await camera.setControl(name, v).catch(() => {});
  }
}

function renderCamControls() {
  $('#camRes').textContent = camera.ready ? `· ${camera.width}×${camera.height}` : '';
  const box = $('#camControls');
  box.innerHTML = '';
  const ctrls = camera.controls();
  for (const c of ctrls) {
    const label = document.createElement('label');
    label.className = 'slider';
    const span = document.createElement('span');
    span.textContent = c.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(settings.camControls[c.name] ?? c.value);
    let pending = 0;
    input.addEventListener('input', () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const v = Number(input.value);
        settings.camControls[c.name] = v;
        saveSettings();
        camera.setControl(c.name, v).catch((err) => console.warn('camera control', c.name, err));
      });
    });
    label.append(span, input);
    box.appendChild(label);
  }
  $('#camReset').classList.toggle('hidden', !ctrls.length);
}

$('#camReset').addEventListener('click', async () => {
  settings.camControls = {};
  saveSettings();
  await camera.resetAuto();
  // a fresh stream is the most reliable way back to the driver's defaults
  await startCamera(settings.deviceId || undefined);
  toast('Camera back to automatic settings');
});

async function populateCameras() {
  const cams = await Camera.list();
  cameraSel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `Camera ${i + 1}`;
    cameraSel.appendChild(o);
  });
  cameraSel.value = camera.deviceId;
  cameraSel.classList.toggle('hidden', cams.length < 2);
}
cameraSel.addEventListener('change', async () => {
  settings.deviceId = cameraSel.value;
  saveSettings();
  await startCamera(cameraSel.value);
});

/* ------------------------------------------------------------------ */
/* Detection loop + auto-capture                                       */
/* ------------------------------------------------------------------ */

function canDetect() {
  return state.cvLoaded && camera.ready && state.view === 'live' && state.mode !== 'area' && !anyPanelOpen() && !state.busy && !live.capturing;
}

interface DetectResult {
  corners: Pt[];
  clipped: number;
  brightness: number;
  area: number;
}

async function detectTick(now: number) {
  if (live.detecting || now - live.lastDetect < DETECT_INTERVAL || !canDetect()) return;
  live.detecting = true;
  live.lastDetect = now;
  try {
    const img = camera.grab(DETECT_WIDTH);
    const res = await cvCall<DetectResult | null>('detect', { image: img });
    if (canDetect()) handleDetection(res, img.width, img.height);
  } catch (err) {
    console.warn('detect failed', err);
  } finally {
    live.detecting = false;
  }
}

function handleDetection(res: DetectResult | null, w: number, h: number) {
  const now = performance.now();
  if (res) {
    const q = res.corners.map((p) => ({ x: p.x / w, y: p.y / h })) as Quad;
    live.raw = q;
    live.lastSeen = now;
    live.stats = { clipped: res.clipped, brightness: res.brightness, area: res.area };
    // hand-held pages always jiggle a little: only restart the hold if the page drifts
    // more than STABLE_TOL away from where the hold started
    if (!live.anchor || maxDist(q, live.anchor) > STABLE_TOL) {
      live.anchor = q;
      live.stableSince = now;
    }
    live.quad = live.quad && maxDist(live.quad, q) < 0.15 ? lerpQuad(live.quad, q, 0.3) : q;
  } else if (now - live.lastSeen > 700) {
    live.quad = null;
    live.raw = null;
    live.anchor = null;
    live.stats = null;
    live.stableSince = now;
  }

  if (!live.armed) {
    const gone = !live.quad && now - live.lastSeen > 500;
    const moved = !!(live.quad && live.capturedQuad && maxDist(live.quad, live.capturedQuad) > 0.12);
    if (now - live.lastCaptureAt > 1200 && (gone || moved || !live.capturedQuad)) {
      live.armed = true;
      live.stableSince = now;
    }
  }

  live.progress = live.quad && live.armed && settings.autoCapture ? clamp((now - live.stableSince) / HOLD_MS, 0, 1) : 0;
  if (live.progress >= 1) capture(false);
}

function updateHint() {
  let msg = '';
  if (!camera.ready) msg = '';
  else if (state.cvFailed) msg = 'Scanner engine failed to load — reload the page';
  else if (!state.cvLoaded) msg = 'Loading scanner engine…';
  else if (state.mode === 'area') {
    msg = live.area ? 'Press Enter to capture this area · Esc to clear' : 'Drag a box over what you want to scan';
  } else if (state.retakeIndex !== null) {
    msg = `Retaking page ${state.retakeIndex + 1} — hold up the page`;
  } else if (live.capturing) {
    msg = 'Capturing…';
  } else if (!live.armed) {
    msg = state.mode === 'multi' ? `Page ${state.pages.length} captured ✓ — swap in the next page` : 'Captured ✓';
  } else if (!live.quad) {
    msg = 'Hold the page up with all 4 corners in view';
  } else if (live.stats && live.stats.area < 0.2) {
    msg = 'Bring the page closer — it should fill most of the view';
  } else if (live.stats && live.stats.clipped > 0.45) {
    msg = 'Page looks washed out — lower Brightness or camera Exposure';
  } else if (live.stats && live.stats.brightness < 0.33) {
    msg = 'Too dark — turn the screen light up';
  } else if (!settings.autoCapture) {
    msg = 'Page found — press Space to capture';
  } else {
    msg = 'Got it — capturing…';
  }
  if (hintEl.textContent !== msg) hintEl.textContent = msg;
}

function updateRing() {
  const show = live.armed && !!live.quad && live.progress > 0.04 && state.mode !== 'area';
  ring.classList.toggle('show', show);
  ringFg.style.strokeDashoffset = String(251.33 * (1 - live.progress));
}

function drawOverlay() {
  const W = overlay.width;
  const H = overlay.height;
  octx.clearRect(0, 0, W, H);
  if (state.view !== 'live' || !W) return;
  const lw = Math.max(2, W / 320);

  if (state.mode === 'area') {
    const r = live.area;
    if (!r) return;
    const x0 = Math.min(r.x0, r.x1) * W, x1 = Math.max(r.x0, r.x1) * W;
    const y0 = Math.min(r.y0, r.y1) * H, y1 = Math.max(r.y0, r.y1) * H;
    octx.fillStyle = 'rgba(0,0,0,0.45)';
    octx.fillRect(0, 0, W, H);
    octx.clearRect(x0, y0, x1 - x0, y1 - y0);
    octx.strokeStyle = '#3b82f6';
    octx.lineWidth = lw;
    octx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    octx.fillStyle = '#fff';
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      octx.beginPath();
      octx.arc(x, y, lw * 2.6, 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }
    return;
  }

  const q = live.quad;
  if (!q) return;
  const color = !live.armed ? '148,163,184' : live.progress > 0.04 ? '34,197,94' : '59,130,246';
  octx.beginPath();
  q.forEach((p, i) => (i ? octx.lineTo(p.x * W, p.y * H) : octx.moveTo(p.x * W, p.y * H)));
  octx.closePath();
  octx.fillStyle = `rgba(${color},0.18)`;
  octx.fill();
  octx.strokeStyle = `rgb(${color})`;
  octx.lineWidth = lw;
  octx.lineJoin = 'round';
  octx.stroke();
  octx.fillStyle = '#fff';
  for (const p of q) {
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, lw * 2.4, 0, Math.PI * 2);
    octx.fill();
    octx.stroke();
  }
}

function frame(now: number) {
  detectTick(now);
  drawOverlay();
  updateRing();
  updateHint();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve on the next decoded video frame (falls back to a short timer). */
function nextVideoFrame(): Promise<void> {
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (typeof v.requestVideoFrameCallback === 'function') {
    return new Promise((r) => {
      v.requestVideoFrameCallback!(() => r());
      setTimeout(r, 80);
    });
  }
  return sleep(35).then(() => undefined);
}

type Shot = { img: ImageData; corners: Quad; found: boolean; detected: number; merged?: number };

async function detectNorm(small: ImageData): Promise<Quad | null> {
  try {
    const det = await cvCall<DetectResult | null>('detect', { image: small });
    return det ? (det.corners.map((p) => ({ x: p.x / small.width, y: p.y / small.height })) as Quad) : null;
  } catch {
    return null;
  }
}

/**
 * Instant capture: grab the next few video frames back to back (no waiting for the user
 * to hold still), find the page in each, then merge the sharpest frames that agree on
 * where the page is. With fixedNorm (custom area) detection is skipped.
 */
async function burst(fallback: Quad | null, fixedNorm?: Quad): Promise<Shot> {
  const frames: { img: ImageData; corners: Quad; norm: Quad | null; sharp: number }[] = [];
  for (let i = 0; i < BURST_FRAMES; i++) {
    if (i) await nextVideoFrame();
    const { full, small } = camera.grabPair(DETECT_WIDTH);
    let q: Quad | null = fixedNorm ?? (await detectNorm(small));
    // a detection far from where the page was is probably a mis-detection
    if (q && fallback && !fixedNorm && maxDist(q, fallback) > 0.15) q = null;
    const use = q ?? fallback;
    const corners = use
      ? (use.map((p) => ({ x: p.x * full.width, y: p.y * full.height })) as Quad)
      : fullQuad(full.width, full.height);
    let sharp = 0;
    try {
      sharp = await cvCall<number>('sharpness', { image: full, corners });
    } catch {
      /* ignore */
    }
    frames.push({ img: full, corners, norm: q, sharp: q ? sharp : sharp * 0.6 });
  }

  frames.sort((a, b) => b.sharp - a.sharp);
  const best = frames[0];
  let img = best.img;
  let merged = 1;
  if (settings.mergeFrames) {
    const group = frames
      .filter((f) => f === best || (f.norm && best.norm ? maxDist(f.norm, best.norm) < 0.06 : !!fixedNorm))
      .slice(0, 3);
    if (group.length >= 2) {
      try {
        const r = await cvCall<{ image: ImageData; used: number }>('stack', {
          frames: group.map((f) => ({ image: f.img, corners: f.corners })),
        });
        img = r.image;
        merged = r.used;
      } catch (err) {
        console.warn('merge failed', err);
      }
    }
  }
  const detected = frames.filter((f) => f.norm).length;
  return { img, corners: best.corners, found: !!best.norm || !!fixedNorm || !!fallback, detected, merged };
}

async function capture(manual: boolean) {
  if (live.capturing || state.view !== 'live' || !camera.ready || anyPanelOpen() || state.busy) return;
  if (state.mode === 'area') {
    captureArea();
    return;
  }
  const q = live.raw ?? live.quad;
  live.capturing = true;
  live.armed = false;
  live.capturedQuad = q;
  live.lastCaptureAt = performance.now();
  live.progress = 0;
  if (manual) doFlash();
  try {
    const shot = await burst(q);
    if (!manual && shot.detected === 0) {
      // page left the frame mid-burst: don't save a picture of the background
      live.armed = true;
      live.anchor = null;
      return;
    }
    if (!manual) doFlash();
    if (manual && !shot.found) toast('No page outline found — captured the whole frame');
    live.lastCaptureAt = performance.now();
    const page = newPage(shot.img, shot.corners, settings.filter, settings.ink);
    if (state.mode === 'multi') addMultiPage(page);
    else openReview(page, 'single');
  } finally {
    live.capturing = false;
  }
}

async function captureArea() {
  const r = live.area;
  if (!r) {
    toast('Drag a box over the camera view first');
    return;
  }
  if (live.capturing) return;
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const norm: Quad = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  live.capturing = true;
  doFlash();
  try {
    const shot = await burst(null, norm);
    openReview(newPage(shot.img, shot.corners, settings.filter, settings.ink), 'single');
  } finally {
    live.capturing = false;
  }
}

/* ---------- custom-area selection on the live view ---------- */

function toNorm(e: PointerEvent): Pt {
  const r = mirrorEl.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (settings.mirror) x = 1 - x;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

overlay.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'area' || state.view !== 'live') return;
  overlay.setPointerCapture(e.pointerId);
  const p = toNorm(e);
  const r = live.area;
  const rect = mirrorEl.getBoundingClientRect();
  if (r) {
    const xs = [Math.min(r.x0, r.x1), Math.max(r.x0, r.x1)];
    const ys = [Math.min(r.y0, r.y1), Math.max(r.y0, r.y1)];
    const norm = { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] };
    const cs = [
      { x: xs[0], y: ys[0] },
      { x: xs[1], y: ys[0] },
      { x: xs[1], y: ys[1] },
      { x: xs[0], y: ys[1] },
    ];
    const hit = cs.findIndex((c) => Math.hypot((c.x - p.x) * rect.width, (c.y - p.y) * rect.height) < 18);
    if (hit >= 0) {
      live.area = norm;
      live.areaDrag = { kind: 'corner', start: p, orig: { ...norm }, corner: hit };
      return;
    }
    if (p.x > xs[0] && p.x < xs[1] && p.y > ys[0] && p.y < ys[1]) {
      live.area = norm;
      live.areaDrag = { kind: 'move', start: p, orig: { ...norm } };
      return;
    }
  }
  live.area = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  live.areaDrag = { kind: 'new', start: p, orig: null };
});

overlay.addEventListener('pointermove', (e) => {
  const d = live.areaDrag;
  if (!d || !live.area) return;
  const p = toNorm(e);
  if (d.kind === 'new') {
    live.area.x1 = p.x;
    live.area.y1 = p.y;
  } else if (d.kind === 'move' && d.orig) {
    const w = d.orig.x1 - d.orig.x0, h = d.orig.y1 - d.orig.y0;
    const nx = clamp(d.orig.x0 + p.x - d.start.x, 0, 1 - w);
    const ny = clamp(d.orig.y0 + p.y - d.start.y, 0, 1 - h);
    live.area = { x0: nx, y0: ny, x1: nx + w, y1: ny + h };
  } else if (d.kind === 'corner' && d.orig) {
    const a = { ...d.orig };
    if (d.corner === 0 || d.corner === 3) a.x0 = p.x;
    else a.x1 = p.x;
    if (d.corner === 0 || d.corner === 1) a.y0 = p.y;
    else a.y1 = p.y;
    live.area = a;
  }
});

overlay.addEventListener('pointerup', () => {
  if (!live.areaDrag) return;
  live.areaDrag = null;
  const r = live.area;
  if (r && (Math.abs(r.x1 - r.x0) < 0.02 || Math.abs(r.y1 - r.y0) < 0.02)) live.area = null;
  else if (r) live.area = { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
});

/* ------------------------------------------------------------------ */
/* Multi-page strip                                                    */
/* ------------------------------------------------------------------ */

function addMultiPage(page: Page) {
  let idx: number;
  if (state.retakeIndex !== null && state.retakeIndex < state.pages.length) {
    idx = state.retakeIndex;
    state.pages[idx] = page;
    state.retakeIndex = null;
    toast(`Page ${idx + 1} retaken`);
  } else {
    state.pages.push(page);
    idx = state.pages.length - 1;
  }
  renderStrip();
  strip.scrollTo({ left: strip.scrollWidth, behavior: 'smooth' });
  renderPage(page)
    .then((c) => {
      page.thumb = makeThumb(c);
      if (review.page !== page) compact(page);
      renderStrip();
    })
    .catch((err) => toast(`Processing failed: ${err.message}`, true));
}

let dragFrom = -1;
function renderStrip() {
  strip.innerHTML = '';
  state.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (p.thumb ? '' : ' pending') + (state.retakeIndex === i ? ' retake' : '');
    el.draggable = true;
    el.title = 'Click to edit · drag to reorder';
    if (p.thumb) {
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = `Page ${i + 1}`;
      el.appendChild(img);
    } else {
      const s = document.createElement('div');
      s.className = 'spin';
      el.appendChild(s);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    el.appendChild(num);
    const btns = document.createElement('div');
    btns.className = 'tbtns';
    const copy = document.createElement('button');
    copy.className = 'tbtn copy';
    copy.textContent = 'Copy';
    copy.title = `Copy page ${i + 1} to the clipboard`;
    copy.onclick = (e) => {
      e.stopPropagation();
      copyImage(() => p.result ?? renderPage(p), `Page ${i + 1}`);
    };
    const del = document.createElement('button');
    del.className = 'tbtn';
    del.textContent = '×';
    del.title = 'Delete page';
    del.onclick = (e) => {
      e.stopPropagation();
      deletePage(i);
    };
    btns.append(copy, del);
    el.appendChild(btns);
    el.onclick = () => openReview(p, 'multi');
    el.addEventListener('dragstart', (e) => {
      dragFrom = i;
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(i));
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom < 0 || dragFrom === i) return;
      const [moved] = state.pages.splice(dragFrom, 1);
      state.pages.splice(i, 0, moved);
      dragFrom = -1;
      renderStrip();
    });
    strip.appendChild(el);
  });
  const n = state.pages.length;
  pageCount.textContent = String(n);
  multiSave.disabled = n === 0;
  $<HTMLButtonElement>('#multiClear').disabled = n === 0;
}

function deletePage(i: number) {
  state.pages.splice(i, 1);
  if (state.retakeIndex !== null) {
    if (state.retakeIndex === i) state.retakeIndex = null;
    else if (state.retakeIndex > i) state.retakeIndex--;
  }
  renderStrip();
}

multiSave.addEventListener('click', () => saveMulti());
$('#multiClear').addEventListener('click', async () => {
  if (!state.pages.length) return;
  const out = state.pages.filter((p) => p.result).map((p) => ({ canvas: p.result!, bw: p.filter === 'bw' }));
  state.pages = [];
  state.retakeIndex = null;
  renderStrip();
  toast('Cleared — the pages are still in History');
  if (out.length) await addHistory(out, { name: defaultName(), saved: false, thumb: makeThumb(out[0].canvas, 140) });
});

/* ------------------------------------------------------------------ */
/* Review screen                                                       */
/* ------------------------------------------------------------------ */

function openReview(page: Page, kind: 'single' | 'multi') {
  review.page = page;
  review.kind = kind;
  review.editing = false;
  state.view = 'review';
  reviewEl.classList.remove('hidden');
  cornerCanvas.classList.add('hidden');
  reviewCanvas.classList.remove('hidden');
  $('#cornerTip').classList.add('hidden');
  cornersBtn.innerHTML = 'Adjust corners <kbd>C</kbd>';
  saveGroup.classList.toggle('hidden', kind !== 'single');
  const pageNav = $('#pageNav');
  pageNav.classList.toggle('hidden', kind !== 'multi');
  if (kind === 'single') {
    reviewTitle.textContent = 'Review scan';
    $('#copyBtn').innerHTML = 'Copy image <kbd>Ctrl+C</kbd>';
  } else {
    const i = state.pages.indexOf(page);
    reviewTitle.textContent = `Page ${i + 1}`;
    $('#pageNavText').textContent = `${i + 1} / ${state.pages.length}`;
    $<HTMLButtonElement>('#prevPage').disabled = i <= 0;
    $<HTMLButtonElement>('#nextPage').disabled = i >= state.pages.length - 1;
    $('#copyBtn').innerHTML = `Copy page ${i + 1} <kbd>Ctrl+C</kbd>`;
  }
  // clear previous image so stale content isn't shown
  reviewCanvas.width = 10;
  reviewCanvas.height = 14;
  buildActions();
  renderFilterChips();
  refreshReview();
}

function buildActions() {
  reviewActions.innerHTML = '';
  const add = (html: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.innerHTML = html;
    b.onclick = fn;
    reviewActions.appendChild(b);
  };
  if (review.kind === 'single') {
    add('Retake', '', () => retakeSingle());
    add('Discard <kbd>Esc</kbd>', 'danger', () => discardSingle());
  } else {
    add('Back to scanning <kbd>Enter</kbd>', 'primary', () => closeReview());
    add('Retake this page', '', () => retakeMultiPage());
    add('Delete page <kbd>Del</kbd>', 'danger', () => deleteReviewedPage());
  }
}

function copyReviewed() {
  const page = review.page;
  if (!page || review.editing) return;
  const label = review.kind === 'multi' ? `Page ${state.pages.indexOf(page) + 1}` : 'Scan';
  copyImage(() => renderPage(page), label);
}

function gotoPage(delta: number) {
  const page = review.page;
  if (!page || review.kind !== 'multi' || review.editing) return;
  const next = state.pages[state.pages.indexOf(page) + delta];
  if (!next) return;
  closeReview();
  openReview(next, 'multi');
}

$('#copyBtn').addEventListener('click', () => copyReviewed());
$('#saveBtn').addEventListener('click', () => saveSingle());
$('#prevPage').addEventListener('click', () => gotoPage(-1));
$('#nextPage').addEventListener('click', () => gotoPage(1));

function renderFilterChips() {
  const box = $('#filterChips');
  box.innerHTML = '';
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.className = 'chip' + (review.page?.filter === f.id ? ' active' : '');
    b.textContent = f.label;
    b.onclick = () => setFilter(f.id);
    box.appendChild(b);
  }
  const ink = $<HTMLInputElement>('#inkRange');
  ink.value = String(Math.round((review.page?.ink ?? settings.ink) * 100));
  ink.disabled = review.page?.filter === 'original';
  (ink.parentElement as HTMLElement).style.opacity = ink.disabled ? '0.45' : '1';
}

let inkTimer = 0;
$<HTMLInputElement>('#inkRange').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value) / 100;
  clearTimeout(inkTimer);
  inkTimer = window.setTimeout(() => {
    if (!review.page) return;
    review.page.ink = v;
    settings.ink = v;
    saveSettings();
    refreshReview();
  }, 120);
});

async function refreshReview() {
  const page = review.page;
  if (!page) return;
  reviewSpin.classList.remove('hidden');
  try {
    const c = await renderPage(page);
    if (review.page === page && !review.editing && state.view === 'review') {
      reviewCanvas.width = c.width;
      reviewCanvas.height = c.height;
      reviewCanvas.getContext('2d')!.drawImage(c, 0, 0);
    }
  } catch (err: any) {
    toast(`Processing failed: ${err.message}`, true);
  } finally {
    if (review.page === page) reviewSpin.classList.add('hidden');
  }
}

function setFilter(f: FilterName) {
  if (!review.page) return;
  review.page.filter = f;
  settings.filter = f;
  saveSettings();
  renderFilterChips();
  refreshReview();
}

function cycleFilter(dir: number) {
  if (!review.page) return;
  const i = FILTERS.findIndex((f) => f.id === review.page!.filter);
  setFilter(FILTERS[(i + dir + FILTERS.length) % FILTERS.length].id);
}

function rotate(deg: number) {
  if (!review.page || review.editing) return;
  review.page.rotation = (((review.page.rotation + deg) % 360) + 360) % 360 as Rotation;
  refreshReview();
}

function closeReview() {
  const page = review.page;
  if (review.kind === 'multi' && page) {
    if (page.result) page.thumb = makeThumb(page.result);
    compact(page);
    renderStrip();
  }
  review.page = null;
  review.editing = false;
  review.srcCanvas = null;
  review.srcFor = null;
  reviewEl.classList.add('hidden');
  state.view = 'live';
}

function rearm(immediately: boolean) {
  const now = performance.now();
  live.armed = immediately;
  live.capturedQuad = immediately ? null : live.capturedQuad;
  live.lastCaptureAt = now;
  live.stableSince = now;
  live.progress = 0;
}

function retakeSingle() {
  closeReview();
  rearm(true);
}

async function discardSingle() {
  const page = review.page;
  closeReview();
  rearm(false);
  if (page?.result) {
    const out: OutPage[] = [{ canvas: page.result, bw: page.filter === 'bw' }];
    await addHistory(out, { name: defaultName(), saved: false, thumb: makeThumb(page.result, 140) });
  }
}

function retakeMultiPage() {
  const page = review.page;
  if (!page) return;
  state.retakeIndex = state.pages.indexOf(page);
  closeReview();
  rearm(true);
  renderStrip();
}

function deleteReviewedPage() {
  const page = review.page;
  if (!page) return;
  const i = state.pages.indexOf(page);
  closeReview();
  if (i >= 0) deletePage(i);
}

$('#rotL').addEventListener('click', () => rotate(-90));
$('#rotR').addEventListener('click', () => rotate(90));
cornersBtn.addEventListener('click', () => toggleCorners());

/* ---------- corner editor ---------- */

function toggleCorners(cancel = false) {
  const page = review.page;
  if (!page) return;
  if (!review.editing) {
    if (cancel) return;
    review.editing = true;
    review.editCorners = page.corners.map((p) => ({ ...p })) as Quad;
    if (review.srcFor !== page || !review.srcCanvas) {
      const c = document.createElement('canvas');
      c.width = page.source.width;
      c.height = page.source.height;
      c.getContext('2d')!.putImageData(page.source, 0, 0);
      review.srcCanvas = c;
      review.srcFor = page;
    }
    cornerCanvas.width = page.source.width;
    cornerCanvas.height = page.source.height;
    reviewCanvas.classList.add('hidden');
    cornerCanvas.classList.remove('hidden');
    cornersBtn.innerHTML = 'Apply corners <kbd>Enter</kbd>';
    $('#cornerTip').classList.remove('hidden');
    drawCorners();
  } else {
    review.editing = false;
    if (!cancel && review.editCorners) {
      page.corners = review.editCorners;
      invalidateWarp(page);
    }
    cornerCanvas.classList.add('hidden');
    reviewCanvas.classList.remove('hidden');
    cornersBtn.innerHTML = 'Adjust corners <kbd>C</kbd>';
    $('#cornerTip').classList.add('hidden');
    refreshReview();
  }
}

function drawCorners() {
  const src = review.srcCanvas;
  const q = review.editCorners;
  if (!src || !q) return;
  const ctx = cornerCanvas.getContext('2d')!;
  const W = cornerCanvas.width;
  const H = cornerCanvas.height;
  ctx.drawImage(src, 0, 0);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill('evenodd');
  const lw = Math.max(2, W / 400);
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = lw;
  ctx.stroke();
  q.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw * 5, 0, Math.PI * 2);
    ctx.fillStyle = i === review.drag ? '#3b82f6' : 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.stroke();
  });
  // magnifier while dragging
  const l = review.loupe;
  if (l) {
    const R = Math.min(W, H) * 0.14;
    const zoom = 3;
    const cx = l.x < W / 2 ? W - R - lw * 6 : R + lw * 6;
    const cy = R + lw * 6;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.drawImage(src, l.x - R / zoom, l.y - R / zoom, (R * 2) / zoom, (R * 2) / zoom, cx - R, cy - R, R * 2, R * 2);
    // quad edges inside the loupe
    ctx.translate(cx - l.x * zoom, cy - l.y * zoom);
    ctx.scale(zoom, zoom);
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = lw / zoom;
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = lw * 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function toSrc(e: PointerEvent): Pt {
  const r = cornerCanvas.getBoundingClientRect();
  return {
    x: clamp(((e.clientX - r.left) / r.width) * cornerCanvas.width, 0, cornerCanvas.width),
    y: clamp(((e.clientY - r.top) / r.height) * cornerCanvas.height, 0, cornerCanvas.height),
  };
}

cornerCanvas.addEventListener('pointerdown', (e) => {
  const q = review.editCorners;
  if (!q) return;
  const p = toSrc(e);
  const r = cornerCanvas.getBoundingClientRect();
  const tol = (36 * cornerCanvas.width) / r.width;
  let best = -1;
  let bestD = Infinity;
  q.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (bestD > tol) return;
  review.drag = best;
  review.loupe = q[best];
  cornerCanvas.setPointerCapture(e.pointerId);
  cornerCanvas.classList.add('dragging');
  drawCorners();
});
cornerCanvas.addEventListener('pointermove', (e) => {
  if (review.drag < 0 || !review.editCorners) return;
  const p = toSrc(e);
  review.editCorners[review.drag] = p;
  review.loupe = p;
  drawCorners();
});
cornerCanvas.addEventListener('pointerup', () => {
  review.drag = -1;
  review.loupe = null;
  cornerCanvas.classList.remove('dragging');
  drawCorners();
});

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

async function runSave(
  target: NonNullable<Awaited<ReturnType<typeof pickTarget>>>,
  getPages: () => Promise<OutPage[]>,
  format: Format,
): Promise<OutPage[] | null> {
  showBusy('Preparing…');
  try {
    const out = await getPages();
    await writeOutput(target, out, format, { ocr: settings.ocr && format === 'pdf', onStatus: (m) => (busyText.textContent = m) });
    return out;
  } catch (err: any) {
    console.error(err);
    toast(`Save failed: ${err?.message || err}`, true);
    return null;
  } finally {
    hideBusy();
  }
}

// NOTE: these are called straight from click / keydown handlers. pickTarget() must be the first await.
async function saveSingle() {
  const page = review.page;
  if (!page || state.busy) return;
  const format = settings.format;
  const target = await pickTarget(format, defaultName(), 1);
  if (!target) return;
  const out = await runSave(target, () => toOutPages([page]), format);
  if (!out) return;
  toast(`Saved ${target.label}`);
  closeReview();
  rearm(false);
  await addHistory(out, { name: target.label, saved: true, thumb: makeThumb(out[0].canvas, 140) });
}

async function saveMulti() {
  if (!state.pages.length || state.busy) return;
  const format = settings.format;
  const n = state.pages.length;
  const target = await pickTarget(format, defaultName(), format === 'pdf' ? 1 : n);
  if (!target) return;
  const out = await runSave(target, () => toOutPages(state.pages), format);
  if (!out) return;
  toast(`Saved ${n} page${n > 1 ? 's' : ''} → ${target.label}`);
  state.pages = [];
  state.retakeIndex = null;
  renderStrip();
  rearm(false);
  await addHistory(out, { name: target.label, saved: true, thumb: makeThumb(out[0].canvas, 140) });
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

// small cache so copying several pages of one scan doesn't re-decode it each time
let historyCache: { id: string; pages: Promise<OutPage[]> } | null = null;
function historyPages(id: string): Promise<OutPage[]> {
  if (historyCache?.id !== id) historyCache = { id, pages: history.loadPages(id) };
  return historyCache.pages;
}

async function addHistory(...args: Parameters<typeof history.add>) {
  await history.add(...args);
  if (!historyPanel.classList.contains('hidden')) renderHistory();
}

async function openHistory() {
  if (state.view !== 'live') return;
  historyPanel.classList.remove('hidden');
  await renderHistory();
}

async function renderHistory() {
  const items = await history.list();
  historyList.innerHTML = '';
  if (!items.length) {
    historyList.innerHTML = '<p class="muted">No scans yet.</p>';
    return;
  }
  for (const e of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const img = document.createElement('img');
    img.src = e.thumb;
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.name;
    const badge = document.createElement('span');
    badge.className = 'badge' + (e.saved ? '' : ' unsaved');
    badge.textContent = e.saved ? 'saved' : 'not saved';
    name.appendChild(badge);
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = `${new Date(e.date).toLocaleString()} · ${e.pages} page${e.pages > 1 ? 's' : ''}`;
    const copies = document.createElement('div');
    copies.className = 'copies';
    const copyLabel = document.createElement('span');
    copyLabel.className = 'muted small';
    copyLabel.textContent = 'Copy:';
    copies.appendChild(copyLabel);
    for (let i = 0; i < e.pages; i++) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = e.pages === 1 ? 'Image' : `Page ${i + 1}`;
      b.title = 'Copy to clipboard';
      b.onclick = () =>
        copyImage(async () => (await historyPages(e.id))[i].canvas, e.pages === 1 ? 'Scan' : `Page ${i + 1}`);
      copies.appendChild(b);
    }
    meta.append(name, sub, copies);
    const actions = document.createElement('div');
    actions.className = 'acts';
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.onclick = fn;
      actions.appendChild(b);
    };
    mk('Save again', 'primary', () => resaveHistory(e));
    mk('Open', '', () => openHistoryEntry(e));
    mk('Delete', 'danger', async () => {
      await history.remove(e.id);
      renderHistory();
    });
    row.append(img, meta, actions);
    historyList.appendChild(row);
  }
}

async function resaveHistory(e: history.HistoryEntry) {
  if (state.busy) return;
  const format = settings.format;
  const base = e.saved && /\.\w+$/.test(e.name) ? e.name.replace(/\.[^.]+$/, '') : defaultName(new Date(e.date));
  const target = await pickTarget(format, base, format === 'pdf' ? 1 : e.pages);
  if (!target) return;
  const out = await runSave(target, () => history.loadPages(e.id), format);
  if (!out) return;
  await history.markSaved(e.id, target.label);
  toast(`Saved ${target.label}`);
  renderHistory();
}

async function openHistoryEntry(e: history.HistoryEntry) {
  showBusy('Opening…');
  try {
    const out = await history.loadPages(e.id);
    for (const o of out) {
      const data = o.canvas.getContext('2d')!.getImageData(0, 0, o.canvas.width, o.canvas.height);
      const p = newPage(data, fullQuad(data.width, data.height), 'original');
      p.result = o.canvas;
      p.thumb = makeThumb(o.canvas);
      state.pages.push(p);
    }
    historyPanel.classList.add('hidden');
    setMode('multi');
    toast(`Opened ${out.length} page${out.length > 1 ? 's' : ''} — add more or Finish & save`);
  } catch (err: any) {
    toast(`Could not open: ${err.message}`, true);
  } finally {
    hideBusy();
  }
}

$('#historyClear').addEventListener('click', async () => {
  await history.clear();
  renderHistory();
});

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  if (t instanceof HTMLInputElement && !['checkbox', 'range'].includes(t.type)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && state.view === 'review' && !anyPanelOpen() && !state.busy) {
    if (window.getSelection()?.toString()) return; // let normal text copy through
    e.preventDefault();
    copyReviewed();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.busy) {
    e.preventDefault();
    return;
  }
  const k = e.key;
  const lower = k.toLowerCase();
  if ([' ', 'Enter'].includes(k)) e.preventDefault();

  if (anyPanelOpen()) {
    if (k === 'Escape') {
      historyPanel.classList.add('hidden');
      helpPanel.classList.add('hidden');
    }
    return;
  }

  if (state.view === 'review') {
    if (review.editing) {
      if (k === 'Escape') toggleCorners(true);
      else if (k === 'Enter' || lower === 'c') toggleCorners();
      return;
    }
    if (k === 'Enter') review.kind === 'single' ? saveSingle() : closeReview();
    else if (k === 'Escape') review.kind === 'single' ? discardSingle() : closeReview();
    else if (lower === 'r') rotate(e.shiftKey ? -90 : 90);
    else if (lower === 'f') cycleFilter(e.shiftKey ? -1 : 1);
    else if (k === 'ArrowLeft') gotoPage(-1);
    else if (k === 'ArrowRight') gotoPage(1);
    else if (lower === 'c') toggleCorners();
    else if ((k === 'Delete' || k === 'Backspace') && review.kind === 'multi') deleteReviewedPage();
    return;
  }

  if (k === '1') setMode('single');
  else if (k === '2') setMode('multi');
  else if (k === '3') setMode('area');
  else if (k === ' ') capture(true);
  else if (k === 'Enter') {
    if (state.mode === 'multi') saveMulti();
    else if (state.mode === 'area') captureArea();
  } else if (k === 'Escape') {
    if (state.mode === 'area') live.area = null;
    else if (state.retakeIndex !== null) {
      state.retakeIndex = null;
      renderStrip();
    }
  } else if (lower === 'h') openHistory();
  else if (lower === 'o') toggleCamera();
  else if (lower === 'a') {
    settings.autoCapture = !settings.autoCapture;
    saveSettings();
    syncControls();
    toast(`Auto-capture ${settings.autoCapture ? 'on' : 'off'}`);
  } else if (k === '?') helpPanel.classList.remove('hidden');
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

applyLight();
syncControls();
setMode('single');
cvReady
  .then(() => (state.cvLoaded = true))
  .catch((err) => {
    console.error(err);
    state.cvFailed = true;
  });
startCamera(settings.deviceId || undefined);
requestAnimationFrame(frame);
