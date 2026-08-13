const express = require('express');
const { query, getClient } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');
const mailer = require('../email');
const { getStripe } = require('../stripeClient');
const { recordBookingEvent } = require('../bookingAudit');
const { SETTLED, notSettledSql, settledReason } = require('../paymentStatus');
const metrics = require('../metrics');
const { quoteBooking, stripeLineItems, formatAmount } = require('../pricing');
const { refundQuoteFor } = require('../refundQuote');

const router = express.Router();

// Guard for the routes that take money. Returns a message when the booking has
// already been charged, or null when it is safe to proceed.
function alreadyCharged(booking) {
  return settledReason(booking.payment_status);
}

const notSettled = notSettledSql;
const SETTLED_PAYMENT_STATUSES = SETTLED;

// Send the right notification once a booking flips to paid. A payment that
// lands on a CANCELLED booking (e.g. a stale link paid in the race before its
// session could be expired) must not be treated as a normal confirmation — we
// alert the owner to refund instead of emailing the customer a receipt for a
// booking that no longer exists.
async function notifyPaid(bookingId) {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const booking = rows[0];
  if (!booking) return;
  if (booking.status === 'cancelled') {
    await mailer.sendPaymentOnCancelledBookingToOwner({ booking });
    return;
  }
  await Promise.all([
    mailer.sendPaymentReceivedToCustomer({ booking }),
    mailer.sendPaymentReceivedToOwner({ booking })
  ]);
}

// Build Stripe line items for a booking from the authoritative pricing module,
// so every checkout surface (admin link, customer self-serve, approval email)
// charges and itemises the same way.
async function lineItemsForBooking(booking) {
  const { rows } = await query('SELECT * FROM services WHERE id = $1', [booking.service_id]);
  const service = rows[0] || { name: booking.service_name, price_cents: booking.amount_cents, billing_unit: 'session' };
  const quote = quoteBooking({
    service,
    startDate: booking.start_date,
    endDate: booking.end_date,
    dogCount: booking.dog_count
  });
  return stripeLineItems({
    service,
    quote,
    bookingId: booking.id,
    dogName: booking.dog_name,
    authoritativeTotalCents: booking.amount_cents
  });
}

// Reconcile a booking's payment status with Stripe. Webhooks are the primary
// path, but they can fail silently (misconfigured endpoint, missing secret,
// transient network error). This helper retrieves the Checkout Session (or
// PaymentIntent) from Stripe and flips the booking to 'paid' if Stripe reports
// the payment as succeeded. Safe to call repeatedly — the UPDATE short-circuits
// when already paid.
async function syncBookingFromStripe(stripe, booking) {
  let paid = false;
  let paymentIntentId = null;

  // Check every session id ever minted for this booking, newest first. A
  // customer who retried payment may have completed an older session, so we
  // can't rely on just the latest one. Fall back to the legacy scalar column
  // for rows migrated before stripe_session_ids existed.
  const sessionIds = Array.isArray(booking.stripe_session_ids) && booking.stripe_session_ids.length > 0
    ? [...booking.stripe_session_ids].reverse()
    : (booking.stripe_session_id ? [booking.stripe_session_id] : []);

  for (const sessionId of sessionIds) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === 'paid') {
        paid = true;
        paymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent && session.payment_intent.id) || null;
        break;
      }
    } catch (err) {
      console.error('[sync] session retrieve failed for booking', booking.id, sessionId, err.message);
    }
  }

  if (!paid && booking.stripe_payment_id && booking.stripe_payment_id.startsWith('pi_')) {
    try {
      const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_id);
      if (intent.status === 'succeeded') {
        paid = true;
        paymentIntentId = intent.id;
      }
    } catch (err) {
      console.error('[sync] intent retrieve failed for booking', booking.id, err.message);
    }
  }

  if (!paid) {
    return { changed: false, payment_status: booking.payment_status };
  }

  const result = await query(
    `UPDATE bookings SET
       payment_status = 'paid',
       stripe_payment_id = COALESCE(NULLIF($1, ''), stripe_payment_id),
       status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
       updated_at = NOW()
     WHERE id = $2 AND ${notSettled(3)}`,
    [paymentIntentId || '', booking.id, SETTLED_PAYMENT_STATUSES]
  );

  if (result.rowCount > 0) {
    await notifyPaid(booking.id);
  }

  return { changed: result.rowCount > 0, payment_status: 'paid' };
}

