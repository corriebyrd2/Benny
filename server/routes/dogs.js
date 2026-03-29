const express = require('express');
const { getDb } = require('../database');
const { authenticateCustomer } = require('../customerAuth');

const router = express.Router();

// Get all dogs for the logged-in customer
router.get('/', authenticateCustomer, (req, res) => {
  const db = getDb();
  const dogs = db.prepare('SELECT * FROM dogs WHERE customer_id = ? ORDER BY created_at ASC').all(req.customer.id);
  res.json(dogs);
});

// Create a new dog profile
router.post('/', authenticateCustomer, (req, res) => {
  const db = getDb();
  const { name, breed, weight, age, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Dog name is required' });
  }

  const result = db.prepare(
    'INSERT INTO dogs (customer_id, name, breed, weight, age, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.customer.id, name.trim(), breed || '', weight || '', age || '', notes || '');

  res.status(201).json({ id: result.lastInsertRowid, message: 'Dog profile created' });
});

// Update a dog profile
router.put('/:id', authenticateCustomer, (req, res) => {
  const db = getDb();
  const { name, breed, weight, age, notes } = req.body;

  const dog = db.prepare('SELECT * FROM dogs WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.id);
  if (!dog) {
    return res.status(404).json({ error: 'Dog not found' });
  }

  db.prepare(`
    UPDATE dogs SET
      name = COALESCE(?, name),
      breed = COALESCE(?, breed),
      weight = COALESCE(?, weight),
      age = COALESCE(?, age),
      notes = COALESCE(?, notes),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND customer_id = ?
  `).run(name || null, breed !== undefined ? breed : null, weight !== undefined ? weight : null, age !== undefined ? age : null, notes !== undefined ? notes : null, req.params.id, req.customer.id);

  res.json({ message: 'Dog profile updated' });
});

// Delete a dog profile
router.delete('/:id', authenticateCustomer, (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM dogs WHERE id = ? AND customer_id = ?').run(req.params.id, req.customer.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Dog not found' });
  }

  res.json({ message: 'Dog profile deleted' });
});

module.exports = router;
