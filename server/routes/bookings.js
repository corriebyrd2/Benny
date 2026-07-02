const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');
const mailer = require('../email');
const { getStripe } = require('../stripeClient');

const router = express.Router();

const MS_PER_DAY = 86400000;
const MAX_DOGS_PER_BOOKING = 10;

// Allowed values for the two independent status columns. Used to reject typos
// or arbitrary strings on the admin update route so the data stays queryable
// (the dashboard/clients aggregations group on these exact values).
const VALID_STATUS = new Set(['pending', 'confirmed', 'completed', 'cancelled']);
const VALID_PAYMENT_STATUS = new Set(['unpaid', 'requested', 'paid']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate an optional YYYY-MM-DD date range. Returns an error message or null.
// ISO dates compare correctly as strings, so end < start is a lexical check.
function validateDateRange(startDate, endDate) {
  if (startDate && !DATE_RE.test(startDate)) return 'start_date must be in YYYY-MM-DD format';
  if (endDate && !DATE_RE.test(endDate)) return 'end_date must be in YYYY-MM-DD format';
  if (startDate && endDate && endDate < startDate) return 'end_date cannot be before start_date';
  return null;
}

function normalizeDogCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_DOGS_PER_BOOKING, n);
}

// Expire any still-open Stripe Checkout Session tied to a booking. Called when a
// booking is cancelled so a customer can't pay a now-stale link (which would
// otherwise revive the cancelled booking and take their money). Best-effort:
// per-session errors are logged, never thrown, and a missing/expired session is
// a no-op.
async function expireOpenStripeSessions(stripe, booking) {
  const sessionIds = Array.isArray(booking.stripe_session_ids) && booking.stripe_session_ids.length > 0
    ? booking.stripe_session_ids
    : (booking.stripe_session_id ? [booking.stripe_session_id] : []);
  for (const sid of sessionIds) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      if (session && session.status === 'open') {
        await stripe.checkout.sessions.expire(sid);
      }
    } catch (err) {
      console.warn('[cancel] failed to expire session', sid, err.message);
    }
  }
}

// Number of nights between two YYYY-MM-DD dates (0 if end <= start or invalid).
function nightsBetween(startDate, endDate) {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / MS_PER_DAY);
}

// Boarding/daycare are billed per-night/per-day, so the total must scale with
// the length of stay; grooming/training are per-session (flat). The schema has
// no unit column, so we infer the unit from the service's price_label. Every
// service rate is also per-dog — a booking for two pups doubles the price.
function computeAmountCents(service, startDate, endDate, dogCount) {
  const base = Number(service.price_cents) || 0;
  const count = normalizeDogCount(dogCount);
  const label = String(service.price_label || '').toLowerCase();
  const perNight = label.includes('night');
  const perDay = label.includes('day');
  if ((!perNight && !perDay) || !startDate || !endDate) return base * count;
  const nights = nightsBetween(startDate, endDate);
  // Per-night charges the number of nights; per-day charges inclusive days.
  const qty = perNight ? Math.max(1, nights) : Math.max(1, nights + 1);
  return base * qty * count;
}

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
  const { owner_name, email, phone, dog_name, service_id, preferred_dates, message, start_date, end_date, dog_count } = req.body;

  if (!owner_name || !email || !dog_name || !service_id) {
    return res.status(400).json({ error: 'Missing required fields: owner_name, email, dog_name, service_id' });
  }

  const dateError = validateDateRange(start_date, end_date);
  if (dateError) {
    return res.status(400).json({ error: dateError });
  }

  const { rows: serviceRows } = await query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = serviceRows[0];
  if (!service) {
    return res.status(400).json({ error: 'Invalid service selected' });
  }

  const dogs = normalizeDogCount(dog_count);
  const amount_cents = computeAmountCents(service, start_date, end_date, dogs);

  const { rows } = await query(
    `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, start_date, end_date, dog_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      owner_name, email, phone || '', dog_name,
      service_id, service.name,
      preferred_dates || '', message || '',
      amount_cents,
      start_date || null, end_date || null,
      dogs
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
    amount_cents
  });
});

// Authenticated customer: Get my bookings
router.get('/my', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, dog_count, service_id, service_name, preferred_dates, message,
            status, payment_status, amount_cents, created_at, updated_at
     FROM bookings WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customer.id]
  );
  res.json(rows);
});

// Authenticated customer: Create a booking
router.post('/customer-book', authenticateCustomer, async (req, res) => {
  const { dog_name, dog_id, dog_names, service_id, preferred_dates, message, start_date, end_date, dog_count } = req.body;

  const dateError = validateDateRange(start_date, end_date);
  if (dateError) {
    return res.status(400).json({ error: dateError });
  }

  // New shape: dog_names is an array of names (saved + typed). The count is
  // derived from the array length, so the client can't desync count from
  // selection. Old shape (dog_id or dog_name + dog_count) still works for
  // existing tests and stale browser sessions.
  let resolvedNames = null;
  if (Array.isArray(dog_names) && dog_names.length > 0) {
    const seen = new Set();
    resolvedNames = [];
    for (const raw of dog_names) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      resolvedNames.push(name);
    }
    if (resolvedNames.length === 0) {
      return res.status(400).json({ error: 'At least one dog name is required' });
    }
    // Names list must agree with the billed cap — otherwise booking.dog_name
    // would display all submitted dogs while dog_count/amount only cover the
    // first MAX_DOGS_PER_BOOKING.
    if (resolvedNames.length > MAX_DOGS_PER_BOOKING) {
      return res.status(400).json({
        error: `At most ${MAX_DOGS_PER_BOOKING} dogs per booking`
      });
    }
  } else {
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
    if (!resolvedDogName) {
      return res.status(400).json({ error: 'Dog name and service are required' });
    }
    resolvedNames = [resolvedDogName];
  }

  if (!service_id) {
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

  // Multi-dog: count comes from the names array. Old shape: honor explicit
  // dog_count (legacy callers).
  const dogs = Array.isArray(dog_names)
    ? Math.min(MAX_DOGS_PER_BOOKING, Math.max(1, resolvedNames.length))
    : normalizeDogCount(dog_count);
  const resolvedDogName = resolvedNames.join(', ');
  const amount_cents = computeAmountCents(service, start_date, end_date, dogs);

  const { rows } = await query(
    `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, customer_id, start_date, end_date, dog_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      customer.name, customer.email, customer.phone || '',
      resolvedDogName, service_id, service.name,
      preferred_dates || '', message || '',
      amount_cents, customer.id,
      start_date || null, end_date || null,
      dogs
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
    amount_cents
  });
});

