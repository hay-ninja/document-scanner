// Copies the OpenCV.js build into public/vendor so the classic web worker can importScripts() it.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@techstark/opencv-js/dist/opencv.js');
const dest = resolve(root, 'public/vendor/opencv.js');

if (!existsSync(src)) {
  console.warn('[copy-vendor] opencv.js not found yet (run npm install).');
  process.exit(0);
}
if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log('[copy-vendor] copied opencv.js -> public/vendor/opencv.js');
}
