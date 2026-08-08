require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { loginAdmin } = require('./server/auth');
const {
  registerCustomer,
  loginCustomer,
  authenticateCustomer,
  createEmailVerificationToken,
  createPasswordResetToken,
  resetPasswordWithToken,
  validatePassword,
  verifyEmailWithToken
} = require('./server/customerAuth');
const mailer = require('./server/email');
const { sendPasswordResetToCustomer } = mailer;
const { init: initDb, query } = require('./server/database');
const sessions = require('./server/sessions');
const metrics = require('./server/metrics');
const assets = require('./server/assets');
const { newNonce } = require('./server/render');
const { launchCheck, formatLaunchReport } = require('./server/businessProfile');
const htmlShell = require('./server/htmlShell');
const { validateAcceptance, recordAcceptance, listAcceptancesForCustomer } = require('./server/policyAcceptance');
const { listPolicies, requiredForPoint } = require('./server/legal');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const TEST_MODE = process.env.TEST_MODE === '1';

// Install the test harness BEFORE feature modules load so email/Stripe
// overrides are in place when routes require('./email') / ('./stripeClient').
// Hard-fail if TEST_MODE leaks into a production deploy: the harness silently
// replaces the email transport with an in-memory log and stubs Stripe, so a
// production process running with TEST_MODE=1 would drop real emails on the
// floor and never charge customers.
if (TEST_MODE) {
  if (IS_PROD) {
    console.error('Refusing to start: TEST_MODE=1 cannot be combined with NODE_ENV=production');
    process.exit(1);
  }
  require('./server/testHarness').install();
}

// Validate required env vars in production; fail fast instead of booting with defaults.
function validateEnv() {
  const problems = [];
  if (!process.env.NEON_DATABASE_URL && !process.env.DATABASE_URL) {
    problems.push('NEON_DATABASE_URL (or DATABASE_URL) must be set');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'benny-pets-default-secret' || process.env.JWT_SECRET === 'change-this-to-a-random-secret-key') {
    problems.push('JWT_SECRET must be set to a strong random value');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'changeme123') {
    problems.push('ADMIN_PASSWORD must be set (not the default)');
  }
  if (!process.env.ADMIN_EMAIL) {
    problems.push('ADMIN_EMAIL must be set');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL must be set (Neon Postgres connection string)');
  }
  if (problems.length) {
    if (IS_PROD) {
      console.error('Refusing to start: insecure configuration');
      for (const p of problems) console.error('  - ' + p);
      process.exit(1);
    } else {
      console.warn('WARNING: insecure configuration (allowed in non-production):');
      for (const p of problems) console.warn('  - ' + p);
    }
  }
}
validateEnv();

// Behind Railway's proxy — required for correct req.protocol, req.ip, and secure cookies.
app.set('trust proxy', 1);

// Disable ETag on app-level responses so JSON API responses never return 304.
// express.static keeps its own ETag handling for cacheable assets.
app.set('etag', false);

// Per-request CSP nonce. The admin and customer portals carry large inline
// <script>/<style> blocks; stamping a nonce into them (see server/htmlShell.js)
// is what lets the policy below run WITHOUT 'unsafe-inline'.
app.use((req, res, next) => {
  res.locals.cspNonce = newNonce();
  next();
});

// Security headers.
//
// CSP was previously disabled outright ("inline scripts would break"), which
// left the app with no defence-in-depth against injected script at all. The
// policy below carries no 'unsafe-inline' and no 'unsafe-eval'.
//
// frame-ancestors 'none' is the frame protection (X-Frame-Options is legacy and
// helmet still emits it alongside). connect-src is same-origin only: the app
// makes no cross-origin XHR. Stripe Checkout is a full-page redirect, not an
// embed, so it needs no frame-src or script-src entry.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'script-src': ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      'style-src': ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      'font-src': ["'self'", 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'manifest-src': ["'self'"],
      'upgrade-insecure-requests': IS_PROD ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: IS_PROD ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false
}));