// Public: Look up bookings by email
router.post('/lookup', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, dog_count, service_id, service_name, preferred_dates, message,
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
    `SELECT id, owner_name, email, phone, dog_name, dog_count, service_id, service_name, preferred_dates, message,
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

// Walk through every Stripe Checkout Session we've ever minted for this
// booking. If any is already paid, surface that to the caller so they can
// refuse the re-price (the customer just paid the OLD amount). Open sessions
// are expired so the customer can't pay a stale link after the admin has
// changed the price. Best-effort: per-session errors are logged but don't
// abort the loop — sessions can legitimately be missing, already expired,
// or already complete.
async function reconcileStripeSessionsForReprice(stripe, booking) {
  const sessionIds = Array.isArray(booking.stripe_session_ids) && booking.stripe_session_ids.length > 0
    ? booking.stripe_session_ids
    : (booking.stripe_session_id ? [booking.stripe_session_id] : []);

  if (sessionIds.length === 0) return { paidSession: null, expiredAny: false };

  let expiredAny = false;
  for (const sid of sessionIds) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      if (session && session.payment_status === 'paid') {
        return { paidSession: session, expiredAny };
      }
      if (session && session.status === 'open') {
        try {
          await stripe.checkout.sessions.expire(sid);
          expiredAny = true;
        } catch (expireErr) {
          console.warn('[reprice] failed to expire session', sid, expireErr.message);
        }
      }
    } catch (retrieveErr) {
      console.warn('[reprice] failed to retrieve session', sid, retrieveErr.message);
    }
  }

  return { paidSession: null, expiredAny };
}

// Admin: Update booking status
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res) => {
  const { status, payment_status, amount_cents, dog_count } = req.body;

  // Reject unknown status values so the dashboard/clients aggregations, which
  // group on exact strings, never silently miss a mistyped record.
  if (status !== undefined && status !== null && !VALID_STATUS.has(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_STATUS].join(', ')}` });
  }
  if (payment_status !== undefined && payment_status !== null && !VALID_PAYMENT_STATUS.has(payment_status)) {
    return res.status(400).json({ error: `Invalid payment_status. Must be one of: ${[...VALID_PAYMENT_STATUS].join(', ')}` });
  }

  // Block re-pricing or dog-count changes on a settled booking — the customer
  // has already paid the original amount, so silently changing it here would
  // misrepresent the receipt. Status/payment_status edits still go through
  // (e.g. correcting a wrongly-marked record).
  const wantsRepricing = amount_cents !== undefined || dog_count !== undefined;
  let existingBooking = null;
  let postRepriceResetSql = null;
  let postRepriceResetParams = null;
  if (wantsRepricing) {
    const { rows: existing } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    existingBooking = existing[0];
    if (!existingBooking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (existingBooking.payment_status === 'paid') {
      return res.status(409).json({ error: 'Cannot change price or dog count on a paid booking' });
    }

    // If any Stripe Checkout Session was ever minted, the customer may still
    // have a live link at the old price. Expire those sessions now and force
    // payment_status back to 'unpaid' so the admin has to mint a fresh link
    // (via Send Payment Request) before the customer can pay the new amount.
    const hasSessions =
      (Array.isArray(existingBooking.stripe_session_ids) && existingBooking.stripe_session_ids.length > 0) ||
      !!existingBooking.stripe_session_id;
    if (hasSessions) {
      const stripe = getStripe();
      if (!stripe) {
        return res.status(409).json({
          error: 'A Stripe payment link is already outstanding for this booking. ' +
                 'Re-configure Stripe so existing links can be expired before re-pricing.'
        });
      }
      const { paidSession } = await reconcileStripeSessionsForReprice(stripe, existingBooking);
      if (paidSession) {
        // Customer paid via the old link in the window between admin opening
        // the modal and saving the edit. Mark the booking paid and refuse the
        // re-price so receipts stay consistent with what was actually charged.
        const paymentIntentId = typeof paidSession.payment_intent === 'string'
          ? paidSession.payment_intent
          : (paidSession.payment_intent && paidSession.payment_intent.id) || '';
        await query(
          `UPDATE bookings SET
             payment_status = 'paid',
             stripe_payment_id = COALESCE(NULLIF($1, ''), stripe_payment_id),
             status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
             updated_at = NOW()
           WHERE id = $2 AND payment_status != 'paid'`,
          [paymentIntentId, existingBooking.id]
        );
        return res.status(409).json({
          error: 'Customer just paid via the existing link. Refresh to see the paid status.'
        });
      }
      // Defer the payment_status / stripe_session_id reset until after the
      // main UPDATE so it isn't overwritten by COALESCE-from-current.
      postRepriceResetSql =
        `UPDATE bookings SET
           payment_status = 'unpaid',
           stripe_session_id = '',
           updated_at = NOW()
         WHERE id = $1`;
      postRepriceResetParams = [existingBooking.id];
    }
  }

  // When the admin changes dog_count, recompute amount_cents from the service
  // rate so the per-dog multiplier flows through. Explicit amount_cents in
  // the same request still wins so manual price adjustments stay possible.
  let recomputedAmount = null;
  if (dog_count !== undefined && amount_cents === undefined && existingBooking) {
    const { rows: serviceRows } = await query('SELECT * FROM services WHERE id = $1', [existingBooking.service_id]);
    const service = serviceRows[0];
    if (service) {
      recomputedAmount = computeAmountCents(service, existingBooking.start_date, existingBooking.end_date, dog_count);
    }
  }

  const normalizedDogCount = dog_count !== undefined ? normalizeDogCount(dog_count) : null;
  const finalAmount = amount_cents ?? recomputedAmount;

  await query(
    `UPDATE bookings SET
       status = COALESCE($1, status),
       payment_status = COALESCE($2, payment_status),
       amount_cents = COALESCE($3, amount_cents),
       dog_count = COALESCE($4, dog_count),
       updated_at = NOW()
     WHERE id = $5`,
    [status ?? null, payment_status ?? null, finalAmount ?? null, normalizedDogCount, req.params.id]
  );

  if (postRepriceResetSql) {
    await query(postRepriceResetSql, postRepriceResetParams);
  }

  const { rows: updated } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  await logAudit(req.admin.id, req.admin.email, 'update', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking updated', booking: updated[0] });
});

