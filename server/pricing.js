// Single authoritative pricing source.
//
// Every surface that shows or charges money — homepage service cards, service
// detail pages, the booking form, availability quotes, admin views, Stripe line
// items, confirmation emails and receipts — derives its numbers from the
// functions here. Nothing formats a price by hand, and no formatted label is
// ever persisted: a stored label can drift from the amount actually charged
// (see migrations/0014), so labels are computed at read time from structured
// data.
//
// Structured model:
//   price_cents    integer, minor units, >= 0
//   currency       ISO-4217 lowercase (matches Stripe's convention)
//   billing_unit   'night' | 'day' | 'session'
//   price_is_from  true when the rate is a starting price ("From $45/night")
//   per-dog        every rate is per dog; a booking for N dogs multiplies by N

const MS_PER_DAY = 86400000;

const BILLING_UNITS = Object.freeze(['night', 'day', 'session']);
const BOOKING_MODES = Object.freeze(['bookable', 'inquiry', 'unavailable']);

const UNIT_SUFFIX = Object.freeze({
  night: '/night',
  day: '/day',
  session: '/session'
});

const UNIT_NOUN = Object.freeze({
  night: 'night',
  day: 'day',
  session: 'session'
});

const DEFAULT_CURRENCY = (process.env.PRICE_CURRENCY || 'usd').toLowerCase();

// Currencies whose minor unit is not 1/100. Extend if the business ever prices
// outside these; getting this wrong silently charges 100x.
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk']);

function normalizeCurrency(currency) {
  const c = String(currency || DEFAULT_CURRENCY).toLowerCase();
  return /^[a-z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}

function normalizeBillingUnit(unit) {
  return BILLING_UNITS.includes(unit) ? unit : 'session';
}

function normalizeBookingMode(mode) {
  return BOOKING_MODES.includes(mode) ? mode : 'bookable';
}

function minorUnitsPerMajor(currency) {
  return ZERO_DECIMAL.has(normalizeCurrency(currency)) ? 1 : 100;
}

// "$45", "$45.50". Whole amounts drop the decimals so marketing copy reads
// naturally; fractional amounts always show both digits.
function formatAmount(cents, currency = DEFAULT_CURRENCY) {
  const cur = normalizeCurrency(currency);
  const divisor = minorUnitsPerMajor(cur);
  const amount = Number(cents || 0) / divisor;
  const fractionDigits = divisor === 1 ? 0 : (Number.isInteger(amount) ? 0 : 2);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: cur.toUpperCase(),
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(amount);
}

// The public rate label for a service card — e.g. "From $45/night".
// This replaces the removed services.price_label column.
function priceLabel(service) {
  if (!service) return '';
  const unit = normalizeBillingUnit(service.billing_unit);
  const prefix = service.price_is_from === false ? '' : 'From ';
  return `${prefix}${formatAmount(service.price_cents, service.currency)}${UNIT_SUFFIX[unit]}`;
}

// Screen-reader/plain-language expansion of the same rate. "/night" is a visual
// shorthand; assistive tech should hear the whole sentence.
function priceLabelLong(service) {
  if (!service) return '';
  const unit = normalizeBillingUnit(service.billing_unit);
  const prefix = service.price_is_from === false ? '' : 'Starting at ';
  return `${prefix}${formatAmount(service.price_cents, service.currency)} per ${UNIT_NOUN[unit]}, per dog`;
}

// Whole nights between two YYYY-MM-DD dates. 0 when the range is empty or
// invalid. Dates are treated as calendar dates in UTC so a browser in any
// timezone that posts "2026-03-01" gets the same night count as the server.
function nightsBetween(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / MS_PER_DAY);
}

// How many billable units a date range represents for a given service.
//   night   -> number of nights (a 1-night stay is 1)
//   day     -> inclusive days (a same-day daycare booking is 1)
//   session -> always 1; sessions are flat regardless of dates
function billableQuantity(billingUnit, startDate, endDate) {
  const unit = normalizeBillingUnit(billingUnit);
  if (unit === 'session') return 1;
  if (!startDate || !endDate) return 1;
  const nights = nightsBetween(startDate, endDate);
  return unit === 'night' ? Math.max(1, nights) : Math.max(1, nights + 1);
}

