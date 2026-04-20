const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

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

// Treat the multipart-form field "show_on_homepage" as false only when explicitly
// set to '0' or 'false'. Any other value (including undefined) defaults to true.
function parseShowOnHomepage(val) {
  return !(val === '0' || val === 'false' || val === false);
}

const ALLOWED_SECTIONS = ['hero', 'about', 'gallery'];
function normalizeSection(val) {
  return ALLOWED_SECTIONS.includes(val) ? val : 'gallery';
}

// Public: Get all homepage photos
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM photos WHERE show_on_homepage ORDER BY display_order ASC'
  );
  res.json(rows);
});

// Admin: Get all photos
router.get('/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM photos ORDER BY display_order ASC');
  res.json(rows);
});

// Admin: Upload a photo
router.post('/', authenticateToken, requirePermission('write'), upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file provided' });
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
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    await query('DELETE FROM photos WHERE id = $1', [req.params.id]);
  }

  await logAudit(req.admin.id, req.admin.email, 'delete', 'photos', req.params.id, 'success');
  res.json({ message: 'Photo deleted' });
});

module.exports = router;
