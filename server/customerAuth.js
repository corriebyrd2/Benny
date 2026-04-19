const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, withTx } = require('./database');

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
  const normalizedEmail = email.toLowerCase();

  const existing = await query(
    'SELECT id FROM customers WHERE LOWER(email) = $1',
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    return { error: 'An account with this email already exists' };
  }

  const hash = bcrypt.hashSync(password, 10);

  const { customerId, dogs } = await withTx(async (client) => {
    const insertCustomer = await client.query(
      `INSERT INTO customers (name, email, phone, password_hash, dog_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, normalizedEmail, phone || '', hash, dogName || '']
    );
    const id = insertCustomer.rows[0].id;

    if (dogName) {
      await client.query(
        'INSERT INTO dogs (customer_id, name) VALUES ($1, $2)',
        [id, dogName]
      );
    }

    const dogsResult = await client.query(
      'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
      [id]
    );
    return { customerId: id, dogs: dogsResult.rows };
  });

  const customer = { id: customerId, email: normalizedEmail, name };
  const token = generateCustomerToken(customer);
  return {
    token,
    customer: { id: customerId, email: normalizedEmail, name, phone: phone || '', dog_name: dogName || '', dogs }
  };
}

async function loginCustomer(email, password) {
  const { rows } = await query(
    'SELECT * FROM customers WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  const customer = rows[0];

  if (!customer) {
    return null;
  }

  if (!bcrypt.compareSync(password, customer.password_hash)) {
    return null;
  }

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