// THE authoritative amount for a booking. Server-side only — the client never
// supplies a price. Returns an itemised quote so confirmations, Stripe line
// items and receipts can all show the same breakdown instead of re-deriving it.
function quoteBooking({ service, startDate, endDate, dogCount }) {
  const unit = normalizeBillingUnit(service && service.billing_unit);
  const currency = normalizeCurrency(service && service.currency);
  const unitAmountCents = Math.max(0, Math.round(Number(service && service.price_cents) || 0));
  const dogs = Math.max(1, Math.min(10, parseInt(dogCount, 10) || 1));
  const quantity = billableQuantity(unit, startDate, endDate);
  const subtotalCents = unitAmountCents * quantity * dogs;

  return {
    currency,
    billing_unit: unit,
    unit_amount_cents: unitAmountCents,
    quantity,
    dog_count: dogs,
    subtotal_cents: subtotalCents,
    // No tax/deposit/discount is configured for this business yet. They are
    // modelled explicitly so downstream code reads a total rather than assuming
    // subtotal === total; see docs/PRICING.md for what the owner must supply
    // before any of these can be non-zero.
    deposit_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    total_cents: subtotalCents,
    unit_label: `${formatAmount(unitAmountCents, currency)}/${UNIT_NOUN[unit]}`,
    total_label: formatAmount(subtotalCents, currency),
    description: buildQuoteDescription({ quantity, unit, dogs })
  };
}

function buildQuoteDescription({ quantity, unit, dogs }) {
  const unitPart = `${quantity} ${UNIT_NOUN[unit]}${quantity === 1 ? '' : 's'}`;
  const dogPart = `${dogs} dog${dogs === 1 ? '' : 's'}`;
  return `${unitPart} x ${dogPart}`;
}

// Refund owed for a cancellation, from the cancellation policy in
// content/legal. Expressed here so booking, admin and receipt code share one
// implementation instead of three rounding conventions.
//
// hoursBeforeStart >= 48  -> full refund
// 24 <= hours < 48        -> 50%
// hours < 24              -> no refund
// Rounding always favours the customer (Math.ceil on the refund).
function refundForCancellation({ amountPaidCents, hoursBeforeStart }) {
  const paid = Math.max(0, Math.round(Number(amountPaidCents) || 0));
  const hours = Number(hoursBeforeStart);
  if (!Number.isFinite(hours)) return { refund_cents: 0, retained_cents: paid, tier: 'unknown' };
  if (hours >= 48) return { refund_cents: paid, retained_cents: 0, tier: 'full' };
  if (hours >= 24) {
    const refund = Math.ceil(paid / 2);
    return { refund_cents: refund, retained_cents: paid - refund, tier: 'half' };
  }
  return { refund_cents: 0, retained_cents: paid, tier: 'none' };
}

// Stripe line items built from the same quote the customer was shown. Passing
// unit_amount x quantity (rather than a pre-multiplied total with quantity 1)
// means the Stripe dashboard, the receipt Stripe emails, and our own
// confirmation all show the identical breakdown.
function stripeLineItems({ service, quote, bookingId, dogName, authoritativeTotalCents }) {
  const name = (service && service.name) || 'Booking';
  const stored = authoritativeTotalCents === undefined || authoritativeTotalCents === null
    ? null
    : Math.max(0, Math.round(Number(authoritativeTotalCents) || 0));

  // The amount stored on the booking is what the customer agreed to. If an
  // admin manually adjusted it, or the service rate changed after the booking
  // was taken, the freshly computed quote will disagree — charge the stored
  // amount as a single line item rather than silently re-pricing at checkout.
  if (stored !== null && stored !== quote.total_cents) {
    return [{
      price_data: {
        currency: quote.currency,
        product_data: {
          name,
          description: `Booking #${bookingId} for ${dogName}`
        },
        unit_amount: stored
      },
      quantity: 1
    }];
  }

  return [{
    price_data: {
      currency: quote.currency,
      product_data: {
        name,
        description: `Booking #${bookingId} for ${dogName} - ${quote.description}`
      },
      unit_amount: quote.unit_amount_cents
    },
    quantity: quote.quantity * quote.dog_count
  }];
}

// Shape a services row for any public consumer. Computed fields only — callers
// must not read price columns directly, so that a future currency or unit
// change lands in one place.
function publicService(row) {
  const service = {
    ...row,
    billing_unit: normalizeBillingUnit(row.billing_unit),
    booking_mode: normalizeBookingMode(row.booking_mode),
    currency: normalizeCurrency(row.currency),
    price_cents: Math.max(0, Number(row.price_cents) || 0)
  };
  return {
    ...service,
    price_label: priceLabel(service),
    price_label_long: priceLabelLong(service),
    bookable: service.booking_mode === 'bookable'
  };
}

module.exports = {
  BILLING_UNITS,
  BOOKING_MODES,
  DEFAULT_CURRENCY,
  billableQuantity,
  formatAmount,
  nightsBetween,
  normalizeBillingUnit,
  normalizeBookingMode,
  normalizeCurrency,
  priceLabel,
  priceLabelLong,
  publicService,
  quoteBooking,
  refundForCancellation,
  stripeLineItems
};
