const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const archiver = require('archiver');
const { PassThrough } = require('stream');

nativeTheme.themeSource = 'dark';

let mainWindow;
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const watermarksDir = path.join(userDataPath, 'watermarks');

// Ensure dirs exist
if (!fs.existsSync(watermarksDir)) fs.mkdirSync(watermarksDir, { recursive: true });

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}
  return { lastZipName: 'processed-images', watermarks: [], watermarkPositions: {} };
}

function saveConfig(config) {
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
}

function getIconPath() {
  if (process.platform === 'darwin') return path.join(__dirname, 'icon.icns');
  if (process.platform === 'win32')  return path.join(__dirname, 'icon.ico');
  return path.join(__dirname, 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#080808',
    title: 'ImPrint V2.0',
    icon: getIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // macOS dock icon
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }

  mainWindow.loadFile('index.html');

  // Open external links in default browser, not Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('set-last-zip-name', (_, name) => {
  const config = loadConfig();
  config.lastZipName = name;
  saveConfig(config);
});

ipcMain.handle('open-watermark-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Watermark Image',
    filters: [{ name: 'Images', extensions: ['png', 'svg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const srcPath = result.filePaths[0];
  const id = `wm_${Date.now()}`;
  const ext = path.extname(srcPath);
  const destPath = path.join(watermarksDir, `${id}${ext}`);
  fs.copyFileSync(srcPath, destPath);
  const config = loadConfig();
  const entry = { id, name: path.basename(srcPath, ext), file: `${id}${ext}`, ext };
  config.watermarks = config.watermarks || [];
  config.watermarks.push(entry);
  saveConfig(config);
  const data = fs.readFileSync(destPath).toString('base64');
  return { ...entry, data: `data:image/${ext.slice(1)};base64,${data}` };
});

ipcMain.handle('get-watermarks', () => {
  const config = loadConfig();
  return (config.watermarks || []).map(wm => {
    const filePath = path.join(watermarksDir, wm.file);
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath).toString('base64');
    const mime = wm.ext === '.svg' ? 'image/svg+xml' : `image/${wm.ext.slice(1)}`;
    return { ...wm, data: `data:${mime};base64,${data}` };
  }).filter(Boolean);
});

ipcMain.handle('delete-watermark', (_, id) => {
  const config = loadConfig();
  const wm = (config.watermarks || []).find(w => w.id === id);
  if (wm) {
    const filePath = path.join(watermarksDir, wm.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  config.watermarks = (config.watermarks || []).filter(w => w.id !== id);
  delete (config.watermarkPositions || {})[id];
  saveConfig(config);
});

ipcMain.handle('rename-watermark', (_, { id, name }) => {
  const config = loadConfig();
  const wm = (config.watermarks || []).find(w => w.id === id);
  if (wm) wm.name = name;
  saveConfig(config);
});

ipcMain.handle('save-watermark-positions', (_, { id, positions }) => {
  const config = loadConfig();
  config.watermarkPositions = config.watermarkPositions || {};
  config.watermarkPositions[id] = positions;
  saveConfig(config);
});

ipcMain.handle('get-watermark-positions', (_, id) => {
  const config = loadConfig();
  return (config.watermarkPositions || {})[id] || {};
});

ipcMain.handle('process-images', async (_, { images, metadata, watermarkId, opacity, folderInZip, zipFolderName, strip }) => {
  const config = loadConfig();
  const settings = config.settings || {};
  const defaults = settings.defaults || {};
  let wmBuffer = null;
  let wmPositions = {};

  if (watermarkId) {
    const wm = (config.watermarks || []).find(w => w.id === watermarkId);
    if (wm) {
      wmBuffer = fs.readFileSync(path.join(watermarksDir, wm.file));
      wmPositions = (config.watermarkPositions || {})[watermarkId] || {};
    }
  }

  // Build EXIF object for sharp — all fields mapped correctly, no base64 tricks
  const buildExif = (fields) => {
    const ifd0 = {};
    if (fields.title)       { ifd0.ImageDescription = fields.title; ifd0.XPTitle = fields.title; }
    if (fields.author)      { ifd0.Artist = fields.author; ifd0.XPAuthor = fields.author; }
    if (fields.copyright)   ifd0.Copyright = fields.copyright;
    if (fields.software)    ifd0.Software = fields.software;
    if (fields.description) ifd0.XPComment = fields.description;
    if (fields.keywords)    ifd0.XPKeywords = fields.keywords;
    if (fields.comment)     ifd0.XPSubject = fields.comment;
    const customs = (fields.custom || []).filter(c => c.key && c.value);
    if (customs.length) {
      const customStr = customs.map(c => `${c.key}=${c.value}`).join('; ');
      ifd0.XPComment = ifd0.XPComment ? `${ifd0.XPComment} | ${customStr}` : customStr;
    }
    return { IFD0: ifd0 };
  };

  const RATIOS = {
    '1:1': {w:1,h:1}, '3:4': {w:3,h:4}, '4:3': {w:4,h:3},
    '2:3': {w:2,h:3}, '3:2': {w:3,h:2}, '9:16': {w:9,h:16},
    '16:9': {w:16,h:9}, '5:4': {w:5,h:4}, '4:5': {w:4,h:5}, '21:9': {w:21,h:9}
  };

  function detectRatio(width, height) {
    const imgRatio = width / height;
    let bestMatch = null, bestDiff = Infinity;
    for (const [key, val] of Object.entries(RATIOS)) {
      const diff = Math.abs(val.w / val.h - imgRatio);
      if (diff < bestDiff) { bestDiff = diff; bestMatch = key; }
    }
    return bestMatch;
  }

  const processedFiles = [];

  for (const img of images) {
    const inputBuffer = Buffer.from(img.data, 'base64');

    // Each image carries its own metadata (shared fields + per-image title)
    const imgMeta = { ...(img.metadata || {}) };
    ['author','copyright','software','keywords','comment','description'].forEach(k => {
      if (!imgMeta[k] && defaults[k]) imgMeta[k] = defaults[k];
    });
    if (settings.poweredBy) {
      imgMeta.custom = [...(imgMeta.custom || [])];
      imgMeta.custom.push({ key: 'powered_by', value: 'Imprint · https://github.com/Blake-and-Watt/Imprint' });
    }

    const hasUserMetadata = Object.values(imgMeta).some(v =>
      v && (typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : false)
    );

    // ── Step 1: Strip original metadata OR preserve it ─────────────────────────
    let pipeline = strip
      ? sharp(inputBuffer).withMetadata(false)
      : sharp(inputBuffer).withMetadata();

    // ── Step 2: Write user metadata on top ─────────────────────────────────────
    if (hasUserMetadata) {
      try {
        pipeline = pipeline.withMetadata({ exif: buildExif(imgMeta) });
      } catch (e) {
        console.error('Metadata write error:', e);
      }
    }

    let outputBuffer = await pipeline.toBuffer();

    // ── Step 3: Composite watermark — preserve metadata with .withMetadata() ───
    if (wmBuffer) {
      try {
        const { width, height } = await sharp(outputBuffer).metadata();
        const ratioKey = detectRatio(width, height);
        const pos = wmPositions[ratioKey];

        if (pos && width && height) {
          const wmW = Math.max(1, Math.round(pos.w * width));
          const wmH = Math.max(1, Math.round(pos.h * height));
          const wmX = Math.round(pos.x * width);
          const wmY = Math.round(pos.y * height);

          const resizedWm = await sharp(wmBuffer)
            .resize(wmW, wmH, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
            .ensureAlpha()
            .toBuffer();

          outputBuffer = await sharp(outputBuffer)
            .withMetadata()
            .composite([{ input: resizedWm, left: wmX, top: wmY, blend: 'over' }])
            .toBuffer();
        }
      } catch (e) {
        console.error('Watermark error:', e);
      }
    }

    // img.name is now the desired output filename (already set by renderer)
    processedFiles.push({ name: img.name, buffer: outputBuffer });
  }

  // ── Create ZIP ────────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pass = new PassThrough();
    pass.on('data', chunk => chunks.push(chunk));
    pass.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    pass.on('error', reject);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(pass);
    const folder = folderInZip
      ? (zipFolderName || 'images').replace(/[^a-zA-Z0-9_\- ]/g, '_') + '/'
      : '';
    for (const f of processedFiles) archive.append(f.buffer, { name: folder + f.name });
    archive.finalize();
  });
});

ipcMain.handle('get-settings', () => {
  const config = loadConfig();
  const settings = config.settings || {};
  // poweredBy defaults ON unless explicitly set to false
  if (settings.poweredBy === undefined) settings.poweredBy = true;
  return settings;
});

ipcMain.handle('save-settings', (_, settings) => {
  const config = loadConfig();
  config.settings = settings;
  saveConfig(config);
});

ipcMain.handle('read-metadata', async (_, { images }) => {
  const results = [];
  for (const img of images) {
    try {
      const buf = Buffer.from(img.data, 'base64');
      const meta = await sharp(buf).metadata();
      // Extract EXIF sub-fields if present
      let exifParsed = null;
      if (meta.exif) {
        try {
          // Read raw exif buffer as key-value by scanning common tag offsets
          // sharp exposes exif as a Buffer — parse what we can display
          exifParsed = parseExifBuffer(meta.exif);
        } catch {}
      }
      results.push({
        name: img.name,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        space: meta.space,
        channels: meta.channels,
        depth: meta.depth,
        density: meta.density,
        hasAlpha: meta.hasAlpha,
        hasProfile: meta.hasProfile,
        orientation: meta.orientation,
        exif: exifParsed,
        hasExif: !!meta.exif,
        hasIcc: !!meta.icc,
        hasIptc: !!meta.iptc,
        hasXmp: !!meta.xmp,
        rawSize: buf.length,
      });
    } catch (e) {
      results.push({ name: img.name, error: e.message });
    }
  }
  return results;
});

// Minimal EXIF buffer parser — reads ASCII/SHORT/LONG tags from IFD0
function parseExifBuffer(buf) {
  const fields = {};
  try {
    if (!buf || buf.length < 8) return fields;
    // Check byte order: 'II' = little endian, 'MM' = big endian
    const marker = buf.slice(0, 2).toString('ascii');
    const le = marker === 'II';
    const read16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const read32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const ifdOffset = read32(4);

    // Known tag IDs → friendly names
    const tagNames = {
      0x010E: 'ImageDescription', 0x010F: 'Make', 0x0110: 'Model',
      0x0112: 'Orientation', 0x011A: 'XResolution', 0x011B: 'YResolution',
      0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime',
      0x013B: 'Artist', 0x013E: 'WhitePoint', 0x8298: 'Copyright',
      0x8769: 'ExifIFD', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
      0x9286: 'UserComment', 0x920A: 'FocalLength', 0x829A: 'ExposureTime',
      0x829D: 'FNumber', 0x8827: 'ISOSpeedRatings', 0xA420: 'ImageUniqueID',
      0x013C: 'HostComputer', 0x9C9B: 'XPTitle', 0x9C9C: 'XPComment',
      0x9C9D: 'XPAuthor', 0x9C9E: 'XPKeywords', 0x9C9F: 'XPSubject',
    };

    const entryCount = read16(ifdOffset);
    for (let i = 0; i < entryCount && i < 64; i++) {
      const base = ifdOffset + 2 + i * 12;
      if (base + 12 > buf.length) break;
      const tag = read16(base);
      const type = read16(base + 2);
      const count = read32(base + 4);
      const valOffset = base + 8;

      const name = tagNames[tag];
      if (!name) continue;

      try {
        let value = null;
        if (type === 2) { // ASCII
          const dataLen = count;
          let dataStart = valOffset;
          if (dataLen > 4) dataStart = read32(valOffset);
          if (dataStart + dataLen <= buf.length) {
            value = buf.slice(dataStart, dataStart + dataLen).toString('ascii').replace(/\0/g, '').trim();
          }
        } else if (type === 3 && count === 1) { // SHORT
          value = read16(valOffset);
        } else if (type === 4 && count === 1) { // LONG
          value = read32(valOffset);
        } else if (type === 5 && count >= 1) { // RATIONAL
          const rOff = read32(valOffset);
          if (rOff + 8 <= buf.length) {
            const num = read32(rOff);
            const den = read32(rOff + 4);
            value = den !== 0 ? `${num}/${den}` : `${num}`;
          }
        } else if (type === 7 && name === 'UserComment' && count > 8) { // UNDEFINED
          const ucOff = count > 4 ? read32(valOffset) : valOffset;
          if (ucOff + count <= buf.length) {
            value = buf.slice(ucOff + 8, ucOff + count).toString('utf8').replace(/\0/g, '').trim();
          }
        }
        if (value !== null && value !== undefined && value !== '') {
          fields[name] = String(value);
        }
      } catch {}
    }
  } catch {}
  return fields;
}

ipcMain.handle('get-saved-values', () => {
  const config = loadConfig();
  return config.savedValues || {};
});

ipcMain.handle('save-field-value', (_, { fieldKey, value }) => {
  if (!value || !value.trim()) return;
  const config = loadConfig();
  config.savedValues = config.savedValues || {};
  config.savedValues[fieldKey] = config.savedValues[fieldKey] || [];
  const trimmed = value.trim();
  if (!config.savedValues[fieldKey].includes(trimmed)) {
    config.savedValues[fieldKey].unshift(trimmed); // newest first
    if (config.savedValues[fieldKey].length > 20) config.savedValues[fieldKey].pop(); // cap at 20
  }
  saveConfig(config);
  return config.savedValues[fieldKey];
});

ipcMain.handle('delete-saved-value', (_, { fieldKey, value }) => {
  const config = loadConfig();
  if (!config.savedValues || !config.savedValues[fieldKey]) return;
  config.savedValues[fieldKey] = config.savedValues[fieldKey].filter(v => v !== value);
  saveConfig(config);
  return config.savedValues[fieldKey];
});

ipcMain.handle('save-zip', async (_, { data, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save ZIP Archive',
    defaultPath: `${defaultName}.zip`,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, Buffer.from(data, 'base64'));
  const name = path.basename(result.filePath, '.zip');
  const config = loadConfig();
  config.lastZipName = name;
  saveConfig(config);
  return name;
});
