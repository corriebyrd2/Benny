const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'benny-pets-default-secret';

function generateToken(admin) {
  return jwt.sign({ id: admin.id, email: admin.email }, JWT_SECRET, { expiresIn: '24h' });
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

module.exports = { authenticateToken, loginAdmin };
