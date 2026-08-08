const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');
const { identify, safeDisplayName, sha256, storageName, MAX_BYTES } = require('../fileValidation');
const malware = require('../malwareScan');

const router = express.Router();

const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
// Store dog documents outside the publicly mounted /uploads tree by default.
const DOC_UPLOAD_DIR = process.env.DOG_DOC_UPLOAD_DIR || path.join(path.dirname(BASE_UPLOAD_DIR), 'dog-documents');
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

// Uploads are buffered in memory and identified by their BYTES before anything
// touches the filesystem. The previous implementation streamed straight to disk
// under a name built from the client's own extension, so an .html or .exe
// upload was written out before any check could run — and no check ran.
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 }
});

async function recordDocumentEvent({ documentId, dogId, event, actorType, actorId, detail }) {
  try {
    await query(
      `INSERT INTO document_events (document_id, dog_id, event, actor_type, actor_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [documentId ?? null, dogId ?? null, event, actorType, String(actorId || ''),
        String(detail || '').slice(0, 500)]
    );
  } catch (err) {
    console.error('[document-audit] failed to record', event, err.message);
  }
}

function publicDocumentFields(doc) {
  return {
    id: doc.id,
    dog_id: doc.dog_id,
    original_name: doc.original_name,
    // The detected type is what will actually be served; expose that rather
    // than the client's original claim.
    mime_type: doc.detected_mime || doc.mime_type,
    size_bytes: doc.size_bytes,
    scan_status: doc.scan_status || 'not_scanned',
    uploaded_at: doc.uploaded_at
  };
}

async function documentsByDogIds(dogIds) {
  const ids = [...new Set(dogIds.map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const { rows } = await query(
    `SELECT id, dog_id, original_name, mime_type, detected_mime, size_bytes,
            scan_status, uploaded_at
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
  if (!malware.isServable(doc.scan_status)) {
    return res.status(409).json({
      error: 'This document is quarantined and cannot be downloaded. Please contact us.'
    });
  }

  const filePath = path.join(DOC_UPLOAD_DIR, doc.filename);
  const resolvedBase = path.resolve(DOC_UPLOAD_DIR);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
    return res.status(404).json({ error: 'Document not found' });
  }
  if (!fs.existsSync(resolvedFile)) {
    return res.status(404).json({ error: 'Document not found' });
  }

  // Serve the type derived from the file's own bytes, never the one the
  // uploader declared. Everything else here exists to guarantee the browser
  // treats this as an opaque download rather than a document to render.
  res.setHeader('Content-Type', doc.detected_mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  // res.download sets Content-Disposition: attachment with a correctly quoted,
  // RFC 5987-encoded filename.
  res.download(resolvedFile, safeDisplayName(doc.original_name, path.extname(doc.filename)));
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
    await recordDocumentEvent({
      documentId: rows[0].id, dogId: rows[0].dog_id, event: 'download',
      actorType: 'admin', actorId: req.admin.id, detail: req.admin.email || ''
    });
    await sendDocument(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admin: the access trail for one document. These are veterinary records, so
// "who fetched this, and when" has to be answerable.
router.get('/admin/documents/:docId/events', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, document_id, dog_id, event, actor_type, actor_id, detail, created_at
       FROM document_events WHERE document_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [req.params.docId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Admin: every document event for a dog, including uploads that were rejected
// (which have no document_id, because nothing was stored).
router.get('/admin/dogs/:dogId/document-events', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, document_id, dog_id, event, actor_type, actor_id, detail, created_at
       FROM document_events WHERE dog_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [req.params.dogId]
    );
    res.json(rows);
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
//
// Order matters: ownership first, then identify the bytes, then write. A file
// that fails any check never reaches the filesystem.
router.post('/:id/documents', authenticateCustomer, uploadDocument.single('document'), async (req, res, next) => {
  try {
    const { rows: dogRows } = await query(
      'SELECT * FROM dogs WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.customer.id]
    );
    if (!dogRows[0]) {
      return res.status(404).json({ error: 'Dog not found' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'Document file is required' });
    }

    const identified = identify(req.file.buffer);
    if (!identified.ok) {
      require('../metrics').increment('benny_upload_rejections_total', { reason: 'file_type' });
      await recordDocumentEvent({
        dogId: dogRows[0].id, event: 'upload_rejected',
        actorType: 'customer', actorId: req.customer.id, detail: identified.reason
      });
      return res.status(400).json({ error: identified.reason });
    }

    const digest = sha256(req.file.buffer);
    // Duplicate-submit protection. A double-click, a retried request or a
    // re-upload of the same record returns the existing document rather than
    // creating a second copy on disk.
    const { rows: existing } = await query(
      'SELECT * FROM dog_documents WHERE dog_id = $1 AND sha256 = $2',
      [dogRows[0].id, digest]
    );
    if (existing[0]) {
      return res.status(200).json({
        message: 'This document has already been uploaded',
        duplicate: true,
        document: publicDocumentFields(existing[0])
      });
    }

    await fs.promises.mkdir(DOC_UPLOAD_DIR, { recursive: true });
    const filename = storageName(identified.ext);
    const filePath = path.join(DOC_UPLOAD_DIR, filename);
    // Owner-only permissions; these are veterinary records.
    await fs.promises.writeFile(filePath, req.file.buffer, { mode: 0o600 });

    const scan = await malware.scanFile(filePath);
    if (scan.status === 'quarantined' || scan.status === 'error') {
      await fs.promises.unlink(filePath).catch(() => {});
      require('../metrics').increment('benny_upload_rejections_total', { reason: scan.status });
      await recordDocumentEvent({
        dogId: dogRows[0].id, event: 'upload_quarantined',
        actorType: 'customer', actorId: req.customer.id,
        detail: `${scan.status}: ${scan.detail}`
      });
      return res.status(422).json({
        error: scan.status === 'quarantined'
          ? 'That file was flagged by our security scan and was not stored.'
          : 'We could not verify that file was safe. Please try again or contact us.'
      });
    }

    let inserted;
    try {
      const result = await query(
        `INSERT INTO dog_documents
           (dog_id, customer_id, filename, original_name, mime_type, detected_mime,
            size_bytes, sha256, scan_status, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 = 'not_scanned' THEN NULL ELSE NOW() END)
         RETURNING *`,
        [
          dogRows[0].id,
          req.customer.id,
          filename,
          safeDisplayName(req.file.originalname, identified.ext),
          // The client's claim is kept for forensics only; nothing reads it.
          String(req.file.mimetype || '').slice(0, 120),
          identified.mime,
          req.file.buffer.length,
          digest,
          scan.status
        ]
      );
      inserted = result.rows[0];
    } catch (dbErr) {
      // Never leave bytes on disk that no row points at.
      await fs.promises.unlink(filePath).catch(() => {});
      throw dbErr;
    }

    await recordDocumentEvent({
      documentId: inserted.id, dogId: inserted.dog_id, event: 'upload',
      actorType: 'customer', actorId: req.customer.id,
      detail: `${identified.mime} ${req.file.buffer.length}B scan=${scan.status}`
    });

    res.status(201).json({ message: 'Document uploaded', document: publicDocumentFields(inserted) });
  } catch (err) {
    next(err);
  }
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
    await recordDocumentEvent({
      documentId: rows[0].id, dogId: rows[0].dog_id, event: 'download',
      actorType: 'customer', actorId: req.customer.id, detail: ''
    });
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
       RETURNING dd.id, dd.dog_id, dd.filename`,
      [req.params.docId, req.customer.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    if (SAFE_FILENAME_RE.test(rows[0].filename)) {
      await fs.promises.unlink(path.join(DOC_UPLOAD_DIR, rows[0].filename)).catch(() => {});
    }
    await recordDocumentEvent({
      documentId: rows[0].id, dogId: rows[0].dog_id, event: 'delete',
      actorType: 'customer', actorId: req.customer.id, detail: ''
    });
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

// Delete a dog profile.
//
// dog_documents cascades in the database, but the FILES did not: deleting a dog
// left its uploaded veterinary records on disk indefinitely, unreferenced and
// unreachable — the worst of both worlds for a retention policy. Collect the
// filenames before the cascade removes the rows that name them.
router.delete('/:id', authenticateCustomer, async (req, res, next) => {
  try {
    const { rows: docs } = await query(
      `SELECT dd.id, dd.filename FROM dog_documents dd
       JOIN dogs d ON d.id = dd.dog_id
       WHERE dd.dog_id = $1 AND d.customer_id = $2`,
      [req.params.id, req.customer.id]
    );

    const result = await query(
      'DELETE FROM dogs WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.customer.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Dog not found' });
    }

    for (const doc of docs) {
      if (!SAFE_FILENAME_RE.test(doc.filename)) continue;
      await fs.promises.unlink(path.join(DOC_UPLOAD_DIR, doc.filename)).catch(() => {});
      await recordDocumentEvent({
        documentId: doc.id, dogId: Number(req.params.id), event: 'delete_with_dog',
        actorType: 'customer', actorId: req.customer.id, detail: ''
      });
    }

    res.json({ message: 'Dog profile deleted', documents_deleted: docs.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
