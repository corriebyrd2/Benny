const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');
const mailer = require('../email');

const router = express.Router();

// Public: Check availability for a given date
// Returns count of non-cancelled bookings that overlap the requested date.
// Capacity is fixed at 10 slots per day.
router.get('/availability', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM bookings
     WHERE status != 'cancelled'
       AND start_date IS NOT NULL
       AND start_date <= $1
       AND COALESCE(end_date, start_date) >= $1`,
    [date]
  );

  const count = rows[0].count;
  const capacity = 10;
  res.json({ date, count, capacity, available: count < capacity });
});

// Public: Create a booking
router.post('/', async (req, res) => {
  const { owner_name, email, phone, dog_name, service_id, preferred_dates, message, start_date, end_date } = req.body;

  if (!owner_name || !email || !dog_name || !service_id) {
    return res.status(400).json({ error: 'Missing required fields: owner_name, email, dog_name, service_id' });
  }

  const { rows: serviceRows } = await query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = serviceRows[0];
  if (!service) {
    return res.status(400).json({ error: 'Invalid service selected' });
  }

  const { rows } = await query(
    `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      owner_name, email, phone || '', dog_name,
      service_id, service.name,
      preferred_dates || '', message || '',
      service.price_cents,
      start_date || null, end_date || null
    ]
  );
  const booking = rows[0];

  await Promise.all([
    mailer.sendNewBookingToOwner({ booking }),
    mailer.sendBookingReceivedToCustomer({ booking })
  ]);

  res.status(201).json({
    id: booking.id,
    message: 'Booking request submitted',
    amount_cents: service.price_cents
  });
});

// Authenticated customer: Get my bookings
router.get('/my', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message,
            status, payment_status, amount_cents, created_at, updated_at
     FROM bookings WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customer.id]
  );
  res.json(rows);
});

// Authenticated customer: Create a booking
router.post('/customer-book', authenticateCustomer, async (req, res) => {
  const { dog_name, dog_id, service_id, preferred_dates, message, start_date, end_date } = req.body;

  let resolvedDogName = dog_name;
  if (dog_id) {
    const { rows: dogRows } = await query(
      'SELECT * FROM dogs WHERE id = $1 AND customer_id = $2',
      [dog_id, req.customer.id]
    );
    if (!dogRows[0]) {
      return res.status(400).json({ error: 'Dog not found' });
    }
    resolvedDogName = dogRows[0].name;
  }

  if (!resolvedDogName || !service_id) {
    return res.status(400).json({ error: 'Dog name and service are required' });
  }

  const { rows: serviceRows } = await query(
    'SELECT * FROM services WHERE id = $1 AND active = 1',
    [service_id]
  );
  const service = serviceRows[0];
  if (!service) {
    return res.status(400).json({ error: 'Invalid service selected' });
  }

  const { rows: customerRows } = await query('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
  const customer = customerRows[0];
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const { rows } = await query(
    `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, customer_id, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      customer.name, customer.email, customer.phone || '',
      resolvedDogName, service_id, service.name,
      preferred_dates || '', message || '',
      service.price_cents, customer.id,
      start_date || null, end_date || null
    ]
  );
  const booking = rows[0];

  await Promise.all([
    mailer.sendNewBookingToOwner({ booking }),
    mailer.sendBookingReceivedToCustomer({ booking })
  ]);

  res.status(201).json({
    id: booking.id,
    message: 'Booking request submitted successfully!',
    service_name: service.name,
    amount_cents: service.price_cents
  });
});

// Public: Look up bookings by email
router.post('/lookup', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message,
            status, payment_status, amount_cents, created_at, updated_at
     FROM bookings WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC`,
    [email]
  );
  res.json(rows);
});

// Public: Get a single booking by ID + email verification
router.post('/customer/:id', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required for verification' });
  }

  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message,
            status, payment_status, amount_cents, stripe_payment_id, created_at, updated_at
     FROM bookings WHERE id = $1 AND LOWER(email) = LOWER($2)`,
    [req.params.id, email]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Booking not found or email does not match' });
  }
  res.json(rows[0]);
});

// Admin: Get all bookings
router.get('/', authenticateToken, requirePermission('read'), async (req, res) => {
  const { status, payment_status } = req.query;

  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (payment_status) {
    params.push(payment_status);
    conditions.push(`payment_status = $${params.length}`);
  }

  let sql = 'SELECT * FROM bookings';
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const { rows } = await query(sql, params);
  res.json(rows);
});

// Admin: Get single booking
router.get('/:id', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows[0]) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json(rows[0]);
});

// Admin: Update booking status
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res) => {
  const { status, payment_status, amount_cents } = req.body;

  await query(
    `UPDATE bookings SET
       status = COALESCE($1, status),
       payment_status = COALESCE($2, payment_status),
       amount_cents = COALESCE($3, amount_cents),
       updated_at = NOW()
     WHERE id = $4`,
    [status ?? null, payment_status ?? null, amount_cents ?? null, req.params.id]
  );

  await logAudit(req.admin.id, req.admin.email, 'update', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking updated' });
});

// Admin: Approve booking (confirms + auto-requests payment)
router.post('/:id/approve', authenticateToken, requirePermission('write'), async (req, res) => {
  const { rows } = await query(
    `UPDATE bookings SET status = 'confirmed', payment_status = 'requested', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  await mailer.sendBookingApprovedToCustomer({ booking: rows[0] });
  await logAudit(req.admin.id, req.admin.email, 'approve', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking approved and payment requested' });
});

// Admin: Cancel booking with reason
router.post('/:id/cancel', authenticateToken, requirePermission('write'), async (req, res) => {
  const { reason } = req.body;

  const { rows } = await query(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [reason || '', req.params.id]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  await mailer.sendBookingCancelledToCustomer({ booking: rows[0], reason: reason || '' });
  await logAudit(req.admin.id, req.admin.email, 'cancel', 'bookings', req.params.id, reason || '');
  res.json({ message: 'Booking cancelled' });
});

// Admin: Mark booking as completed and paid
router.post('/:id/complete', authenticateToken, requirePermission('write'), async (req, res) => {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows[0]) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  await query(
    `UPDATE bookings SET status = 'completed', payment_status = 'paid', updated_at = NOW()
     WHERE id = $1`,
    [req.params.id]
  );

  await logAudit(req.admin.id, req.admin.email, 'complete', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking marked as completed and paid' });
});

// Admin: Delete booking
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res) => {
  await query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
  await logAudit(req.admin.id, req.admin.email, 'delete', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking deleted' });
});

module.exports = router;
