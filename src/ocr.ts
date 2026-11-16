import { createWorker, type Worker } from 'tesseract.js';

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let workerPromise: Promise<Worker> | null = null;
let onProgress: ((p: number) => void) | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', undefined, {
      logger: (m) => {
        if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
      },
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** Run OCR on a page and return word boxes in canvas pixel coordinates. */
export async function ocrWords(canvas: HTMLCanvasElement, progress?: (p: number) => void): Promise<OcrWord[]> {
  const worker = await getWorker();
  onProgress = progress ?? null;
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const w of line.words ?? []) {
            const text = w.text?.trim();
            if (!text || w.confidence < 20) continue;
            words.push({ text, ...w.bbox });
          }
        }
      }
    }
    return words;
  } finally {
    onProgress = null;
  }
}
