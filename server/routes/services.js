const express = require('express');
const { query } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

function parsePerks(services) {
  for (const s of services) {
    s.perks = JSON.parse(s.perks || '[]');
  }
  return services;
}

// Public: Get all active services
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM services WHERE active ORDER BY display_order ASC'
    );
    res.json(parsePerks(rows));
  } catch (err) { next(err); }
});

// Admin: Get all services (including inactive)
router.get('/all', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM services ORDER BY display_order ASC');
    res.json(parsePerks(rows));
  } catch (err) { next(err); }
});

// Admin: Create a service
router.post('/', authenticateToken, requirePermission('write'), async (req, res, next) => {
  try {
    const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id } = req.body;

    const { rows } = await query(`
      INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      name, description, icon || '',
      JSON.stringify(perks || []),
      price_cents || 0, price_label || '',
      !!is_featured, display_order || 0,
      stripe_price_id || ''
    ]);

    const id = rows[0].id;
    logAudit(req.admin.id, req.admin.email, 'create', 'services', id.toString(), 'success');
    res.status(201).json({ id, message: 'Service created' });
  } catch (err) { next(err); }
});

// Admin: Update a service
router.put('/:id', authenticateToken, requirePermission('write'), async (req, res, next) => {
  try {
    const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, active, stripe_price_id } = req.body;

    await query(`
      UPDATE services SET
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
        updated_at = now()
      WHERE id = $11
    `, [
      name, description, icon,
      perks ? JSON.stringify(perks) : null,
      price_cents, price_label,
      is_featured !== undefined ? !!is_featured : null,
      display_order,
      active !== undefined ? !!active : null,
      stripe_price_id,
      req.params.id
    ]);

    logAudit(req.admin.id, req.admin.email, 'update', 'services', req.params.id, 'success');
    res.json({ message: 'Service updated' });
  } catch (err) { next(err); }
});

// Admin: Delete a service
router.delete('/:id', authenticateToken, requirePermission('delete'), async (req, res, next) => {
  try {
    await query('DELETE FROM services WHERE id = $1', [req.params.id]);
    logAudit(req.admin.id, req.admin.email, 'delete', 'services', req.params.id, 'success');
    res.json({ message: 'Service deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
