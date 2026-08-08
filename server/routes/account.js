// Data export and account deletion.
//
// The published Privacy Policy states that a customer can export a
// machine-readable copy of their data and delete their account. Neither was
// implemented, so the policy was promising something the software did not do —
// which is worse than promising nothing.
//
// Both actions are destructive or disclosive, so both require the customer to
// re-enter their password. A live session is not sufficient authority to hand
// over every record about someone, or to erase it.

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { query, getClient } = require('../database');
const { authenticateCustomer } = require('../customerAuth');
const sessions = require('../sessions');
const { formatAmount } = require('../pricing');

const router = express.Router();

const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const DOC_UPLOAD_DIR = process.env.DOG_DOC_UPLOAD_DIR
  || path.join(path.dirname(BASE_UPLOAD_DIR), 'dog-documents');
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Re-authenticate for a sensitive action.
 *
 * Holding a session means "this browser signed in at some point". Exporting or
 * erasing everything about a person warrants proving they are still the person
 * — an unattended laptop should not be enough.
 */
async function requirePassword(req, res, next) {
  try {
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'Please re-enter your password to confirm.',
        reauthentication_required: true
      });
    }
    const { rows } = await query('SELECT password_hash FROM customers WHERE id = $1',
      [req.customer.id]);
    if (!rows[0] || !bcrypt.compareSync(password, rows[0].password_hash)) {
      // Deliberately 403, not 401. Throughout this app 401 means "your session
      // is gone, sign in again", and the client acts on it by signing the user
      // out. A failed RE-authentication is a different thing: the session is
      // perfectly valid, the confirmation was wrong. Answering 401 here signed
      // people out for mistyping their own password.
      return res.status(403).json({
        error: 'That password is not correct.',
        reauthentication_failed: true
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// --- Export ---------------------------------------------------------------

async function buildExport(customerId) {
  const [profile, dogs, documents, bookings, acceptances, subscription, activeSessions, events] =
    await Promise.all([
      query(`SELECT id, name, email, phone, dog_name, created_at
             FROM customers WHERE id = $1`, [customerId]),
      query(`SELECT id, name, breed, weight, age, notes, created_at, updated_at
             FROM dogs WHERE customer_id = $1 ORDER BY created_at`, [customerId]),
      query(`SELECT dd.id, dd.dog_id, dd.original_name,
                    COALESCE(NULLIF(dd.detected_mime, ''), dd.mime_type) AS mime_type,
                    dd.size_bytes, dd.sha256, dd.scan_status, dd.uploaded_at
             FROM dog_documents dd
             JOIN dogs d ON d.id = dd.dog_id
             WHERE d.customer_id = $1 ORDER BY dd.uploaded_at`, [customerId]),
      query(`SELECT id, service_name, dog_name, dog_count, preferred_dates, start_date,
                    end_date, message, status, payment_status, amount_cents,
                    refunded_cents, created_at, updated_at
             FROM bookings WHERE customer_id = $1 ORDER BY created_at`, [customerId]),
      query(`SELECT policy_slug, policy_version, accepted, context, booking_id, accepted_at
             FROM policy_acceptances WHERE customer_id = $1 ORDER BY accepted_at`, [customerId]),
      query(`SELECT email, source, consent_at, consent_source, unsubscribed_at
             FROM subscribers
             WHERE LOWER(email) = (SELECT LOWER(email) FROM customers WHERE id = $1)`, [customerId]),
      query(`SELECT created_at, last_seen_at, expires_at, user_agent
             FROM sessions
             WHERE subject_type = 'customer' AND subject_id = $1 AND revoked_at IS NULL
             ORDER BY last_seen_at DESC`, [customerId]),
      query(`SELECT be.event, be.from_status, be.to_status, be.from_payment_status,
                    be.to_payment_status, be.amount_cents, be.created_at, be.booking_id
             FROM booking_events be
             JOIN bookings b ON b.id = be.booking_id
             WHERE b.customer_id = $1 ORDER BY be.created_at`, [customerId])
    ]);

  return {
    export_format_version: 1,
    generated_at: new Date().toISOString(),
    // Says plainly what is here and what is deliberately not.
    notes: [
      'This file contains every record we hold that is linked to your account.',
      'Document CONTENTS are not included — download each document from your account.',
      'Passwords are stored only as a one-way hash and cannot be exported.',
      'Card numbers never reach our servers, so we hold none to export.',
      'Server request logs are not linked to your account and are retained for 30 days.'
    ],
    profile: profile.rows[0] || null,
    dogs: dogs.rows,
    documents: documents.rows,
    bookings: bookings.rows.map(b => ({
      ...b,
      amount: formatAmount(b.amount_cents),
      refunded: formatAmount(b.refunded_cents || 0)
    })),
    booking_history: events.rows,
    policy_acceptances: acceptances.rows,
    newsletter_subscription: subscription.rows[0] || null,
    active_sessions: activeSessions.rows
  };
}

// A GET would put the whole export in browser history and server logs, and a
// password cannot be sent safely in a query string — so this is a POST.
router.post('/export', authenticateCustomer, requirePassword, async (req, res, next) => {
  try {
    const data = await buildExport(req.customer.id);
    const filename = `benny-and-the-pets-data-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

// A preview so someone can see what deletion will remove before committing.
router.get('/deletion-preview', authenticateCustomer, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM dogs WHERE customer_id = $1) AS dogs,
         (SELECT COUNT(*)::int FROM dog_documents dd JOIN dogs d ON d.id = dd.dog_id
           WHERE d.customer_id = $1) AS documents,
         (SELECT COUNT(*)::int FROM bookings WHERE customer_id = $1) AS bookings,
         (SELECT COUNT(*)::int FROM bookings
           WHERE customer_id = $1 AND payment_status IN ('paid','partially_refunded','refunded'))
           AS financial_bookings`,
      [req.customer.id]
    );
    const counts = rows[0];
    res.json({
      will_be_deleted: {
        profile: 1,
        dogs: counts.dogs,
        documents: counts.documents,
        sessions: 'all',
        newsletter_subscription: 'removed'
      },
      will_be_anonymised: {
        bookings: counts.bookings,
        reason: counts.financial_bookings > 0
          ? 'Bookings that were paid are financial records we are required to keep. Your name, ' +
            'email, phone, dog names and messages are erased from them; the dates, service and ' +
            'amounts remain, with no link back to you.'
          : 'Booking rows are retained without any personal detail linked to you.'
      },
      irreversible: true
    });
  } catch (err) {
    next(err);
  }
});

// --- Deletion -------------------------------------------------------------

router.delete('/', authenticateCustomer, requirePassword, async (req, res, next) => {
  const customerId = req.customer.id;

  // Collect document filenames BEFORE the cascade removes the rows naming them,
  // or the files are orphaned on disk forever.
  let filenames = [];
  try {
    const { rows } = await query(
      `SELECT dd.filename FROM dog_documents dd
       JOIN dogs d ON d.id = dd.dog_id WHERE d.customer_id = $1`,
      [customerId]
    );
    filenames = rows.map(r => r.filename);
  } catch (err) {
    return next(err);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Anonymise rather than delete bookings: a paid booking is a financial
    // record. Everything that identifies a person is erased; the dates, service
    // and amounts survive with no link back.
    await client.query(
      `UPDATE bookings SET
         owner_name = 'Deleted customer',
         email = '',
         phone = '',
         dog_name = 'Deleted',
         message = '',
         preferred_dates = '',
         customer_id = NULL,
         updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId]
    );

    // Marketing consent goes with the account.
    await client.query(
      `DELETE FROM subscribers
       WHERE LOWER(email) = (SELECT LOWER(email) FROM customers WHERE id = $1)`,
      [customerId]
    );

    // dogs and dog_documents cascade from customers; acceptance records keep
    // their evidentiary value with customer_id set to NULL by their own FK
    // rule, so what was agreed at a point in time survives without naming
    // anyone.
    await client.query('DELETE FROM customers WHERE id = $1', [customerId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return next(err);
  }
  client.release();

  // Only once the database change is committed: deleting files first would lose
  // documents if the transaction rolled back.
  let filesDeleted = 0;
  for (const filename of filenames) {
    if (!SAFE_FILENAME_RE.test(filename)) continue;
    try {
      await fs.promises.unlink(path.join(DOC_UPLOAD_DIR, filename));
      filesDeleted += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[account-deletion] could not remove document file', filename, err.message);
      }
    }
  }

  await sessions.revokeAllForSubject('customer', customerId, 'account_deleted');
  sessions.clearSessionCookies(res);

  res.json({
    message: 'Your account and personal data have been deleted.',
    documents_deleted: filesDeleted
  });
});

module.exports = router;
module.exports.buildExport = buildExport;
