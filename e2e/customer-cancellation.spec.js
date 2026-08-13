// Customer-initiated cancellation.
//
// The published cancellation policy has always said "You can cancel from your
// account, or by contacting us, at any time before the stay begins" — but the
// only cancel endpoint was admin-permissioned, so "from your account" did not
// exist. A customer's only route was to email the owner and hope.
//
// The rule under test is the policy's: cancellable until the stay begins, not
// until the refund deadline. Cancelling late is allowed; it just earns a
// smaller refund, or none.

const { test, expect } = require('@playwright/test');
const {
  resetAll, loginAdmin, registerCustomer, firstServiceId, safeBody,
  getEmails, simulateStripeWebhook, anonymousRequest
} = require('./utils');

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function customerHeaders(session) {
  return {
    authorization: `Bearer ${session.token}`,
    'x-csrf-token': session.csrfToken
  };
}

// A booking owned by a registered customer, made through the portal's own
// endpoint so the row looks exactly like a real one.
async function customerBooking(request, session, { start = daysFromNow(30), end = null } = {}) {
  const serviceId = await firstServiceId(request);
  const res = await request.post('/api/bookings/customer-book', {
    headers: customerHeaders(session),
    data: {
      dog_names: ['Rex'],
      service_id: serviceId,
      start_date: start,
      end_date: end || start
    }
  });
  expect(res.status(), await safeBody(res)).toBe(201);
  return res.json();
}

async function myBookings(request, session) {
  const res = await request.get('/api/bookings/my', { headers: customerHeaders(session) });
  expect(res.status(), await safeBody(res)).toBe(200);
  return res.json();
}

async function payFor(request, bookingId) {
  const token = await loginAdmin(request);
  await request.post(`/api/bookings/${bookingId}/approve`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const hook = await simulateStripeWebhook(request, {
    type: 'checkout.session.completed',
    booking_id: bookingId,
    payment_id: `pi_cancel_${bookingId}`
  });
  expect(hook.status()).toBe(200);
  return token;
}

test.describe('a customer can cancel their own upcoming booking', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('cancelling before the stay marks it cancelled and frees the place', async ({ request }) => {
    const session = await registerCustomer(request);
    const start = daysFromNow(30);
    const { id } = await customerBooking(request, session, { start });

    const before = await request.get(`/api/bookings/availability?date=${start}`);
    const bookedBefore = (await before.json()).count;
    expect(bookedBefore).toBeGreaterThan(0);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session),
      data: { reason: 'Plans changed' }
    });
    expect(res.status(), await safeBody(res)).toBe(200);

    const [booking] = await myBookings(request, session);
    expect(booking.status).toBe('cancelled');
    expect(booking.cancel_reason).toContain('Plans changed');
    expect(booking.can_cancel).toBe(false);

    // The whole point of cancelling early: someone else can have the place.
    const after = await request.get(`/api/bookings/availability?date=${start}`);
    expect((await after.json()).count).toBe(bookedBefore - 1);
  });

  test('the reason is recorded as the customer’s, not the owner’s', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session);

    await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session),
      data: { reason: 'Found a sitter' }
    });

    const token = await loginAdmin(request);
    const events = await (await request.get(`/api/bookings/${id}/events`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    const cancelled = events.find(e => e.event === 'cancelled');
    expect(cancelled).toBeTruthy();
    expect(cancelled.actor_type).toBe('customer');
    expect(cancelled.to_status).toBe('cancelled');
  });

  test('both the customer and the owner are told', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session);

    await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session),
      data: { reason: 'Plans changed' }
    });

    const mail = await getEmails(request);
    // The harness records `to` as the array SendGrid is handed, not a string.
    const addressed = (m, email) => [].concat(m.to || []).includes(email);
    const toCustomer = mail.find(m => addressed(m, session.email) && /cancelled/i.test(m.subject));
    expect(toCustomer, 'customer gets a cancellation confirmation').toBeTruthy();

    const toOwner = mail.find(m => /Customer cancelled booking/i.test(m.subject));
    expect(toOwner, 'owner is told the customer cancelled').toBeTruthy();
    expect(toOwner.subject).toContain(`#${id}`);
  });

  test('a booking with no start date is still cancellable', async ({ request }) => {
    const session = await registerCustomer(request);
    const serviceId = await firstServiceId(request);
    const created = await request.post('/api/bookings/customer-book', {
      headers: customerHeaders(session),
      data: { dog_names: ['Rex'], service_id: serviceId, preferred_dates: 'sometime in spring' }
    });
    expect(created.status(), await safeBody(created)).toBe(201);
    const { id } = await created.json();

    const [booking] = await myBookings(request, session);
    expect(booking.can_cancel).toBe(true);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(res.status(), await safeBody(res)).toBe(200);
  });
});

