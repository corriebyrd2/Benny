require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { loginAdmin } = require('./server/auth');
const { registerCustomer, loginCustomer, authenticateCustomer } = require('./server/customerAuth');
const { query, runMigrations, seed } = require('./server/database');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Validate required env vars in production; fail fast instead of booting with defaults.
function validateEnv() {
  const problems = [];
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

// Security headers. CSP is disabled because admin.html/customer.html use extensive
// inline scripts/styles that a strict CSP would break.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(compression());

// CORS whitelist. FRONTEND_ORIGIN is a comma-separated list of allowed origins
// (e.g. https://bennyandthepets.com,https://www.bennyandthepets.com).
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (allowedOrigins.length === 0) return cb(null, true); // unset → allow all (dev)
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Stripe webhook needs the raw body for signature verification, so it must be
// mounted BEFORE express.json() consumes the stream.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// Health check for Railway
app.get('/healthz', (req, res) => res.json({ ok: true }));

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

// Rate limiters for auth endpoints
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

// Admin auth
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const result = await loginAdmin(email, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// Customer auth
app.post('/api/customer/register', registerLimiter, async (req, res, next) => {
  try {
    const { name, email, password, phone, dog_name } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const result = await registerCustomer(name, email, password, phone, dog_name);
    if (result.error) {
      return res.status(409).json({ error: result.error });
    }
    res.status(201).json(result);
  } catch (err) { next(err); }
});

app.post('/api/customer/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const result = await loginCustomer(email, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json(result);
  } catch (err) { next(err); }
});

app.get('/api/customer/profile', authenticateCustomer, async (req, res, next) => {
  try {
    const [{ rows: customerRows }, { rows: dogs }] = await Promise.all([
      query(
        'SELECT id, name, email, phone, dog_name, created_at FROM customers WHERE id = $1',
        [req.customer.id]
      ),
      query(
        'SELECT * FROM dogs WHERE customer_id = $1 ORDER BY created_at ASC',
        [req.customer.id]
      )
    ]);
    if (customerRows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json({ ...customerRows[0], dogs });
  } catch (err) { next(err); }
});

// Feature routers
app.use('/api/services', require('./server/routes/services'));
app.use('/api/photos', require('./server/routes/photos'));
app.use('/api/bookings', require('./server/routes/bookings'));
app.use('/api/payments', require('./server/routes/payments'));
app.use('/api/dogs', require('./server/routes/dogs'));

// Dashboard stats for admin
const { authenticateToken, requirePermission } = require('./server/auth');
app.get('/api/dashboard/stats', authenticateToken, requirePermission('read'), async (req, res, next) => {
  try {
    const [bookingStats, photoCount, serviceCount, recentBookings] = await Promise.all([
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
          COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
          COALESCE(SUM(amount_cents) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS revenue
        FROM bookings
      `),
      query('SELECT COUNT(*)::int AS count FROM photos'),
      query('SELECT COUNT(*)::int AS count FROM services WHERE active'),
      query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 5')
    ]);

    const b = bookingStats.rows[0];
    res.json({
      totalBookings: b.total,
      pendingBookings: b.pending,
      confirmedBookings: b.confirmed,
      totalPhotos: photoCount.rows[0].count,
      activeServices: serviceCount.rows[0].count,
      paidBookings: b.paid,
      totalRevenue: Number(b.revenue),
      recentBookings: recentBookings.rows
    });
  } catch (err) { next(err); }
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

async function start() {
  await runMigrations();
  await seed();
  app.listen(PORT, () => {
    console.log(`Benny and the Pets server listening on :${PORT} (${NODE_ENV})`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