// Admin: Approve booking (confirms + auto-requests payment)
router.post('/:id/approve', authenticateToken, requirePermission('write'), async (req, res) => {
  const { rows } = await query(
    `UPDATE bookings SET status = 'confirmed', payment_status = 'requested', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Mint a Stripe checkout link so the confirmation email is directly payable.
  // If Stripe isn't configured (or the call fails), fall back to a link-free
  // confirmation — the customer can still pay from the portal.
  let checkoutUrl = null;
  const stripe = getStripe();
  if (stripe) {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: booking.service_name,
              description: `Booking #${booking.id} for ${booking.dog_name} - Benny and the Pets`
            },
            unit_amount: booking.amount_cents
          },
          quantity: 1
        }],
        mode: 'payment',
        metadata: { booking_id: booking.id.toString() },
        success_url: `${base}/my-bookings?email=${encodeURIComponent(booking.email)}&booking=${booking.id}`,
        cancel_url: `${base}/my-bookings?email=${encodeURIComponent(booking.email)}`
      });
      checkoutUrl = session.url;
      await query(
        `UPDATE bookings SET
           stripe_session_id = $2,
           stripe_session_ids = array_append(stripe_session_ids, $2),
           updated_at = NOW()
         WHERE id = $1 AND payment_status != 'paid'`,
        [booking.id, session.id]
      );
    } catch (err) {
      console.error('[approve] failed to create Stripe checkout session:', err.message);
    }
  }

  await mailer.sendBookingApprovedToCustomer({ booking, checkoutUrl });
  await logAudit(req.admin.id, req.admin.email, 'approve', 'bookings', req.params.id, 'success');
  res.json({ message: 'Booking approved and payment requested', checkout_url: checkoutUrl });
});

// Admin: Cancel booking with reason
router.post('/:id/cancel', authenticateToken, requirePermission('write'), async (req, res) => {
  const { reason } = req.body;

  const { rows: existingRows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Kill any live payment link before cancelling. Otherwise a customer holding
  // a still-open Checkout link from the confirmation email could pay it after
  // cancellation, and the webhook would mark the booking paid — taking money
  // for a booking that no longer exists.
  const stripe = getStripe();
  if (stripe) {
    await expireOpenStripeSessions(stripe, existing);
  }

  const { rows } = await query(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [reason || '', req.params.id]
  );

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
