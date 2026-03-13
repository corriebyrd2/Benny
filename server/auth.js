const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'benny-pets-default-secret';

function generateToken(admin) {
  return jwt.sign({ id: admin.id, email: admin.email, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

function generateCustomerToken(customer) {
  return jwt.sign({ id: customer.id, email: customer.email, role: 'customer' }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticateCustomer(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'customer') {
      return res.status(403).json({ error: 'Customer authentication required' });
    }
    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

function registerCustomer(name, email, phone, password) {
  const db = getDb();

  const existing = db.prepare('SELECT id FROM customers WHERE LOWER(email) = LOWER(?)').get(email);
  if (existing) {
    return { error: 'An account with this email already exists' };
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO customers (name, email, phone, password_hash) VALUES (?, ?, ?, ?)').run(name, email, phone || '', hash);

  const customer = { id: result.lastInsertRowid, email, name };
  const token = generateCustomerToken(customer);
  return { token, customer: { id: customer.id, email, name, phone: phone || '' } };
}

function loginCustomer(email, password) {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE LOWER(email) = LOWER(?)').get(email);

  if (!customer) return null;
  if (!bcrypt.compareSync(password, customer.password_hash)) return null;

  const token = generateCustomerToken(customer);
  return { token, customer: { id: customer.id, email: customer.email, name: customer.name, phone: customer.phone } };
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function loginAdmin(email, password) {
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

  if (!admin) {
    return null;
  }

  if (!bcrypt.compareSync(password, admin.password_hash)) {
    return null;
  }

  const token = generateToken(admin);
  return { token, admin: { id: admin.id, email: admin.email } };
}

module.exports = { authenticateToken, loginAdmin, authenticateCustomer, registerCustomer, loginCustomer };
