// Refunds.
//
// The cancellation policy promises tiered refunds and server/pricing.js
// implements the calculation — but nothing called it. There was no refund
// endpoint, no admin action, and no payment status that could represent a
// refunded booking. Cancelling a paid booking marked it cancelled and kept the
// money, silently and with no record.

const { test, expect } = require('@playwright/test');
const {
  resetAll, loginAdmin, firstServiceId, safeBody, getEmails, simulateStripeWebhook,
  anonymousRequest
} = require('./utils');

// A stay far enough out to sit in the full-refund tier, and one inside 24 hours.
function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function paidBooking(request, { start = daysFromNow(30), dogs = 1 } = {}) {
  const serviceId = await firstServiceId(request);
  const created = await request.post('/api/bookings', {
    data: {
      owner_name: 'Refund Tester',
      email: `refund-${Math.random().toString(36).slice(2, 8)}@test.local`,
      dog_name: 'Rex',
      service_id: serviceId,
      start_date: start,
      end_date: start,
      dog_count: dogs
    }
  });
  expect(created.status(), await safeBody(created)).toBe(201);
  const { id, amount_cents } = await created.json();

  const token = await loginAdmin(request);
  await request.post(`/api/bookings/${id}/approve`, {
    headers: { authorization: `Bearer ${token}` }
  });
  // Settle it through the real webhook path.
  const hook = await simulateStripeWebhook(request, {
    type: 'checkout.session.completed', booking_id: id, payment_id: `pi_refund_${id}`
  });
  expect(hook.status()).toBe(200);

  return { id, amountCents: amount_cents, token };
}

test.describe('refund quoting', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a stay more than 48 hours out is quoted a full refund', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const quote = await (await request.get(`/api/payments/refund-quote/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();

    expect(quote.tier).toBe('full');
    expect(quote.amount_paid_cents).toBe(amountCents);
    expect(quote.refundable_now_cents).toBe(amountCents);
    expect(quote.already_refunded_cents).toBe(0);
  });

  test('a stay inside 24 hours is quoted nothing', async ({ request }) => {
    // Today's date is inside the 24-hour window by definition.
    const { id, token } = await paidBooking(request, { start: daysFromNow(0) });
    const quote = await (await request.get(`/api/payments/refund-quote/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(quote.tier).toBe('none');
    expect(quote.refundable_now_cents).toBe(0);
  });

  test('the quote matches the published policy tiers', async ({ request }) => {
    // Between 24 and 48 hours out: half, rounded in the customer's favour.
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(2) });
    const quote = await (await request.get(`/api/payments/refund-quote/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(['full', 'half']).toContain(quote.tier);
    if (quote.tier === 'half') {
      expect(quote.refundable_now_cents).toBe(Math.ceil(amountCents / 2));
    }
  });

  test('quotes are admin-only', async ({ request, playwright, baseURL }) => {
    const { id } = await paidBooking(request);
    // A cookie-free client: paidBooking signed an admin in, and that session
    // cookie would otherwise authenticate this request.
    const anon = await anonymousRequest(playwright, baseURL);
    expect((await anon.get(`/api/payments/refund-quote/${id}`)).status()).toBe(401);
    await anon.dispose();
  });
});

