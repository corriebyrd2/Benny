const express = require('express');
const { query, getClient } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');
const mailer = require('../email');
const { getStripe } = require('../stripeClient');
const { quoteBooking, stripeLineItems, formatAmount } = require('../pricing');
const { recordBookingEvent, listBookingEvents } = require('../bookingAudit');
const { SETTLED, notSettledSql, isSettled } = require('../paymentStatus');
const { refundQuoteFor, startDateIso } = require('../refundQuote');

const router = express.Router();

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

// Whether a customer may still cancel this booking themselves.
//
// The published cancellation policy says a customer can cancel "at any time
// before the stay begins", so the cut-off is the start of the start date, not
// the refund deadline — cancelling late is allowed, it just earns a smaller
// refund (or none) under the policy tiers. Dates are compared in UTC, matching
// how start_date is stored and how the refund quote measures its deadline.
//
// A booking with no start date has no moment to be "past", so it stays
// cancellable; the same reasoning as the refund quote treating it as full.
// Cancelled and completed bookings are terminal.
const CANCELLABLE_STATUSES = new Set(['pending', 'confirmed']);

function todayIsoUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// What cancelling this booking now would return.
//
// refundQuoteFor is pure policy arithmetic over amount_cents — it answers "of
// this sum, how much does the policy give back", not "was this sum ever
// taken". An unpaid booking would therefore quote its full price as
// refundable. The admin refund route never hits that because it rejects
// unsettled bookings before quoting; this path is reached by any customer with
// a pending booking, so the settled check has to happen here.
function cancellationQuote(booking) {
  if (!isSettled(booking.payment_status)) {
    return {
      ...refundQuoteFor({ ...booking, amount_cents: 0, refunded_cents: 0 }),
      amount_paid_cents: 0,
      refundable_now_cents: 0
    };
  }
  return refundQuoteFor(booking);
}

// Returns null when the customer may cancel, or { status, error } describing
// why not. One function so the list endpoint's `can_cancel` flag and the cancel
// endpoint's enforcement can never disagree.
function customerCancelBlock(booking, now = Date.now()) {
  if (booking.status === 'cancelled') {
    return { status: 409, error: 'This booking is already cancelled.' };
  }
  if (!CANCELLABLE_STATUSES.has(booking.status)) {
    return { status: 400, error: 'This booking has already taken place and cannot be cancelled online.' };
  }
  const start = startDateIso(booking);
  if (start && start <= todayIsoUtc(now)) {
    return {
      status: 400,
      error: 'This stay has already started. Please contact us directly to make changes.'
    };
  }
  return null;
}

// Pricing is owned by server/pricing.js — the single authoritative source used
// by marketing cards, booking quotes, Stripe line items, emails and receipts.
// Nothing here re-derives an amount from a label or a client-supplied value.
function computeAmountCents(service, startDate, endDate, dogCount) {
  return quoteBooking({ service, startDate, endDate, dogCount }).total_cents;
}

// A service may be publicly visible without being bookable (see
// migrations/0014). Only 'bookable' services may be selected in a booking; the
// others route to an inquiry or show an explicit unavailable status.
function bookableError(service) {
  if (!service) return 'Invalid service selected';
  if (service.active === false) return 'Invalid service selected';
  if (service.booking_mode === 'inquiry') {
    return `${service.name} is not available for instant booking yet. Please contact us to enquire.`;
  }
  if (service.booking_mode === 'unavailable') {
    return `${service.name} is temporarily unavailable.`;
  }
  return null;
}

// Daily capacity, in dogs. Configurable so the owner can set it to the real
// number rather than the 10 that was hard-coded in the availability endpoint.
const DAILY_CAPACITY = Math.max(1, Number(process.env.DAILY_CAPACITY || 10));

