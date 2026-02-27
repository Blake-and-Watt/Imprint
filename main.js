const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const archiver = require('archiver');
const { PassThrough } = require('stream');

// ExifTool — load lazily so a missing install doesn't crash the app
let exiftool = null;
try { exiftool = require('exiftool-vendored').exiftool; } catch {}

// exifr — pure-JS EXIF/IPTC/XMP parser, no binary needed, great fallback
let exifr = null;
try { exifr = require('exifr'); } catch {}

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
app.on('before-quit', () => { try { if (exiftool) exiftool.end(); } catch {} });

// ─── Format conversion helpers ────────────────────────────────────────────────
async function convertFormat(buffer, fmt, quality) {
  const q = Math.max(1, Math.min(100, quality || 100));
  // Extract whatever metadata is currently in the buffer (user-written EXIF)
  // and carry it through the format conversion — don't let the re-encode silently strip it.
  try {
    switch (fmt) {
      case 'jpeg':
        return await sharp(buffer).withMetadata().jpeg({ quality: q }).toBuffer();
      case 'png':
        return await sharp(buffer).withMetadata().png({ compressionLevel: Math.round((100 - q) / 56 * 9) }).toBuffer();
      case 'webp':
        return await sharp(buffer).withMetadata().webp({ quality: q }).toBuffer();
      case 'tiff':
        return await sharp(buffer).withMetadata().tiff({ quality: q }).toBuffer();
      case 'gif':
        return await sharp(buffer).withMetadata().gif().toBuffer();
      case 'bmp':
        return await sharpToBmp(buffer);   // raw pixel encoder — metadata not applicable
      case 'pdf':
        return await sharpToPdf(buffer, q); // JPEG-in-PDF wrapper
      default:
        return await sharp(buffer).withMetadata().jpeg({ quality: q }).toBuffer();
    }
  } catch (e) {
    console.error('Format conversion error:', e);
    return buffer;
  }
}

// Minimal BMP encoder — 24-bit uncompressed DIB
async function sharpToBmp(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rowSize = Math.ceil(width * 3 / 4) * 4; // rows must be padded to 4-byte boundary
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const bmp = Buffer.alloc(fileSize, 0);

  // File header (14 bytes)
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(fileSize, 2);
  bmp.writeUInt32LE(0, 6);       // reserved
  bmp.writeUInt32LE(54, 10);     // pixel data offset

  // DIB header (40 bytes)
  bmp.writeUInt32LE(40, 14);     // BITMAPINFOHEADER size
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(-height, 22); // negative = top-down row order
  bmp.writeUInt16LE(1, 26);      // color planes
  bmp.writeUInt16LE(24, 28);     // bits per pixel
  bmp.writeUInt32LE(0, 30);      // BI_RGB, no compression
  bmp.writeUInt32LE(pixelArraySize, 34);
  bmp.writeInt32LE(2835, 38);    // ~72 DPI X
  bmp.writeInt32LE(2835, 42);    // ~72 DPI Y
  bmp.writeUInt32LE(0, 46);
  bmp.writeUInt32LE(0, 50);

  // Write pixels: sharp gives RGB, BMP wants BGR
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = 54 + y * rowSize + x * 3;
      bmp[d]     = data[s + 2]; // B
      bmp[d + 1] = data[s + 1]; // G
      bmp[d + 2] = data[s];     // R
    }
  }
  return bmp;
}

