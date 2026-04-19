const express = require('express');
const { query } = require('../database');
const mailer = require('../email');

const router = express.Router();

// Matches RFC-5322-ish emails — good enough as a first-line validation before
// we hand the address to SendGrid (which does its own verification).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public: subscribe to the newsletter. Idempotent by (lower) email — re-submitting
// the same address re-triggers a SendGrid sync but does not create duplicates.
router.post('/', async (req, res) => {
  const raw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 64) : 'homepage';

  if (!raw || raw.length > 254 || !EMAIL_RE.test(raw)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  await query(
    `INSERT INTO subscribers (email, source)
     VALUES ($1, $2)
     ON CONFLICT (LOWER(email)) DO NOTHING`,
    [raw, source]
  );

  const sync = await mailer.addMarketingContact({ email: raw });

  if (sync.status === 'accepted') {
    await query(
      `UPDATE subscribers SET sendgrid_status = 'accepted', sendgrid_synced_at = NOW()
       WHERE LOWER(email) = LOWER($1)`,
      [raw]
    );
    if (!sync.attachedToList) {
      console.warn('[subscribe] accepted without list attachment:', raw);
    }
  } else if (sync.status === 'failed') {
    await query(
      `UPDATE subscribers SET sendgrid_status = 'failed'
       WHERE LOWER(email) = LOWER($1)`,
      [raw]
    );
    console.error('[subscribe] SendGrid sync failed for', raw, '→', sync.error);
  } else if (sync.status === 'skipped') {
    console.warn('[subscribe] SendGrid sync skipped for', raw, '→', sync.reason);
  }

  // Always 200 from the user's perspective — we captured the email locally
  // even if the SendGrid sync is queued or failed. An admin can retry later.
  // sendgrid_status is included so admins testing the flow can see whether
  // the contact actually reached SendGrid.
  res.status(200).json({
    message: 'Subscribed',
    sendgrid_status: sync.status,
    sendgrid_attached_to_list: sync.status === 'accepted' ? Boolean(sync.attachedToList) : false
  });
});

module.exports = router;
