const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

const VALID_BILLING_UNITS = new Set(['night', 'day', 'session']);
function normalizeBillingUnit(val) {
  return VALID_BILLING_UNITS.has(val) ? val : 'session';
}

function parsePerks(services) {
  for (const s of services) {
    try { s.perks = JSON.parse(s.perks || '[]'); } catch { s.perks = []; }
  }
  return services;
}

// Public: Get all active services
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM services WHERE active = TRUE ORDER BY display_order ASC'
  );
  res.json(parsePerks(rows));
});

// Admin: Get all services (including inactive)
router.get('/all', authenticateToken, requirePermission('read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM services ORDER BY display_order ASC');
  res.json(parsePerks(rows));
});

// Admin: Create a service
router.post('/', authenticateToken, requirePermission('write'), async (req, res) => {
  const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id, billing_unit } = req.body;

  const { rows } = await query(
    `INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id, billing_unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      name, description, icon || '',
      JSON.stringify(perks || []),
      price_cents || 0, price_label || '',
      !!is_featured, display_order || 0,
      stripe_price_id || '',
      normalizeBillingUnit(billing_unit)
    ]
  );

  await logAudit(req.admin.id, req.admin.email, 'create', 'services', rows[0].id.toString(), 'success');
  res.status(201).json({ id: rows[0].id, message: 'Service created' });
});

// Admin: Update a service
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res) => {
  const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, active, stripe_price_id, billing_unit } = req.body;

  await query(
    `UPDATE services SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       icon = COALESCE($3, icon),
       perks = COALESCE($4, perks),
       price_cents = COALESCE($5, price_cents),
       price_label = COALESCE($6, price_label),
       is_featured = COALESCE($7, is_featured),
       display_order = COALESCE($8, display_order),
       active = COALESCE($9, active),
       stripe_price_id = COALESCE($10, stripe_price_id),
       billing_unit = COALESCE($11, billing_unit),
       updated_at = NOW()
     WHERE id = $12`,
    [
      name ?? null,
      description ?? null,
      icon ?? null,
      perks ? JSON.stringify(perks) : null,
      price_cents ?? null,
      price_label ?? null,
      is_featured !== undefined ? !!is_featured : null,
      display_order ?? null,
      active !== undefined ? !!active : null,
      stripe_price_id ?? null,
      billing_unit !== undefined ? normalizeBillingUnit(billing_unit) : null,
      req.params.id
    ]
  );

  await logAudit(req.admin.id, req.admin.email, 'update', 'services', req.params.id, 'success');
  res.json({ message: 'Service updated' });
});

// Admin: Delete a service
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res) => {
  await query('DELETE FROM services WHERE id = $1', [req.params.id]);
  await logAudit(req.admin.id, req.admin.email, 'delete', 'services', req.params.id, 'success');
  res.json({ message: 'Service deleted' });
});

module.exports = router;
