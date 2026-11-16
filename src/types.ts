export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt];
export type FilterName = 'magic' | 'gray' | 'bw' | 'original';
export type Mode = 'single' | 'multi' | 'area';
export type Format = 'pdf' | 'jpg' | 'png';
export type Rotation = 0 | 90 | 180 | 270;

export interface Page {
  id: string;
  /** Full-resolution camera frame (unmirrored). */
  source: ImageData;
  /** Page corners in source pixel coordinates: tl, tr, br, bl. */
  corners: Quad;
  filter: FilterName;
  rotation: Rotation;
  /** Flattened, unfiltered page (dropped when not being edited, to save memory). */
  warped?: ImageData;
  filtered?: { filter: FilterName; data: ImageData };
  /** Final rendered page (filtered + rotated). */
  result?: HTMLCanvasElement;
  thumb?: string;
  queue?: Promise<unknown>;
}

/** A finished page ready to be written out. */
export interface OutPage {
  canvas: HTMLCanvasElement;
  bw: boolean;
}

export const FILTERS: { id: FilterName; label: string }[] = [
  { id: 'magic', label: 'Magic color' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
  { id: 'original', label: 'Original' },
];