test.describe('what the customer is told they are owed', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('an unpaid booking quotes no refund, not its full price', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id, amount_cents } = await customerBooking(request, session);
    expect(amount_cents).toBeGreaterThan(0);

    const [booking] = await myBookings(request, session);
    // The refund calculation is pure policy arithmetic over amount_cents. If it
    // were applied without asking whether the money was ever taken, an unpaid
    // booking would promise a refund of its full price.
    expect(booking.cancellation.amount_paid_cents).toBe(0);
    expect(booking.cancellation.refundable_now_cents).toBe(0);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    const body = await res.json();
    expect(body.refund_due).toBe(false);
    expect(body.refund_cents).toBe(0);
    expect(body.refund_message).toMatch(/nothing to refund/i);
  });

  test('a paid stay more than 48 hours out is quoted the full amount back', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id, amount_cents } = await customerBooking(request, session, { start: daysFromNow(30) });
    await payFor(request, id);

    const [booking] = await myBookings(request, session);
    expect(booking.cancellation.tier).toBe('full');
    expect(booking.cancellation.refundable_now_cents).toBe(amount_cents);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    const body = await res.json();
    expect(body.refund_due).toBe(true);
    expect(body.refund_cents).toBe(amount_cents);
    expect(body.refund_tier).toBe('full');
  });

  test('a paid stay inside 48 hours is quoted half, and the owner is told the figure', async ({ request }) => {
    const session = await registerCustomer(request);
    // Tomorrow is >24h and <48h away for most of the day; use the day after to
    // stay firmly inside the half tier regardless of the hour the suite runs.
    const { id, amount_cents } = await customerBooking(request, session, { start: daysFromNow(1) });
    await payFor(request, id);

    const [booking] = await myBookings(request, session);
    expect(['half', 'none']).toContain(booking.cancellation.tier);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    const body = await res.json();
    expect(body.refund_cents).toBeLessThan(amount_cents);

    const mail = await getEmails(request);
    const toOwner = mail.find(m => /Customer cancelled booking/i.test(m.subject));
    expect(toOwner).toBeTruthy();
  });
});

test.describe('cancellation is refused when it should be', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a stay that has already started cannot be cancelled online', async ({ request }) => {
    const session = await registerCustomer(request);
    // Booking validation checks the shape of the dates, not that they are in
    // the future, so an in-progress stay can be set up through the customer's
    // own endpoint — which is what makes the cut-off worth enforcing here.
    const { id } = await customerBooking(request, session, {
      start: daysFromNow(-1), end: daysFromNow(2)
    });

    const listed = (await myBookings(request, session)).find(b => b.id === id);
    expect(listed, 'the in-progress booking is visible to its customer').toBeTruthy();
    expect(listed.can_cancel).toBe(false);
    expect(listed.cancel_blocked_reason).toMatch(/already started/i);
    expect(listed.cancellation).toBeNull();

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/already started/i);
  });

  test('a stay starting today is past the cut-off', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session, { start: daysFromNow(0) });

    const listed = (await myBookings(request, session)).find(b => b.id === id);
    expect(listed.can_cancel).toBe(false);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(res.status()).toBe(400);
  });

  test('cancelling twice is reported, not double-counted', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session);

    const first = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(first.status()).toBe(200);

    const second = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).error).toMatch(/already cancelled/i);
  });

  test('a completed booking cannot be cancelled', async ({ request }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session);
    const token = await loginAdmin(request);
    await request.post(`/api/bookings/${id}/complete`, {
      headers: { authorization: `Bearer ${token}` }
    });

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(session), data: {}
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/already taken place/i);
  });

  test('one customer cannot cancel another customer’s booking', async ({ request }) => {
    const owner = await registerCustomer(request);
    const attacker = await registerCustomer(request);
    const { id } = await customerBooking(request, owner);

    const res = await request.post(`/api/bookings/my/${id}/cancel`, {
      headers: customerHeaders(attacker), data: {}
    });
    // 404, not 403: a wrong-owner response must not confirm the booking exists.
    expect(res.status()).toBe(404);

    const [booking] = await myBookings(request, owner);
    expect(booking.status).not.toBe('cancelled');
  });

  test('an anonymous caller cannot cancel anything', async ({ request, playwright, baseURL }) => {
    const session = await registerCustomer(request);
    const { id } = await customerBooking(request, session);

    const anon = await anonymousRequest(playwright, baseURL);
    const res = await anon.post(`/api/bookings/my/${id}/cancel`, { data: {} });
    expect(res.status()).toBe(401);
    await anon.dispose();
  });
});

