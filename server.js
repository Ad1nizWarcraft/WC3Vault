/**
 * WC3 Asset Vault — Server
 * Install: npm install
 * Run:     node server.js
 * Open:    http://localhost:3000
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuid } = require('uuid');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const UPLOADS   = path.join(__dirname, 'uploads');

// Ensure directories exist on startup
for (const dir of [UPLOADS, DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Asset store — one JSON file per asset ──────────────────────────────────
// Filename format: {id}_{slug}.json
// e.g. 3f2a1b4c-..._footman-hero.json

function slugify(name) {
  return (name || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'asset';
}

function assetFilename(id, name) {
  return `${id}_${slugify(name)}.json`;
}

function loadAsset(id) {
  // Scan data dir for a file starting with the given id
  try {
    const files = fs.readdirSync(DATA_DIR);
    const match = files.find(f => f.startsWith(id + '_') && f.endsWith('.json'));
    if (!match) return null;
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, match), 'utf8'));
  } catch { return null; }
}

function saveAsset(asset) {
  const fname = assetFilename(asset.id, asset.name);
  // Remove any old file for this id (name may have changed)
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const f of files) {
      if (f.startsWith(asset.id + '_') && f.endsWith('.json') && f !== fname) {
        fs.unlinkSync(path.join(DATA_DIR, f));
      }
    }
  } catch {}
  fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(asset, null, 2));
}

function deleteAssetFile(id) {
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const f of files) {
      if (f.startsWith(id + '_') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(DATA_DIR, f));
      }
    }
  } catch {}
}

function loadAssets() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ── Multer ─────────────────────────────────────────────────────────────────
const ALLOWED_EXT = new Set([
  'mdx','mdl','blp','png','jpg','jpeg','gif','bmp','tga','webp','zip','rar'
]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS, req.assetId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Preserve original filename but sanitise
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = file.originalname.split('.').pop().toLowerCase();
    cb(null, ALLOWED_EXT.has(ext));
  }
});

// ── Relevance scoring ──────────────────────────────────────────────────────
function score(asset, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const t of terms) {
    if (asset.name.toLowerCase().includes(t))                          s += 10;
    if ((asset.tags || []).some(g => g.toLowerCase().includes(t)))     s +=  6;
    if ((asset.description || '').toLowerCase().includes(t))           s +=  3;
    if ((asset.author || '').toLowerCase().includes(t))                s +=  2;
    if ((asset.uploader || '').toLowerCase().includes(t))              s +=  1;
  }
  return s;
}

// ── Type classification helpers ────────────────────────────────────────────
const IMG_EXTS   = new Set(['blp','png','jpg','jpeg','gif','bmp','tga','webp']);
const MODEL_EXTS = new Set(['mdx','mdl']);

function classifyAsset(asset) {
  // Explicit assetType stored at upload time takes priority
  if (asset.assetType) return asset.assetType;
  // Fallback: derive from extension
  const ext = (asset.ext || asset.name.split('.').pop() || '').toLowerCase();
  if (MODEL_EXTS.has(ext)) return 'mdx';
  if (IMG_EXTS.has(ext))   return 'blp';
  return 'other';
}

// ── Static files ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

// ── GET /api/assets ────────────────────────────────────────────────────────
app.get('/api/assets', (req, res) => {
  let list = loadAssets();
  const { q = '', type = 'all', sort = 'recent', page = '1', limit = '60' } = req.query;

  // Type filter
  if (type !== 'all') {
    list = list.filter(a => {
      const at = classifyAsset(a);
      if (type === 'mdx')    return at === 'mdx';
      if (type === 'blp')    return at === 'blp';
      if (type === 'icon')   return at === 'icon';
      if (type === 'ported') return at === 'ported';
      return true;
    });
  }

  // Search
  if (q.trim()) {
    list = list
      .map(a => ({ ...a, _score: score(a, q) }))
      .filter(a => a._score > 0)
      .sort((a, b) => b._score - a._score);
  } else {
    if (sort === 'recent')    list = list.slice().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (sort === 'name')      list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'size')      list = list.slice().sort((a, b) => b.size - a.size);
    if (sort === 'downloads') list = list.slice().sort((a, b) => (b.downloads||0) - (a.downloads||0));
  }

  const total   = list.length;
  const pageNum = Math.max(1, parseInt(page, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const assets  = list.slice((pageNum - 1) * perPage, pageNum * perPage);

  res.json({ total, page: pageNum, limit: perPage, assets });
});

// ── GET /api/assets/:id ────────────────────────────────────────────────────
app.get('/api/assets/:id', (req, res) => {
  const asset = loadAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  res.json(asset);
});

// ── POST /api/assets ───────────────────────────────────────────────────────
app.post('/api/assets', (req, res, next) => {
  req.assetId = uuid();   // set before multer so storage destination can use it
  next();
}, upload.fields([
  { name: 'file',      maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'images',    maxCount: 8 }
]), (req, res) => {
  const mainFile = req.files?.file?.[0];
  if (!mainFile) return res.status(400).json({ error: 'No file provided' });

  const thumbFile  = req.files?.thumbnail?.[0];
  const imgFiles   = req.files?.images || [];
  const { name, description, tags, uploader, author, assetType } = req.body;

  const asset = {
    id:          req.assetId,
    name:        (name || mainFile.originalname).trim(),
    description: (description || '').trim(),
    tags:        (tags || '').split(',').map(t => t.trim()).filter(Boolean),
    uploader:    (uploader || 'Anonymous').trim(),
    author:      (author || '').trim() || null,
    assetType:   (assetType || '').trim() || null,
    ext:         mainFile.originalname.split('.').pop().toLowerCase(),
    filename:    mainFile.filename,
    fileUrl:     `/uploads/${req.assetId}/${mainFile.filename}`,
    thumbnail:   thumbFile ? `/uploads/${req.assetId}/${thumbFile.filename}` : null,
    images:      imgFiles.map(f => `/uploads/${req.assetId}/${f.filename}`),
    size:        mainFile.size,
    downloads:   0,
    uploadedAt:  new Date().toISOString()
  };

  saveAsset(asset);
  res.status(201).json(asset);
});

// ── POST /api/assets/:id/download ─────────────────────────────────────────
app.post('/api/assets/:id/download', (req, res) => {
  const asset = loadAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  asset.downloads = (asset.downloads || 0) + 1;
  saveAsset(asset);
  res.json({ downloads: asset.downloads });
});

// ── DELETE /api/assets/:id ─────────────────────────────────────────────────
app.delete('/api/assets/:id', (req, res) => {
  const asset = loadAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });

  deleteAssetFile(asset.id);
  const dir = path.join(UPLOADS, asset.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WC3 Asset Vault → http://localhost:${PORT}`);
});
