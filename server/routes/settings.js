const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

// Whitelist — prevents arbitrary keys from being written and constrains what
// clients can set. If you add a new setting, add its key here and reference it
// from the homepage.
const ALLOWED_KEYS = new Set([
  'business_name',
  'footer_tagline',
  'contact_address_line1',
  'contact_address_line2',
  'contact_phone_display',
  'contact_phone_secondary',
  'contact_email',
  'hours_weekday',
  'hours_weekend',
  'facebook_url',
  'instagram_url',
  'tiktok_url'
]);

function rowsToObject(rows) {
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Public: Get all site settings (company info shown on the homepage).
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT key, value FROM site_settings');
  res.json(rowsToObject(rows));
});

// Admin: Update one or more settings.
router.put('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const body = req.body || {};
  const updates = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    updates.push([key, typeof value === 'string' ? value : String(value ?? '')]);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid settings provided' });
  }

  for (const [key, value] of updates) {
    await query(
      `INSERT INTO site_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  await logAudit(req.admin.id, req.admin.email, 'update', 'site_settings',
    updates.map(u => u[0]).join(','), 'success');

  const { rows } = await query('SELECT key, value FROM site_settings');
  res.json(rowsToObject(rows));
});

module.exports = router;
