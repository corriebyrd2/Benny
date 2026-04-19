const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'benny-pets-default-secret';

function generateCustomerToken(customer) {
  return jwt.sign(
    { id: customer.id, email: customer.email, type: 'customer' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authenticateCustomer(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'customer') {
      return res.status(403).json({ error: 'Invalid token type' });
    }
    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

async function registerCustomer(name, email, password, phone, dogName) {
  const { rows: existing } = await query(
    'SELECT id FROM customers WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  if (existing.length) {
    return { error: 'An account with this email already exists' };
  }

  const hash = bcrypt.hashSync(password, 10);
  const { rows: inserted } = await query(
    `INSERT INTO customers (name, email, phone, password_hash, dog_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, email.toLowerCase(), phone || '', hash, dogName || '']
  );
  const customerId = inserted[0].id;

  if (dogName) {
    await query('INSERT INTO dogs (customer_id, name) VALUES ($1, $2)', [customerId, dogName]);
  }

  const { rows: dogs } = await query(
    'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
    [customerId]
  );

  const customer = { id: customerId, email: email.toLowerCase(), name };
  const token = generateCustomerToken(customer);
  return {
    token,
    customer: {
      id: customerId,
      email: email.toLowerCase(),
      name,
      phone: phone || '',
      dog_name: dogName || '',
      dogs
    }
  };
}

async function loginCustomer(email, password) {
  const { rows } = await query(
    'SELECT * FROM customers WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  const customer = rows[0];
  if (!customer) return null;
  if (!bcrypt.compareSync(password, customer.password_hash)) return null;

  const { rows: dogs } = await query(
    'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
    [customer.id]
  );

  const token = generateCustomerToken(customer);
  return {
    token,
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
      dog_name: customer.dog_name,
      dogs
    }
  };
}

module.exports = { authenticateCustomer, registerCustomer, loginCustomer };
