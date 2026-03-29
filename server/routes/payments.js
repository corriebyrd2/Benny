const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const { authenticateCustomer } = require('../customerAuth');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_test_placeholder') {
    return null;
  }
  return require('stripe')(key);
}

// Public: Create a payment intent for a booking
router.post('/create-payment-intent', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Please add your Stripe keys to the .env file.' });
  }

  const { booking_id } = req.body;
  const db = getDb();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking_id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.payment_status === 'paid') {
    return res.status(400).json({ error: 'Booking is already paid' });
  }

  try {
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

    // Store the payment intent ID on the booking
    db.prepare('UPDATE bookings SET stripe_payment_id = ? WHERE id = ?')
      .run(paymentIntent.id, booking_id);

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: booking.amount_cents
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: Confirm payment completed (called after successful Stripe payment)
router.post('/confirm-payment', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const { payment_intent_id } = req.body;
  const db = getDb();

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status === 'succeeded') {
      const bookingId = paymentIntent.metadata.booking_id;
      db.prepare(`
        UPDATE bookings SET
          payment_status = 'paid',
          stripe_payment_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(payment_intent_id, bookingId);

      res.json({ message: 'Payment confirmed', booking_id: bookingId });
    } else {
      res.status(400).json({ error: 'Payment not yet completed', status: paymentIntent.status });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Request payment from customer (sets payment_status to 'requested')
router.post('/request-payment', authenticateToken, requirePermission('write'), (req, res) => {
  const { booking_id } = req.body;
  const db = getDb();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking_id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.payment_status === 'paid') {
    return res.status(400).json({ error: 'Booking is already paid' });
  }

  db.prepare(`
    UPDATE bookings SET
      payment_status = 'requested',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(booking_id);

  logAudit(req.admin.id, req.admin.email, 'request_payment', 'payments', booking_id.toString(), 'success');
  res.json({ message: 'Payment requested from customer' });
});

// Admin: Send a payment link for a booking
router.post('/send-payment-link', authenticateToken, requirePermission('write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Please add your Stripe keys to the .env file.' });
  }

  const { booking_id } = req.body;
  const db = getDb();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking_id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: booking.service_name,
            description: `Booking for ${booking.dog_name} - Benny and the Pets`
          },
          unit_amount: booking.amount_cents
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: {
        booking_id: booking.id.toString()
      },
      success_url: `${req.protocol}://${req.get('host')}/my-bookings?email=${encodeURIComponent(booking.email)}&booking=${booking.id}`,
      cancel_url: `${req.protocol}://${req.get('host')}/my-bookings?email=${encodeURIComponent(booking.email)}`
    });

    // Also mark as requested so customer sees it in their dashboard
    db.prepare(`
      UPDATE bookings SET
        payment_status = 'requested',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND payment_status != 'paid'
    `).run(booking_id);

    logAudit(req.admin.id, req.admin.email, 'send_payment_link', 'payments', booking_id.toString(), 'success');
    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer: Create a checkout session for their booking
router.post('/customer-checkout', authenticateCustomer, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Online payment is not yet configured. Please contact us to arrange payment.' });
  }

  const { booking_id } = req.body;
  const db = getDb();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(booking_id, req.customer.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.payment_status === 'paid') {
    return res.status(400).json({ error: 'Booking is already paid' });
  }

  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot pay for a cancelled booking' });
  }

  try {
    const host = req.get('host');
    const protocol = req.protocol;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: booking.service_name,
            description: `Booking #${booking.id} for ${booking.dog_name}`
          },
          unit_amount: booking.amount_cents
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: {
        booking_id: booking.id.toString()
      },
      success_url: `${protocol}://${host}/my-bookings?payment=success&booking=${booking.id}`,
      cancel_url: `${protocol}://${host}/my-bookings?payment=cancelled`
    });

    res.json({ checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook endpoint
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

  const db = getDb();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const bookingId = session.metadata.booking_id;
      if (bookingId) {
        db.prepare(`
          UPDATE bookings SET
            payment_status = 'paid',
            stripe_payment_id = ?,
            status = 'confirmed',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(session.payment_intent, bookingId);
      }
      break;
    }
    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      const bookingId = intent.metadata.booking_id;
      if (bookingId) {
        db.prepare(`
          UPDATE bookings SET
            payment_status = 'paid',
            stripe_payment_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(intent.id, bookingId);
      }
      break;
    }
  }

  res.json({ received: true });
});

// Admin: Get Stripe config status
router.get('/config', authenticateToken, requirePermission('read'), (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  const pubKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const configured = key && key !== 'sk_test_placeholder' && pubKey && pubKey !== 'pk_test_placeholder';
  res.json({
    configured,
    publishable_key: configured ? pubKey : null
  });
});

module.exports = router;