// Permissions-Policy: switch off browser features this app never uses, so an
// injected script cannot silently reach for a camera, microphone or location.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), ' +
    'fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), ' +
    'midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()');
  next();
});

app.use(metrics.requestMetrics);
app.use(compression());

// CORS whitelist. FRONTEND_ORIGIN is a comma-separated list of allowed origins.
// Browsers send an Origin header on every non-GET fetch (including same-origin
// POSTs like the admin login form), so "no Origin header" alone isn't enough
// to identify a same-origin call — we also accept any Origin matching the
// request's own scheme+host. Cross-origin requests in production are rejected
// unless their origin is in the whitelist; we never fall through to allow-all
// while credentials: true is set.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function originAllowed(req) {
  const origin = req.header('Origin');
  if (!origin) return true;
  if (origin === `${req.protocol}://${req.get('host')}`) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Outside production, an empty allowlist means "developer machine" — accept
  // anything so a local frontend on another port can work. In production an
  // empty allowlist means same-origin only.
  return allowedOrigins.length === 0 && !IS_PROD;
}

app.use(cors((req, cb) => {
  // Never signal an allowlist decision by throwing: the thrown error reached
  // the generic error handler and the browser got an opaque 500, which is
  // indistinguishable from the server being broken. Reflect no CORS headers
  // instead and let the explicit 403 below answer the request.
  if (!originAllowed(req)) return cb(null, { origin: false });
  cb(null, { origin: true, credentials: true });
}));

// Explicit, machine-readable CORS denial. A disallowed cross-origin request
// gets a 403 with a clear reason rather than a 500 or a silent hang.
app.use((req, res, next) => {
  if (originAllowed(req)) return next();
  if (req.method === 'OPTIONS') return res.status(403).end();
  return res.status(403).json({
    error: 'cors_origin_not_allowed',
    message: 'This origin is not permitted to call the API.'
  });
});

// Webhooks need the raw body for signature verification, so they must be
// mounted BEFORE express.json() consumes the stream.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use('/api/sendgrid/events', express.raw({ type: 'application/json' }), require('./server/routes/sendgridEvents').router);
app.use(express.json({ limit: '1mb' }));
// body-parser 2.x (bundled with Express 5) leaves req.body undefined when the
// incoming request has no JSON body — empty body, missing/wrong Content-Type,
// browser preflights, health probes. Route handlers that destructure req.body
// then crash with "Cannot destructure property '...' of 'req.body' as it is
// undefined" and surface as a 500. Restore the previous default of an empty
// object so each handler's own field validation runs and returns a clean 400.
app.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});

// Block probes for dotfiles and other sensitive root paths. These are never
// served anyway (no root static middleware exists), but logging them makes
// automated scan activity visible in production logs.
const PROBE_PATH_RE = /^\/(?:\.[\w]|package(?:-lock)?\.json$|node_modules(?:\/|$)|Procfile$|railway\.json$)/i;
app.use((req, res, next) => {
  if (PROBE_PATH_RE.test(req.path)) {
    console.warn('[probe]', req.ip, req.method, req.path);
    return res.status(404).end();
  }
  next();
});

// Metrics, in Prometheus text format.
//
// Guarded by a bearer token rather than left open: the counters expose traffic
// shape and error rates, which is reconnaissance for anyone probing. When
// METRICS_TOKEN is unset the endpoint is available only from a loopback
// address, so a local Prometheus works out of the box while a public scrape
// does not.
app.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (provided !== token) return res.status(401).type('text/plain').send('unauthorized\n');
  } else {
    const ip = req.ip || '';
    const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!local) return res.status(404).end();
  }
  res.type('text/plain; version=0.0.4').send(metrics.render());
});

// Readiness: is this process able to serve traffic right now? Distinct from
// liveness — a process that is up but cannot reach its database should be taken
// out of rotation, not restarted.
app.get('/readyz', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, reason: 'database_unreachable' });
  }
});

