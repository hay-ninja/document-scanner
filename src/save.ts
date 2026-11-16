import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ocrWords } from './ocr';
import type { Format, OutPage } from './types';

const MIME: Record<Format, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
const DESC: Record<Format, string> = { pdf: 'PDF document', jpg: 'JPEG image', png: 'PNG image' };

export function defaultName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `scan_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  );
}

interface Target {
  /** What to call it in the toast. */
  label: string;
  /** Base name the user picked (without extension) for multi-file output. */
  base: string;
  write(fileName: string, blob: Blob): Promise<void>;
}

function downloadTarget(base: string): Target {
  return {
    label: 'Downloads',
    base,
    async write(fileName, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * Ask where to save. MUST be the first await inside a click / keydown handler
 * (the browser requires a fresh user gesture to open the dialog).
 * Returns null if the user cancelled.
 */
export async function pickTarget(format: Format, base: string, fileCount: number): Promise<Target | null> {
  const w = window as any;
  if (fileCount === 1 || format === 'pdf') {
    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: `${base}.${format}`,
          startIn: 'downloads',
          types: [{ description: DESC[format], accept: { [MIME[format]]: [`.${format}`] } }],
        });
        return {
          label: handle.name,
          base: handle.name.replace(/\.[^.]+$/, ''),
          async write(_fileName, blob) {
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
          },
        };
      } catch (e) {
        if (isAbort(e)) return null;
        console.warn('Save picker failed, falling back to download', e);
      }
    }
    return downloadTarget(base);
  }
  // several image files -> pick a folder
  if (typeof w.showDirectoryPicker === 'function') {
    try {
      const dir = await w.showDirectoryPicker({ startIn: 'downloads', mode: 'readwrite' });
      return {
        label: `${fileCount} files in ${dir.name}`,
        base,
        async write(fileName, blob) {
          const fh = await dir.getFileHandle(fileName, { create: true });
          const writable = await fh.createWritable();
          await writable.write(blob);
          await writable.close();
        },
      };
    } catch (e) {
      if (isAbort(e)) return null;
      console.warn('Folder picker failed, falling back to download', e);
    }
  }
  return downloadTarget(base);
}

const WINANSI_FIX: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  'ﬁ': 'fi', 'ﬂ': 'fl',
};
function sanitize(text: string): string {
  return text.replace(/[‘’“”–—…ﬁﬂ]/g, (c) => WINANSI_FIX[c]).replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

export async function buildPdf(
  pages: OutPage[],
  opts: { ocr: boolean; title: string; onStatus?: (msg: string) => void },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title);
  doc.setCreator('Document Scanner');
  doc.setProducer('Document Scanner (pdf-lib)');
  const font = opts.ocr ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const LONG = 841.89; // A4 long side in points

  for (let i = 0; i < pages.length; i++) {
    const { canvas, bw } = pages[i];
    const label = pages.length > 1 ? ` page ${i + 1}/${pages.length}` : '';
    opts.onStatus?.(`Building PDF${label}…`);
    const blob = await canvasToBlob(canvas, bw ? 'image/png' : 'image/jpeg', 0.9);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = bw ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const s = LONG / Math.max(canvas.width, canvas.height);
    const pw = canvas.width * s;
    const ph = canvas.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });

    if (opts.ocr && font) {
      try {
        const words = await ocrWords(canvas, (p) => opts.onStatus?.(`Reading text${label}… ${Math.round(p * 100)}%`));
        for (const w of words) {
          const text = sanitize(w.text);
          if (!text) continue;
          const bw_ = (w.x1 - w.x0) * s;
          const bh = (w.y1 - w.y0) * s;
          const unit = font.widthOfTextAtSize(text, 1);
          if (unit <= 0 || bw_ <= 0) continue;
          const size = Math.max(1, Math.min(bw_ / unit, bh * 1.6));
          try {
            page.drawText(text, { x: w.x0 * s, y: ph - w.y1 * s + bh * 0.15, size, font, opacity: 0 });
          } catch {
            /* unencodable glyph */
          }
        }
      } catch (err) {
        console.warn('OCR failed', err);
        opts.onStatus?.('OCR unavailable, saving without text…');
      }
    }
  }
  return doc.save();
}

/** Writes pages to the chosen target in the chosen format. */
export async function writeOutput(
  target: Target,
  pages: OutPage[],
  format: Format,
  opts: { ocr: boolean; onStatus?: (msg: string) => void },
) {
  if (format === 'pdf') {
    const bytes = await buildPdf(pages, { ocr: opts.ocr, title: target.base, onStatus: opts.onStatus });
    opts.onStatus?.('Writing file…');
    await target.write(`${target.base}.pdf`, new Blob([bytes as BlobPart], { type: MIME.pdf }));
    return;
  }
  for (let i = 0; i < pages.length; i++) {
    opts.onStatus?.(pages.length > 1 ? `Writing image ${i + 1}/${pages.length}…` : 'Writing image…');
    const blob = await canvasToBlob(pages[i].canvas, MIME[format], 0.92);
    const name = pages.length > 1 ? `${target.base}_p${i + 1}.${format}` : `${target.base}.${format}`;
    await target.write(name, blob);
  }
}
