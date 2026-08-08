// Server-side session management.
//
// Replaces the stateless JWT-in-localStorage design. The contract:
//
//   * The token is 32 random bytes. Only its SHA-256 hash is stored, so a
//     database disclosure yields no usable sessions.
//   * Browsers receive it in an HttpOnly, SameSite=Lax cookie (Secure in
//     production). Page scripts cannot read it, so an injected script cannot
//     exfiltrate it — which is exactly what localStorage allowed.
//   * Programmatic clients may present the same opaque token as
//     `Authorization: Bearer <token>`. That is not a weakening: the token is
//     only ever handed out in response to a request that already carried
//     credentials (login or registration). No authenticated endpoint returns
//     it, so an injected script cannot obtain one.
//   * Sessions expire twice over: an absolute deadline, and an idle timeout
//     measured from last use.
//   * Any request that changes a credential revokes every session for that
//     subject.
//
// CSRF: cookie authentication is ambient, so state-changing requests
// authenticated by cookie must also present a matching X-CSRF-Token header
// (double-submit). Bearer-authenticated requests are not ambient and are
// exempt. See requireCsrf below.

const crypto = require('crypto');
const { query } = require('./database');

const SESSION_COOKIE = 'bp_session';
const CSRF_COOKIE = 'bp_csrf';
const CSRF_HEADER = 'x-csrf-token';

const IS_PROD = process.env.NODE_ENV === 'production';

// Absolute lifetime, and how long a session may sit unused before it dies.
// Admin sessions are shorter because an admin token reaches every customer's
// personal data.
const POLICY = {
  customer: {
    absoluteMs: Number(process.env.CUSTOMER_SESSION_ABSOLUTE_MS || 7 * 24 * 60 * 60 * 1000),
    idleMs: Number(process.env.CUSTOMER_SESSION_IDLE_MS || 48 * 60 * 60 * 1000)
  },
  admin: {
    absoluteMs: Number(process.env.ADMIN_SESSION_ABSOLUTE_MS || 12 * 60 * 60 * 1000),
    idleMs: Number(process.env.ADMIN_SESSION_IDLE_MS || 60 * 60 * 1000)
  }
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashIp(ip) {
  if (!ip) return '';
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '')
    .update(String(ip)).digest('hex').slice(0, 32);
}

// Minimal cookie parsing — avoids a dependency for something this small.
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

async function createSession({ subjectType, subjectId, req }) {
  const policy = POLICY[subjectType];
  if (!policy) throw new Error(`Unknown session subject type: ${subjectType}`);

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + policy.absoluteMs);

  await query(
    `INSERT INTO sessions (token_hash, subject_type, subject_id, expires_at, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      hashToken(token),
      subjectType,
      subjectId,
      expiresAt,
      req ? String(req.get('user-agent') || '').slice(0, 300) : '',
      req ? hashIp(req.ip) : ''
    ]
  );

  return { token, expiresAt, csrfToken: crypto.randomBytes(24).toString('base64url') };
}

/**
 * Resolve a token to a live session, enforcing both expiry rules and moving
 * last_seen_at forward. Returns null for anything absent, revoked, expired or
 * idle-timed-out — the caller must not distinguish between those cases to the
 * client.
 */
async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;

  const { rows } = await query(
    `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)]
  );
  const session = rows[0];
  if (!session) return null;

  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) {
    await revokeSession(token, 'expired');
    return null;
  }

  const policy = POLICY[session.subject_type];
  const idleFor = now - new Date(session.last_seen_at).getTime();
  if (policy && idleFor > policy.idleMs) {
    await revokeSession(token, 'idle_timeout');
    return null;
  }

  // Only write when the timestamp has moved meaningfully, so a burst of
  // requests does not turn every read into a write.
  if (idleFor > 60_000) {
    await query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [session.id]);
  }

  return session;
}

async function revokeSession(token, reason = 'logout') {
  if (!token) return 0;
  const { rowCount } = await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token), reason]
  );
  return rowCount;
}

/**
 * Kill every session for one person. Called on password reset, password change,
 * account deletion and any suspected compromise — the whole point of moving off
 * stateless tokens.
 */
async function revokeAllForSubject(subjectType, subjectId, reason) {
  const { rowCount } = await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $3
     WHERE subject_type = $1 AND subject_id = $2 AND revoked_at IS NULL`,
    [subjectType, subjectId, reason || 'revoked']
  );
  return rowCount;
}

async function listActiveSessions(subjectType, subjectId) {
  const { rows } = await query(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent
     FROM sessions
     WHERE subject_type = $1 AND subject_id = $2
       AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY last_seen_at DESC LIMIT 50`,
    [subjectType, subjectId]
  );
  return rows;
}

// --- Cookies ---------------------------------------------------------------

function setSessionCookies(res, { token, expiresAt, csrfToken }) {
  const maxAge = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    // Lax keeps the session usable when a customer returns from the Stripe
    // Checkout redirect, which a Strict cookie would drop.
    sameSite: 'lax',
    path: '/',
    maxAge
  });
  // Readable by design: the page has to echo it back in a header for the
  // double-submit check. It is not a credential on its own.
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/',
    maxAge
  });
}

function clearSessionCookies(res) {
  const options = { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/' };
  res.clearCookie(SESSION_COOKIE, options);
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}

// --- Request helpers -------------------------------------------------------

// Where did the credential come from? This decides whether CSRF applies.
//
// An explicit Authorization header WINS over the cookie. The cookie is ambient
// — the browser attaches it to every request whether or not the caller intended
// it — while a header is a deliberate choice by the caller. Preferring the
// cookie would mean a client that deliberately presented credential A could be
// silently acted on as credential B, which is a confused-deputy bug and makes
// cross-account behaviour impossible to reason about (or to test).
function credentialFrom(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return { token, source: 'bearer' };
  }
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) {
    return { token: cookies[SESSION_COOKIE], source: 'cookie', csrfCookie: cookies[CSRF_COOKIE] };
  }
  return { token: null, source: null };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check. Only applies to cookie-authenticated,
 * state-changing requests: a Bearer token is not sent automatically by the
 * browser, so it carries no cross-site risk.
 */
function csrfOk(req, credential) {
  if (credential.source !== 'cookie') return true;
  if (SAFE_METHODS.has(req.method)) return true;
  const sent = req.headers[CSRF_HEADER];
  const expected = credential.csrfCookie;
  if (!sent || !expected) return false;
  const a = Buffer.from(String(sent));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  CSRF_COOKIE,
  CSRF_HEADER,
  POLICY,
  SESSION_COOKIE,
  clearSessionCookies,
  createSession,
  credentialFrom,
  csrfOk,
  hashToken,
  listActiveSessions,
  parseCookies,
  resolveSession,
  revokeAllForSubject,
  revokeSession,
  setSessionCookies
};
