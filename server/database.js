const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const rawConnectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!rawConnectionString) {
  throw new Error('NEON_DATABASE_URL (or DATABASE_URL) is required');
}
// pg parses `sslmode` out of the URL and that parse wins over the explicit
// `ssl` pool option, so a URL carrying sslmode=disable would still negotiate
// TLS. Strip the parameter and let resolveSsl() below be the single authority.
const SSLMODE_RE = /([?&])sslmode=([^&]*)(&|$)/i;
const urlSslMode = (rawConnectionString.match(SSLMODE_RE)?.[2] || '').toLowerCase();
const connectionString = rawConnectionString
  .replace(SSLMODE_RE, (_m, lead, _v, trail) => (lead === '?' && trail === '&' ? '?' : (trail === '&' ? lead : '')))
  .replace(/\?$/, '');

// TLS mode. Managed Postgres (Neon) terminates TLS at a proxy whose chain the
// default CA bundle may not verify, so the hosted default stays
// rejectUnauthorized:false. A local/CI Postgres speaking plain TCP must be able
// to turn TLS off entirely — otherwise the driver negotiates SSL against a
// server that doesn't offer it and every query fails. `sslmode=disable` in the
// connection string, or DATABASE_SSL=disable, selects that.
function resolveSsl() {
  const mode = (process.env.DATABASE_SSL || urlSslMode || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: resolveSsl(),
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Bound how long a single statement may hold a pooled connection. Without
  // this a pathological query pins a connection until the client disconnects.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000)
});

pool.on('error', (err) => {
  console.error('[pg pool error]', err);
});

function query(text, params) {
  return pool.query(text, params);
}

function getClient() {
  return pool.connect();
}

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Reconcile deployments whose schema was created before schema_migrations
  // tracking existed (e.g. via the legacy 001_initial.sql bootstrap). If a
  // migration's characteristic table is already present, mark it applied.
  const preExisting = [
    { migration: '0001_init.sql', table: 'admins' },
    { migration: '001_initial.sql', table: 'admins' },
    { migration: '0002_settings.sql', table: 'settings' },
    { migration: '0002_subscribers.sql', table: 'subscribers' }
  ];
  for (const { migration, table } of preExisting) {
    const { rows } = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [table]
    );
    if (rows.length) {
      await pool.query(
        'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [migration]
      );
    }
  }

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migration] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

async function seed() {
  const { rows: adminRows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (adminRows[0].count === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, $3)',
      [process.env.ADMIN_EMAIL, hash, 'admin']
    );
    console.log('[seed] created initial admin');
  }

  // Site settings.
  //
  // Only values that are TRUE FOR THIS BUSINESS are seeded. Contact details,
  // address, hours, phone and email are deliberately absent: there is no
  // correct default for them, and the previous placeholder seeds
  // ("123 Pawsome Lane", "(555) BENNY-PET", "woof@bennyandthepets.com") were
  // published to visitors and search engines as if they were real. Missing
  // values hide their component and block launch — see server/businessProfile.js.
  //
  // The Facebook URL is the one externally verifiable profile that already
  // shipped and resolves; Instagram/TikTok stay empty until the owner supplies
  // real profile URLs, and their footer links are not rendered while empty.
  const defaultSettings = {
    business_name: 'Benny and the Pets',
    footer_tagline: 'Where tails never stop wagging and every pup is family.',
    facebook_url: 'https://www.facebook.com/profile.php?id=61563336148397'
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await pool.query(
      'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  const { rows: serviceRows } = await pool.query('SELECT COUNT(*)::int AS count FROM services');
  if (serviceRows[0].count === 0) {
    // The catalog is the single source of truth for BOTH marketing cards and
    // the booking form (see server/routes/services.js). Only the two services
    // the business actually delivers today are seeded active; grooming and
    // training are seeded inactive because their rates, and the "certified
    // trainers" credential claim, are unverified owner facts. Publishing them
    // as immediately bookable is what produced the original four-cards /
    // two-API-services mismatch.
    //
    // No price_label column: labels are derived from price_cents + billing_unit.
    const seeds = [
      // name, description, icon, perks, price_cents, is_featured, order, billing_unit, booking_mode, active
      ['Overnight Boarding',
        'Cozy suites with evening check-ins, so your dog sleeps somewhere calm and supervised.',
        '\u{1F3E0}',
        JSON.stringify(['Private suites', 'Evening walk included', 'Breakfast & dinner']),
        4500, false, 1, 'night', 'bookable', true],
      ['Doggy Daycare',
        'A full day of supervised socialisation, play and rest. Your dog comes home happily tired.',
        '\u2600\uFE0F',
        JSON.stringify(['Supervised group play', 'Nap time included', 'Photo updates']),
        3000, true, 2, 'day', 'bookable', true],
      ['Spa & Grooming',
        'Bath, blow-dry and nail trimming. Availability and rates are being confirmed.',
        '\u{1F6C0}',
        JSON.stringify(['Bath & blow-dry', 'Nail trimming', 'Coat brushing']),
        3500, false, 3, 'session', 'inquiry', false],
      ['Training Sessions',
        'One-to-one positive-reinforcement sessions. Availability and rates are being confirmed.',
        '\u{1F3C3}',
        JSON.stringify(['1-on-1 sessions', 'Progress reports']),
        5000, false, 4, 'session', 'inquiry', false]
    ];
    for (const s of seeds) {
      await pool.query(
        `INSERT INTO services
           (name, description, icon, perks, price_cents, is_featured, display_order,
            billing_unit, booking_mode, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        s
      );
    }
    console.log('[seed] inserted default services');
  }
}

async function init() {
  await runMigrations();
  await seed();
}

module.exports = { pool, query, getClient, init, seed };
