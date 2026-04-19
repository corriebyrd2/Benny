const express = require('express');
const { query } = require('../database');
const { authenticateCustomer } = require('../customerAuth');

const router = express.Router();

// Get all dogs for the logged-in customer
router.get('/', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
    [req.customer.id]
  );
  res.json(rows);
});

// Create a new dog profile
router.post('/', authenticateCustomer, async (req, res) => {
  const { name, breed, weight, age, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Dog name is required' });
    }

  const { rows: customerRows } = await query('SELECT id FROM customers WHERE id = $1', [req.customer.id]);
  if (!customerRows[0]) {
    return res.status(401).json({ error: 'Customer not found. Please log out and log in again.' });
  }

  const { rows } = await query(
    `INSERT INTO dogs (customer_id, name, breed, weight, age, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.customer.id, name.trim(), breed || '', weight || '', age || '', notes || '']
  );

  res.status(201).json({ id: rows[0].id, message: 'Dog profile created' });
});

// Update a dog profile
router.put('/:id', authenticateCustomer, async (req, res) => {
  const { name, breed, weight, age, notes } = req.body;

  const { rows: dogRows } = await query(
    'SELECT * FROM dogs WHERE id = $1 AND customer_id = $2',
    [req.params.id, req.customer.id]
  );
  if (!dogRows[0]) {
    return res.status(404).json({ error: 'Dog not found' });
  }

  await query(
    `UPDATE dogs SET
       name = COALESCE($1, name),
       breed = COALESCE($2, breed),
       weight = COALESCE($3, weight),
       age = COALESCE($4, age),
       notes = COALESCE($5, notes),
       updated_at = NOW()
     WHERE id = $6 AND customer_id = $7`,
    [
      name ?? null,
      breed !== undefined ? breed : null,
      weight !== undefined ? weight : null,
      age !== undefined ? age : null,
      notes !== undefined ? notes : null,
      req.params.id,
      req.customer.id
    ]
  );

    res.json({ message: 'Dog profile updated' });
  } catch (err) { next(err); }
});

// Delete a dog profile
router.delete('/:id', authenticateCustomer, async (req, res) => {
  const result = await query(
    'DELETE FROM dogs WHERE id = $1 AND customer_id = $2',
    [req.params.id, req.customer.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Dog not found' });
  }

    res.json({ message: 'Dog profile deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