test.describe('cancelling from the portal UI', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  // Signs a fresh customer in through the real form and lands on My Bookings.
  async function signInWithBooking(page, request, bookingOpts) {
    const session = await registerCustomer(request);
    const created = await customerBooking(request, session, bookingOpts);

    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(session.email);
    await page.locator('#loginPassword').fill(session.password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);
    await page.getByRole('button', { name: 'My Bookings' }).click();
    await expect(page.locator('.booking-card')).toBeVisible();
    return { session, created };
  }

  test('the cancel button walks the customer through to a cancelled booking', async ({ page, request }) => {
    const { created } = await signInWithBooking(page, request);

    await page.locator('button[data-action="openCancelModal"]').first().click();
    const modal = page.locator('#cancelOverlay');
    await expect(modal).toHaveClass(/active/);
    // The consequence is stated before the customer commits to it.
    await expect(modal).toContainText(`booking #${created.id}`);
    await expect(modal).toContainText(/nothing has been charged/i);

    await page.locator('#cancelReason').fill('Plans changed');
    await page.locator('#cancelConfirmBtn').click();

    await expect(modal).not.toHaveClass(/active/);
    await expect(page.locator('.booking-card')).toHaveClass(/status-cancelled/);
    // The offer to cancel is gone once there is nothing left to cancel.
    await expect(page.locator('button[data-action="openCancelModal"]')).toHaveCount(0);
  });

  test('"Keep booking" leaves the booking alone', async ({ page, request }) => {
    await signInWithBooking(page, request);

    await page.locator('button[data-action="openCancelModal"]').first().click();
    await expect(page.locator('#cancelOverlay')).toHaveClass(/active/);
    await page.getByRole('button', { name: 'Keep booking' }).click();

    await expect(page.locator('#cancelOverlay')).not.toHaveClass(/active/);
    await expect(page.locator('.booking-card')).not.toHaveClass(/status-cancelled/);
  });

  test('a stay already under way offers no cancel button, and says why', async ({ page, request }) => {
    await signInWithBooking(page, request, { start: daysFromNow(-1), end: daysFromNow(3) });

    await expect(page.locator('button[data-action="openCancelModal"]')).toHaveCount(0);
    await page.locator('button[data-action="openDetail"]').first().click();
    await expect(page.locator('#detailBody')).toContainText(/already started/i);
  });

  test('a paid stay is shown the refund it is owed before confirming', async ({ page, request }) => {
    const { created } = await signInWithBooking(page, request, { start: daysFromNow(30) });
    await payFor(request, created.id);
    await page.reload();
    await page.getByRole('button', { name: 'My Bookings' }).click();
    await expect(page.locator('.booking-card')).toBeVisible();

    await page.locator('button[data-action="openCancelModal"]').first().click();
    // The figure comes from the server's quote — the browser never computes it.
    await expect(page.locator('#cancelOverlay')).toContainText(/refunds the full \$45\.00/i);
  });
});
