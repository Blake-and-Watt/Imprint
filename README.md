<div align="center">

# ImPrint V2.0

**Bulk image metadata cleaner, EXIF writer, metadata viewer, watermarker, and ZIP exporter — built for creators who care about their work.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/Blake-and-Watt/Imprint/releases)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-47848F?logo=electron)](https://www.electronjs.org/)
[![Support on Ko-fi](https://img.shields.io/badge/support-Ko--fi-FF5F5F?logo=ko-fi)](https://ko-fi.com/BlakeAndWatt)

*Powered by [Blake & Watt](https://ko-fi.com/BlakeAndWatt)*

</div>

---

## What Hole Does Imprint Fill?

If you shoot, create, edit, or sell images — you've run into this problem:

- Stock sites, clients, and social platforms **strip or corrupt** the metadata in your files
- Adding copyright and creator info to dozens of images means clicking through Lightroom or Bridge one at a time
- Your watermark looks right on a 16:9 crop but is completely wrong on a 4:5 or 9:16
- You can't easily inspect what metadata is actually embedded in a file before sending it
- Every time you export, you're hunting for the last ZIP name you used

**Imprint solves all of this in one place.** Drop your images in, inspect what's already there, strip all existing metadata, write exactly what you want, apply a watermark that automatically repositions itself based on each image's aspect ratio, and export everything as a named ZIP — in seconds.

---

## Features

### Process Images
- **Bulk drag & drop** — any number of images at once, with thumbnail previews
- **Strip all original EXIF/IPTC/XMP** from every image in a single toggle — nothing carries over unless you choose it
- **Write standard metadata fields:** Title, Author/Creator, Copyright, Software, Description, Keywords, Comment
- **Unlimited custom named fields** — define your own key/value pairs (e.g. `Client = Acme Co`, `Session = Spring 2024`)
- **Saved values with autocomplete** — bookmark your most-used values and have them autocomplete as you type, with character-match highlighting and full keyboard navigation (↑↓ Enter Tab)
- **Default metadata from Settings** — set Author, Copyright, and other fields once; they silently auto-fill every export
- Title autocomplete is opt-in per-session (titles are usually unique)

### Metadata Viewer
- **Drop any images to inspect their original metadata** — reads files exactly as they are, before any processing
- Displays **EXIF, IPTC, XMP, and ICC profile presence** per file with clear indicators
- Shows full **file info:** format, dimensions, color space, channels, bit depth, DPI, alpha channel, ICC profile status, file size
- Reads and displays all **decoded EXIF fields:** ImageDescription, Artist, Copyright, DateTime, Make, Model, Software, GPS tags, exposure data, and more
- **Per-file navigation** — click any file in the list to jump to its results; dots indicate metadata presence
- **Export a plain-text metadata report** of all analysed files for record-keeping or client delivery

### Watermarks
- **Watermark library** — upload and name multiple watermarks, reuse across projects
- **Per-aspect-ratio positioning** — for each of the 10 standard ratios (1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, 5:4, 4:5, 21:9), drag and resize your watermark exactly where you want it on a live canvas preview
- **Locked or free aspect ratio** — Lock preserves the watermark's natural proportions while resizing; Unlock gives you free-form control
- **Auto-applied on export** — Imprint detects each image's aspect ratio and applies the matching saved watermark position automatically
- **Opacity control** per export session
- Double-click any watermark card to rename it

### Export
- **ZIP export** with a fully custom name you choose each time
- **Remembers your last ZIP name** — pre-filled every session so you're never hunting for it
- **Folder-in-ZIP option** — choose whether images are wrapped in a named folder inside the ZIP (unzip → folder → images) or sit loose at the root (unzip → images directly)
- Bulk input: JPG, PNG, WEBP, TIFF

### Settings
- Set default metadata once — Author, Copyright, Software, Keywords, Comment, Description — silently applied to every export
- **Folder in ZIP toggle** — persistent preference for how exported ZIPs are structured
- Optional **"Powered by Imprint"** attribution — writes a hidden metadata field crediting this app. Never visible in the image itself, only readable by EXIF tools. Completely optional and clearly explained
- Ko-fi support link

---

## Installation

### Requirements
- [Node.js](https://nodejs.org/) v18+
- npm v9+

### Run from source

```bash
# Clone the repo
git clone https://github.com/Blake-and-Watt/Imprint.git
cd Imprint

# Install dependencies
npm install

# Launch
npm start
```

### Build a distributable

```bash
npm run build
```

Outputs a platform-specific installer to `dist/`:

| Platform | Output |
|----------|--------|
| macOS | `.dmg` |
| Windows | `.exe` (NSIS installer) |
| Linux | `.AppImage` |

---

## Project Structure

```
Imprint/
├── main.js          ← Electron main process (Node backend, IPC handlers, image processing)
├── preload.js       ← Secure contextBridge between main and renderer
├── index.html       ← Entire UI (all panels, styles, and client-side JS in one file)
├── icon.png         ← App icon (used in window titlebar, dock, taskbar)
├── package.json     ← Dependencies and build config
└── README.md
```

Dependencies: `electron`, `sharp` (image processing), `archiver` (ZIP creation), `electron-builder` (packaging).

---

## What Data Is Stored (and What Isn't)

Imprint stores a small config file and your watermark images in your OS app data directory. **Nothing is ever sent to any server.** The app is entirely local.

### What IS stored on your machine

| Item | Location | Contents |
|------|----------|----------|
| `config.json` | `<appData>/Imprint/config.json` | Last ZIP name · watermark metadata · per-ratio watermark positions · settings defaults · folder-in-ZIP preference · autocomplete saved values (up to 20 per field) |
| Watermark images | `<appData>/Imprint/watermarks/` | Copies of watermark files you've uploaded, named by internal ID |

**`<appData>` location by OS:**
- **macOS:** `~/Library/Application Support/Imprint/`
- **Windows:** `C:\Users\<you>\AppData\Roaming\Imprint\`
- **Linux:** `~/.config/Imprint/`

### What is NOT stored or transmitted

- **Your images are never saved by the app.** They exist in memory while processing, then land in the ZIP you download. Imprint keeps no copies.
- **No analytics. No telemetry. No network requests.** The app never phones home.
- **No accounts, no login, no cloud sync.** 100% local.

---

## Usage Guide

### Processing Images

1. Open **Process Images**
2. Drag & drop images onto the zone, or click to browse
3. Toggle **Strip All Original** to clear existing metadata (on by default — recommended)
4. Fill in metadata fields — leave blank to use your Settings defaults
5. Add custom key/value fields with `+ Add field`
6. Select a watermark and opacity if needed
7. Enter a ZIP name (your last used is pre-filled)
8. Click **Export ZIP**

### Inspecting Metadata

1. Open **Metadata Viewer**
2. Drag & drop images to inspect
3. Click **Analyse All** — Imprint reads their original metadata without modifying anything
4. Click any file in the left list to view its detailed results
5. Use **Export Report** to save a plain-text `.txt` summary

### Setting Up Watermarks

1. Open **Watermarks**
2. Click **+ Add** and select a PNG or WebP watermark file
3. Click the watermark card to open the Position Editor
4. On each of the 10 aspect ratio canvases:
   - **Drag** the box to reposition
   - **Drag the corner handle** to resize
   - **Lock Ratio** to preserve natural proportions
5. Click **Save All Positions**

On export, Imprint detects each image's aspect ratio and auto-applies the correct position.

### Settings

1. Open **Settings**
2. Fill in default Author, Copyright, etc. — applied silently to every export
3. Toggle **Wrap files in folder inside ZIP** based on your preferred extraction structure
4. Toggle **Powered by Imprint** if you'd like to include the optional attribution metadata tag
5. Click **Save Settings**

---

## Support the Project

Imprint is free and open source. If it saves you time, please consider supporting continued development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/BlakeAndWatt)

---

## Contributing

Issues and pull requests are welcome. Open an issue first for significant changes so we can align before you build.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Special Thanks

> **ImPrint V2.0 was built in genuine collaboration with [Claude](https://claude.ai) by Anthropic.**
>
> The watermark positioning system, EXIF metadata pipeline and viewer, per-ratio canvas editor, autocomplete engine, ZIP export flow, and overall application architecture were all designed and coded with Claude as a real development partner — not just autocomplete or code suggestions. This entire application, from first file to V2.0, was built through direct conversation.
>
> If you're a developer curious what serious AI-assisted software engineering looks like today, this project is a concrete, real-world example of it. [claude.ai](https://claude.ai) is worth your time.

---

<div align="center">
  <sub>Built by <a href="https://ko-fi.com/BlakeAndWatt">Anthony Nicolas · Blake & Watt</a></sub>
</div>