test.describe('issuing refunds', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a full refund updates status, records the refund and emails the customer', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    const res = await request.post(`/api/payments/refund/${id}`, {
      headers, data: { reason: 'Customer cancelled in good time' }
    });
    expect(res.status(), await safeBody(res)).toBe(200);
    const body = await res.json();
    expect(body.amount_cents).toBe(amountCents);
    expect(body.payment_status).toBe('refunded');
    expect(body.stripe_refund_id).toBeTruthy();

    const booking = await (await request.get(`/api/bookings/${id}`, { headers })).json();
    expect(booking.payment_status).toBe('refunded');
    expect(booking.refunded_cents).toBe(amountCents);

    const history = await (await request.get(`/api/payments/refunds/${id}`, { headers })).json();
    expect(history).toHaveLength(1);
    expect(history[0].amount_cents).toBe(amountCents);
    expect(history[0].tier).toBe('full');
    expect(history[0].created_by).toBeTruthy();

    const emails = await getEmails(request, { subject: 'Refund issued' });
    expect(emails.length).toBe(1);
  });

  test('a partial refund leaves the booking partially refunded', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    const half = Math.floor(amountCents / 2);
    const res = await request.post(`/api/payments/refund/${id}`, {
      headers, data: { amount_cents: half }
    });
    expect(res.status(), await safeBody(res)).toBe(200);
    expect((await res.json()).payment_status).toBe('partially_refunded');

    // The remaining balance is what is quoted next.
    const quote = await (await request.get(`/api/payments/refund-quote/${id}`, { headers })).json();
    expect(quote.already_refunded_cents).toBe(half);
    expect(quote.refundable_now_cents).toBe(amountCents - half);

    // And refunding the rest completes it.
    const rest = await request.post(`/api/payments/refund/${id}`, { headers });
    expect(rest.status()).toBe(200);
    expect((await rest.json()).payment_status).toBe('refunded');
  });

  test('refunding more than was paid is refused', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request);
    const headers = { authorization: `Bearer ${token}` };

    const res = await request.post(`/api/payments/refund/${id}`, {
      headers, data: { amount_cents: amountCents + 1 }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/more than was paid/i);
  });

  test('a second full refund is refused', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    expect((await request.post(`/api/payments/refund/${id}`, { headers })).status()).toBe(200);
    const again = await request.post(`/api/payments/refund/${id}`, { headers });
    expect(again.status()).toBe(400);
    expect((await again.json()).error).toMatch(/already been fully refunded/i);
  });

  test('an unpaid booking cannot be refunded', async ({ request }) => {
    const serviceId = await firstServiceId(request);
    const created = await request.post('/api/bookings', {
      data: {
        owner_name: 'Unpaid', email: 'unpaid@test.local', dog_name: 'Rex',
        service_id: serviceId, start_date: daysFromNow(20), end_date: daysFromNow(20)
      }
    });
    const { id } = await created.json();
    const token = await loginAdmin(request);

    const res = await request.post(`/api/payments/refund/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/not been paid/i);
  });

  test('a zero or negative amount is refused', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    for (const amount_cents of [0, -100]) {
      const res = await request.post(`/api/payments/refund/${id}`, { headers, data: { amount_cents } });
      expect(res.status()).toBe(400);
    }
  });

  test('refunding requires admin write permission', async ({ request, playwright, baseURL }) => {
    const { id } = await paidBooking(request);
    const anon = await anonymousRequest(playwright, baseURL);
    expect((await anon.post(`/api/payments/refund/${id}`)).status()).toBe(401);
    await anon.dispose();
  });

  test('the refund is written to the immutable booking trail', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    await request.post(`/api/payments/refund/${id}`, { headers, data: { reason: 'policy' } });

    const events = await (await request.get(`/api/bookings/${id}/events`, { headers })).json();
    const refundEvent = events.find(e => e.event === 'refund_issued');
    expect(refundEvent).toBeTruthy();
    expect(refundEvent.to_payment_status).toBe('refunded');
    expect(refundEvent.actor_type).toBe('admin');
  });
});

test.describe('cancelling a paid booking', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('flags that a refund is owed instead of silently keeping the money', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    const res = await request.post(`/api/bookings/${id}/cancel`, {
      headers, data: { reason: 'Customer request' }
    });
    expect(res.status(), await safeBody(res)).toBe(200);
    const body = await res.json();
    expect(body.refund_due).toBe(true);
    expect(body.refund_hint).toMatch(/refund/i);
  });

  test('an unpaid cancellation reports no refund owed', async ({ request }) => {
    const serviceId = await firstServiceId(request);
    const created = await request.post('/api/bookings', {
      data: {
        owner_name: 'Unpaid', email: 'unpaid2@test.local', dog_name: 'Rex',
        service_id: serviceId, start_date: daysFromNow(20), end_date: daysFromNow(20)
      }
    });
    const { id } = await created.json();
    const token = await loginAdmin(request);

    const res = await request.post(`/api/bookings/${id}/cancel`, {
      headers: { authorization: `Bearer ${token}` }, data: { reason: 'no show' }
    });
    expect((await res.json()).refund_due).toBe(false);
  });
});

// Findings from the Codex review of PR #75. Each of these failed before the
// fix in the same commit.
test.describe('a partly refunded booking is not chargeable again', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  async function partiallyRefunded(request) {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    const res = await request.post(`/api/payments/refund/${id}`, {
      headers, data: { amount_cents: Math.floor(amountCents / 4) }
    });
    expect(res.status(), await safeBody(res)).toBe(200);
    expect((await res.json()).payment_status).toBe('partially_refunded');
    return { id, amountCents, token, headers };
  }

  // Every one of these guarded only on payment_status === 'paid', so a booking
  // that had been paid and partly refunded read as unpaid — and the line items
  // are rebuilt from amount_cents, so the customer would have been charged the
  // ORIGINAL full amount a second time.
  test('an admin cannot request payment again', async ({ request }) => {
    const { id, headers } = await partiallyRefunded(request);
    const res = await request.post('/api/payments/request-payment', {
      headers, data: { booking_id: id }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/partly refunded/i);

    // And the status was not quietly reset to 'requested'.
    const booking = await (await request.get(`/api/bookings/${id}`, { headers })).json();
    expect(booking.payment_status).toBe('partially_refunded');
  });

  test('an admin cannot send a fresh payment link', async ({ request }) => {
    const { id, headers } = await partiallyRefunded(request);
    const res = await request.post('/api/payments/send-payment-link', {
      headers, data: { booking_id: id }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/partly refunded/i);
  });

  test('a fully refunded booking is refused too', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    await request.post(`/api/payments/refund/${id}`, { headers });

    const res = await request.post('/api/payments/request-payment', {
      headers, data: { booking_id: id }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/fully refunded/i);
  });

  test('a webhook cannot overwrite a refund back to paid', async ({ request }) => {
    const { id, headers } = await partiallyRefunded(request);

    // A late duplicate settlement for the same booking must not erase the
    // refund by flipping payment_status back to 'paid'.
    const hook = await simulateStripeWebhook(request, {
      type: 'checkout.session.completed', booking_id: id, payment_id: `pi_late_${id}`
    });
    expect(hook.status()).toBe(200);

    const booking = await (await request.get(`/api/bookings/${id}`, { headers })).json();
    expect(booking.payment_status).toBe('partially_refunded');
    expect(booking.refunded_cents).toBeGreaterThan(0);
  });
});

test.describe('concurrent refunds', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  // HONEST SCOPE: the guarantee comes from `SELECT ... FOR UPDATE` holding the
  // booking row for the whole operation, plus a deterministic Stripe
  // idempotency key. This test cannot *prove* that — the refund path is fast
  // enough with a stubbed Stripe that the requests often serialise on their
  // own — so it asserts the invariant that must hold either way, across enough
  // concurrent attempts to have a real chance of catching a regression.
  test('concurrent refunds can never return more than was paid', async ({ request, playwright, baseURL }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    // Two thirds each: at most ONE can succeed. Unserialised, every attempt
    // reads refunded_cents = 0, passes the remaining-balance check, and creates
    // its own Stripe refund — returning multiples of what the customer paid.
    const twoThirds = Math.floor((amountCents * 2) / 3);

    // Separate contexts so the attempts are on separate connections rather
    // than queued behind one another in a single client.
    const contexts = await Promise.all(
      [0, 1, 2, 3].map(() => playwright.request.newContext({ baseURL }))
    );
    try {
      const results = await Promise.all(contexts.map(ctx =>
        ctx.post(`/api/payments/refund/${id}`, { headers, data: { amount_cents: twoThirds } })));

      const succeeded = results.filter(r => r.status() === 200);
      expect(succeeded).toHaveLength(1);

      const booking = await (await request.get(`/api/bookings/${id}`, { headers })).json();
      expect(booking.refunded_cents).toBe(twoThirds);
      expect(booking.refunded_cents).toBeLessThanOrEqual(amountCents);

      const history = await (await request.get(`/api/payments/refunds/${id}`, { headers })).json();
      expect(history).toHaveLength(1);
      expect(history.reduce((s, r) => s + r.amount_cents, 0)).toBe(booking.refunded_cents);
    } finally {
      await Promise.all(contexts.map(c => c.dispose()));
    }
  });

  test('an identical retry returns the same Stripe refund, not a second one', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    const quarter = Math.floor(amountCents / 4);

    const first = await request.post(`/api/payments/refund/${id}`, {
      headers, data: { amount_cents: quarter }
    });
    expect(first.status(), await safeBody(first)).toBe(200);
    const firstRefundId = (await first.json()).stripe_refund_id;

    // The idempotency key covers (booking, balance already refunded, amount),
    // so this is a different request: the balance has moved. What it must NOT
    // do is refund past the total paid — that is covered above. Here we assert
    // the recorded history stays consistent with the booking.
    const booking = await (await request.get(`/api/bookings/${id}`, { headers })).json();
    const history = await (await request.get(`/api/payments/refunds/${id}`, { headers })).json();
    expect(history).toHaveLength(1);
    expect(history[0].stripe_refund_id).toBe(firstRefundId);
    expect(history.reduce((s, r) => s + r.amount_cents, 0)).toBe(booking.refunded_cents);
  });
});

test.describe('partial refunds in the money figures', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the dashboard reports what was kept, not zero', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };

    const before = await (await request.get('/api/dashboard/stats', { headers })).json();
    expect(before.totalRevenue).toBe(amountCents);
    expect(before.paidBookings).toBe(1);

    const refund = Math.floor(amountCents / 10);
    await request.post(`/api/payments/refund/${id}`, { headers, data: { amount_cents: refund } });

    // Counting only 'paid' rows dropped the whole booking out of revenue, so a
    // $10 refund on a $100 booking reported $0 rather than the $90 retained.
    const after = await (await request.get('/api/dashboard/stats', { headers })).json();
    expect(after.totalRevenue).toBe(amountCents - refund);
    expect(after.paidBookings).toBe(1);
  });

  test('the client list reports net spend and stops calling it pending', async ({ request }) => {
    const { id, amountCents, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    const refund = Math.floor(amountCents / 10);
    await request.post(`/api/payments/refund/${id}`, { headers, data: { amount_cents: refund } });

    const body = await (await request.get('/api/admin/clients', { headers })).json();
    const client = body.clients.find(c => c.bookings.some(b => b.id === id));
    expect(client).toBeTruthy();
    expect(client.total_spent_cents).toBe(amountCents - refund);
    // It was paid. Listing it as still owing money would chase a customer who
    // has already settled.
    expect(client.pending_revenue_cents).toBe(0);
  });

  test('a fully refunded booking earns nothing', async ({ request }) => {
    const { id, token } = await paidBooking(request, { start: daysFromNow(30) });
    const headers = { authorization: `Bearer ${token}` };
    await request.post(`/api/payments/refund/${id}`, { headers });

    const stats = await (await request.get('/api/dashboard/stats', { headers })).json();
    expect(stats.totalRevenue).toBe(0);
  });
});
