const express = require('express');
const { query } = require('../database');

const router = express.Router();

// Matches RFC-5322-ish emails — good enough as a first-line validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public: subscribe to the newsletter. Idempotent by (lower) email — re-submitting
// the same address is a no-op.
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

  res.status(200).json({ message: 'Subscribed' });
});

module.exports = router;
