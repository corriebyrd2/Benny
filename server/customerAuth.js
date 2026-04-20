const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'benny-pets-default-secret';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

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

// Creates a single-use password reset token for the customer matching `email`.
// Returns { token, customer } when an account exists, or null otherwise. The
// caller is responsible for not leaking the difference to unauthenticated users.
async function createPasswordResetToken(email) {
  const { rows } = await query(
    'SELECT id, email, name FROM customers WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  const customer = rows[0];
  if (!customer) return null;

  // Invalidate any prior unused tokens so only the latest link works.
  await query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE customer_id = $1 AND used_at IS NULL',
    [customer.id]
  );

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await query(
    `INSERT INTO password_reset_tokens (customer_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [customer.id, tokenHash, expiresAt]
  );

  return { token, customer, expiresAt };
}

async function resetPasswordWithToken(token, newPassword) {
  if (!token || !newPassword) {
    return { error: 'Invalid request' };
  }
  if (newPassword.length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }

  const tokenHash = hashToken(token);
  const { rows } = await query(
    `SELECT id, customer_id, expires_at, used_at
     FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    return { error: 'This reset link is invalid or has expired' };
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hash, record.customer_id]);
  await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
  return { ok: true };
}

module.exports = {
  authenticateCustomer,
  registerCustomer,
  loginCustomer,
  createPasswordResetToken,
  resetPasswordWithToken
};
