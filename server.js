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
  createPasswordResetToken,
  resetPasswordWithToken,
  validatePassword
} = require('./server/customerAuth');
const { sendPasswordResetToCustomer } = require('./server/email');
const { init: initDb, query } = require('./server/database');

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

// Security headers. CSP is disabled because admin.html/customer.html use extensive
// inline scripts/styles that a strict CSP would break. HSTS is only enabled in
// production — sending it from a local dev server would lock browsers into
// http→https upgrades that fail when developers come back to plain http.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false
}));

app.use(compression());

// CORS whitelist. FRONTEND_ORIGIN is a comma-separated list of allowed origins.
// Same-origin requests (no Origin header) are always allowed because the app
// also serves its own HTML. Cross-origin requests in production are rejected
// unless their origin is in the whitelist — never fall through to allow-all
// while credentials: true is set.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (allowedOrigins.length === 0 && !IS_PROD) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Stripe webhook needs the raw body for signature verification, so it must be
// mounted BEFORE express.json() consumes the stream.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// Health check — hits the database to confirm it's reachable.
app.get('/healthz', async (req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Static assets — explicit directories only, to avoid exposing server.js, package.json, .env, etc.
app.use('/css', express.static(path.join(__dirname, 'css'), { maxAge: IS_PROD ? '7d' : 0 }));
app.use('/js', express.static(path.join(__dirname, 'js'), { maxAge: IS_PROD ? '7d' : 0 }));
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: IS_PROD ? '30d' : 0 }));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: IS_PROD ? '30d' : 0 }));

// HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/my-bookings', (req, res) => res.sendFile(path.join(__dirname, 'customer.html')));

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
// /api/bookings/lookup returns full PII (phone, dog name, dates, free-text
// message) for any matching email. Without a limiter, anyone can enumerate
// customer addresses by submitting candidate emails and observing whether the
// response array is empty.
const bookingLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookup attempts. Try again in an hour.' }
});
app.locals.limiters = { authLimiter, registerLimiter, subscribeLimiter, passwordResetRequestLimiter, publicBookingLimiter, bookingLookupLimiter };

// Admin auth
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const result = await loginAdmin(email, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json(result);
});

// Customer auth
app.post('/api/customer/register', registerLimiter, async (req, res) => {
  const { name, email, password, phone, dog_name } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }
  const result = await registerCustomer(name, email, password, phone, dog_name);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }
  res.status(201).json(result);
});

app.post('/api/customer/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const result = await loginCustomer(email, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json(result);
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
    res.json({ ok: true });
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
// Rate-limit only the public booking-creation and lookup endpoints; admin and
// authenticated customer routes on the same router stay unlimited.
app.post('/api/bookings', publicBookingLimiter, (req, res, next) => next('route'));
app.post('/api/bookings/lookup', bookingLookupLimiter, (req, res, next) => next('route'));
app.use('/api/bookings', require('./server/routes/bookings'));
app.use('/api/payments', require('./server/routes/payments'));
app.use('/api/dogs', require('./server/routes/dogs'));
app.use('/api/subscribe', subscribeLimiter, require('./server/routes/subscribers'));
app.use('/api/campaigns', require('./server/routes/campaigns'));
app.use('/api/settings', require('./server/routes/settings'));

if (TEST_MODE) {
  app.use('/api/__test__', require('./server/testHarness').buildRouter());
}

// Dashboard stats for admin
const { authenticateToken, requirePermission } = require('./server/auth');
app.get('/api/dashboard/stats', authenticateToken, requirePermission('read'), async (req, res) => {
  const [
    totalBookings, pendingBookings, confirmedBookings,
    totalPhotos, activeServices, paidBookings, totalRevenue, recentBookings
  ] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM bookings'),
    query("SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'pending'"),
    query("SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'confirmed'"),
    query('SELECT COUNT(*)::int AS count FROM photos'),
    query('SELECT COUNT(*)::int AS count FROM services WHERE active = 1'),
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

// Central error handler — avoid leaking internals in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  const status = err.status || 500;
  const message = IS_PROD && status === 500 ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

async function bootstrap() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Benny and the Pets server listening on :${PORT} (${NODE_ENV})`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
