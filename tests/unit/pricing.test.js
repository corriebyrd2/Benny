// Unit tests for the authoritative pricing module.
//
// These run without a database or a browser (`npm run test:unit`) so a pricing
// regression fails in seconds rather than at the end of a Playwright run.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-not-for-production';
const pricing = require('../../server/pricing');

const BOARDING = { price_cents: 4500, billing_unit: 'night', currency: 'usd', price_is_from: true };
const DAYCARE = { price_cents: 3000, billing_unit: 'day', currency: 'usd', price_is_from: true };
const GROOMING = { price_cents: 3500, billing_unit: 'session', currency: 'usd', price_is_from: false };

test('price labels are derived from cents, never stored', () => {
  assert.equal(pricing.priceLabel(BOARDING), 'From $45/night');
  assert.equal(pricing.priceLabel(DAYCARE), 'From $30/day');
  assert.equal(pricing.priceLabel(GROOMING), '$35/session');
});

test('the daycare label matches its amount — the original defect', () => {
  // Shipped state was price_cents 3000 with the label "From $35/day" and a
  // homepage card reading "$30/day". A label that can disagree no longer exists.
  const label = pricing.priceLabel(DAYCARE);
  const quote = pricing.quoteBooking({ service: DAYCARE, dogCount: 1 });
  assert.equal(label, 'From $30/day');
  assert.equal(quote.total_cents, 3000);
  assert.ok(label.includes(pricing.formatAmount(quote.unit_amount_cents, 'usd')));
});

test('fractional amounts keep both decimal places', () => {
  assert.equal(pricing.formatAmount(4550), '$45.50');
  assert.equal(pricing.formatAmount(4500), '$45');
  assert.equal(pricing.formatAmount(0), '$0');
});

test('the long label spells out the unit and the per-dog basis', () => {
  assert.equal(pricing.priceLabelLong(BOARDING), 'Starting at $45 per night, per dog');
  assert.equal(pricing.priceLabelLong(GROOMING), '$35 per session, per dog');
});

test('nights are counted between calendar dates, timezone-independently', () => {
  assert.equal(pricing.nightsBetween('2026-03-01', '2026-03-04'), 3);
  assert.equal(pricing.nightsBetween('2026-03-01', '2026-03-01'), 0);
  assert.equal(pricing.nightsBetween('2026-03-04', '2026-03-01'), 0);
  // Across a US daylight-saving transition the night count must not drift.
  assert.equal(pricing.nightsBetween('2026-03-07', '2026-03-09'), 2);
  // Across a leap day.
  assert.equal(pricing.nightsBetween('2028-02-28', '2028-03-01'), 2);
});

test('billable quantity differs per unit', () => {
  assert.equal(pricing.billableQuantity('night', '2026-03-01', '2026-03-04'), 3);
  // Daycare is inclusive days: the same range is four days.
  assert.equal(pricing.billableQuantity('day', '2026-03-01', '2026-03-04'), 4);
  // A same-day daycare booking is still one day, not zero.
  assert.equal(pricing.billableQuantity('day', '2026-03-01', '2026-03-01'), 1);
  // Sessions ignore dates entirely.
  assert.equal(pricing.billableQuantity('session', '2026-03-01', '2026-03-09'), 1);
});

test('every rate is per dog and scales with the number of dogs', () => {
  const one = pricing.quoteBooking({ service: BOARDING, startDate: '2026-03-01', endDate: '2026-03-04', dogCount: 1 });
  const three = pricing.quoteBooking({ service: BOARDING, startDate: '2026-03-01', endDate: '2026-03-04', dogCount: 3 });
  assert.equal(one.total_cents, 13500);
  assert.equal(three.total_cents, 40500);
  assert.equal(three.total_cents, one.total_cents * 3);
  assert.equal(three.description, '3 nights x 3 dogs');
});

test('dog count is clamped to a sane range', () => {
  assert.equal(pricing.quoteBooking({ service: GROOMING, dogCount: 0 }).dog_count, 1);
  assert.equal(pricing.quoteBooking({ service: GROOMING, dogCount: -5 }).dog_count, 1);
  assert.equal(pricing.quoteBooking({ service: GROOMING, dogCount: 999 }).dog_count, 10);
  assert.equal(pricing.quoteBooking({ service: GROOMING, dogCount: 'abc' }).dog_count, 1);
});

test('a quote reports a total, not just a subtotal', () => {
  const q = pricing.quoteBooking({ service: DAYCARE, startDate: '2026-05-01', endDate: '2026-05-02', dogCount: 2 });
  assert.equal(q.subtotal_cents, 12000);
  assert.equal(q.total_cents, q.subtotal_cents + q.tax_cents + q.deposit_cents - q.discount_cents);
  assert.equal(q.total_label, '$120');
  assert.equal(q.currency, 'usd');
});

test('Stripe line items reproduce the quoted breakdown', () => {
  const quote = pricing.quoteBooking({ service: BOARDING, startDate: '2026-03-01', endDate: '2026-03-03', dogCount: 2 });
  const items = pricing.stripeLineItems({
    service: { name: 'Overnight Boarding' }, quote, bookingId: 7, dogName: 'Rex',
    authoritativeTotalCents: quote.total_cents
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].price_data.unit_amount * items[0].quantity, quote.total_cents);
  assert.equal(items[0].price_data.unit_amount, 4500);
  assert.equal(items[0].quantity, 4);
});

test('a manually adjusted booking amount is charged, not silently re-priced', () => {
  const quote = pricing.quoteBooking({ service: BOARDING, startDate: '2026-03-01', endDate: '2026-03-03', dogCount: 1 });
  // Admin discounted this booking to $70 after the fact.
  const items = pricing.stripeLineItems({
    service: { name: 'Overnight Boarding' }, quote, bookingId: 7, dogName: 'Rex',
    authoritativeTotalCents: 7000
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].price_data.unit_amount * items[0].quantity, 7000);
});

test('refunds follow the published cancellation tiers and round in the customer favour', () => {
  assert.deepEqual(pricing.refundForCancellation({ amountPaidCents: 10000, hoursBeforeStart: 72 }),
    { refund_cents: 10000, retained_cents: 0, tier: 'full' });
  assert.deepEqual(pricing.refundForCancellation({ amountPaidCents: 10000, hoursBeforeStart: 48 }),
    { refund_cents: 10000, retained_cents: 0, tier: 'full' });
  assert.deepEqual(pricing.refundForCancellation({ amountPaidCents: 10001, hoursBeforeStart: 30 }),
    { refund_cents: 5001, retained_cents: 5000, tier: 'half' });
  assert.deepEqual(pricing.refundForCancellation({ amountPaidCents: 10000, hoursBeforeStart: 2 }),
    { refund_cents: 0, retained_cents: 10000, tier: 'none' });
});

test('publicService exposes computed fields and normalises bad input', () => {
  const s = pricing.publicService({
    name: 'X', price_cents: 2500, billing_unit: 'fortnight', booking_mode: 'whatever', currency: 'ZZZZ'
  });
  assert.equal(s.billing_unit, 'session');
  assert.equal(s.booking_mode, 'bookable');
  assert.equal(s.currency, 'usd');
  assert.equal(s.price_label, 'From $25/session');
  assert.equal(s.bookable, true);
});

test('negative prices cannot become a negative charge', () => {
  const q = pricing.quoteBooking({ service: { price_cents: -500, billing_unit: 'session' }, dogCount: 2 });
  assert.equal(q.total_cents, 0);
});
