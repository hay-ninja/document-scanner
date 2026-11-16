import { del, get, set } from 'idb-keyval';
import { canvasToBlob } from './save';
import type { OutPage } from './types';

export interface HistoryEntry {
  id: string;
  name: string;
  date: number;
  pages: number;
  saved: boolean;
  thumb: string;
}

interface StoredPage {
  blob: Blob;
  bw: boolean;
}

const INDEX = 'history-index';
const MAX = 20;

export async function list(): Promise<HistoryEntry[]> {
  try {
    return ((await get(INDEX)) as HistoryEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function add(pages: OutPage[], meta: { name: string; saved: boolean; thumb: string }) {
  if (!pages.length) return;
  try {
    const stored: StoredPage[] = [];
    for (const p of pages) {
      stored.push({ blob: await canvasToBlob(p.canvas, p.bw ? 'image/png' : 'image/jpeg', 0.9), bw: p.bw });
    }
    const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await set(`history-${id}`, stored);
    const index = await list();
    index.unshift({ id, name: meta.name, date: Date.now(), pages: pages.length, saved: meta.saved, thumb: meta.thumb });
    const removed = index.splice(MAX);
    await set(INDEX, index);
    for (const r of removed) await del(`history-${r.id}`);
  } catch (err) {
    console.warn('Could not save history', err);
  }
}

export async function markSaved(id: string, name: string) {
  const index = await list();
  const e = index.find((x) => x.id === id);
  if (e) {
    e.saved = true;
    e.name = name;
    await set(INDEX, index);
  }
}

export async function loadPages(id: string): Promise<OutPage[]> {
  const stored = ((await get(`history-${id}`)) as StoredPage[] | undefined) ?? [];
  const out: OutPage[] = [];
  for (const s of stored) {
    const bmp = await createImageBitmap(s.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    out.push({ canvas: c, bw: s.bw });
  }
  return out;
}

export async function remove(id: string) {
  const index = (await list()).filter((e) => e.id !== id);
  await set(INDEX, index);
  await del(`history-${id}`);
}

export async function clear() {
  for (const e of await list()) await del(`history-${e.id}`);
  await set(INDEX, []);
}
