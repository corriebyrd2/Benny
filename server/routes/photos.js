const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const r2 = require('../r2');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'photo-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Multer's fileFilter only sees the client-declared MIME type, which is trivial
// to spoof. Sniff the first 16 bytes of the file on disk and verify they match
// one of the allowed image formats.
async function detectImageMime(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const { bytesRead, buffer } = await fd.read({ buffer: Buffer.alloc(16), position: 0 });
    if (bytesRead < 12) return null;
    const b = buffer;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
        b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  } finally {
    await fd.close();
  }
}

// Treat the multipart-form field "show_on_homepage" as false only when explicitly
// set to '0' or 'false'. Any other value (including undefined) defaults to true.
function parseShowOnHomepage(val) {
  return !(val === '0' || val === 'false' || val === false);
}

const ALLOWED_SECTIONS = ['hero', 'about', 'gallery'];
function normalizeSection(val) {
  return ALLOWED_SECTIONS.includes(val) ? val : 'gallery';
}

function photoUrl(filename) {
  if (r2.isConfigured()) return r2.publicUrl(filename);
  return `/uploads/${encodeURIComponent(filename)}`;
}

function withUrl(photo) {
  return { ...photo, url: photoUrl(photo.filename) };
}

// Public: Get all homepage photos
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM photos WHERE show_on_homepage ORDER BY display_order ASC'
  );
  res.json(rows.map(withUrl));
});

// Admin: Get all photos
router.get('/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM photos ORDER BY display_order ASC');
  res.json(rows.map(withUrl));
});

// Admin: Upload a photo
router.post('/', authenticateToken, requirePermission('write'), upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file provided' });
  }

  const detected = await detectImageMime(req.file.path);
  if (!detected) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Uploaded file is not a supported image' });
  }

  if (r2.isConfigured()) {
    try {
      await r2.uploadFile(req.file.filename, req.file.path, detected);
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  }

  const { caption, layout, display_order, show_on_homepage, section } = req.body;

  const { rows } = await query(
    `INSERT INTO photos (filename, original_name, caption, layout, display_order, show_on_homepage, section)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      req.file.filename,
      req.file.originalname,
      caption || '',
      layout || 'normal',
      parseInt(display_order) || 0,
      parseShowOnHomepage(show_on_homepage),
      normalizeSection(section)
    ]
  );

  await logAudit(req.admin.id, req.admin.email, 'create', 'photos', rows[0].id.toString(), 'success');
  res.status(201).json({
    id: rows[0].id,
    filename: req.file.filename,
    url: photoUrl(req.file.filename),
    message: 'Photo uploaded'
  });
});

// Admin: Update photo metadata
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res) => {
  const { caption, layout, display_order, show_on_homepage, section } = req.body;

  await query(
    `UPDATE photos SET
       caption = COALESCE($1, caption),
       layout = COALESCE($2, layout),
       display_order = COALESCE($3, display_order),
       show_on_homepage = COALESCE($4, show_on_homepage),
       section = COALESCE($5, section)
     WHERE id = $6`,
    [
      caption ?? null,
      layout ?? null,
      display_order !== undefined ? parseInt(display_order) : null,
      show_on_homepage !== undefined ? Boolean(show_on_homepage) : null,
      section !== undefined ? normalizeSection(section) : null,
      req.params.id
    ]
  );

  await logAudit(req.admin.id, req.admin.email, 'update', 'photos', req.params.id, 'success');
  res.json({ message: 'Photo updated' });
});

// Admin: Delete a photo
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res) => {
  const { rows } = await query('SELECT * FROM photos WHERE id = $1', [req.params.id]);
  const photo = rows[0];

  if (photo) {
    if (r2.isConfigured()) {
      await r2.deleteFile(photo.filename).catch(() => {});
    } else {
      const filePath = path.join(UPLOAD_DIR, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await query('DELETE FROM photos WHERE id = $1', [req.params.id]);
  }

  await logAudit(req.admin.id, req.admin.email, 'delete', 'photos', req.params.id, 'success');
  res.json({ message: 'Photo deleted' });
});

module.exports = router;