// Legacy PaymentIntent flow. The live frontend pays via Checkout Sessions
// (customer-checkout / send-payment-link), not these endpoints, so they are
// gated to admins rather than left open: an unauthenticated caller could
// otherwise mint Stripe PaymentIntents for any booking id and overwrite its
// stripe_payment_id.
router.post('/create-payment-intent', authenticateToken, requirePermission('write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Please add your Stripe keys to the .env file.' });
  }

  const { booking_id } = req.body;
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [booking_id]);
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const charged = alreadyCharged(booking);
  if (charged) {
    return res.status(400).json({ error: charged });
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: booking.amount_cents,
    currency: 'usd',
    metadata: {
      booking_id: booking.id.toString(),
      dog_name: booking.dog_name,
      service: booking.service_name
    },
    description: `${booking.service_name} for ${booking.dog_name} - Benny and the Pets`
  });

  await query(
    'UPDATE bookings SET stripe_payment_id = $1 WHERE id = $2',
    [paymentIntent.id, booking_id]
  );

  res.json({
    clientSecret: paymentIntent.client_secret,
    amount: booking.amount_cents
  });
});

// Legacy confirm endpoint for the PaymentIntent flow above. Same reasoning:
// gated to admins. Real payment confirmation happens through the signed Stripe
// webhook and the customer/admin sync routes.
router.post('/confirm-payment', authenticateToken, requirePermission('write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const { payment_intent_id } = req.body;
  const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

  if (paymentIntent.status === 'succeeded') {
    const bookingId = paymentIntent.metadata.booking_id;
    await query(
      `UPDATE bookings SET
         payment_status = 'paid',
         stripe_payment_id = $1,
         updated_at = NOW()
       WHERE id = $2`,
      [payment_intent_id, bookingId]
    );

    res.json({ message: 'Payment confirmed', booking_id: bookingId });
  } else {
    res.status(400).json({ error: 'Payment not yet completed', status: paymentIntent.status });
  }
});

// Admin: Request payment from customer (sets payment_status to 'requested')
router.post('/request-payment', authenticateToken, requirePermission('write'), async (req, res) => {
  const { booking_id } = req.body;

  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [booking_id]);
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot request payment for a cancelled booking' });
    }

    const charged = alreadyCharged(booking);
    if (charged) {
      return res.status(400).json({ error: charged });
    }

  await query(
    `UPDATE bookings SET payment_status = 'requested', updated_at = NOW()
       WHERE id = $1 AND ${notSettled(2)}`,
    [booking_id, SETTLED_PAYMENT_STATUSES]
  );

  await logAudit(req.admin.id, req.admin.email, 'request_payment', 'payments', booking_id.toString(), 'success');
  res.json({ message: 'Payment requested from customer' });
});

// Admin: Send a payment link for a booking
router.post('/send-payment-link', authenticateToken, requirePermission('write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Please add your Stripe keys to the .env file.' });
  }

  const { booking_id } = req.body;
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [booking_id]);
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  // Minting a link for a cancelled or already-settled booking would let the
  // customer pay for something they cannot receive, or pay twice.
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot send a payment link for a cancelled booking' });
  }
  const charged = alreadyCharged(booking);
  if (charged) {
    return res.status(400).json({ error: charged });
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: await lineItemsForBooking(booking),
    mode: 'payment',
    metadata: { booking_id: booking.id.toString() },
    success_url: `${req.protocol}://${req.get('host')}/my-bookings?email=${encodeURIComponent(booking.email)}&booking=${booking.id}`,
    cancel_url: `${req.protocol}://${req.get('host')}/my-bookings?email=${encodeURIComponent(booking.email)}`
  });

  await query(
    `UPDATE bookings SET
       payment_status = 'requested',
       stripe_session_id = $2,
       stripe_session_ids = array_append(stripe_session_ids, $2),
       updated_at = NOW()
     WHERE id = $1 AND ${notSettled(3)}`,
    [booking_id, session.id, SETTLED_PAYMENT_STATUSES]
  );

  await mailer.sendPaymentLinkToCustomer({ booking, checkoutUrl: session.url });

  await logAudit(req.admin.id, req.admin.email, 'send_payment_link', 'payments', booking_id.toString(), 'success');
  res.json({ checkout_url: session.url, session_id: session.id });
});

