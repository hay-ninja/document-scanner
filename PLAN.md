# Document Scanner — Plan

A personal, localhost web app that turns a laptop webcam into a CamScanner-style document scanner.
The screen goes bright white to light the paper, the page is auto-detected and captured when held
steady, and the result is flattened into a clean white document.

## Decisions (agreed)

| Topic | Choice |
|---|---|
| Camera | Built-in laptop webcam (front-facing; screen lights the paper) |
| Browser | Chrome / Edge |
| Output | PDF, JPG or PNG — chosen per save; multi-page defaults to PDF |
| Default look | Enhanced color ("magic color"); B&W, grayscale, original also available |
| Auto-capture | Live corner outline → capture after ~1s held steady (progress ring); Space = capture now |
| After capture | Quick review: drag corners, rotate, change filter, retake, save (Enter) |
| Multi-page | Auto-capture loop + thumbnail strip (reorder / delete / retake) → one file |
| Custom area | Drag a box over the live view, Enter → crop + same cleanup |
| Save | Native "Save as" dialog opening in **Downloads** (`showSaveFilePicker`, `startIn: 'downloads'`) |
| Filename | `scan_YYYY-MM-DD_HH-MM` (editable in dialog) |
| Launch | Double-click `Scanner.bat` (also `npm start`) |
| Extras | OCR searchable PDFs, keyboard shortcuts, brightness/warmth slider, session history |
| Repo | Public GitHub repo, scans never committed |

## Stack

- **Vite + TypeScript**, no framework (small app, direct canvas/video work).
- **OpenCV.js** (WASM, `@techstark/opencv-js`) running in a **Web Worker** so detection never stutters the UI.
- **pdf-lib** for PDF assembly (image page + invisible OCR text layer).
- **tesseract.js** for on-device OCR (English; runs in its own worker, only on save when OCR is on).
- **IndexedDB** (`idb-keyval`) for session history.
- Everything runs locally in the browser — no backend, no uploads.

## Screen layout

```
┌──────────────────────────────────────────────┐
│  (bright white "light panel" fills screen)   │
│        ┌──────────────────────────┐          │  ← camera preview near the top,
│        │  live webcam + outline   │          │    close to the webcam so you
│        └──────────────────────────┘          │    look at it naturally
│   [ Single ] [ Multi-page ] [ Custom area ]  │
│   brightness ▬▬▬●▬  warmth ▬●▬▬  ☐ OCR       │
│   [ page strip (multi-page) ]   [History]    │
└──────────────────────────────────────────────┘
```

Preview is mirrored (feels natural like a selfie); captured output is **not** mirrored so text reads correctly.

## Image pipeline

1. **Camera**: request the highest resolution available (ideal 1920×1080), continuous autofocus/exposure where supported.
2. **Detect** (worker, ~10–15 fps on a ~640px downscale): grayscale → blur → Canny + morphological close →
   contours → largest convex 4-point polygon covering >15% of frame. Fallback pass with adaptive
   threshold for low-contrast backgrounds. Corners smoothed across frames to stop jitter.
3. **Stability**: if corners move < ~1.5% of frame size for ~1s → capture. Ring fills while holding;
   moving resets it. In multi-page mode, after a capture it waits for the page to leave / change before arming again.
4. **Warp**: grab a full-res frame, perspective-transform the quad to a flat rectangle (aspect from edge lengths).
5. **Enhance** ("magic color"): estimate the paper/lighting background per channel (large dilate + blur),
   divide it out → uniformly white paper, then contrast stretch, slight saturation boost, unsharp mask.
   - B&W: same normalization → adaptive threshold → small denoise.
   - Grayscale: normalization + contrast stretch.
   - Original: warp only.
6. **Output**: PDF pages sized to A4/Letter-ish aspect at the image's real proportions; JPG quality ~0.9.

## Modes

- **Single**: detect → auto-capture → review → save.
- **Multi-page**: detect → auto-capture → thumbnail added → wait for next page. Strip supports drag-to-reorder,
  delete, click-to-review/retake. "Done" (or Enter) → save one file.
- **Custom area**: freeze-free live view, drag a rectangle, adjust handles, Enter → crop + cleanup → review.

## Keyboard shortcuts

`1/2/3` modes · `Space` capture now · `Enter` save/confirm · `Esc` cancel/back · `R` rotate · `F` cycle filter ·
`Del` delete page · `H` history

## Session history

Last ~20 scans (processed images + metadata) kept in IndexedDB; panel to re-open, re-save, or delete. Clear-all button.

## Build order (one commit each, roughly)

1. Scaffold Vite + TS, README, .gitignore, `git init`, create public GitHub repo
2. Camera + bright light-panel UI + brightness/warmth slider
3. OpenCV worker + live corner detection overlay
4. Stability auto-capture + warp + enhancement filters
5. Review screen (corner editing, rotate, filters, retake)
6. Saving: PDF/JPG/PNG + Save-as dialog defaulting to Downloads
7. Multi-page mode + thumbnail strip
8. Custom area mode
9. OCR text layer for PDFs
10. Session history
11. Keyboard shortcuts, `Scanner.bat`, polish, README usage

## Known limits

- Laptop webcams are ~720p–1080p, so scans will be clean but not flatbed-sharp. Fine for documents and notes,
  less so for tiny print.
- Glossy paper can catch glare from the white screen; the warmth/brightness slider helps.
- Save-location picker needs Chrome/Edge (other browsers fall back to a plain download into Downloads).
