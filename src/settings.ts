import type { FilterName, Format } from './types';

export interface Settings {
  brightness: number;
  warmth: number;
  mirror: boolean;
  autoCapture: boolean;
  filter: FilterName;
  format: Format;
  ocr: boolean;
  deviceId: string;
}

const KEY = 'docscan-settings';
const defaults: Settings = {
  brightness: 100,
  warmth: 0,
  mirror: true,
  autoCapture: true,
  filter: 'magic',
  format: 'pdf',
  ocr: true,
  deviceId: '',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...defaults };
}

export const settings: Settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
