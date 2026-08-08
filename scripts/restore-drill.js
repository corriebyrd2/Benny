#!/usr/bin/env node
// Backup and restore drill.
//
//   node scripts/restore-drill.js
//
// A backup nobody has restored is not a backup. This performs the whole cycle
// against a throwaway database and verifies the result, so "we have backups" is
// a tested claim rather than an assumption:
//
//   1. Seed a source database with representative rows.
//   2. pg_dump it (custom format, the same command in docs/OPERATIONS.md).
//   3. pg_restore into a fresh scratch database.
//   4. Verify row counts AND actual content match, table by table.
//   5. Verify the restored database is usable — constraints, sequences and
//      foreign keys all survived.
//
// Sequences matter more than they look: a restore that loses them appears fine
// until the first insert collides with an existing primary key.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const execFileAsync = promisify(execFile);

const SOURCE_URL = process.env.E2E_DATABASE_URL
  || process.env.NEON_DATABASE_URL
  || process.env.DATABASE_URL;

if (!SOURCE_URL) {
  console.error('Set E2E_DATABASE_URL (or DATABASE_URL).');
  process.exit(2);
}

// Every table whose loss would matter.
const VERIFIED_TABLES = [
  'admins', 'customers', 'dogs', 'dog_documents', 'bookings', 'booking_events',
  'services', 'photos', 'reviews', 'subscribers', 'policy_acceptances',
  'sessions', 'inquiries', 'refunds', 'stripe_events', 'audit_logs'
];

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
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function seed(client) {
  await client.query(`
    INSERT INTO customers (name, email, phone, password_hash, dog_name)
    VALUES ('Restore Drill', 'restore-drill@example.test', '555000', 'hash', 'Backup Dog')
    ON CONFLICT DO NOTHING`);
  const { rows: customers } = await client.query(
    `SELECT id FROM customers WHERE email = 'restore-drill@example.test'`);
  const customerId = customers[0].id;

  await client.query(
    `INSERT INTO dogs (customer_id, name, breed, notes)
     VALUES ($1, 'Backup Dog', 'Labrador', 'Needs his evening tablet')`, [customerId]);

  const { rows: services } = await client.query('SELECT id, name FROM services LIMIT 1');
  await client.query(
    `INSERT INTO bookings (owner_name, email, dog_name, service_id, service_name,
                           amount_cents, customer_id, start_date, end_date, dog_count, message)
     VALUES ('Restore Drill', 'restore-drill@example.test', 'Backup Dog', $1, $2,
             13500, $3, CURRENT_DATE, CURRENT_DATE + 3, 1, 'Free-text worth preserving')`,
    [services[0].id, services[0].name, customerId]);

  await client.query(
    `INSERT INTO inquiries (name, email, message)
     VALUES ('Enquirer', 'enquirer@example.test', 'Do you have space in December?')`);
}

async function tableCounts(client) {
  const counts = {};
  for (const table of VERIFIED_TABLES) {
    try {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      counts[table] = rows[0].n;
    } catch {
      counts[table] = null; // table absent in this schema version
    }
  }
  return counts;
}

