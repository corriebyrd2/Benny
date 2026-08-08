const bcrypt = require('bcryptjs');
const { query } = require('./database');
const sessions = require('./sessions');

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

/**
 * Authenticate an admin from a server-side session.
 *
 * Session rows carry subject_type, so a customer session can no longer be
 * mistaken for an admin one — that separation used to depend on inspecting a
 * `type` claim inside a JWT signed with the same secret as customer tokens.
 * Admin sessions also expire far sooner (12h absolute, 1h idle) because an
 * admin credential reaches every customer's personal data.
 */
async function authenticateToken(req, res, next) {
  try {
    const credential = sessions.credentialFrom(req);
    if (!credential.token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!sessions.csrfOk(req, credential)) {
      return res.status(403).json({ error: 'csrf_token_invalid' });
    }

    const session = await sessions.resolveSession(credential.token);
    if (!session) {
      sessions.clearSessionCookies(res);
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    // A customer session presented to an admin route is a privilege-escalation
    // attempt, not an expiry: answer 403 so it is distinguishable in the logs.
    if (session.subject_type !== 'admin') {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await query('SELECT id, email, role FROM admins WHERE id = $1',
      [session.subject_id]);
    if (!rows[0]) {
      await sessions.revokeSession(credential.token, 'subject_missing');
      sessions.clearSessionCookies(res);
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    // The role is read from the database on every request, so a demotion takes
    // effect immediately rather than when a token happens to expire.
    req.admin = { id: rows[0].id, email: rows[0].email, role: rows[0].role || 'admin' };
    req.session = session;
    req.sessionToken = credential.token;
    next();
  } catch (err) {
    next(err);
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
  return { adminId: admin.id, admin: { id: admin.id, email: admin.email, role: admin.role || 'admin' } };
}

module.exports = { authenticateToken, requirePermission, logAudit, loginAdmin, ROLE_PERMISSIONS };
