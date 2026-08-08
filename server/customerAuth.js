const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./database');
const sessions = require('./sessions');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'benny-pets-default-secret' || JWT_SECRET === 'change-this-to-a-random-secret-key') {
  throw new Error('JWT_SECRET must be set to a strong random value before loading customerAuth module');
}
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Returns null if the password meets policy, or an error message describing
// what's missing. Kept lenient enough that real users won't bounce, strict
// enough to defeat the obvious "password" / "12345678" candidates.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Authenticate a customer from a server-side session.
 *
 * Sessions replaced the stateless JWT: the token is opaque, stored only as a
 * hash, revocable, and idle-expiring. The credential arrives either in the
 * HttpOnly cookie (browsers) or as a Bearer token (programmatic clients).
 */
async function authenticateCustomer(req, res, next) {
  try {
    const credential = sessions.credentialFrom(req);
    if (!credential.token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!sessions.csrfOk(req, credential)) {
      return res.status(403).json({ error: 'csrf_token_invalid' });
    }

    const session = await sessions.resolveSession(credential.token);
    // Absent, revoked, expired and idle-timed-out are deliberately
    // indistinguishable to the client: all are "sign in again".
    if (!session) {
      sessions.clearSessionCookies(res);
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    // A LIVE session of the wrong type is a different thing entirely — someone
    // presenting an admin credential to a customer route. That is a privilege
    // boundary violation, not an expiry, so it answers 403 and leaves the
    // session intact. The admin middleware mirrors this.
    if (session.subject_type !== 'customer') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    const { rows } = await query(
      'SELECT id, email, name FROM customers WHERE id = $1',
      [session.subject_id]
    );
    if (!rows[0]) {
      await sessions.revokeSession(credential.token, 'subject_missing');
      sessions.clearSessionCookies(res);
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    req.customer = { id: rows[0].id, email: rows[0].email, name: rows[0].name };
    req.session = session;
    req.sessionToken = credential.token;
    next();
  } catch (err) {
    next(err);
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

  return {
    customerId,
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

  return {
    customerId: customer.id,
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
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return { error: passwordError };
  }

  const tokenHash = hashToken(token);
  // Atomically consume the token: only one concurrent request can win this
  // UPDATE, so the password change below is guarded against replay.
  const { rows } = await query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING customer_id`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return { error: 'This reset link is invalid or has expired' };
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hash, record.customer_id]);
  // The whole point of a reset is to lock someone out. A stateless token could
  // not be revoked, so an attacker holding one kept access straight through the
  // action taken to remove them.
  const revoked = await sessions.revokeAllForSubject('customer', record.customer_id, 'password_reset');
  return { ok: true, sessions_revoked: revoked };
}

module.exports = {
  authenticateCustomer,
  hashToken,
  registerCustomer,
  loginCustomer,
  createPasswordResetToken,
  resetPasswordWithToken,
  validatePassword
};
