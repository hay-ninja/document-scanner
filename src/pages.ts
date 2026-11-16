import { cvCall } from './cv';
import type { FilterName, OutPage, Page, Quad, Rotation } from './types';

let nextId = 1;

export function newPage(source: ImageData, corners: Quad, filter: FilterName, ink = 0.5): Page {
  return { id: `p${Date.now().toString(36)}${nextId++}`, source, corners, filter, ink, rotation: 0 };
}

export function fullQuad(w: number, h: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

export function rotateToCanvas(img: ImageData, rotation: Rotation): HTMLCanvasElement {
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  if (rotation === 0) return tmp;
  const out = document.createElement('canvas');
  const swap = rotation === 90 || rotation === 270;
  out.width = swap ? img.height : img.width;
  out.height = swap ? img.width : img.height;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(tmp, -img.width / 2, -img.height / 2);
  return out;
}

async function doRender(page: Page): Promise<HTMLCanvasElement> {
  if (!page.warped) {
    page.warped = await cvCall<ImageData>('warp', { image: page.source, corners: page.corners });
    page.filtered = undefined;
  }
  if (!page.filtered || page.filtered.filter !== page.filter || page.filtered.ink !== page.ink) {
    const data =
      page.filter === 'original'
        ? page.warped
        : await cvCall<ImageData>('filter', { image: page.warped, filter: page.filter, strength: page.ink });
    page.filtered = { filter: page.filter, ink: page.ink, data };
  }
  page.result = rotateToCanvas(page.filtered.data, page.rotation);
  return page.result;
}

/** Render a page (serialised per page so rapid edits don't race). */
export function renderPage(page: Page): Promise<HTMLCanvasElement> {
  const run = (page.queue ?? Promise.resolve()).catch(() => {}).then(() => doRender(page));
  page.queue = run;
  return run;
}

/** Re-warp after corners changed. */
export function invalidateWarp(page: Page) {
  page.warped = undefined;
  page.filtered = undefined;
}

/** Drop intermediate buffers once a page is done being edited. */
export function compact(page: Page) {
  page.warped = undefined;
  page.filtered = undefined;
}

export function makeThumb(canvas: HTMLCanvasElement, maxH = 180): string {
  const s = Math.min(1, maxH / canvas.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

export async function toOutPages(pages: Page[]): Promise<OutPage[]> {
  const out: OutPage[] = [];
  for (const p of pages) {
    const canvas = p.result ?? (await renderPage(p));
    out.push({ canvas, bw: p.filter === 'bw' });
  }
  return out;
}