// Customer: Create a checkout session for their booking
router.post('/customer-checkout', authenticateCustomer, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Online payment is not yet configured. Please contact us to arrange payment.' });
  }

  const { booking_id } = req.body;
  const { rows } = await query(
    'SELECT * FROM bookings WHERE id = $1 AND customer_id = $2',
    [booking_id, req.customer.id]
  );
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const charged = alreadyCharged(booking);
  if (charged) {
    return res.status(400).json({ error: charged });
  }

  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot pay for a cancelled booking' });
  }

  const host = req.get('host');
  const protocol = req.protocol;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: await lineItemsForBooking(booking),
    mode: 'payment',
    metadata: { booking_id: booking.id.toString() },
    success_url: `${protocol}://${host}/my-bookings?payment=success&booking=${booking.id}`,
    cancel_url: `${protocol}://${host}/my-bookings?payment=cancelled`
  });

  await query(
    `UPDATE bookings SET
       stripe_session_id = $2,
       stripe_session_ids = array_append(stripe_session_ids, $2),
       updated_at = NOW()
     WHERE id = $1 AND ${notSettled(3)}`,
    [booking.id, session.id, SETTLED_PAYMENT_STATUSES]
  );

  res.json({ checkout_url: session.url });
});

// Stripe webhook endpoint. Signed body verification; raw body is mounted in server.js.
router.post('/webhook', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  // Exactly-once processing. Claiming the event id first means a duplicate or
  // replayed delivery short-circuits here instead of re-running the handler,
  // and the row records that we saw it even if processing later fails.
  let claimed;
  try {
    claimed = await query(
      `INSERT INTO stripe_events (event_id, event_type, booking_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.id,
        event.type,
        parseInt((event.data && event.data.object && event.data.object.metadata
          && event.data.object.metadata.booking_id) || '', 10) || null
      ]
    );
  } catch (err) {
    // The ledger itself is unavailable. Answer 5xx so Stripe retries rather
    // than dropping a real payment notification.
    console.error('[webhook] could not record event', event.id, err.message);
    return res.status(503).json({ error: 'Event ledger unavailable, retry' });
  }

  if (claimed.rowCount === 0) {
    metrics.increment('benny_webhook_events_total', { outcome: 'duplicate' });
    return res.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const bookingId = session.metadata.booking_id;
        if (bookingId) {
          // Confirm the booking on payment — but never resurrect a cancelled
          // one. If a stale link is somehow paid after cancellation, record the
          // payment (so the money is accounted for) yet keep it cancelled; the
          // notifyPaid branch then alerts the owner to refund.
          const result = await query(
            `UPDATE bookings SET
               payment_status = 'paid',
               stripe_payment_id = $1,
               status = CASE WHEN status = 'cancelled' THEN status ELSE 'confirmed' END,
               updated_at = NOW()
             WHERE id = $2 AND ${notSettled(3)}`,
            [session.payment_intent, bookingId, SETTLED_PAYMENT_STATUSES]
          );
          if (result.rowCount > 0) {
            await recordBookingEvent({
              bookingId,
              event: 'payment_succeeded',
              to: { payment_status: 'paid' },
              actorType: 'stripe_webhook',
              actorId: event.id,
              detail: String(session.id || '')
            });
            await notifyPaid(bookingId);
          }
        }
        break;
      }
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        const bookingId = intent.metadata.booking_id;
        if (bookingId) {
          const result = await query(
            `UPDATE bookings SET
               payment_status = 'paid',
               stripe_payment_id = $1,
               updated_at = NOW()
             WHERE id = $2 AND ${notSettled(3)}`,
            [intent.id, bookingId, SETTLED_PAYMENT_STATUSES]
          );
          if (result.rowCount > 0) {
            await recordBookingEvent({
              bookingId,
              event: 'payment_succeeded',
              to: { payment_status: 'paid' },
              actorType: 'stripe_webhook',
              actorId: event.id,
              detail: intent.id
            });
            await notifyPaid(bookingId);
          }
        }
        break;
      }
    }
    await query(
      `UPDATE stripe_events SET processed_at = NOW(), status = 'processed' WHERE event_id = $1`,
      [event.id]
    );
    metrics.increment('benny_webhook_events_total', { outcome: 'processed' });
  } catch (err) {
    console.error('[webhook] processing failed for', event.type, 'event', event.id, err);
    metrics.increment('benny_webhook_events_total', { outcome: 'failed' });
    // Release the claim so Stripe's retry can process the event rather than
    // being deduplicated against a row that never completed.
    try {
      await query('DELETE FROM stripe_events WHERE event_id = $1 AND processed_at IS NULL', [event.id]);
    } catch (cleanupErr) {
      console.error('[webhook] could not release event claim', event.id, cleanupErr.message);
    }
    // 5xx tells Stripe to retry with backoff. Returning 200 here (the previous
    // behaviour) silently lost real payments whenever the DB write failed.
    return res.status(500).json({ error: 'Event processing failed, retry' });
  }

  res.json({ received: true });
});

// Customer: reconcile their booking with Stripe. Used after returning from
// Checkout so the UI reflects the payment even if the webhook hasn't landed.
router.post('/sync/:booking_id', authenticateCustomer, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const { rows } = await query(
    'SELECT * FROM bookings WHERE id = $1 AND customer_id = $2',
    [req.params.booking_id, req.customer.id]
  );
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const result = await syncBookingFromStripe(stripe, booking);
  res.json({
    booking_id: booking.id,
    payment_status: result.payment_status,
    updated: result.changed
  });
});

// Admin: reconcile a booking with Stripe for any booking. Useful when the
// webhook didn't land (e.g., endpoint was mis-configured in Stripe).
router.post('/sync-admin/:booking_id', authenticateToken, requirePermission('write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.booking_id]);
  const booking = rows[0];
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const result = await syncBookingFromStripe(stripe, booking);
  await logAudit(req.admin.id, req.admin.email, 'sync_payment', 'payments', String(booking.id),
    result.changed ? 'updated' : 'no_change');
  res.json({
    booking_id: booking.id,
    payment_status: result.payment_status,
    updated: result.changed
  });
});

// How much of a booking is still refundable, under the published cancellation
// policy, lives in ../refundQuote — customer-initiated cancellation quotes the
// same figure, so there is one implementation rather than two.

// Admin: what the cancellation policy says this booking is owed.
router.get('/refund-quote/:booking_id', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.booking_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    res.json(refundQuoteFor(rows[0]));
  } catch (err) {
    next(err);
  }
});

// Admin: issue a refund.
//
// The amount defaults to what the published cancellation policy owes; an
// explicit amount is allowed (an owner may choose to be more generous) but is
// capped at what was actually paid, so a typo cannot refund more than the
// customer ever handed over.
//
// CONCURRENCY. Reading `refunded_cents`, checking the remaining balance and
// then calling Stripe is a read-modify-write across a network call. Two
// admins — or one admin double-clicking — could both read the same
// `refunded_cents`, both pass the remaining-balance check, and both create a
// Stripe refund; the second write then overwrote the first, so the booking
// under-reported the money returned and would allow refunding it AGAIN.
//
// Two independent defences, because either alone leaves a gap:
//   1. The booking row is locked FOR UPDATE for the whole operation, so the
//      second request waits and re-reads the balance the first one wrote.
//   2. A deterministic Stripe idempotency key derived from the booking, the
//      balance already refunded and the amount. If a request is retried after
//      the lock is released but before we learn the outcome, Stripe returns
//      the SAME refund rather than creating a second one.
//
// The transaction stays open across the Stripe call. That is a deliberate
// trade — refunds are rare, admin-initiated, and correctness of the amount
// matters far more here than holding a connection for a second or two.
router.post('/refund/:booking_id', authenticateToken, requirePermission('write'), async (req, res, next) => {
  const client = await getClient();
  let committed = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.booking_id]);
    const booking = rows[0];
    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const paid = Number(booking.amount_cents) || 0;
    const alreadyRefunded = Number(booking.refunded_cents) || 0;

    // Order matters. A fully refunded booking WAS paid, so testing "is it paid?"
    // first answered "this booking has not been paid" — true of the current
    // status, and misleading about what actually happened.
    if (booking.payment_status === 'refunded' || (paid > 0 && alreadyRefunded >= paid)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This booking has already been fully refunded' });
    }
    if (!['paid', 'partially_refunded'].includes(booking.payment_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This booking has not been paid, so there is nothing to refund' });
    }

    const quote = refundQuoteFor(booking);
    let amount = req.body?.amount_cents === undefined
      ? quote.refundable_now_cents
      : Math.round(Number(req.body.amount_cents));

    if (!Number.isInteger(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Refund amount must be a positive number of cents' });
    }
    if (amount + alreadyRefunded > paid) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot refund more than was paid. At most ${formatAmount(paid - alreadyRefunded)} remains.`
      });
    }

    const stripe = getStripe();
    if (!stripe) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Stripe is not configured, so a refund cannot be issued here' });
    }
    if (!booking.stripe_payment_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No payment reference is recorded for this booking. Refund it in the Stripe dashboard and record it here.'
      });
    }

    let refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent: booking.stripe_payment_id,
        amount,
        metadata: { booking_id: String(booking.id) }
      }, {
        // Same booking, same balance already refunded, same amount => the same
        // refund. A retry cannot become a second refund.
        idempotencyKey: `refund-${booking.id}-${alreadyRefunded}-${amount}`
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[refund] Stripe refused the refund for booking', booking.id, err.message);
      metrics.increment('benny_payment_failures_total', { operation: 'refund' });
      return res.status(502).json({ error: `The payment provider refused the refund: ${err.message}` });
    }

    const totalRefunded = alreadyRefunded + amount;
    const newStatus = totalRefunded >= paid ? 'refunded' : 'partially_refunded';

    // Record the refund before updating the booking: an orphaned refund row is
    // recoverable, a booking that claims a refund with no record is not.
    await client.query(
      `INSERT INTO refunds (booking_id, amount_cents, reason, tier, stripe_refund_id,
                            stripe_payment_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (stripe_refund_id) WHERE stripe_refund_id <> '' DO NOTHING`,
      [booking.id, amount, String(req.body?.reason || '').slice(0, 500), quote.tier,
        refund.id || '', booking.stripe_payment_id, req.admin.email || '']
    );

    await client.query(
      `UPDATE bookings SET refunded_cents = $2, payment_status = $3, updated_at = NOW()
       WHERE id = $1`,
      [booking.id, totalRefunded, newStatus]
    );

    await client.query('COMMIT');
    committed = true;

    await recordBookingEvent({
      bookingId: booking.id,
      event: 'refund_issued',
      from: { payment_status: booking.payment_status },
      to: { payment_status: newStatus },
      amountCents: amount,
      actorType: 'admin',
      actorId: req.admin.id,
      detail: `${quote.tier} tier; stripe ${refund.id || 'n/a'}`
    });

    try {
      await mailer.sendRefundIssuedToCustomer({ booking, amountCents: amount, tier: quote.tier });
    } catch (err) {
      console.error('[refund] customer notification failed for booking', booking.id, err.message);
    }

    await logAudit(req.admin.id, req.admin.email, 'refund', 'payments', String(booking.id),
      `${amount} cents`);

    res.json({
      message: 'Refund issued',
      amount_cents: amount,
      total_refunded_cents: totalRefunded,
      payment_status: newStatus,
      stripe_refund_id: refund.id || null
    });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Admin: the refund history for a booking.
router.get('/refunds/:booking_id', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC',
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Admin: Get Stripe config status
router.get('/config', authenticateToken, requirePermission('read'), (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  const pubKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const isConfigured = !!(key && key !== 'sk_test_placeholder' && pubKey && pubKey !== 'pk_test_placeholder');
  res.json({
    configured: isConfigured,
    publishable_key: isConfigured ? pubKey : null
  });
});

module.exports = router;
