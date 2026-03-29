const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

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

function registerCustomer(name, email, password, phone, dogName) {
  const db = getDb();

  const existing = db.prepare('SELECT id FROM customers WHERE LOWER(email) = LOWER(?)').get(email);
  if (existing) {
    return { error: 'An account with this email already exists' };
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO customers (name, email, phone, password_hash, dog_name) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email.toLowerCase(), phone || '', hash, dogName || '');

  const customer = { id: result.lastInsertRowid, email: email.toLowerCase(), name };

  // Create initial dog profile if dog name provided
  if (dogName) {
    db.prepare('INSERT INTO dogs (customer_id, name) VALUES (?, ?)').run(result.lastInsertRowid, dogName);
  }

  const dogs = db.prepare('SELECT * FROM dogs WHERE customer_id = ? ORDER BY created_at ASC').all(result.lastInsertRowid);
  const token = generateCustomerToken(customer);
  return { token, customer: { id: customer.id, email: customer.email, name, phone: phone || '', dog_name: dogName || '', dogs } };
}

function loginCustomer(email, password) {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE LOWER(email) = LOWER(?)').get(email);

  if (!customer) {
    return null;
  }

  if (!bcrypt.compareSync(password, customer.password_hash)) {
    return null;
  }

  const dogs = db.prepare('SELECT * FROM dogs WHERE customer_id = ? ORDER BY created_at ASC').all(customer.id);
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