// Health check — hits the database to confirm it's reachable.
app.get('/healthz', async (req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Content-hashed assets first: /css/style.<hash>.css and /js/main.<hash>.js are
// immutable for a year. The unhashed paths remain available for anything not
// yet migrated, with a short max-age.
app.use(assets.middleware);
app.use('/css', express.static(path.join(__dirname, 'css'), { maxAge: IS_PROD ? '1h' : 0 }));
app.use('/js', express.static(path.join(__dirname, 'js'), { maxAge: IS_PROD ? '1h' : 0 }));
app.use('/images', express.static(path.join(__dirname, 'images'), {
  maxAge: IS_PROD ? '30d' : 0,
  immutable: IS_PROD
}));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: IS_PROD ? '30d' : 0 }));

// Server-rendered public pages (homepage, /services/:slug, /legal/*,
// robots.txt, sitemap.xml, site.webmanifest).
app.use('/', require('./server/routes/pages'));

// Account portals. Served through htmlShell so their inline scripts receive
// this request's CSP nonce.
app.get('/admin', htmlShell.serve(path.join(__dirname, 'admin.html')));
app.get('/my-bookings', htmlShell.serve(path.join(__dirname, 'customer.html')));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' }
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again in an hour.' }
});
const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many subscribe attempts. Try again in an hour.' }
});
const passwordResetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Try again in an hour.' }
});
const publicBookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many booking requests. Try again in an hour.' }
});
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many enquiries. Please try again in an hour, or email us directly.' }
});
const reviewSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many review submissions. Try again in an hour.' }
});
app.locals.limiters = { authLimiter, registerLimiter, subscribeLimiter, passwordResetRequestLimiter, publicBookingLimiter, reviewSubmitLimiter, inquiryLimiter };

// Admin auth
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const result = await loginAdmin(email, password);
    if (!result) {
      metrics.increment('benny_auth_failures_total', { kind: 'admin_login' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // A fresh session per sign-in — never reuse or extend an existing one.
    const session = await sessions.createSession({
      subjectType: 'admin', subjectId: result.adminId, req
    });
    sessions.setSessionCookies(res, session);

    // The opaque token is returned so programmatic clients can use Bearer auth.
    // Browsers ignore it and rely on the HttpOnly cookie; no AUTHENTICATED
    // endpoint ever discloses a token, so an injected script cannot obtain one.
    res.json({ token: session.token, csrf_token: session.csrfToken, admin: result.admin });
  } catch (err) {
    next(err);
  }
});

