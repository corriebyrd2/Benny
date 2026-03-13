const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'benny-pets-default-secret';

// Role hierarchy: admin > manager > viewer
const ROLE_PERMISSIONS = {
  admin: ['read', 'write', 'delete', 'manage_admins'],
  manager: ['read', 'write', 'delete'],
  viewer: ['read']
};

function generateToken(admin) {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role || 'admin' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
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

function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.admin) {
      logAudit(null, null, permissions.join(','), 'unknown', null, 'denied');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role = req.admin.role || 'viewer';
    const rolePerms = ROLE_PERMISSIONS[role] || [];
    const hasPermission = permissions.every(p => rolePerms.includes(p));

    if (!hasPermission) {
      logAudit(req.admin.id, req.admin.email, permissions.join(','), req.originalUrl, null, 'denied');
      return res.status(403).json({
        error: 'rbac_access_denied',
        message: `Role '${role}' does not have required permission(s): ${permissions.join(', ')}`,
        required_permissions: permissions,
        current_role: role
      });
    }

    next();
  };
}

function logAudit(adminId, adminEmail, action, resource, resourceId, status) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_logs (admin_id, admin_email, action, resource, resource_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(adminId, adminEmail, action, resource, resourceId || null, status || 'success');
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

function loginAdmin(email, password) {
  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

  if (!admin) {
    logAudit(null, email, 'login', 'auth', null, 'failed');
    return null;
  }

  if (!bcrypt.compareSync(password, admin.password_hash)) {
    logAudit(admin.id, email, 'login', 'auth', null, 'failed');
    return null;
  }

  logAudit(admin.id, email, 'login', 'auth', null, 'success');
  const token = generateToken(admin);
  return { token, admin: { id: admin.id, email: admin.email, role: admin.role || 'admin' } };
}

module.exports = { authenticateToken, requirePermission, logAudit, loginAdmin, ROLE_PERMISSIONS };
