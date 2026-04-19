#!/usr/bin/env node
/*
 * One-shot data migration: copies all rows from the legacy SQLite database
 * (better-sqlite3) into a Neon Postgres database.
 *
 * Usage:
 *   SQLITE_PATH=./benny.db DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-pg.js
 *
 * Requirements (install only for the migration window, then uninstall):
 *   npm install better-sqlite3
 *
 * Assumes the target Postgres DB has been initialized via the app's
 * runMigrations() (i.e. tables exist and are empty).
 */
require('dotenv').config();

const Database = require('better-sqlite3');
const { Pool } = require('pg');

const SQLITE_PATH = process.env.SQLITE_PATH || './benny.db';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const BOOLEAN_COLUMNS = {
  services: ['is_featured', 'active'],
  photos: ['show_on_homepage']
};

// FK-respecting order.
const TABLES = [
  'admins',
  'services',
  'customers',
  'photos',
  'number_counters',
  'dogs',
  'bookings',
  'audit_logs'
];

const IDENTITY_TABLES = TABLES; // all tables have an IDENTITY id column

function coerce(row, table) {
  const bools = BOOLEAN_COLUMNS[table] || [];
  for (const col of bools) {
    if (row[col] !== undefined && row[col] !== null) {
      row[col] = row[col] === 1 || row[col] === '1' || row[col] === true;
    }
  }
  return row;
}

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: true }
  });

  const client = await pool.connect();

  try {
    for (const table of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`[${table}] 0 rows, skipping`);
        continue;
      }

      // Columns present in the source; we trust the schema matches.
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const insertSql = `INSERT INTO ${table} (${cols.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${placeholders})`;

      await client.query('BEGIN');
      try {
        for (const raw of rows) {
          const row = coerce({ ...raw }, table);
          await client.query(insertSql, cols.map(c => row[c]));
        }
        await client.query('COMMIT');
        console.log(`[${table}] inserted ${rows.length} rows`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // Reset identity sequences so future inserts don't collide with imported ids.
    for (const table of IDENTITY_TABLES) {
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence($1, 'id'),
           COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1,
           false
         )`,
        [table]
      );
      console.log(`[${table}] sequence reset`);
    }

    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
