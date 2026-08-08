const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');
const {
  FIELDS, FIELD_GROUPS, FIELD_KEYS, getBusinessProfile, launchCheck, validateValue
} = require('../businessProfile');

const router = express.Router();

// The writable keys ARE the business-profile field catalogue — one list, so a
// new profile field cannot be added in one place and silently be unwritable in
// the other.
const ALLOWED_KEYS = new Set(FIELD_KEYS);
const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));

function rowsToObject(rows) {
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Public: the business facts that are configured AND structurally valid.
// Unverified or placeholder values are omitted entirely rather than served to
// the browser, so no client can render them by accident.
router.get('/', async (req, res, next) => {
  try {
    const profile = await getBusinessProfile();
    res.json(profile.values);
  } catch (err) {
    next(err);
  }
});

// Admin: the raw stored rows, including values that failed validation, so the
// settings screen can show an administrator exactly what is wrong.
router.get('/admin', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT key, value FROM site_settings');
    const profile = await getBusinessProfile();
    const stored = rowsToObject(rows);
    res.json({
      // What is stored, INCLUDING values that failed validation. The public
      // endpoint hides those, which meant a stored placeholder showed up as an
      // empty box in the settings screen and the administrator had no way to
      // see what was actually wrong.
      values: stored,
      // What the site is currently able to publish, so the form can show the
      // difference between "stored" and "live".
      published: profile.values,
      fields: FIELDS,
      groups: FIELD_GROUPS,
      missing: profile.missing
    });
  } catch (err) {
    next(err);
  }
});

// Admin: launch gate. `ok: false` lists exactly which business facts are still
// missing or still placeholder text, with the reason for each.
router.get('/launch-check', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const result = await launchCheck();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// Admin: Update one or more settings.
router.put('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const rejected = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const str = typeof value === 'string' ? value : String(value ?? '');
    // Clearing a field is always allowed — that is how an administrator
    // removes something they can no longer stand behind. A NON-empty value has
    // to be structurally plausible for its type, so an obviously fictional
    // "(555) ..." number or a non-https social URL is refused at the door
    // rather than published.
    if (str.trim()) {
      const problem = validateValue(FIELD_BY_KEY.get(key), str);
      if (problem) {
        rejected.push({ key, reason: problem });
        continue;
      }
    }
    updates.push([key, str]);
  }

  if (rejected.length) {
    return res.status(400).json({
      error: rejected.map(r => `${r.key}: ${r.reason}`).join('; '),
      rejected
    });
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

  const profile = await getBusinessProfile();
  res.json(profile.values);
});

module.exports = router;
