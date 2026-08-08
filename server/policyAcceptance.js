// Recording and querying versioned policy acceptance.
//
// Two rules the callers must respect and the tests enforce:
//   * Required contractual acceptance is separate from optional marketing
//     consent. They are never bundled into one checkbox.
//   * Nothing is pre-checked. An acceptance is only recorded when the request
//     explicitly carries `true` for that policy — a missing field is a refusal,
//     not a default.

const crypto = require('crypto');
const { query } = require('./database');
const { currentVersion, requiredForPoint } = require('./legal');

// The acceptance record needs to distinguish "a different person" without
// retaining a raw IP address indefinitely. A keyed hash gives that without
// storing the identifier itself.
function hashIp(ip) {
  if (!ip) return '';
  const key = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 32);
}

/**
 * Validate that every policy required at `point` was explicitly accepted.
 * Returns an array of human-readable errors (empty when satisfied).
 *
 * `accepted` is the client-supplied map, e.g. { terms: true, privacy: true }.
 */
function validateAcceptance(point, accepted) {
  const provided = (accepted && typeof accepted === 'object') ? accepted : {};
  const errors = [];
  for (const policy of requiredForPoint(point)) {
    if (provided[policy.slug] !== true) {
      errors.push(`You must accept the ${policy.title} to continue`);
    }
  }
  return errors;
}

async function recordAcceptance({
  customerId = null,
  email = '',
  point,
  accepted,
  bookingId = null,
  req = null
}) {
  const provided = (accepted && typeof accepted === 'object') ? accepted : {};
  const rows = [];
  for (const policy of requiredForPoint(point)) {
    if (provided[policy.slug] !== true) continue;
    rows.push([
      customerId,
      String(email || '').toLowerCase(),
      policy.slug,
      // The version stored is the version the SERVER is currently serving, not
      // one supplied by the client — otherwise a caller could claim acceptance
      // of an older, more favourable version.
      currentVersion(policy.slug),
      true,
      point,
      bookingId,
      req ? hashIp(req.ip) : '',
      req ? String(req.get('user-agent') || '').slice(0, 300) : ''
    ]);
  }

  for (const r of rows) {
    await query(
      `INSERT INTO policy_acceptances
         (customer_id, email, policy_slug, policy_version, accepted, context,
          booking_id, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      r
    );
  }
  return rows.length;
}

async function listAcceptancesForCustomer(customerId) {
  const { rows } = await query(
    `SELECT policy_slug, policy_version, accepted, context, booking_id, accepted_at
     FROM policy_acceptances WHERE customer_id = $1
     ORDER BY accepted_at DESC LIMIT 200`,
    [customerId]
  );
  return rows;
}

module.exports = {
  hashIp,
  listAcceptancesForCustomer,
  recordAcceptance,
  validateAcceptance
};
