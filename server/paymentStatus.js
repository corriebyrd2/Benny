// What a booking's payment_status means, in one place.
//
// This exists because the meaning was spread across four files and they had
// drifted. Every route that takes money guarded on `payment_status === 'paid'`
// alone, so a booking that had been paid and then PARTLY refunded read as
// "not paid": an admin could request payment again, or the customer could
// start a new checkout, and the line items are rebuilt from `amount_cents` —
// they would have been charged the original full amount a second time.
//
// The revenue figures had the mirror-image bug: they summed only `'paid'`
// rows, so refunding $10 of a $100 booking dropped the whole $100 out of the
// dashboard instead of leaving $90.

// The customer's money has been taken. None of these may be charged again.
const SETTLED = ['paid', 'partially_refunded', 'refunded'];

// Money is currently held for this booking, so it counts towards revenue —
// net of anything given back. A fully refunded booking is settled but earns
// nothing, which is why it is not in this list.
const EARNING = ['paid', 'partially_refunded'];

function isSettled(paymentStatus) {
  return SETTLED.includes(paymentStatus);
}

// Net revenue for one booking row, in cents. Never negative: a refund larger
// than the recorded amount is a data error, not income to subtract from
// another booking.
function netRevenueCents(booking) {
  if (!EARNING.includes(booking.payment_status)) return 0;
  const amount = Number(booking.amount_cents) || 0;
  const refunded = Number(booking.refunded_cents) || 0;
  return Math.max(0, amount - refunded);
}

// Why a booking cannot be charged again. Null when it can be.
function settledReason(paymentStatus) {
  switch (paymentStatus) {
    case 'paid':
      return 'Booking is already paid';
    case 'partially_refunded':
      return 'This booking was paid and has been partly refunded. Charging it again '
        + 'would take the full amount a second time — adjust the refund instead.';
    case 'refunded':
      return 'This booking was paid and has been fully refunded. Create a new booking '
        + 'rather than charging this one again.';
    default:
      return null;
  }
}

// SQL fragment for the conditional UPDATEs that must not overwrite a settled
// status. `index` is the 1-based parameter position of the SETTLED array.
function notSettledSql(index) {
  return `payment_status <> ALL($${index})`;
}

module.exports = { EARNING, SETTLED, isSettled, netRevenueCents, notSettledSql, settledReason };
