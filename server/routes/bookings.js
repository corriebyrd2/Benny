const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

// Public: Create a booking
router.post('/', (req, res) => {
  const db = getDb();
  const { owner_name, email, phone, dog_name, service_id, preferred_dates, message } = req.body;

  if (!owner_name || !email || !dog_name || !service_id) {
    return res.status(400).json({ error: 'Missing required fields: owner_name, email, dog_name, service_id' });
  }

  // Look up service
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  if (!service) {
    return res.status(400).json({ error: 'Invalid service selected' });
  }

  const result = db.prepare(`
    INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    owner_name, email, phone || '', dog_name,
    service_id, service.name,
    preferred_dates || '', message || '',
    service.price_cents
  );

  res.status(201).json({
    id: result.lastInsertRowid,
    message: 'Booking request submitted',
    amount_cents: service.price_cents
  });
});

// Public: Look up bookings by email
router.post('/lookup', (req, res) => {
  const db = getDb();
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const bookings = db.prepare(
    'SELECT id, owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, status, payment_status, amount_cents, created_at, updated_at FROM bookings WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC'
  ).all(email);

  res.json(bookings);
});

// Public: Get a single booking by ID + email verification
router.post('/customer/:id', (req, res) => {
  const db = getDb();
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required for verification' });
  }

  const booking = db.prepare(
    'SELECT id, owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, status, payment_status, amount_cents, stripe_payment_id, created_at, updated_at FROM bookings WHERE id = ? AND LOWER(email) = LOWER(?)'
  ).get(req.params.id, email);

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found or email does not match' });
  }

  res.json(booking);
});

// Admin: Get all bookings
router.get('/', authenticateToken, requirePermission('read'), (req, res) => {
  const db = getDb();
  const { status, payment_status } = req.query;

  let query = 'SELECT * FROM bookings';
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (payment_status) {
    conditions.push('payment_status = ?');
    params.push(payment_status);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  const bookings = db.prepare(query).all(...params);
  res.json(bookings);
});

// Admin: Get single booking
router.get('/:id', authenticateToken, requirePermission('read'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  res.json(booking);
});

// Admin: Update booking status
router.put('/:id', authenticateToken, requirePermission('write'), (req, res) => {
  const db = getDb();
  const { status, payment_status, amount_cents } = req.body;

  db.prepare(`
    UPDATE bookings SET
      status = COALESCE(?, status),
      payment_status = COALESCE(?, payment_status),
      amount_cents = COALESCE(?, amount_cents),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, payment_status, amount_cents, req.params.id);

  logAudit(req.admin.id, req.admin.email, 'update', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking updated' });
});

// Admin: Delete booking
router.delete('/:id', authenticateToken, requirePermission('delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  logAudit(req.admin.id, req.admin.email, 'delete', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking deleted' });
});

module.exports = router;