// How many dogs are already booked in on a given date. Counts DOGS, not
// bookings: one booking for four dogs consumes four places. The old
// availability endpoint counted bookings, so it under-reported occupancy for
// every multi-dog stay.
async function bookedDogsOn(client, date) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(GREATEST(dog_count, 1)), 0)::int AS dogs
     FROM bookings
     WHERE status != 'cancelled'
       AND start_date IS NOT NULL
       AND start_date <= $1
       AND COALESCE(end_date, start_date) >= $1`,
    [date]
  );
  return rows[0].dogs;
}

// Every date a stay occupies, inclusive of both ends.
function datesInStay(startDate, endDate) {
  if (!startDate) return [];
  const out = [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${(endDate || startDate)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  // A guard against a pathological range consuming the request.
  const MAX_NIGHTS = 366;
  for (let t = start, i = 0; t <= end && i <= MAX_NIGHTS; t += 86400000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Reserve capacity and insert, atomically.
 *
 * Booking creation never consulted capacity at all — the availability endpoint
 * reported it, and nothing enforced it, so a full day could be booked
 * arbitrarily many times. Checking and then inserting in two statements would
 * still lose a race between two simultaneous requests, so the check and the
 * insert run inside one transaction guarded by advisory locks.
 *
 * EVERY occupied date is locked, not just the first. Locking only the start
 * date left overlapping stays that begin on different days unserialised: an
 * Aug 1-3 booking and an Aug 2-4 booking took different locks, both read the
 * capacity for Aug 2 before either inserted, and both took the last place.
 *
 * The locks are taken in ascending date order, which is the order
 * `datesInStay` produces. A consistent order across all callers is what makes
 * this deadlock-free: two overlapping stays always contend on their earliest
 * shared date first. MAX_NIGHTS bounds how many locks a single request can
 * take.
 *
 * Returns { booking } or { conflict: { date, booked, capacity, requested } }.
 */
async function insertBookingWithCapacity({ dates, dogs, insertSql, insertParams }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (dates.length > 0) {
      const ordered = [...dates].sort();
      for (const date of ordered) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [date]);
      }

      for (const date of ordered) {
        const booked = await bookedDogsOn(client, date);
        if (booked + dogs > DAILY_CAPACITY) {
          await client.query('ROLLBACK');
          return {
            conflict: { date, booked, capacity: DAILY_CAPACITY, requested: dogs }
          };
        }
      }
    }

    const { rows } = await client.query(insertSql, insertParams);
    await client.query('COMMIT');
    return { booking: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function capacityError(conflict) {
  const remaining = Math.max(0, conflict.capacity - conflict.booked);
  return remaining === 0
    ? `We're fully booked on ${conflict.date}. Please choose different dates or contact us.`
    : `We only have room for ${remaining} more dog${remaining === 1 ? '' : 's'} on ${conflict.date}. ` +
      `Please choose different dates or contact us.`;
}

// Public: Check availability for a given date
// Reports how many DOG PLACES are taken on the requested date.
router.get('/availability', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  const count = await bookedDogsOn({ query }, date);
  res.json({
    date,
    count,
    capacity: DAILY_CAPACITY,
    remaining: Math.max(0, DAILY_CAPACITY - count),
    available: count < DAILY_CAPACITY
  });
});