// Admin: end this session. Idempotent — signing out twice is not an error.
app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const credential = sessions.credentialFrom(req);
    if (credential.token) await sessions.revokeSession(credential.token, 'logout');
    sessions.clearSessionCookies(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Customer auth
// Registration.
//
// The response is IDENTICAL whether or not the address is already registered:
// same status, same body, no session either way. It previously answered
// 409 "An account with this email already exists", which let anyone test an
// address list against the site and learn who is a customer.
//
// The person who owns the address is told by email that someone tried to sign
// up with it. The person who submitted the form learns nothing.
app.post('/api/customer/register', registerLimiter, async (req, res, next) => {
  try {
    const { name, email, password, phone, dog_name, accept_policies, marketing_consent } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    // Contractual acceptance is required and must be explicit — an absent field
    // is a refusal, never a default. Marketing consent is a SEPARATE, optional
    // flag and is never inferred from accepting the terms.
    const acceptanceErrors = validateAcceptance('registration', accept_policies);
    if (acceptanceErrors.length) {
      return res.status(400).json({
        error: acceptanceErrors.join('; '),
        required_policies: requiredForPoint('registration')
      });
    }

    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const result = await registerCustomer(name, email, password, phone, dog_name);

    if (result.created) {
      await recordAcceptance({
        customerId: result.customer.id,
        email: result.customer.email,
        point: 'registration',
        accepted: accept_policies,
        req
      });

      if (marketing_consent === true) {
        await query(
          `INSERT INTO subscribers (email, source, consent_at, consent_source)
           VALUES ($1, $2, NOW(), $2)
           ON CONFLICT (LOWER(email)) DO UPDATE
             SET unsubscribed_at = NULL, consent_at = NOW(),
                 consent_source = EXCLUDED.consent_source`,
          [result.customer.email, 'registration']
        ).catch(err => console.error('[register] marketing opt-in failed', err.message));
      }

      await mailer.sendEmailVerificationToCustomer({
        to: result.customer.email,
        name: result.customer.name,
        verifyLink: `${base}/my-bookings?verify=${encodeURIComponent(result.verificationToken)}`
      }).catch(err => console.error('[register] verification email failed', err.message));
    } else {
      // The address already has an account. Tell its OWNER, and nobody else.
      await mailer.sendRegistrationAttemptToExistingCustomer({
        to: result.existingCustomer.email,
        name: result.existingCustomer.name,
        signInLink: `${base}/my-bookings`,
        resetLink: `${base}/my-bookings?forgot=1`
      }).catch(err => console.error('[register] duplicate-registration notice failed', err.message));
    }

    // 202 with no session, in both branches. The client tells the person to
    // sign in — which succeeds for a new account and fails generically for
    // someone guessing at an existing one.
    res.status(202).json({
      message: 'Check your email. If the address is new, your account is ready — sign in to continue.',
      next_step: 'sign_in'
    });
  } catch (err) {
    next(err);
  }
});

// Confirm an email address from the emailed link.
app.post('/api/customer/verify-email', authLimiter, async (req, res, next) => {
  try {
    const result = await verifyEmailWithToken(req.body?.token);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, email: result.customer.email });
  } catch (err) {
    next(err);
  }
});