// PDF wrapper — embeds a JPEG inside a minimal valid single-page PDF
async function sharpToPdf(buffer, quality) {
  const jpegBuf = await sharp(buffer).jpeg({ quality: quality || 90 }).toBuffer();
  const meta = await sharp(buffer).metadata();
  const W = meta.width || 800;
  const H = meta.height || 600;

  // Build object strings
  const obj = (n, body) => `${n} 0 obj\n${body}\nendobj\n`;
  const catalog  = obj(1, `<</Type /Catalog /Pages 2 0 R>>`);
  const pages    = obj(2, `<</Type /Pages /Kids [3 0 R] /Count 1>>`);
  const content  = `q ${W} 0 0 ${H} 0 0 cm /Img Do Q`;
  const page     = obj(3, `<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources <</XObject <</Img 5 0 R>>>> /Contents 4 0 R>>`);
  const contObj  = obj(4, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  const imgHdr   = `5 0 obj\n<</Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length}>>\nstream\n`;
  const imgTail  = `\nendstream\nendobj\n`;

  const header = '%PDF-1.4\n';
  const body1 = catalog + pages + page + contObj;
  const off5 = Buffer.byteLength(header) + Buffer.byteLength(body1);

  const xrefPos = off5 + Buffer.byteLength(imgHdr) + jpegBuf.length + Buffer.byteLength(imgTail);

  // Cross-reference table (approximate — good enough for most readers)
  const xref = `xref\n0 6\n0000000000 65535 f \n` +
    String(Buffer.byteLength(header)).padStart(10,'0') + ` 00000 n \n` +
    String(Buffer.byteLength(header + catalog)).padStart(10,'0') + ` 00000 n \n` +
    String(Buffer.byteLength(header + catalog + pages)).padStart(10,'0') + ` 00000 n \n` +
    String(Buffer.byteLength(header + catalog + pages + page)).padStart(10,'0') + ` 00000 n \n` +
    String(off5).padStart(10,'0') + ` 00000 n \n`;

  const trailer = `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.concat([
    Buffer.from(header + body1 + imgHdr),
    jpegBuf,
    Buffer.from(imgTail + xref + trailer)
  ]);
}

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

ipcMain.handle('process-images', async (_, { images, watermarkId, opacity, folderInZip, zipFolderName, strip, outputFormat, quality }) => {
  const config = loadConfig();
  const settings = config.settings || {};
  const defaults = settings.defaults || {};
  const fmt = outputFormat || settings.outputFormat || 'jpeg';
  const qual = quality ?? settings.quality ?? 100;
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

    // ── Step 1: Strip ALL metadata or preserve ────────────────────────────────
    // strip=true  → decompose to raw RGB pixels and re-encode from scratch.
    //               This is the ONLY way to guarantee removal of:
    //               - EXIF / IPTC / XMP (standard metadata)
    //               - JFIF / APP0 markers (resolution, version)
    //               - C2PA / JUMBF (APP11 — provenance, SynthID, Google watermarks)
    //               - ICC color profiles
    //               - Maker notes, thumbnail strips, every APP-level segment
    //               Sharp's .withMetadata(false) alone does NOT remove C2PA or JFIF.
    // strip=false → keep all original metadata, user fields are overlaid on top.

    let outputBuffer;

    if (strip) {
      // Decompose to raw pixels — absolutely nothing survives this
      const { data: rawPixels, info: rawInfo } = await sharp(inputBuffer)
        .ensureAlpha()   // normalise to RGBA so channels is always known
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Re-encode from raw with only user metadata written — zero existing markers
      let cleanPipeline = sharp(rawPixels, {
        raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels }
      }).withMetadata(false);

      if (hasUserMetadata) {
        try { cleanPipeline = cleanPipeline.withMetadata({ exif: buildExif(imgMeta) }); }
        catch (e) { console.error('Metadata write error:', e); }
      }

      outputBuffer = await cleanPipeline.toBuffer();
    } else {
      // Preserve original metadata, overlay user fields
      let pipeline = sharp(inputBuffer).withMetadata();
      if (hasUserMetadata) {
        try { pipeline = pipeline.withMetadata({ exif: buildExif(imgMeta) }); }
        catch (e) { console.error('Metadata write error:', e); }
      }
      outputBuffer = await pipeline.toBuffer();
    }

    // ── Step 3: Composite watermark ───────────────────────────────────────────
    // .withMetadata() on the composite call carries whatever metadata was written
    // in Step 1 through to the output — critical whether strip is on or off.
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
            .withMetadata()   // preserve whatever metadata survived/was written above
            .composite([{ input: resizedWm, left: wmX, top: wmY, blend: 'over' }])
            .toBuffer();
        }
      } catch (e) {
        console.error('Watermark error:', e);
      }
    }

    // ── Step 4: Convert format + apply quality ────────────────────────────────
    outputBuffer = await convertFormat(outputBuffer, fmt, qual);

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

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      const buf = Buffer.from(img.data, 'base64');

      // ── Always-available data ──────────────────────────────────────────────
      const sharpMeta = await sharp(buf).metadata();
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      const rawHeaderHex = buf.slice(0, 64).toString('hex').toUpperCase()
        .match(/.{1,2}/g).join(' ');

      // ── Full ExifTool read (if available) ──────────────────────────────────
      let allTags = null;
      if (exiftool) {
        const ext  = path.extname(img.name) || '.jpg';
        const tmp  = path.join(os.tmpdir(), `imprint_${Date.now()}_${i}${ext}`);
        fs.writeFileSync(tmp, buf);
        try {
          const rawTags = await exiftool.read(tmp);
          allTags = flattenTags(rawTags, buf.length, img.name, md5, rawHeaderHex);
        } catch (e) {
          console.error('exiftool read error:', e);
        } finally {
          try { fs.unlinkSync(tmp); } catch {}
        }
      }

      // ── exifr fallback (pure-JS, no binary) ────────────────────────────────
      if (!allTags && exifr) {
        try {
          const parsed = await exifr.parse(buf, {
            tiff: true, xmp: true, iptc: true, jfif: true, ihdr: true,
            icc: true, makerNote: false, userComment: true, translateValues: true,
            reviveValues: true, sanitize: true, mergeOutput: false,
          });
          allTags = flattenExifrTags(parsed, buf.length, img.name, md5, rawHeaderHex);
        } catch (e) {
          console.error('exifr parse error:', e);
        }
      }

      // ── Sharp-only last resort ─────────────────────────────────────────────
      if (!allTags) {
        allTags = fallbackSharpTags(sharpMeta, buf.length, img.name, md5, rawHeaderHex);
      }

      results.push({
        name: img.name,
        // Summary fields for the header card
        format:     sharpMeta.format,
        width:      sharpMeta.width,
        height:     sharpMeta.height,
        rawSize:    buf.length,
        hasExif:    !!sharpMeta.exif,
        hasIptc:    !!sharpMeta.iptc,
        hasXmp:     !!sharpMeta.xmp,
        hasProfile: !!sharpMeta.icc,
        // All grouped tags for the table
        groups: allTags,
      });
    } catch (e) {
      results.push({ name: img.name, error: e.message });
    }
  }
  return results;
});

// Tag group inference from tag name
function inferGroup(key) {
  const k = key.toLowerCase();
  if (['filename','filesize','filetype','filetypeextension','mimetype','checksum',
       'sourcefile','rawheader','rawheaderhex','filemodifydate','fileaccessdate',
       'filecreatetime','filesize_bytes'].includes(k)) return 'File Info';
  if (k.startsWith('jfif')) return 'JFIF';
  if (['imagewidth','imageheight','imagesize','megapixels','colorspace',
       'colorcomponents','bitspersample','encodingprocess','ycbcrsubsampling',
       'pixelsperunitx','pixelsperunity','pixelunits','photometricinterpretation',
       'samplesperpixel','rowsperstrip','stripoffsets','stripbytecounts',
       'orientation','xresolution','yresolution','resolutionunit'].includes(k)) return 'Image';
  if (k.startsWith('gps')) return 'GPS';
  if (['make','model','lensmodel','lensinfo','lensid','lensspec','cameraid'].includes(k)) return 'Camera';
  if (['exposuretime','fnumber','iso','isospeedratings','exposureprogram','meteringmode',
       'flash','focallength','shutterspeedvalue','aperturevalue','brightnessvalue',
       'exposurecompensation','whitebalance','digitalzoomratio','scenecapturetype',
       'focallengthin35mmformat','lightsource','contrast','saturation','sharpness',
       'gaincontrol','subjectdistance','maxaperturevalue','exposuremode'].includes(k)) return 'Camera Settings';
  if (k.includes('date') || k.includes('time') || k === 'createdate' || k === 'modifydate') return 'Dates & Time';
  if (['artist','copyright','creator','rights','title','description','keywords',
       'caption','subject','headline','imagedescription','usercomment','comment',
       'xptitle','xpcomment','xpauthor','xpkeywords','xpsubject',
       'captionabstract','creditline','source','writer','byline','category','objectname'].includes(k)) return 'Creator & Description';
  if (k.startsWith('c2pa') || k.startsWith('claim') || k.startsWith('actions') ||
      k.startsWith('item') || k.startsWith('jumd') || k.startsWith('jumb') ||
      k.includes('c2pa') || k.includes('synthi') || k.includes('digitalsource') ||
      ['instanceid','signatureuri','alg','signature','exclusions','hashdata',
       'pad','generatorname','generatorversion'].includes(k)) return 'C2PA / Provenance';
  if (k.startsWith('xmp') || k.startsWith('xap') || k === 'rating') return 'XMP';
  if (k.startsWith('iptc') || ['city','province','state','country','countrycode',
       'urgency','copyrightnotice','instructions'].includes(k)) return 'IPTC';
  if (k.startsWith('icc') || k.includes('profilename') || k.includes('colorspace') ||
      ['colorprofile','profiledescription','profilecopyright','profileclass',
       'profileconnectionspace','renderingintent'].includes(k)) return 'ICC Profile';
  if (k.startsWith('exif')) return 'EXIF';
  return 'EXIF / Other';
}

// Convert an ExifTool tag value to a display string
function tagValueToString(val) {
  if (val === null || val === undefined) return null;
  if (Buffer.isBuffer(val)) return val.length > 0 ? `(Binary data ${val.length} bytes)` : '(Empty)';
  if (typeof val === 'object') {
    const cn = val.constructor?.name;
    // ExifDateTime / ExifDate / ExifTime
    if (cn === 'ExifDateTime' || cn === 'ExifDate' || cn === 'ExifTime') {
      try { return val.toISOString?.() ?? val.toString(); } catch { return String(val); }
    }
    // BinaryField (exiftool-vendored wraps binary as {_bin: base64})
    if (val._bin !== undefined) {
      const bytes = Buffer.from(val._bin, 'base64').length;
      return `(Binary data ${bytes} bytes)`;
    }
    if (Array.isArray(val)) {
      const strs = val.map(tagValueToString).filter(v => v !== null);
      return strs.join(', ');
    }
    try { const s = String(val); return s === '[object Object]' ? JSON.stringify(val) : s; } catch { return '(Object)'; }
  }
  return String(val);
}

function flattenTags(rawTags, fileSize, fileName, md5, rawHeaderHex) {
  // Internal ExifTool props to skip
  const skip = new Set(['SourceFile','ExifToolVersion','errors','warnings']);
  // Group → [{key, value}]
  const groups = {};
  const addTag = (key, val) => {
    const displayVal = tagValueToString(val);
    if (!displayVal || displayVal === 'undefined') return;
    const group = inferGroup(key);
    if (!groups[group]) groups[group] = [];
    groups[group].push({ key, value: displayVal });
  };

  // Inject our own computed fields first
  addTag('FileName',    fileName);
  addTag('FileSize',    formatBytes(fileSize));
  addTag('Checksum',    md5);
  addTag('RawHeaderHex', rawHeaderHex);

  // Process ExifTool tags
  for (const [key, val] of Object.entries(rawTags)) {
    if (skip.has(key) || typeof val === 'function' || typeof key === 'symbol') continue;
    if (key === 'FileName' || key === 'FileSize') continue; // already added
    addTag(key, val);
  }

  // Sort within each group alphabetically
  for (const g of Object.values(groups)) g.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

// Build groups from exifr output (multi-segment object keyed by segment name)
function flattenExifrTags(parsed, fileSize, fileName, md5, rawHeaderHex) {
  const groups = {};
  const addTag = (group, key, val) => {
    const s = tagValueToString(val);
    if (!s || s === 'undefined') return;
    if (!groups[group]) groups[group] = [];
    // Avoid duplicate keys in same group
    if (!groups[group].find(r => r.key === key)) groups[group].push({ key, value: s });
  };

  // Always-present computed fields
  addTag('File Info', 'FileName',    fileName);
  addTag('File Info', 'FileSize',    formatBytes(fileSize));
  addTag('File Info', 'Checksum',    md5);
  addTag('File Info', 'RawHeaderHex', rawHeaderHex);

  if (!parsed) return groups;

  // exifr returns segments: { exif, gps, ifd0, iptc, xmp, jfif, icc, ... }
  const segmentGroupMap = {
    ifd0:    'Image',
    ifd1:    'Image',
    exif:    'EXIF / Camera',
    gps:     'GPS',
    iptc:    'IPTC',
    xmp:     'XMP',
    jfif:    'JFIF',
    jfxx:    'JFIF',
    icc:     'ICC Profile',
  };

  for (const [seg, segData] of Object.entries(parsed)) {
    if (!segData || typeof segData !== 'object') continue;
    const group = segmentGroupMap[seg.toLowerCase()] || inferGroup(seg);
    if (Buffer.isBuffer(segData)) {
      addTag(group, seg, segData);
      continue;
    }
    for (const [key, val] of Object.entries(segData)) {
      if (typeof val === 'function') continue;
      addTag(group, key, val);
    }
  }

  // Sort within each group
  for (const g of Object.values(groups)) g.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

function fallbackSharpTags(meta, fileSize, fileName, md5, rawHeaderHex) {
  const groups = {};
  const addTag = (group, key, val) => {
    if (val === null || val === undefined) return;
    if (!groups[group]) groups[group] = [];
    groups[group].push({ key, value: String(val) });
  };
  addTag('File Info', 'FileName',     fileName);
  addTag('File Info', 'FileSize',     formatBytes(fileSize));
  addTag('File Info', 'Checksum',     md5);
  addTag('File Info', 'RawHeaderHex', rawHeaderHex);
  addTag('Image', 'Format',       meta.format?.toUpperCase());
  addTag('Image', 'Width',        meta.width);
  addTag('Image', 'Height',       meta.height);
  addTag('Image', 'Channels',     meta.channels);
  addTag('Image', 'BitDepth',     meta.depth);
  addTag('Image', 'ColorSpace',   meta.space);
  addTag('Image', 'Density',      meta.density ? `${meta.density} dpi` : null);
  addTag('Image', 'HasAlpha',     meta.hasAlpha ? 'Yes' : 'No');
  addTag('Image', 'Orientation',  meta.orientation);
  addTag('ICC Profile', 'EmbeddedProfile', meta.icc ? 'Yes' : 'No');
  if (meta.exif)  addTag('EXIF', 'EXIFPresent', 'Yes (install exiftool-vendored to decode)');
  if (meta.iptc)  addTag('IPTC', 'IPTCPresent', 'Yes (install exiftool-vendored to decode)');
  if (meta.xmp)   addTag('XMP',  'XMPPresent',  'Yes (install exiftool-vendored to decode)');
  return groups;
}

function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(2)} MB`;
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
