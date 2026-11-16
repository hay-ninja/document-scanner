// Promise-based client for the OpenCV web worker (public/cv-worker.js).
const worker = new Worker('/cv-worker.js');
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

worker.onmessage = (e: MessageEvent) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error));
};
worker.onerror = (e) => {
  console.error('cv worker error', e);
};

export function cvCall<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

export const cvReady = cvCall<boolean>('init');
