const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

const ALLOWED_KEYS = new Set([
  'contact_address',
  'contact_phone',
  'contact_email',
  'contact_hours',
  'social_facebook_url',
  'social_instagram_url',
  'social_tiktok_url'
]);

function rowsToMap(rows) {
  const map = {};
  for (const key of ALLOWED_KEYS) map[key] = '';
  for (const r of rows) {
    if (ALLOWED_KEYS.has(r.key)) map[r.key] = r.value;
  }
  return map;
}

// Public: fetch public-facing settings (contact info + social links)
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT key, value FROM settings');
  res.json(rowsToMap(rows));
});

// Admin: fetch all settings (same shape, distinct endpoint for clarity)
router.get('/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT key, value FROM settings');
  res.json(rowsToMap(rows));
});

// Admin: update one or more settings. Body: { key: value, ... }
router.put('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const updates = req.body || {};
  const entries = Object.entries(updates).filter(([k]) => ALLOWED_KEYS.has(k));

  if (entries.length === 0) {
    return res.status(400).json({ error: 'No valid settings provided' });
  }

  for (const [key, value] of entries) {
    await query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value ?? '')]
    );
  }

  await logAudit(req.admin.id, req.admin.email, 'update', 'settings', null, 'success');
  const { rows } = await query('SELECT key, value FROM settings');
  res.json(rowsToMap(rows));
});

module.exports = router;
