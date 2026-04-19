const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 30_000
    });
  }
  return pool;
}

async function query(text, params) {
  const result = await getPool().query(text, params);
  return result;
}

async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const applied = new Set(
    (await query('SELECT name FROM _migrations')).rows.map(r => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await withTx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    });
    console.log(`[migrate] applied ${file}`);
  }
}

async function seed() {
  const { rows: adminRows } = await query('SELECT COUNT(*)::int AS count FROM admins');
  if (adminRows[0].count === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@bennyandthepets.com';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 10);
    await query(
      'INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, $3)',
      [email, hash, 'admin']
    );
  }

  const { rows: serviceRows } = await query('SELECT COUNT(*)::int AS count FROM services');
  if (serviceRows[0].count === 0) {
    await withTx(async (client) => {
      const insert = (args) => client.query(`
        INSERT INTO services (name, description, icon, perks, price_cents, price_label, is_featured, display_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, args);

      await insert(['Overnight Boarding',
        'Cozy suites with bedtime stories (yes, really) and midnight check-ins. Your pup sleeps like royalty.',
        '&#127968;',
        JSON.stringify(['Private suites', 'Evening walk included', 'Breakfast & dinner']),
        4500, 'From $45/night', false, 1]);

      await insert(['Doggy Daycare',
        'A full day of socialization, play, and structured activities. Your dog will come home happily exhausted!',
        '&#9728;&#65039;',
        JSON.stringify(['Supervised group play', 'Nap time included', 'Photo updates']),
        3000, 'From $30/day', true, 2]);

      await insert(['Spa & Grooming',
        'Bath time shouldn\'t be a battle. Our gentle groomers make every pup feel pampered and pretty.',
        '&#128704;',
        JSON.stringify(['Bath & blow-dry', 'Nail trimming', 'Coat brushing']),
        3500, 'From $35/session', false, 3]);

      await insert(['Training Sessions',
        'Positive reinforcement training that makes learning fun. From basics to impressive tricks!',
        '&#127939;',
        JSON.stringify(['1-on-1 sessions', 'Certified trainers', 'Progress reports']),
        5000, 'From $50/session', false, 4]);
    });
  }
}

module.exports = { getPool, query, withTx, runMigrations, seed };
