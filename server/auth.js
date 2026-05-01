const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'benny-pets-default-secret' || JWT_SECRET === 'change-this-to-a-random-secret-key') {
  throw new Error('JWT_SECRET must be set to a strong random value before loading auth module');
}

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
  return async (req, res, next) => {
    if (!req.admin) {
      await logAudit(null, null, permissions.join(','), 'unknown', null, 'denied');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role = req.admin.role || 'viewer';
    const rolePerms = ROLE_PERMISSIONS[role] || [];
    const hasPermission = permissions.every(p => rolePerms.includes(p));

    if (!hasPermission) {
      await logAudit(req.admin.id, req.admin.email, permissions.join(','), req.originalUrl, null, 'denied');
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

async function logAudit(adminId, adminEmail, action, resource, resourceId, status) {
  try {
    await query(
      `INSERT INTO audit_logs (admin_id, admin_email, action, resource, resource_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, adminEmail, action, resource, resourceId || null, status || 'success']
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

async function loginAdmin(email, password) {
  const { rows } = await query('SELECT * FROM admins WHERE email = $1', [email]);
  const admin = rows[0];

  if (!admin) {
    await logAudit(null, email, 'login', 'auth', null, 'failed');
    return null;
  }

  if (!bcrypt.compareSync(password, admin.password_hash)) {
    await logAudit(admin.id, email, 'login', 'auth', null, 'failed');
    return null;
  }

  await logAudit(admin.id, email, 'login', 'auth', null, 'success');
  const token = generateToken(admin);
  return { token, admin: { id: admin.id, email: admin.email, role: admin.role || 'admin' } };
}

module.exports = { authenticateToken, requirePermission, logAudit, loginAdmin, ROLE_PERMISSIONS };
