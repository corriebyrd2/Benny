const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requirePermission, logAudit } = require('../auth');

const router = express.Router();

// Public: Get all active services
router.get('/', (req, res) => {
  const db = getDb();
  const services = db.prepare(
    'SELECT * FROM services WHERE active = 1 ORDER BY display_order ASC'
  ).all();

  services.forEach(s => {
    s.perks = JSON.parse(s.perks || '[]');
  });

  res.json(services);
});

// Admin: Get all services (including inactive)
router.get('/all', authenticateToken, requirePermission('read'), (req, res) => {
  const db = getDb();
  const services = db.prepare('SELECT * FROM services ORDER BY display_order ASC').all();
  services.forEach(s => {
    s.perks = JSON.parse(s.perks || '[]');
  });
  res.json(services);
});

// Admin: Create a service
router.post('/', authenticateToken, requirePermission('write'), (req, res) => {
  const db = getDb();
  const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id } = req.body;

  const result = db.prepare(`
    INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order, stripe_price_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, description, icon || '',
    JSON.stringify(perks || []),
    price_cents || 0, price_label || '',
    is_featured ? 1 : 0, display_order || 0,
    stripe_price_id || ''
  );

  logAudit(req.admin.id, req.admin.email, 'create', 'services', result.lastInsertRowid.toString(), 'success');
  res.status(201).json({ id: result.lastInsertRowid, message: 'Service created' });
});

// Admin: Update a service
router.put('/:id', authenticateToken, requirePermission('write'), (req, res) => {
  const db = getDb();
  const { name, description, icon, perks, price_cents, price_label, is_featured, display_order, active, stripe_price_id } = req.body;

  db.prepare(`
    UPDATE services SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      icon = COALESCE(?, icon),
      perks = COALESCE(?, perks),
      price_cents = COALESCE(?, price_cents),
      price_label = COALESCE(?, price_label),
      is_featured = COALESCE(?, is_featured),
      display_order = COALESCE(?, display_order),
      active = COALESCE(?, active),
      stripe_price_id = COALESCE(?, stripe_price_id),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name, description, icon,
    perks ? JSON.stringify(perks) : null,
    price_cents, price_label,
    is_featured !== undefined ? (is_featured ? 1 : 0) : null,
    display_order,
    active !== undefined ? (active ? 1 : 0) : null,
    stripe_price_id,
    req.params.id
  );

  logAudit(req.admin.id, req.admin.email, 'update', 'services', req.params.id, 'success');
  res.json({ message: 'Service updated' });
});

// Admin: Delete a service
router.delete('/:id', authenticateToken, requirePermission('delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  logAudit(req.admin.id, req.admin.email, 'delete', 'services', req.params.id, 'success');
  res.json({ message: 'Service deleted' });
});

module.exports = router;
