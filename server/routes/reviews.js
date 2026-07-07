const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

const STATUSES = ['pending', 'approved', 'rejected'];

// Public: approved reviews only — this is what the homepage carousel loads.
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, reviewer_name, pet_name, rating, review_text, created_at
     FROM reviews WHERE status = 'approved' ORDER BY reviewed_at ASC, id ASC`
  );
  res.json(rows);
});

// Public: submit a review. It lands in the admin queue as 'pending' and is
// never shown on the homepage until an admin approves it.
router.post('/', async (req, res) => {
  const name = typeof req.body?.reviewer_name === 'string' ? req.body.reviewer_name.trim() : '';
  const petName = typeof req.body?.pet_name === 'string' ? req.body.pet_name.trim() : '';
  const text = typeof req.body?.review_text === 'string' ? req.body.review_text.trim() : '';
  const rating = parseInt(req.body?.rating, 10);

  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'Your name is required (80 characters max)' });
  }
  if (petName.length > 80) {
    return res.status(400).json({ error: 'Pet name must be 80 characters or fewer' });
  }
  if (!text || text.length > 1000) {
    return res.status(400).json({ error: 'A review is required (1000 characters max)' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  const { rows } = await query(
    `INSERT INTO reviews (reviewer_name, pet_name, rating, review_text)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, petName, rating, text]
  );

  res.status(201).json({ id: rows[0].id, message: 'Review submitted for approval' });
});

// Admin: all reviews, newest first, optionally filtered by status.
router.get('/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { status } = req.query;
  if (status && STATUSES.includes(status)) {
    const { rows } = await query(
      'SELECT * FROM reviews WHERE status = $1 ORDER BY created_at DESC',
      [status]
    );
    return res.json(rows);
  }
  const { rows } = await query('SELECT * FROM reviews ORDER BY created_at DESC');
  res.json(rows);
});

// Admin: approve/reject (or move back to pending).
router.put('/:id/status', authenticateToken, requirePermission('write'), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
  }

  const { rows } = await query(
    `UPDATE reviews
     SET status = $1, reviewed_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END
     WHERE id = $2 RETURNING id`,
    [status, req.params.id]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'Review not found' });
  }

  await logAudit(req.admin.id, req.admin.email, 'update', 'reviews', req.params.id, 'success');
  res.json({ message: 'Review updated' });
});

// Admin: delete a review permanently.
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res) => {
  await query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
  await logAudit(req.admin.id, req.admin.email, 'delete', 'reviews', req.params.id, 'success');
  res.json({ message: 'Review deleted' });
});

module.exports = router;
