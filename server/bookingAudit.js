// Append-only audit trail for booking and payment state transitions.
//
// Every status or payment_status change that a customer could later dispute is
// recorded here with who caused it and what it moved from/to. Writes are
// best-effort: an audit failure must never abort the business operation it is
// describing, but it is logged loudly so a silently broken trail is visible.

const { query } = require('./database');

async function recordBookingEvent({
  bookingId,
  event,
  from = {},
  to = {},
  amountCents = null,
  actorType = 'system',
  actorId = '',
  detail = ''
}) {
  try {
    await query(
      `INSERT INTO booking_events
         (booking_id, event, from_status, to_status,
          from_payment_status, to_payment_status, amount_cents,
          actor_type, actor_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        bookingId,
        event,
        from.status || '',
        to.status || '',
        from.payment_status || '',
        to.payment_status || '',
        amountCents,
        actorType,
        String(actorId || ''),
        String(detail || '').slice(0, 1000)
      ]
    );
  } catch (err) {
    console.error('[booking-audit] failed to record', event, 'for booking', bookingId, err.message);
  }
}

async function listBookingEvents(bookingId, limit = 100) {
  const { rows } = await query(
    `SELECT * FROM booking_events WHERE booking_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [bookingId, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return rows;
}

module.exports = { recordBookingEvent, listBookingEvents };
