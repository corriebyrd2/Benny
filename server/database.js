const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('NEON_DATABASE_URL (or DATABASE_URL) is required');
}

const pool = new Pool({
  connectionString,
  // Neon terminates TLS at the proxy; the default CA bundle may not match.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
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

  const { rows: serviceRows } = await pool.query('SELECT COUNT(*)::int AS count FROM services');
  if (serviceRows[0].count === 0) {
    const seeds = [
      ['Overnight Boarding',
        'Cozy suites with bedtime stories (yes, really) and midnight check-ins. Your pup sleeps like royalty.',
        '\u{1F3E0}',
        JSON.stringify(['Private suites', 'Evening walk included', 'Breakfast & dinner']),
        4500, 'From $45/night', 0, 1],
      ['Doggy Daycare',
        'A full day of socialization, play, and structured activities. Your dog will come home happily exhausted!',
        '\u2600\uFE0F',
        JSON.stringify(['Supervised group play', 'Nap time included', 'Photo updates']),
        3000, 'From $30/day', 1, 2],
      ['Spa & Grooming',
        'Bath time shouldn\'t be a battle. Our gentle groomers make every pup feel pampered and pretty.',
        '\u{1F6C0}',
        JSON.stringify(['Bath & blow-dry', 'Nail trimming', 'Coat brushing']),
        3500, 'From $35/session', 0, 3],
      ['Training Sessions',
        'Positive reinforcement training that makes learning fun. From basics to impressive tricks!',
        '\u{1F3C3}',
        JSON.stringify(['1-on-1 sessions', 'Certified trainers', 'Progress reports']),
        5000, 'From $50/session', 0, 4]
    ];
    for (const s of seeds) {
      await pool.query(
        `INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
