# Document Scanner

A CamScanner-style document scanner that runs on `localhost` and uses your laptop webcam.
The screen turns bright white to light the paper. The page is detected and captured automatically
once you hold it still, then flattened and cleaned into a crisp white document.

Everything runs in your browser. No images are uploaded anywhere.

## Run it

Double-click **`Scanner.bat`**. The first run installs dependencies, then it opens
<http://localhost:5317> in your default browser. Use Chrome or Edge to get the "Save as" dialog.

Or from a terminal:

```bash
npm install
npm start
```

## Modes

| Key | Mode | What it does |
|---|---|---|
| `1` | **Single page** | Hold a page up with all 4 corners in view. When the ring fills (about 1 s still), it captures and opens the review screen. |
| `2` | **Multi-page** | Captures each page as you hold it up, then waits for the next one. Pages collect in a strip where you can click to edit, drag to reorder, or × to delete. **Finish & save** (`Enter`) makes one PDF. |
| `3` | **Custom area** | Drag a box over the live view (move it or resize from the corners), then press `Enter`. Gets the same white-paper cleanup. |

## Review screen

- **Filters** (`F`): Magic color (default, keeps pen and highlighter colors), Grayscale, B&W, Original
- **Rotate** (`R` / `Shift+R`)
- **Adjust corners** (`C`): drag the corners with a magnifier, then `Enter` to apply
- **Copy image** (`Ctrl+C`): copies the page as a PNG, ready to paste anywhere. Every page in the multi-page strip and in History has its own Copy button too.
- **Save** (`Enter`): choose PDF / JPG / PNG. A Save-as dialog opens in **Downloads** by default.
  Multi-page JPG/PNG asks for a folder.
- **Searchable text (OCR)**: adds an invisible text layer to PDFs so you can search and copy from them.

## Other bits

- **Light / Warmth sliders** dim or warm up the white light (helps with glare on glossy paper)
- **Fullscreen** for the most light
- **History** (`H`): the last 20 scans, saved or discarded, stay in the browser.
  Use "Save again" to re-export one, or "Open" to load it back into multi-page and add more pages.
- **Auto-capture** toggle (`A`). `Space` always captures right away.
- `?demo` (for example <http://localhost:5317/?demo>) swaps the webcam for a simulated page, for testing.

## Tips

- Hold the page 30–50 cm from the screen with all four corners visible. A darker background behind the page helps detection.
- Laptop webcams are about 720p–1080p, so scans look clean but tiny print can soften. Fill the frame with the page.

## How it works

- **OpenCV.js** (WASM) in a web worker ([public/cv-worker.js](public/cv-worker.js)) handles detection, warp, and filters:
  - **Detection**: Canny edges, plus a bright-region pass and an adaptive-threshold pass. It picks the largest convex quad.
  - **Auto-capture**: corners are smoothed and checked for stability before capturing.
  - **Warp**: a perspective transform to a flat rectangle, upscaled to about 2200 px.
  - **Magic color**: divides out the estimated paper background so the paper turns uniformly white, then stretches levels, boosts saturation, and sharpens.
- **pdf-lib** builds the PDFs. **tesseract.js** does the OCR (English). Its language data downloads once from a CDN, then gets cached.
- **idb-keyval** (IndexedDB) stores the history.
- **Vite + TypeScript**, no framework.
