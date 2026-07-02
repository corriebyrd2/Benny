const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');

const router = express.Router();

const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
// Store dog documents outside the publicly mounted /uploads tree by default.
const DOC_UPLOAD_DIR = process.env.DOG_DOC_UPLOAD_DIR || path.join(path.dirname(BASE_UPLOAD_DIR), 'dog-documents');
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(DOC_UPLOAD_DIR)) {
      fs.mkdirSync(DOC_UPLOAD_DIR, { recursive: true });
    }
    cb(null, DOC_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname || '').slice(0, 20);
    cb(null, `dog-doc-${uniqueSuffix}${ext}`);
  }
});

const uploadDocument = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

function publicDocumentFields(doc) {
  return {
    id: doc.id,
    dog_id: doc.dog_id,
    original_name: doc.original_name,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    uploaded_at: doc.uploaded_at
  };
}

async function documentsByDogIds(dogIds) {
  const ids = [...new Set(dogIds.map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const { rows } = await query(
    `SELECT id, dog_id, original_name, mime_type, size_bytes, uploaded_at
     FROM dog_documents
     WHERE dog_id = ANY($1::int[])
     ORDER BY uploaded_at DESC`,
    [ids]
  );
  const byDog = new Map(ids.map(id => [id, []]));
  for (const row of rows) {
    byDog.get(row.dog_id)?.push(publicDocumentFields(row));
  }
  return byDog;
}

async function sendDocument(res, doc) {
  if (!doc || !SAFE_FILENAME_RE.test(doc.filename)) {
    return res.status(404).json({ error: 'Document not found' });
  }
  const filePath = path.join(DOC_UPLOAD_DIR, doc.filename);
  const resolvedBase = path.resolve(DOC_UPLOAD_DIR);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.download(filePath, doc.original_name);
}

// Admin: Get all dog profiles and attached documents.
router.get('/admin/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.customer_id, d.name, d.breed, d.weight, d.age, d.notes, d.created_at, d.updated_at,
            c.name AS owner_name, c.email AS owner_email, c.phone AS owner_phone
     FROM dogs d
     JOIN customers c ON c.id = d.customer_id
     ORDER BY c.name ASC, d.name ASC`
  );
  const docs = await documentsByDogIds(rows.map(d => d.id));
  res.json(rows.map(d => ({ ...d, documents: docs.get(d.id) || [] })));
});

// Admin: Download a dog document.
router.get('/admin/documents/:docId/download', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM dog_documents WHERE id = $1', [req.params.docId]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    await sendDocument(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// Get all dogs for the logged-in customer
router.get('/', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
    [req.customer.id]
  );
  const docs = await documentsByDogIds(rows.map(d => d.id));
  res.json(rows.map(d => ({ ...d, documents: docs.get(d.id) || [] })));
});

// Create a new dog profile
router.post('/', authenticateCustomer, async (req, res) => {
  const { name, breed, weight, age, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Dog name is required' });
  }

  const { rows: customerRows } = await query('SELECT id FROM customers WHERE id = $1', [req.customer.id]);
  if (!customerRows[0]) {
    return res.status(401).json({ error: 'Customer not found. Please log out and log in again.' });
  }

  const { rows } = await query(
    `INSERT INTO dogs (customer_id, name, breed, weight, age, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.customer.id, name.trim(), breed || '', weight || '', age || '', notes || '']
  );

  res.status(201).json({ id: rows[0].id, message: 'Dog profile created' });
});

// Customer: Upload a document for one of their dogs.
router.post('/:id/documents', authenticateCustomer, uploadDocument.single('document'), async (req, res) => {
  const { rows: dogRows } = await query(
    'SELECT * FROM dogs WHERE id = $1 AND customer_id = $2',
    [req.params.id, req.customer.id]
  );
  if (!dogRows[0]) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'Dog not found' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Document file is required' });
  }

  const { rows } = await query(
    `INSERT INTO dog_documents (dog_id, customer_id, filename, original_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, dog_id, original_name, mime_type, size_bytes, uploaded_at`,
    [
      dogRows[0].id,
      req.customer.id,
      req.file.filename,
      req.file.originalname || req.file.filename,
      req.file.mimetype || 'application/octet-stream',
      req.file.size || 0
    ]
  );

  res.status(201).json({ message: 'Document uploaded', document: publicDocumentFields(rows[0]) });
});

// Customer: Download a document attached to one of their dogs.
router.get('/documents/:docId/download', authenticateCustomer, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT dd.* FROM dog_documents dd
       JOIN dogs d ON d.id = dd.dog_id
       WHERE dd.id = $1 AND d.customer_id = $2`,
      [req.params.docId, req.customer.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    await sendDocument(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// Customer: Delete a document attached to one of their dogs.
router.delete('/documents/:docId', authenticateCustomer, async (req, res, next) => {
  try {
    const { rows } = await query(
      `DELETE FROM dog_documents dd
       USING dogs d
       WHERE dd.id = $1 AND dd.dog_id = d.id AND d.customer_id = $2
       RETURNING dd.filename`,
      [req.params.docId, req.customer.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    if (SAFE_FILENAME_RE.test(rows[0].filename)) {
      fs.promises.unlink(path.join(DOC_UPLOAD_DIR, rows[0].filename)).catch(() => {});
    }
    res.json({ message: 'Document deleted' });
  } catch (err) {
    next(err);
  }
});

// Update a dog profile
router.put('/:id', authenticateCustomer, async (req, res) => {
  const { name, breed, weight, age, notes } = req.body;

  const { rows: dogRows } = await query(
    'SELECT * FROM dogs WHERE id = $1 AND customer_id = $2',
    [req.params.id, req.customer.id]
  );
  if (!dogRows[0]) {
    return res.status(404).json({ error: 'Dog not found' });
  }

  await query(
    `UPDATE dogs SET
       name = COALESCE($1, name),
       breed = COALESCE($2, breed),
       weight = COALESCE($3, weight),
       age = COALESCE($4, age),
       notes = COALESCE($5, notes),
       updated_at = NOW()
     WHERE id = $6 AND customer_id = $7`,
    [
      name ?? null,
      breed !== undefined ? breed : null,
      weight !== undefined ? weight : null,
      age !== undefined ? age : null,
      notes !== undefined ? notes : null,
      req.params.id,
      req.customer.id
    ]
  );

  res.json({ message: 'Dog profile updated' });
});

// Delete a dog profile
router.delete('/:id', authenticateCustomer, async (req, res) => {
  const result = await query(
    'DELETE FROM dogs WHERE id = $1 AND customer_id = $2',
    [req.params.id, req.customer.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Dog not found' });
  }

  res.json({ message: 'Dog profile deleted' });
});

module.exports = router;
