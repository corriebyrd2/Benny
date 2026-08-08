const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');

const router = express.Router();

// Matches RFC-5322-ish emails — good enough as a first-line validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Unsubscribe links must work from an email client with no session, and must
// not let anyone unsubscribe an address they don't know. A keyed HMAC of the
// address satisfies both without storing a per-subscriber token: the link is
// unguessable, stable, and verifiable in constant time.
function unsubscribeToken(email) {
  const secret = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', secret)
    .update(`unsubscribe:${String(email).toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 32);
}

function tokenMatches(email, token) {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function unsubscribeUrl(baseUrl, email) {
  const params = new URLSearchParams({ e: email, t: unsubscribeToken(email) });
  return `${baseUrl.replace(/\/$/, '')}/api/subscribe/unsubscribe?${params.toString()}`;
}

// Public: subscribe to the newsletter. Idempotent by (lower) email.
//
// Consent must be EXPLICIT: the caller has to send marketing_consent === true,
// which on the homepage comes from a separate, unticked checkbox. Subscribing
// is never a side effect of another action.
router.post('/', async (req, res, next) => {
  try {
    const raw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 64) : 'homepage';

    if (!raw || raw.length > 254 || !EMAIL_RE.test(raw)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (req.body?.marketing_consent !== true) {
      return res.status(400).json({
        error: 'Marketing consent is required. Tick the consent box to subscribe.'
      });
    }

    // Re-subscribing after an unsubscribe is a fresh, explicit consent, so it
    // clears the previous opt-out and records the new timestamp.
    await query(
      `INSERT INTO subscribers (email, source, consent_at, consent_source)
       VALUES ($1, $2, NOW(), $2)
       ON CONFLICT (LOWER(email)) DO UPDATE
         SET unsubscribed_at = NULL,
             unsubscribe_reason = '',
             consent_at = NOW(),
             consent_source = EXCLUDED.consent_source`,
      [raw, source]
    );

    res.status(200).json({ message: 'Subscribed' });
  } catch (err) {
    next(err);
  }
});

// Public: one-click unsubscribe from an emailed link. Answers 200 whether or
// not the address was subscribed, so the endpoint cannot be used to test
// whether someone is on the list.
router.get('/unsubscribe', async (req, res, next) => {
  try {
    const email = String(req.query.e || '').trim();
    const token = String(req.query.t || '');
    const ok = email && EMAIL_RE.test(email) && tokenMatches(email, token);

    if (ok) {
      await query(
        `UPDATE subscribers
         SET unsubscribed_at = NOW(), unsubscribe_reason = 'link'
         WHERE LOWER(email) = LOWER($1) AND unsubscribed_at IS NULL`,
        [email]
      );
    }

    res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Unsubscribed</title>
<link rel="stylesheet" href="/css/style.css"></head>
<body><main id="main" class="doc-page"><div class="container container-narrow">
<h1>You're unsubscribed</h1>
<p>You will not receive further marketing email from us. Messages about your own
bookings are not marketing and will still be sent.</p>
<p><a href="/">Back to the homepage</a></p>
</div></main></body></html>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.unsubscribeToken = unsubscribeToken;
module.exports.unsubscribeUrl = unsubscribeUrl;
