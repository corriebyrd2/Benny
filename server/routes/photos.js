const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Public: Get all homepage photos
router.get('/', (req, res) => {
  const db = getDb();
  const photos = db.prepare(
    'SELECT * FROM photos WHERE show_on_homepage = 1 ORDER BY display_order ASC'
  ).all();
  res.json(photos);
});

// Admin: Get all photos
router.get('/all', authenticateToken, requirePermission('read'), (req, res) => {
  const db = getDb();
  const photos = db.prepare('SELECT * FROM photos ORDER BY display_order ASC').all();
  res.json(photos);
});

// Admin: Upload a photo
router.post('/', authenticateToken, requirePermission('write'), upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file provided' });
  }

  const db = getDb();
  const { caption, layout, display_order, show_on_homepage } = req.body;

  const result = db.prepare(`
    INSERT INTO photos (filename, original_name, caption, layout, display_order, show_on_homepage)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.file.filename,
    req.file.originalname,
    caption || '',
    layout || 'normal',
    parseInt(display_order) || 0,
    show_on_homepage !== '0' ? 1 : 0
  );

  logAudit(req.admin.id, req.admin.email, 'create', 'photos', result.lastInsertRowid.toString(), 'success');
  res.status(201).json({
    id: result.lastInsertRowid,
    filename: req.file.filename,
    message: 'Photo uploaded'
  });
});

// Admin: Update photo metadata
router.put('/:id', authenticateToken, requirePermission('write'), (req, res) => {
  const db = getDb();
  const { caption, layout, display_order, show_on_homepage } = req.body;

  db.prepare(`
    UPDATE photos SET
      caption = COALESCE(?, caption),
      layout = COALESCE(?, layout),
      display_order = COALESCE(?, display_order),
      show_on_homepage = COALESCE(?, show_on_homepage)
    WHERE id = ?
  `).run(
    caption, layout,
    display_order !== undefined ? parseInt(display_order) : null,
    show_on_homepage !== undefined ? (show_on_homepage ? 1 : 0) : null,
    req.params.id
  );

  logAudit(req.admin.id, req.admin.email, 'update', 'photos', req.params.id, 'success');
  res.json({ message: 'Photo updated' });
});

// Admin: Delete a photo
router.delete('/:id', authenticateToken, requirePermission('delete'), (req, res) => {
  const db = getDb();
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);

  if (photo) {
    const filePath = path.join(__dirname, '..', '..', 'uploads', photo.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  }

  logAudit(req.admin.id, req.admin.email, 'delete', 'photos', req.params.id, 'success');
  res.json({ message: 'Photo deleted' });
});

module.exports = router;