async function main() {
  const stamp = Date.now();
  const sourceDb = `benny_restore_src_${stamp}`;
  const targetDb = `benny_restore_dst_${stamp}`;
  const dumpFile = path.join(os.tmpdir(), `benny-restore-drill-${stamp}.dump`);

  const admin = await connect(SOURCE_URL);
  await admin.query(`CREATE DATABASE ${sourceDb}`);
  await admin.query(`CREATE DATABASE ${targetDb}`);
  await admin.end();

  const sourceUrl = urlWithDatabase(SOURCE_URL, sourceDb);
  const targetUrl = urlWithDatabase(SOURCE_URL, targetDb);
  let failure = null;
  let source = null;
  let target = null;
  let seededPool = null;

  try {
    // 1. Build a realistic source.
    process.env.NEON_DATABASE_URL = sourceUrl;
    delete require.cache[require.resolve('../server/database')];
    const db = require('../server/database');
    await db.init();
    // Held so it can be closed before the scratch database is dropped —
    // otherwise the pool logs a "terminating connection" error on the way out.
    seededPool = db.pool;
    source = await connect(sourceUrl);
    await seed(source);
    const before = await tableCounts(source);
    const { rows: bookingBefore } = await source.query(
      `SELECT owner_name, email, amount_cents, dog_count, message
       FROM bookings WHERE email = 'restore-drill@example.test'`);
    console.log(`Source ready: ${Object.values(before).filter(Boolean).reduce((a, b) => a + b, 0)} rows across ${VERIFIED_TABLES.length} tables`);

    // 2. Dump — the same command documented for production.
    const started = Date.now();
    await execFileAsync('pg_dump', ['--no-owner', '--no-acl', '--format=custom',
      '--file', dumpFile, sourceUrl]);
    const dumpBytes = fs.statSync(dumpFile).size;
    console.log(`Dumped ${(dumpBytes / 1024).toFixed(1)} KB in ${Date.now() - started}ms`);
    if (dumpBytes < 1024) throw new Error('The dump is implausibly small; pg_dump probably wrote nothing');

    // 3. Restore into an empty database.
    const restoreStarted = Date.now();
    await execFileAsync('pg_restore', ['--no-owner', '--no-acl', '--clean',
      '--if-exists', '--dbname', targetUrl, dumpFile]);
    const restoreMs = Date.now() - restoreStarted;
    console.log(`Restored in ${restoreMs}ms`);

    // 4. Verify counts and content.
    target = await connect(targetUrl);
    const after = await tableCounts(target);
    for (const table of VERIFIED_TABLES) {
      if (before[table] !== after[table]) {
        throw new Error(`${table}: ${before[table]} rows before, ${after[table]} after`);
      }
    }
    console.log('Row counts match on every table');

    const { rows: bookingAfter } = await target.query(
      `SELECT owner_name, email, amount_cents, dog_count, message
       FROM bookings WHERE email = 'restore-drill@example.test'`);
    if (JSON.stringify(bookingBefore) !== JSON.stringify(bookingAfter)) {
      throw new Error('Booking content differs after restore:\n' +
        `  before ${JSON.stringify(bookingBefore)}\n  after  ${JSON.stringify(bookingAfter)}`);
    }
    console.log('Row content matches');

    // 5. Verify the restore is USABLE, not merely present.
    const { rows: joined } = await target.query(
      `SELECT d.name FROM dogs d JOIN customers c ON c.id = d.customer_id
       WHERE c.email = 'restore-drill@example.test'`);
    if (joined.length !== 1) throw new Error('Foreign key relationships did not survive the restore');

    // Sequences: a restore that loses them looks fine until the first insert
    // collides with an existing primary key.
    await target.query(
      `INSERT INTO customers (name, email, phone, password_hash, dog_name)
       VALUES ('Post Restore', 'post-restore@example.test', '', 'hash', '')`);
    console.log('Foreign keys and sequences survived; the restore accepts new writes');

    // Constraints came back too.
    let constraintHeld = false;
    try {
      await target.query(`INSERT INTO services (name, description, price_cents, billing_unit)
                          VALUES ('Bad', 'x', -1, 'night')`);
    } catch {
      constraintHeld = true;
    }
    if (!constraintHeld) throw new Error('CHECK constraints did not survive the restore');
    console.log('CHECK constraints survived');

    console.log('');
    console.log(`Restore drill passed. Dump ${(dumpBytes / 1024).toFixed(1)} KB, restore ${restoreMs}ms.`);
  } catch (err) {
    failure = err;
  } finally {
    if (seededPool) await seededPool.end().catch(() => {});
    if (source) await source.end().catch(() => {});
    if (target) await target.end().catch(() => {});
    fs.promises.unlink(dumpFile).catch(() => {});
    const cleanup = await connect(SOURCE_URL);
    for (const db of [sourceDb, targetDb]) {
      await cleanup.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    }
    await cleanup.end();
  }

  if (failure) {
    console.error('');
    console.error('Restore drill FAILED:');
    console.error(failure.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Restore drill could not run:', err.message);
  process.exit(2);
});