// Public: Create a booking
router.post('/', async (req, res, next) => {
  try {
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
  const notBookable = bookableError(service);
  if (notBookable) {
    return res.status(400).json({ error: notBookable });
  }

  const dogs = normalizeDogCount(dog_count);
  const amount_cents = computeAmountCents(service, start_date, end_date, dogs);

  const { booking, conflict } = await insertBookingWithCapacity({
    dates: datesInStay(start_date, end_date),
    dogs,
    insertSql: `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, start_date, end_date, dog_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    insertParams: [
      owner_name, email, phone || '', dog_name,
      service_id, service.name,
      preferred_dates || '', message || '',
      amount_cents,
      start_date || null, end_date || null,
      dogs
    ]
  });
  if (conflict) {
    return res.status(409).json({ error: capacityError(conflict), conflict });
  }

  await Promise.all([
    mailer.sendNewBookingToOwner({ booking }),
    mailer.sendBookingReceivedToCustomer({ booking })
  ]);

  res.status(201).json({
    id: booking.id,
    message: 'Booking request submitted',
    amount_cents
  });
  } catch (err) {
    next(err);
  }
});

// Authenticated customer: Get my bookings
//
// start_date/end_date and cancel_reason are selected because the portal needs
// them: without the dates it cannot tell the customer whether a stay is still
// cancellable, and the cancelled-booking banner it already renders was always
// blank because cancel_reason was never sent.
//
// can_cancel and cancellation are derived server-side from the same helpers the
// cancel endpoint enforces with, so the button the customer sees and the rule
// the server applies cannot drift apart. The refund figure in particular must
// never be computed in the browser.
router.get('/my', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    `SELECT id, owner_name, email, phone, dog_name, dog_count, service_id, service_name, preferred_dates, message,
            status, payment_status, amount_cents, refunded_cents, cancel_reason,
            start_date, end_date, created_at, updated_at
     FROM bookings WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customer.id]
  );
  res.json(rows.map(booking => {
    const block = customerCancelBlock(booking);
    return {
      ...booking,
      can_cancel: block === null,
      cancel_blocked_reason: block ? block.error : null,
      // What cancelling right now would return, under the published policy.
      // Only meaningful while the booking is still cancellable.
      cancellation: block === null ? cancellationQuote(booking) : null
    };
  }));
});

// Authenticated customer: cancel my own booking.
//
// Scoped by customer_id in the WHERE clause rather than checked after the
// fetch, so one customer can neither cancel nor probe for the existence of
// another's booking — a miss is an indistinguishable 404 either way.
//
// This deliberately does NOT issue the refund. Moving money is an
// admin-permissioned, locked, idempotency-keyed operation (POST
// /api/payments/refund/:id) and putting a customer-triggered path into it is a
// larger decision than this change should make on its own. What happens instead
// is that the customer is told exactly what the policy owes them, and the owner
// is emailed the same figure, so the refund is a prompt rather than something
// nobody noticed. See the note in the PR.
router.post('/my/:id/cancel', authenticateCustomer, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 500);

    const { rows: existingRows } = await query(
      'SELECT * FROM bookings WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.customer.id]
    );
    const existing = existingRows[0];
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const block = customerCancelBlock(existing);
    if (block) {
      return res.status(block.status).json({ error: block.error });
    }

    // What the customer is owed, measured BEFORE the row changes — the quote
    // reads amount_cents and start_date, and the figure the customer is shown
    // must be the one that applied at the moment they cancelled.
    const quote = cancellationQuote(existing);

    // Kill any live payment link first, exactly as the admin path does.
    // Otherwise a customer holding an open Checkout link could still pay for
    // the booking they just cancelled, and the webhook would record the money.
    const stripe = getStripe();
    if (stripe) {
      await expireOpenStripeSessions(stripe, existing);
    }

    // The status guard is repeated in the UPDATE so two concurrent requests
    // (a double-tap, or a customer racing an admin) cannot both count as the
    // cancellation. The second matches no row and is reported as already done.
    const { rows } = await query(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = $1, updated_at = NOW()
       WHERE id = $2 AND customer_id = $3 AND status = ANY($4::text[])
       RETURNING *`,
      [
        reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer',
        req.params.id,
        req.customer.id,
        [...CANCELLABLE_STATUSES]
      ]
    );
    const booking = rows[0];
    if (!booking) {
      return res.status(409).json({ error: 'This booking is already cancelled.' });
    }

    await recordBookingEvent({
      bookingId: booking.id,
      event: 'cancelled',
      from: { status: existing.status, payment_status: existing.payment_status },
      to: { status: 'cancelled', payment_status: booking.payment_status },
      actorType: 'customer',
      actorId: req.customer.id,
      detail: reason || 'cancelled by customer'
    });

    // Notifications are best-effort: a mail failure must not leave the customer
    // staring at an error for a cancellation that did in fact happen.
    await Promise.all([
      mailer.sendBookingCancelledToCustomer({ booking, reason: reason || '' }),
      mailer.sendBookingCancelledByCustomerToOwner({ booking, reason: reason || '', quote })
    ]).catch(err => console.error('[cancel-mine] notification failed:', err.message));

    const refundDue = quote.refundable_now_cents > 0;
    res.json({
      message: 'Booking cancelled',
      booking_id: booking.id,
      refund_due: refundDue,
      refund_cents: quote.refundable_now_cents,
      refund_tier: quote.tier,
      // Said plainly, because "tier: none" is not something a customer should
      // have to interpret.
      refund_message: refundDue
        ? `Under our cancellation policy you are due a refund of ${formatAmount(quote.refundable_now_cents)}. We'll process it to your original payment method.`
        : quote.amount_paid_cents > 0
          ? 'Under our cancellation policy this cancellation is not eligible for a refund. Contact us if you think that is wrong.'
          : 'Nothing was charged for this booking, so there is nothing to refund.'
    });
  } catch (err) {
    next(err);
  }
});

