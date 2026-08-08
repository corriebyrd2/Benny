// Test-only router and setup. Only loaded when TEST_MODE=1.
// Provides:
//   - in-memory email capture (replaces SendGrid transport)
//   - Stripe client stub (deterministic checkout URLs)
//   - /api/__test__/emails          GET / DELETE
//   - /api/__test__/db/reset        POST
//   - /api/__test__/stripe/webhook  POST — constructs a signed event and fans
//                                         it through the real webhook route
//   - /api/__test__/health          GET

const express = require('express');
const crypto = require('crypto');
const mailer = require('./email');
const stripeClient = require('./stripeClient');
const { pool, seed } = require('./database');

const emailLog = [];

function assertNotProduction() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test harness must never be loaded in production');
  }
}

function install() {
  assertNotProduction();
  // Capture emails — including marketing campaign sends, which now go through
  // the regular Mail Send transport (with recipients in bcc).
  mailer.setTransport({
    async send(msg) {
      emailLog.push({
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        bcc: msg.bcc ? (Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]) : [],
        from: msg.from,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        templateId: msg.templateId,
        dynamicTemplateData: msg.dynamicTemplateData,
        categories: msg.categories || [],
        customArgs: msg.customArgs || {},
        at: new Date().toISOString()
      });
    }
  }, { markConfigured: true });

  // Stripe stub. Returns deterministic URLs; the real Stripe SDK is never called.
  // Webhook verification still uses the real SDK via the test route below.
  let sessionCounter = 0;
  const sessions = new Map();
  stripeClient.setClient({
    checkout: {
      sessions: {
        async create({ metadata, line_items, success_url, cancel_url }) {
          sessionCounter += 1;
          const id = `cs_test_${sessionCounter}_${Date.now()}`;
          const session = {
            id,
            url: `https://stripe.test/checkout/${id}`,
            status: 'open',
            payment_status: 'unpaid',
            metadata,
            line_items,
            success_url,
            cancel_url
          };
          sessions.set(id, session);
          return session;
        },
        async retrieve(id) {
          return sessions.get(id) || { id, status: 'complete', payment_status: 'unpaid' };
        },
        async expire(id) {
          const s = sessions.get(id);
          if (s) s.status = 'expired';
          return s || { id, status: 'expired' };
        }
      }
    },
    paymentIntents: {
      async create({ amount, metadata, description }) {
        const id = `pi_test_${Date.now()}`;
        return {
          id,
          client_secret: `${id}_secret_test`,
          amount,
          metadata,
          description,
          status: 'requires_payment_method'
        };
      },
      async retrieve(id) {
        return { id, status: 'succeeded', metadata: { booking_id: '0' } };
      }
    },
    webhooks: {
      // Use the REAL signature algorithm so production code path is exercised.
      constructEvent(rawBody, signature, secret) {
        const parts = Object.fromEntries(
          String(signature).split(',').map(p => p.split('='))
        );
        const timestamp = parts.t;
        const sig = parts.v1;
        if (!timestamp || !sig) throw new Error('invalid signature');
        const payload = `${timestamp}.${rawBody.toString('utf8')}`;
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        if (expected !== sig) throw new Error('signature mismatch');
        return JSON.parse(rawBody.toString('utf8'));
      }
    }
  });

  console.log('[testHarness] installed — emails captured in memory, Stripe stubbed');
}

function buildRouter() {
  assertNotProduction();
  const router = express.Router();

  router.get('/health', (req, res) => res.json({ ok: true, mode: 'test' }));

  router.get('/emails', (req, res) => {
    const { to, subject } = req.query;
    let items = emailLog;
    if (to) items = items.filter(e => e.to.includes(to));
    if (subject) items = items.filter(e => e.subject.includes(subject));
    res.json(items);
  });

  router.delete('/emails', (req, res) => {
    emailLog.length = 0;
    res.json({ cleared: true });
  });

  router.post('/rate-limits/reset', (req, res) => {
    const limiters = req.app.locals.limiters || {};
    for (const l of Object.values(limiters)) {
      if (l && typeof l.resetKey === 'function') {
        l.resetKey(req.ip);
        // Also reset common localhost IPs in case tests run via a different bind
        l.resetKey('::1');
        l.resetKey('127.0.0.1');
        l.resetKey('::ffff:127.0.0.1');
      }
    }
    res.json({ reset: true });
  });

  router.post('/db/reset', async (req, res, next) => {
    try {
      // Truncate every app table in dependency order. Using CASCADE is safer
      // for FKs, but RESTART IDENTITY resets SERIALs so tests have predictable ids.
      // Every app table. site_settings was previously missing, so a spec that
      // edited a setting leaked into later specs (the homepage title assertion
      // failed against a business_name another spec had written).
      await pool.query(`
        TRUNCATE TABLE
          email_events,
          document_events,
          inquiries,
          sessions,
          stripe_events,
          booking_events,
          dog_documents,
          dogs,
          bookings,
          customers,
          password_reset_tokens,
          photos,
          reviews,
          services,
          site_settings,
          subscribers,
          policy_acceptances,
          audit_logs,
          admins
        RESTART IDENTITY CASCADE
      `);
      await seed();
      res.json({ reset: true });
    } catch (err) {
      next(err);
    }
  });

  // Build a signed Stripe webhook event and post it through the production route.
  // Body: { type: 'checkout.session.completed' | 'payment_intent.succeeded', booking_id, payment_id }
  router.post('/stripe/webhook', async (req, res, next) => {
    try {
      const { type, booking_id, payment_id } = req.body;
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not set' });
      }

      let data;
      if (type === 'checkout.session.completed') {
        data = {
          object: {
            id: `cs_test_${Date.now()}`,
            payment_intent: payment_id || `pi_test_${Date.now()}`,
            metadata: { booking_id: String(booking_id) }
          }
        };
      } else if (type === 'payment_intent.succeeded') {
        data = {
          object: {
            id: payment_id || `pi_test_${Date.now()}`,
            metadata: { booking_id: String(booking_id) }
          }
        };
      } else {
        return res.status(400).json({ error: 'unsupported event type' });
      }

      const event = {
        id: `evt_test_${Date.now()}`,
        type,
        data,
        created: Math.floor(Date.now() / 1000)
      };
      const raw = Buffer.from(JSON.stringify(event), 'utf8');
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', secret)
        .update(`${timestamp}.${raw.toString('utf8')}`)
        .digest('hex');
      const header = `t=${timestamp},v1=${sig}`;

      // Forward to the real webhook handler in-process
      const fetch = globalThis.fetch;
      const port = process.env.PORT || 3000;
      const resp = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': header
        },
        body: raw
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { install, buildRouter };
