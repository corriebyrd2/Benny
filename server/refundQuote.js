// What the published cancellation policy owes on a given booking.
//
// This lived inside routes/payments.js, where only the admin refund endpoints
// could reach it. Customer-initiated cancellation needs the identical figure —
// the customer is told what they will get back at the moment they cancel, and
// the owner is told what to refund — so it moved here rather than being
// written a second time. One implementation, one rounding convention.

const { refundForCancellation, formatAmount } = require('./pricing');

// A DATE column comes back from pg as a Date object, whose default string form
// is "Mon Sep 01 2026 ..." — slicing that gives "Mon Sep 01", which parses to
// NaN. Always normalise through this.
function startDateIso(booking) {
  if (!booking || !booking.start_date) return null;
  return booking.start_date instanceof Date
    ? booking.start_date.toISOString().slice(0, 10)
    : String(booking.start_date).slice(0, 10);
}

// Hours from now until the stay begins. Infinity when the booking carries no
// start date: there is no deadline to measure against, and the customer should
// not lose money because we never captured a date.
function hoursBeforeStart(booking, now = Date.now()) {
  const iso = startDateIso(booking);
  if (!iso) return Infinity;
  const start = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(start)) return Infinity;
  return (start - now) / 3600000;
}

function refundQuoteFor(booking, now = Date.now()) {
  const paid = Number(booking.amount_cents) || 0;
  const alreadyRefunded = Number(booking.refunded_cents) || 0;
  const hours = hoursBeforeStart(booking, now);

  const policy = refundForCancellation({ amountPaidCents: paid, hoursBeforeStart: hours });
  const remaining = Math.max(0, policy.refund_cents - alreadyRefunded);
  return {
    tier: policy.tier,
    hours_before_start: Number.isFinite(hours) ? Math.round(hours) : null,
    amount_paid_cents: paid,
    already_refunded_cents: alreadyRefunded,
    policy_refund_cents: policy.refund_cents,
    refundable_now_cents: remaining,
    retained_cents: policy.retained_cents,
    summary: `${formatAmount(remaining)} refundable of ${formatAmount(paid)} paid`
  };
}

module.exports = { refundQuoteFor, startDateIso, hoursBeforeStart };
