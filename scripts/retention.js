#!/usr/bin/env node
// Retention sweep.
//
//   node scripts/retention.js            # report only
//   node scripts/retention.js --apply    # actually delete
//
// Retention periods were documented but nothing enforced them, so every table
// grew forever. This is the job that enforces them. It defaults to a DRY RUN —
// a deletion script that deletes by default is one accidental invocation away
// from an incident.
//
// Run it from a scheduler (Railway cron, GitHub Actions schedule) with --apply.
//
// Deliberately NOT swept here:
//   * bookings, refunds, policy_acceptances — financial and consent records.
//     Their retention is a legal question, marked [OWNER] in the published
//     privacy policy, and is not engineering's to decide.
//   * dog_documents — deleted when the customer deletes the document, the pet
//     or the account. A time-based sweep needs the owner's compliance period.

require('dotenv').config();

const APPLY = process.argv.includes('--apply');

// Each rule states WHY, because a retention period without a reason gets
// changed by whoever next finds it inconvenient.
const RULES = [
  {
    name: 'expired sessions',
    why: 'A revoked or expired session is already refused at resolve time; the rows are pure growth.',
    countSql: `SELECT COUNT(*)::int AS n FROM sessions
               WHERE expires_at < NOW() - INTERVAL '30 days'`,
    deleteSql: `DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '30 days'`
  },
  {
    name: 'used and expired password reset tokens',
    why: 'Single-use and one-hour-lived. Nothing reads them after that.',
    countSql: `SELECT COUNT(*)::int AS n FROM password_reset_tokens
               WHERE (used_at IS NOT NULL OR expires_at < NOW())
                 AND created_at < NOW() - INTERVAL '30 days'`,
    deleteSql: `DELETE FROM password_reset_tokens
                WHERE (used_at IS NOT NULL OR expires_at < NOW())
                  AND created_at < NOW() - INTERVAL '30 days'`
  },
  {
    name: 'used and expired email verification tokens',
    why: 'Same reasoning as reset tokens.',
    countSql: `SELECT COUNT(*)::int AS n FROM email_verification_tokens
               WHERE (used_at IS NOT NULL OR expires_at < NOW())
                 AND created_at < NOW() - INTERVAL '30 days'`,
    deleteSql: `DELETE FROM email_verification_tokens
                WHERE (used_at IS NOT NULL OR expires_at < NOW())
                  AND created_at < NOW() - INTERVAL '30 days'`
  },
  {
    name: 'processed Stripe webhook events',
    why: 'Kept 90 days for replay protection and reconciliation; Stripe does not retry beyond that.',
    countSql: `SELECT COUNT(*)::int AS n FROM stripe_events
               WHERE processed_at IS NOT NULL AND received_at < NOW() - INTERVAL '90 days'`,
    deleteSql: `DELETE FROM stripe_events
                WHERE processed_at IS NOT NULL AND received_at < NOW() - INTERVAL '90 days'`
  },
  {
    name: 'email delivery events',
    why: 'Diagnostic only. 90 days is well past the point of being useful.',
    countSql: `SELECT COUNT(*)::int AS n FROM email_events
               WHERE created_at < NOW() - INTERVAL '90 days'`,
    deleteSql: `DELETE FROM email_events WHERE created_at < NOW() - INTERVAL '90 days'`
  },
  {
    name: 'spam enquiries',
    why: 'Marked spam by an admin. Kept 30 days in case the call was wrong.',
    countSql: `SELECT COUNT(*)::int AS n FROM inquiries
               WHERE status = 'spam' AND created_at < NOW() - INTERVAL '30 days'`,
    deleteSql: `DELETE FROM inquiries WHERE status = 'spam' AND created_at < NOW() - INTERVAL '30 days'`
  },
  {
    name: 'rejected reviews',
    why: 'Never published, and moderation is long settled after 90 days.',
    countSql: `SELECT COUNT(*)::int AS n FROM reviews
               WHERE status = 'rejected' AND created_at < NOW() - INTERVAL '90 days'`,
    deleteSql: `DELETE FROM reviews WHERE status = 'rejected' AND created_at < NOW() - INTERVAL '90 days'`
  }
];

async function main() {
  const { query, pool } = require('../server/database');
  console.log(APPLY ? 'Retention sweep (APPLYING)' : 'Retention sweep (dry run — pass --apply to delete)');
  console.log('');

  let total = 0;
  for (const rule of RULES) {
    let count = 0;
    try {
      const { rows } = await query(rule.countSql);
      count = rows[0].n;
    } catch (err) {
      // A table that does not exist yet in this schema version is not a failure.
      console.log(`  ${rule.name}: skipped (${err.message.split('\n')[0]})`);
      continue;
    }

    if (count === 0) {
      console.log(`  ${rule.name}: nothing to remove`);
      continue;
    }

    total += count;
    if (APPLY) {
      const result = await query(rule.deleteSql);
      console.log(`  ${rule.name}: deleted ${result.rowCount}`);
    } else {
      console.log(`  ${rule.name}: ${count} eligible`);
    }
    console.log(`      ${rule.why}`);
  }

  console.log('');
  console.log(APPLY ? `Done. ${total} rows were eligible.` : `${total} rows eligible. Re-run with --apply.`);
  await pool.end();
}

main().catch(err => {
  console.error('Retention sweep failed:', err.message);
  process.exit(1);
});