// Re-send the confirmation link to the signed-in customer.
app.post('/api/customer/resend-verification', authenticateCustomer, passwordResetRequestLimiter,
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'SELECT id, name, email, email_verified_at FROM customers WHERE id = $1',
        [req.customer.id]
      );
      const customer = rows[0];
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      if (customer.email_verified_at) {
        return res.json({ ok: true, already_verified: true });
      }

      const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const { token } = await createEmailVerificationToken(customer.id);
      await mailer.sendEmailVerificationToCustomer({
        to: customer.email,
        name: customer.name,
        verifyLink: `${base}/my-bookings?verify=${encodeURIComponent(token)}`
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

app.post('/api/customer/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const result = await loginCustomer(email, password);
    if (!result) {
      metrics.increment('benny_auth_failures_total', { kind: 'customer_login' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (result.unverified) {
      return res.status(403).json({
        error: 'Please confirm your email address first. Check your inbox for the link we sent.',
        email_verification_required: true
      });
    }

    const session = await sessions.createSession({
      subjectType: 'customer', subjectId: result.customerId, req
    });
    sessions.setSessionCookies(res, session);
    res.json({ token: session.token, csrf_token: session.csrfToken, customer: result.customer });
  } catch (err) {
    next(err);
  }
});

// Customer: end this session.
app.post('/api/customer/logout', async (req, res, next) => {
  try {
    const credential = sessions.credentialFrom(req);
    if (credential.token) await sessions.revokeSession(credential.token, 'logout');
    sessions.clearSessionCookies(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Customer: see where they are signed in, and sign every other device out.
app.get('/api/customer/sessions', authenticateCustomer, async (req, res, next) => {
  try {
    const active = await sessions.listActiveSessions('customer', req.customer.id);
    res.json(active.map(s => ({
      id: s.id,
      current: s.id === req.session.id,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      expires_at: s.expires_at,
      user_agent: s.user_agent
    })));
  } catch (err) {
    next(err);
  }
});

app.post('/api/customer/sessions/revoke-others', authenticateCustomer, async (req, res, next) => {
  try {
    await sessions.revokeAllForSubject('customer', req.customer.id, 'revoke_others');
    // Re-issue for the caller so the action does not sign them out too.
    const session = await sessions.createSession({
      subjectType: 'customer', subjectId: req.customer.id, req
    });
    sessions.setSessionCookies(res, session);
    res.json({ ok: true, token: session.token, csrf_token: session.csrfToken });
  } catch (err) {
    next(err);
  }
});

// Password reset — always responds 200 so we never reveal whether an email is
// registered. The reset link (when one is issued) is sent out-of-band via email.
app.post('/api/customer/forgot-password', passwordResetRequestLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await createPasswordResetToken(email);
    if (result) {
      const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const resetLink = `${base}/my-bookings?reset=${encodeURIComponent(result.token)}`;
      await sendPasswordResetToCustomer({
        to: result.customer.email,
        name: result.customer.name,
        resetLink
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/customer/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    const result = await resetPasswordWithToken(token, password);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    // Surfaced so the customer can see that other devices were signed out —
    // and so the test suite can prove it happened.
    res.json({ ok: true, sessions_revoked: result.sessions_revoked || 0 });
  } catch (err) {
    next(err);
  }
});

app.get('/api/customer/profile', authenticateCustomer, async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, email, phone, dog_name, created_at FROM customers WHERE id = $1',
    [req.customer.id]
  );
  const customer = rows[0];
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  const { rows: dogs } = await query(
    'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
    [req.customer.id]
  );
  res.json({ ...customer, dogs });
});

// Feature routers
app.use('/api/services', require('./server/routes/services'));
app.use('/api/photos', require('./server/routes/photos'));
// Rate-limit only the public booking-creation endpoint; admin and
// authenticated customer routes on the same router stay unlimited.
app.post('/api/bookings', publicBookingLimiter, (req, res, next) => next('route'));
app.use('/api/bookings', require('./server/routes/bookings'));
app.use('/api/payments', require('./server/routes/payments'));
app.use('/api/dogs', require('./server/routes/dogs'));
app.use('/api/subscribe', subscribeLimiter, require('./server/routes/subscribers'));
// Rate-limit only the public review submission; the public GET and admin
// moderation routes on the same router stay unlimited.
app.post('/api/reviews', reviewSubmitLimiter, (req, res, next) => next('route'));
app.use('/api/reviews', require('./server/routes/reviews'));
app.post('/api/inquiries', inquiryLimiter, (req, res, next) => next('route'));
app.use('/api/inquiries', require('./server/routes/inquiries'));
app.use('/api/campaigns', require('./server/routes/campaigns'));
app.use('/api/customer/account', require('./server/routes/account'));
app.use('/api/settings', require('./server/routes/settings'));

// Public: the policy catalogue and which policies must be accepted where. The
// customer portal renders its consent checkboxes from this, so the client can
// never drift from what the server actually enforces.
app.get('/api/legal/policies', (req, res) => {
  res.json({
    policies: listPolicies().map(p => ({
      slug: p.slug, title: p.title, version: p.version,
      effective: p.effective, summary: p.summary, draft: !!p.draft,
      acceptance: p.acceptance, url: `/legal/${p.slug}`
    })),
    acceptance_points: {
      registration: requiredForPoint('registration'),
      booking: requiredForPoint('booking')
    }
  });
});

// Authenticated customer: what they have accepted, and when.
app.get('/api/legal/my-acceptances', authenticateCustomer, async (req, res, next) => {
  try {
    res.json(await listAcceptancesForCustomer(req.customer.id));
  } catch (err) {
    next(err);
  }
});

if (TEST_MODE) {
  app.use('/api/__test__', require('./server/testHarness').buildRouter());
}

// Dashboard stats for admin
const { authenticateToken, requirePermission } = require('./server/auth');

// Admin: Clients directory — aggregates registered customers AND guest
// bookers (by email) with their dogs, bookings, and per-client totals,
// plus business-wide KPIs in a single payload so the client panel can
// render without a second round-trip.
app.get('/api/admin/clients', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    // Bounded. This endpoint loaded EVERY customer, dog, document and booking
    // into memory and aggregated there — fine at hundreds of clients, a latency
    // cliff at tens of thousands. The cap is generous enough that the panel is
    // unchanged for any realistic present-day dataset, and `truncated` tells the
    // caller when it has been hit rather than silently showing a partial list.
    const MAX_ROWS = Math.min(5000, Math.max(50, Number(req.query.limit) || 2000));

    const [customersRes, dogsRes, documentsRes, bookingsRes] = await Promise.all([
      query('SELECT id, name, email, phone, created_at FROM customers ORDER BY created_at DESC LIMIT $1', [MAX_ROWS]),
      query('SELECT id, customer_id, name, breed, weight, age, notes, created_at FROM dogs LIMIT $1', [MAX_ROWS * 3]),
      query(`SELECT id, dog_id, original_name,
                    COALESCE(NULLIF(detected_mime, ''), mime_type) AS mime_type,
                    size_bytes, scan_status, uploaded_at
             FROM dog_documents ORDER BY uploaded_at DESC LIMIT $1`, [MAX_ROWS * 3]),
      query(`SELECT id, owner_name, email, phone, dog_name, service_name, preferred_dates,
                    status, payment_status, amount_cents, customer_id, start_date, end_date,
                    dog_count, created_at
             FROM bookings WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT $1`, [MAX_ROWS * 5])
    ]);

    const customers = customersRes.rows;
    const dogs = dogsRes.rows;
    const documents = documentsRes.rows;
    const documentsByDogId = new Map();
    for (const doc of documents) {
      if (!documentsByDogId.has(doc.dog_id)) documentsByDogId.set(doc.dog_id, []);
      documentsByDogId.get(doc.dog_id).push(doc);
    }
    const bookings = bookingsRes.rows;

    const customersById = new Map(customers.map(c => [c.id, c]));
    const clientsByEmail = new Map();

    function getOrCreateClient(emailRaw, fallback) {
      const key = (emailRaw || '').toLowerCase().trim();
      if (!key) return null;
      let client = clientsByEmail.get(key);
      if (!client) {
        client = {
          customer_id: null,
          name: fallback.name || emailRaw,
          email: fallback.email || emailRaw,
          phone: fallback.phone || '',
          registered_at: null,
          type: 'guest',
          dogs: [],
          bookings: [],
          first_seen: fallback.created_at || null,
          last_seen: fallback.created_at || null
        };
        clientsByEmail.set(key, client);
      }
      return client;
    }

    for (const c of customers) {
      const client = getOrCreateClient(c.email, { name: c.name, email: c.email, phone: c.phone, created_at: c.created_at });
      if (!client) continue;
      client.customer_id = c.id;
      client.name = c.name;
      client.email = c.email;
      client.phone = c.phone || client.phone;
      client.registered_at = c.created_at;
      client.type = 'registered';
      client.first_seen = c.created_at;
      client.last_seen = c.created_at;
    }

    for (const d of dogs) {
      const customer = customersById.get(d.customer_id);
      if (!customer) continue;
      const client = clientsByEmail.get((customer.email || '').toLowerCase().trim());
      if (!client) continue;
      const dogNameLower = (d.name || '').toLowerCase().trim();
      if (!dogNameLower) continue;
      // Same client can't own two dogs with the same name — collapse duplicate
      // rows (older imports + new profile entries) into a single dog.
      if (client.dogs.some(x => x.name.toLowerCase().trim() === dogNameLower)) continue;
      client.dogs.push({
        id: d.id,
        name: d.name,
        breed: d.breed || '',
        weight: d.weight || '',
        age: d.age || '',
        notes: d.notes || '',
        documents: documentsByDogId.get(d.id) || [],
        created_at: d.created_at,
        source: 'profile'
      });
    }

    for (const b of bookings) {
      const client = getOrCreateClient(b.email, {
        name: b.owner_name, email: b.email, phone: b.phone, created_at: b.created_at
      });
      if (!client) continue;

      if (!client.phone && b.phone) client.phone = b.phone;
      if (!client.first_seen || new Date(b.created_at) < new Date(client.first_seen)) {
        client.first_seen = b.created_at;
      }
      if (!client.last_seen || new Date(b.created_at) > new Date(client.last_seen)) {
        client.last_seen = b.created_at;
      }

      client.bookings.push({
        id: b.id,
        dog_name: b.dog_name,
        dog_count: Number(b.dog_count) || 1,
        service_name: b.service_name,
        preferred_dates: b.preferred_dates || '',
        start_date: b.start_date,
        end_date: b.end_date,
        status: b.status,
        payment_status: b.payment_status,
        amount_cents: Number(b.amount_cents) || 0,
        created_at: b.created_at
      });

      // Surface dogs that appear only in bookings (guests, or registered
      // customers who haven't added a profile for that pup yet).
      const dogNameLower = (b.dog_name || '').toLowerCase().trim();
      if (dogNameLower && !client.dogs.some(d => d.name.toLowerCase().trim() === dogNameLower)) {
        client.dogs.push({
          id: null,
          name: b.dog_name,
          breed: '',
          weight: '',
          age: '',
          notes: '',
          documents: [],
          created_at: b.created_at,
          source: 'booking'
        });
      }
    }

    const clients = Array.from(clientsByEmail.values()).map(client => {
      const paid = client.bookings.filter(b => b.payment_status === 'paid');
      const pending = client.bookings.filter(b => b.status !== 'cancelled' && b.payment_status !== 'paid');
      const total_spent_cents = paid.reduce((s, b) => s + b.amount_cents, 0);
      const pending_revenue_cents = pending.reduce((s, b) => s + b.amount_cents, 0);
      return {
        ...client,
        total_bookings: client.bookings.length,
        completed_bookings: client.bookings.filter(b => b.status === 'completed').length,
        pending_bookings: client.bookings.filter(b => b.status === 'pending').length,
        confirmed_bookings: client.bookings.filter(b => b.status === 'confirmed').length,
        total_dogs: client.dogs.length,
        total_spent_cents,
        pending_revenue_cents
      };
    });

    const totalRevenue = clients.reduce((s, c) => s + c.total_spent_cents, 0);
    const pendingRevenue = clients.reduce((s, c) => s + c.pending_revenue_cents, 0);
    const totalBookings = bookings.length;
    const totalClients = clients.length;

    // Count distinct dogs system-wide. Two different clients may each have a
    // pup named "Max" — those are two unique dogs. Same name within one
    // client (profile + booking, or duplicate rows) collapses to one.
    const uniqueDogKeys = new Set();
    for (const c of clients) {
      const emailKey = (c.email || '').toLowerCase().trim();
      for (const d of c.dogs) {
        const nameKey = (d.name || '').toLowerCase().trim();
        if (nameKey) uniqueDogKeys.add(`${emailKey}|${nameKey}`);
      }
    }
    const totalDogs = uniqueDogKeys.size;
    const registeredClients = clients.filter(c => c.type === 'registered').length;
    const guestClients = clients.filter(c => c.type === 'guest').length;
    const avgRevenuePerClient = totalClients ? Math.round(totalRevenue / totalClients) : 0;
    const avgBookingsPerClient = totalClients ? Math.round((totalBookings / totalClients) * 10) / 10 : 0;
    const avgDogsPerClient = totalClients ? Math.round((totalDogs / totalClients) * 10) / 10 : 0;

    const topSpender = clients.reduce(
      (top, c) => c.total_spent_cents > (top?.total_spent_cents || 0) ? c : top, null);
    const mostLoyal = clients.reduce(
      (top, c) => c.total_bookings > (top?.total_bookings || 0) ? c : top, null);

    clients.sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0));

    res.json({
      clients,
      truncated: customers.length >= MAX_ROWS,
      limit: MAX_ROWS,
      kpis: {
        total_revenue_cents: totalRevenue,
        pending_revenue_cents: pendingRevenue,
        total_bookings: totalBookings,
        total_clients: totalClients,
        total_dogs: totalDogs,
        registered_clients: registeredClients,
        guest_clients: guestClients,
        avg_revenue_per_client_cents: avgRevenuePerClient,
        avg_bookings_per_client: avgBookingsPerClient,
        avg_dogs_per_client: avgDogsPerClient,
        top_spender: topSpender && topSpender.total_spent_cents > 0
          ? { name: topSpender.name, email: topSpender.email,
              total_spent_cents: topSpender.total_spent_cents }
          : null,
        most_loyal: mostLoyal && mostLoyal.total_bookings > 0
          ? { name: mostLoyal.name, email: mostLoyal.email,
              total_bookings: mostLoyal.total_bookings }
          : null
      }
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/dashboard/stats', authenticateToken, requirePermission('read'), async (req, res) => {
  const [
    totalBookings, pendingBookings, confirmedBookings,
    totalPhotos, activeServices, paidBookings, totalRevenue, recentBookings
  ] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM bookings'),
    query("SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'pending'"),
    query("SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'confirmed'"),
    query('SELECT COUNT(*)::int AS count FROM photos'),
    query('SELECT COUNT(*)::int AS count FROM services WHERE active = TRUE'),
    query("SELECT COUNT(*)::int AS count FROM bookings WHERE payment_status = 'paid'"),
    query("SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM bookings WHERE payment_status = 'paid'"),
    query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 5')
  ]);

  res.json({
    totalBookings: totalBookings.rows[0].count,
    pendingBookings: pendingBookings.rows[0].count,
    confirmedBookings: confirmedBookings.rows[0].count,
    totalPhotos: totalPhotos.rows[0].count,
    activeServices: activeServices.rows[0].count,
    paidBookings: paidBookings.rows[0].count,
    totalRevenue: Number(totalRevenue.rows[0].total),
    recentBookings: recentBookings.rows
  });
});

// 404 for unmatched API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Catch-all 404 for any other unmatched route
app.use((req, res) => res.status(404).end());

// Central error handler — avoid leaking internals in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  metrics.increment('benny_unhandled_errors_total', {});
  const status = err.status || 500;
  const message = IS_PROD && status === 500 ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

async function bootstrap() {
  await initDb();

  // If R2 is configured, probe the bucket once at startup. A misconfigured
  // token or bucket name is the most common reason uploaded homepage photos
  // (Hero / "Meet Ben & The Pack" / Gallery) don't appear — without this
  // probe the failure is silent until someone notices a broken image.
  const r2 = require('./server/r2');
  if (r2.isConfigured()) {
    const probe = await r2.checkBucket();
    if (probe.ok) {
      console.log(`[r2] startup probe OK — bucket "${probe.bucket}" reachable`);
    } else {
      const status = probe.httpStatus ? ` HTTP ${probe.httpStatus}` : '';
      console.warn(
        `[r2] startup probe FAILED — bucket "${probe.bucket}" not reachable ` +
        `(${probe.errorName || 'Unknown'}${status}: ${probe.message}). ` +
        `Homepage photos uploaded to this app will not load. ` +
        `Check R2_BUCKET_NAME and that the R2 API token has Object Read & Write permission.`
      );
    }
  }

  // Report missing business/legal configuration loudly at boot. Public
  // components that would have rendered an unconfigured fact hide themselves,
  // so the site stays truthful, but an administrator needs to see WHY. The
  // deploy-blocking version of this check is `npm run check:launch`.
  try {
    const result = await launchCheck();
    if (result.ok) {
      console.log('[launch-check]', formatLaunchReport(result));
    } else {
      console.error('[launch-check] ' + formatLaunchReport(result).split('\n').join('\n[launch-check] '));
    }
  } catch (err) {
    console.error('[launch-check] could not run:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Benny and the Pets server listening on :${PORT} (${NODE_ENV})`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