// Authenticated customer: Create a booking
router.post('/customer-book', authenticateCustomer, async (req, res, next) => {
  try {
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
    'SELECT * FROM services WHERE id = $1 AND active = TRUE',
    [service_id]
  );
  const service = serviceRows[0];
  const notBookable = bookableError(service);
  if (notBookable) {
    return res.status(400).json({ error: notBookable });
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

  const { booking, conflict } = await insertBookingWithCapacity({
    dates: datesInStay(start_date, end_date),
    dogs,
    insertSql: `INSERT INTO bookings (owner_name, email, phone, dog_name, service_id, service_name, preferred_dates, message, amount_cents, customer_id, start_date, end_date, dog_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    insertParams: [
      customer.name, customer.email, customer.phone || '',
      resolvedDogName, service_id, service.name,
      preferred_dates || '', message || '',
      amount_cents, customer.id,
      start_date || null, end_date || null,
      dogs
    ]
  });
  if (conflict) {
    return res.status(409).json({ error: capacityError(conflict), conflict });
  }

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
  } catch (err) {
    next(err);
  }
});

// NOTE: There is deliberately no unauthenticated "look up bookings by email"
// endpoint. Knowing an email address must never be enough to read someone
// else's bookings (phone, dog names, free-text messages, amounts). Customers
// see their own bookings via GET /my (JWT-scoped by customer_id); guests get
// status updates by email. Don't reintroduce email-only lookup here.

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

// Admin: the immutable transition trail for one booking. This is what makes a
// payment dispute answerable.
router.get('/:id/events', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    res.json(await listBookingEvents(req.params.id));
  } catch (err) {
    next(err);
  }
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
           WHERE id = $2 AND ${notSettledSql(3)}`,
          [paymentIntentId, existingBooking.id, SETTLED]
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
  // Load current state first so re-approving is a no-op instead of minting a
  // second payment link and emailing the customer a duplicate confirmation.
  const { rows: existingRows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (existing.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot approve a cancelled booking' });
  }
  if (existing.payment_status === 'paid') {
    return res.status(400).json({ error: 'Booking is already paid' });
  }

  // Only the pending -> confirmed transition mints a link and emails. The
  // conditional UPDATE also settles concurrent/duplicate approvals: whichever
  // request doesn't win the transition falls through to the no-op branch. To
  // re-send a payment link for an already-confirmed booking, use Send Payment
  // Link, which is purpose-built for that.
  const { rows } = await query(
    `UPDATE bookings SET status = 'confirmed', payment_status = 'requested', updated_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id]
  );
  const booking = rows[0];
  if (!booking) {
    return res.json({
      message: 'Booking already approved',
      already_approved: true,
      checkout_url: null
    });
  }

  // Mint a Stripe checkout link so the confirmation email is directly payable.
  // If Stripe isn't configured (or the call fails), fall back to a link-free
  // confirmation — the customer can still pay from the portal.
  let checkoutUrl = null;
  const stripe = getStripe();
  if (stripe) {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      // Line items are built from the same quote the customer was shown, so the
      // Stripe dashboard, Stripe's own receipt and our confirmation email all
      // display an identical breakdown instead of three separate derivations.
      const { rows: svcRows } = await query('SELECT * FROM services WHERE id = $1', [booking.service_id]);
      const quote = quoteBooking({
        service: svcRows[0] || { price_cents: booking.amount_cents, billing_unit: 'session' },
        startDate: booking.start_date,
        endDate: booking.end_date,
        dogCount: booking.dog_count
      });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: stripeLineItems({
          service: svcRows[0] || { name: booking.service_name },
          quote,
          bookingId: booking.id,
          dogName: booking.dog_name,
          authoritativeTotalCents: booking.amount_cents
        }),
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
         WHERE id = $1 AND ${notSettledSql(3)}`,
        [booking.id, session.id, SETTLED]
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
  await recordBookingEvent({
    bookingId: Number(req.params.id),
    event: 'cancelled',
    from: { status: existing.status, payment_status: existing.payment_status },
    to: { status: 'cancelled', payment_status: rows[0].payment_status },
    actorType: 'admin',
    actorId: req.admin.id,
    detail: reason || ''
  });
  await logAudit(req.admin.id, req.admin.email, 'cancel', 'bookings', req.params.id, reason || '');

  // Cancelling a PAID booking used to keep the money with no prompt and no
  // record. Surface what the published policy owes so the refund is a decision
  // rather than an oversight.
  const paidCents = Number(existing.amount_cents) || 0;
  const refundedCents = Number(existing.refunded_cents) || 0;
  const owesRefund = ['paid', 'partially_refunded'].includes(existing.payment_status)
    && refundedCents < paidCents;

  res.json({
    message: 'Booking cancelled',
    refund_due: owesRefund,
    refund_hint: owesRefund
      ? 'This booking was paid. Check the refund quote and issue a refund if one is owed.'
      : null
  });
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
