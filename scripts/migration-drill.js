#!/usr/bin/env node
// Migration up / down / up drill.
//
//   node scripts/migration-drill.js
//
// Reversals used to live only in comments at the top of each migration, which
// meant they were unverified prose. Anyone running one under pressure during an
// incident would be finding out then whether it worked. This drill executes
// them against a throwaway database and proves three things:
//
//   1. Every migration applies cleanly from empty.
//   2. Every reversal in server/migrations/down/ actually runs.
//   3. Re-applying afterwards reaches the SAME schema — so a rollback followed
//      by a roll-forward is safe, not a one-way door.
//
// It also seeds representative rows before rolling back, so a reversal that
// would fail on real data (a constraint that cannot represent an existing
// value) fails here instead of in production. That is not hypothetical: the
// 0022 reversal narrows payment_status, and folding 'refunded' back to 'paid'
// is required for it to apply at all.
//
// Requires a Postgres the connecting role may CREATE DATABASE on. The drill
// creates its own scratch database and drops it at the end.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'server', 'migrations');
const DOWN_DIR = path.join(MIGRATIONS_DIR, 'down');

const SOURCE_URL = process.env.E2E_DATABASE_URL
  || process.env.NEON_DATABASE_URL
  || process.env.DATABASE_URL;

if (!SOURCE_URL) {
  console.error('Set E2E_DATABASE_URL (or DATABASE_URL) to a Postgres the role may create databases on.');
  process.exit(2);
}

function urlWithDatabase(url, dbName) {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function sslFor(url) {
  return /sslmode=disable/i.test(url) ? false : { rejectUnauthorized: false };
}

async function connect(url) {
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  // Dropping the scratch database with FORCE terminates any connection still
  // open to it, which pg surfaces as an 'error' event. Unhandled, that crashes
  // the process and hides the real failure underneath it.
  client.on('error', () => {});
  await client.connect();
  return client;
}

function upMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

function downFor(migration) {
  const file = path.join(DOWN_DIR, migration.replace(/\.sql$/, '.down.sql'));
  return fs.existsSync(file) ? file : null;
}

// A comparable fingerprint of the schema: every column and every constraint,
// ordered. Comparing this before and after a down/up cycle is what proves the
// cycle is lossless in shape.
async function schemaFingerprint(client) {
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name`);
  const { rows: constraints } = await client.query(`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE','CHECK','FOREIGN KEY')
      AND tc.constraint_name NOT LIKE '%_not_null'
    ORDER BY tc.table_name, tc.constraint_name`);
  const payload = JSON.stringify({ columns, constraints });
  return { hash: crypto.createHash('sha256').update(payload).digest('hex'), columns, constraints };
}

async function applyAll(client, files, label) {
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`${label}: ${file} failed — ${err.message}`);
    }
  }
}

// Rows that exercise the parts of the schema the reversals touch.
async function seedRepresentativeData(client) {
  await client.query(`
    INSERT INTO services (name, description, icon, perks, price_cents, is_featured,
                          display_order, billing_unit, booking_mode, active)
    VALUES ('Drill Service', 'seeded by the migration drill', '', '[]', 4500, false, 1,
            'night', 'bookable', true)`);
  await client.query(`
    INSERT INTO customers (name, email, phone, password_hash, dog_name)
    VALUES ('Drill Customer', 'drill@example.test', '', 'x', 'Drill Dog')`);
  await client.query(`
    INSERT INTO bookings (owner_name, email, dog_name, service_id, service_name,
                          amount_cents, payment_status, refunded_cents, start_date, end_date)
    VALUES ('Drill Customer', 'drill@example.test', 'Drill Dog',
            (SELECT id FROM services WHERE name = 'Drill Service'), 'Drill Service',
            4500, 'refunded', 4500, CURRENT_DATE, CURRENT_DATE)`);
  await client.query(`
    INSERT INTO subscribers (email, source, consent_at, consent_source)
    VALUES ('drill@example.test', 'drill', NOW(), 'drill')`);
}

async function main() {
  const scratch = `benny_migration_drill_${Date.now()}`;
  const admin = await connect(SOURCE_URL);

  console.log(`Creating scratch database ${scratch}`);
  await admin.query(`CREATE DATABASE ${scratch}`);
  await admin.end();

  const url = urlWithDatabase(SOURCE_URL, scratch);
  let failure = null;
  let client = null;

  try {
    client = await connect(url);
    const files = upMigrations();
    console.log(`Applying ${files.length} migrations`);
    await applyAll(client, files, 'up');

    const before = await schemaFingerprint(client);
    console.log(`Schema after first up: ${before.hash.slice(0, 12)} ` +
      `(${before.columns.length} columns, ${before.constraints.length} constraints)`);

    await seedRepresentativeData(client);
    console.log('Seeded representative rows');

    // Reverse, newest first — the order an operator would use.
    const reversible = files.filter(downFor).reverse();
    console.log(`Reversing ${reversible.length} migrations`);
    for (const file of reversible) {
      const sql = fs.readFileSync(downFor(file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`down: ${file} failed — ${err.message}`);
      }
    }

    // Re-apply ONLY what was reversed, in forward order — the roll-forward an
    // operator would actually perform. Replaying the base migrations too would
    // just fail on "relation already exists", since they were never rolled back.
    const rollForward = [...reversible].reverse();
    console.log(`Re-applying ${rollForward.length}`);
    await applyAll(client, rollForward, 'up (second pass)');

    const after = await schemaFingerprint(client);
    console.log(`Schema after re-apply:  ${after.hash.slice(0, 12)}`);

    if (before.hash !== after.hash) {
      const beforeSet = new Set(before.columns.map(c => `${c.table_name}.${c.column_name}:${c.data_type}:${c.is_nullable}:${c.column_default}`));
      const afterSet = new Set(after.columns.map(c => `${c.table_name}.${c.column_name}:${c.data_type}:${c.is_nullable}:${c.column_default}`));
      const missing = [...beforeSet].filter(c => !afterSet.has(c));
      const extra = [...afterSet].filter(c => !beforeSet.has(c));
      throw new Error(
        'up -> down -> up did not reach the same schema.\n' +
        (missing.length ? `  missing after cycle: ${missing.join(', ')}\n` : '') +
        (extra.length ? `  unexpected after cycle: ${extra.join(', ')}\n` : '')
      );
    }

    // Migrations with no reversal file are listed rather than silently ignored.
    const irreversible = files.filter(f => !downFor(f));
    if (irreversible.length) {
      console.log('');
      console.log(`No reversal file for ${irreversible.length} older migration(s):`);
      console.log(`  ${irreversible.join(', ')}`);
      console.log('  These predate the drill. Rolling back past them means restoring a backup.');
    }

    console.log('');
    console.log('Migration drill passed: up -> down -> up is schema-identical.');
  } catch (err) {
    failure = err;
  } finally {
    // Close the working connection BEFORE dropping the database it is on.
    if (client) await client.end().catch(() => {});
    const cleanup = await connect(SOURCE_URL);
    await cleanup.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(async () => {
      await cleanup.query(`DROP DATABASE IF EXISTS ${scratch}`).catch(() => {});
    });
    await cleanup.end();
  }

  if (failure) {
    console.error('');
    console.error('Migration drill FAILED:');
    console.error(failure.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Migration drill could not run:', err.message);
  process.exit(2);
});
