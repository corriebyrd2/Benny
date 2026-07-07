const { test, expect } = require('@playwright/test');
const {
  resetAll,
  loginAdmin,
  registerCustomer,
  firstServiceId,
  createPublicBooking,
  getEmails,
  simulateStripeWebhook
} = require('./utils');

test.describe('bookings', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('public booking: creates row, emails owner + customer', async ({ request }) => {
    const body = await createPublicBooking(request, {
      owner_name: 'Alice',
      email: 'alice@test.local',
      dog_name: 'Spot'
    });
    expect(body).toMatchObject({
      id: expect.any(Number),
      message: 'Booking request submitted',
      amount_cents: expect.any(Number)
    });

    const toOwner = await getEmails(request, { subject: 'New booking request' });
    const toCustomer = await getEmails(request, { to: 'alice@test.local' });
    expect(toOwner.length).toBeGreaterThan(0);
    expect(toCustomer.length).toBeGreaterThan(0);
    expect(toCustomer[0].subject).toContain('Spot');
  });

  test('public booking: rejects missing fields', async ({ request }) => {
    const res = await request.post('/api/bookings', { data: { owner_name: 'Only Name' } });
    expect(res.status()).toBe(400);
  });

  test('public booking: rejects invalid service_id', async ({ request }) => {
    const res = await request.post('/api/bookings', {
      data: {
        owner_name: 'Alice',
        email: 'a@test.local',
        dog_name: 'Spot',
        service_id: 99999
      }
    });
    expect(res.status()).toBe(400);
  });

  test('email-only booking lookup no longer exists', async ({ request }) => {
    // Removed: knowing an email must never be enough to read someone else's
    // bookings. Registered customers use GET /my; guests are notified by email.
    await createPublicBooking(request, { email: 'LookUp@Test.Local', dog_name: 'Max' });
    const res = await request.post('/api/bookings/lookup', {
      data: { email: 'lookup@test.local' }
    });
    expect(res.status()).toBe(404);
  });

  test('customer can create a booking via /customer-book and see it in /my', async ({ request }) => {
    const { token, customer } = await registerCustomer(request, {
      email: 'portalbook@test.local'
    });
    const serviceId = await firstServiceId(request);

    const createRes = await request.post('/api/bookings/customer-book', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        service_id: serviceId,
        dog_name: customer.dogs[0].name,
        preferred_dates: 'next week'
      }
    });
    expect(createRes.status()).toBe(201);

    const myRes = await request.get('/api/bookings/my', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(myRes.status()).toBe(200);
    const list = await myRes.json();
    expect(list.length).toBe(1);
    expect(list[0].customer_id ?? list[0].customerId).toBeFalsy(); // /my filters already
    expect(list[0].service_id).toBe(serviceId);
  });

  test('admin can list, approve, then cancel a booking', async ({ request }) => {
    const booking = await createPublicBooking(request, {
      email: 'flow@test.local',
      dog_name: 'Biscuit'
    });

    const token = await loginAdmin(request);
    const list = await request.get('/api/bookings', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(list.status()).toBe(200);
    expect((await list.json()).length).toBe(1);

    const approve = await request.post(`/api/bookings/${booking.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(approve.status()).toBe(200);

    // Customer should get an "approved" email
    const approved = await getEmails(request, { to: 'flow@test.local' });
    expect(approved.some(e => /confirmed/i.test(e.subject))).toBe(true);

    const after = await request.get(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const updated = await after.json();
    expect(updated.status).toBe('confirmed');
    expect(updated.payment_status).toBe('requested');

    const cancel = await request.post(`/api/bookings/${booking.id}/cancel`, {
      headers: { authorization: `Bearer ${token}` },
      data: { reason: 'unexpected closure' }
    });
    expect(cancel.status()).toBe(200);

    const cancelled = await getEmails(request, { to: 'flow@test.local' });
    expect(cancelled.some(e => /cancelled/i.test(e.subject))).toBe(true);

    const final = await request.get(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = await final.json();
    expect(body.status).toBe('cancelled');
    expect(body.cancel_reason).toBe('unexpected closure');
  });

  test('approving twice sends only one confirmation email (idempotent)', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'idem@test.local' });
    const token = await loginAdmin(request);

    const first = await request.post(`/api/bookings/${booking.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(first.status()).toBe(200);
    expect((await first.json()).already_approved).toBeFalsy();

    const second = await request.post(`/api/bookings/${booking.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(second.status()).toBe(200);
    expect((await second.json()).already_approved).toBe(true);

    const confirmations = await getEmails(request, { to: 'idem@test.local' });
    expect(confirmations.filter(e => /confirmed/i.test(e.subject)).length).toBe(1);
  });

  test('cannot approve a cancelled booking', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'cxl@test.local' });
    const token = await loginAdmin(request);
    await request.post(`/api/bookings/${booking.id}/cancel`, {
      headers: { authorization: `Bearer ${token}` },
      data: { reason: 'closed' }
    });
    const res = await request.post(`/api/bookings/${booking.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(400);
  });

  test('admin can filter by status', async ({ request }) => {
    await createPublicBooking(request, { email: 'p1@test.local' });
    const b2 = await createPublicBooking(request, { email: 'p2@test.local' });

    const adminToken = await loginAdmin(request);
    await request.post(`/api/bookings/${b2.id}/approve`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });

    const confirmed = await request.get('/api/bookings?status=confirmed', {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const pending = await request.get('/api/bookings?status=pending', {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect((await confirmed.json()).length).toBe(1);
    expect((await pending.json()).length).toBe(1);
  });

  test('admin can delete', async ({ request }) => {
    const b = await createPublicBooking(request);
    const token = await loginAdmin(request);
    const del = await request.delete(`/api/bookings/${b.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);
    const got = await request.get(`/api/bookings/${b.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(got.status()).toBe(404);
  });

  test('rejects a booking whose end_date is before its start_date', async ({ request }) => {
    const serviceId = await firstServiceId(request);
    const res = await request.post('/api/bookings', {
      data: {
        owner_name: 'Alice', email: 'baddates@test.local', dog_name: 'Spot',
        service_id: serviceId, start_date: '2026-06-10', end_date: '2026-06-03'
      }
    });
    expect(res.status()).toBe(400);
  });

  test('admin update rejects an unknown status value', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'badstatus@test.local' });
    const token = await loginAdmin(request);
    const res = await request.put(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'banana' }
    });
    expect(res.status()).toBe(400);
  });

  test('cancelling expires the payment link and a stale payment does not revive the booking', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'stale@test.local' });
    const token = await loginAdmin(request);

    // Approve mints a Stripe checkout session (the "live link").
    await request.post(`/api/bookings/${booking.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    // Then cancel — this should expire the outstanding session.
    await request.post(`/api/bookings/${booking.id}/cancel`, {
      headers: { authorization: `Bearer ${token}` },
      data: { reason: 'customer changed plans' }
    });

    // Simulate the stale link being paid anyway (race). The booking must stay
    // cancelled; the owner is alerted to refund; the customer gets no receipt.
    await simulateStripeWebhook(request, {
      type: 'checkout.session.completed',
      booking_id: booking.id,
      payment_id: 'pi_stale'
    });

    const after = await request.get(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const row = await after.json();
    expect(row.status).toBe('cancelled');
    expect(row.payment_status).toBe('paid');

    const ownerAlerts = await getEmails(request, { subject: 'CANCELLED booking' });
    expect(ownerAlerts.length).toBeGreaterThanOrEqual(1);

    const customerReceipts = await getEmails(request, { to: 'stale@test.local' });
    expect(customerReceipts.some(e => /Payment received/i.test(e.subject))).toBe(false);
  });

  test('billing follows billing_unit, not the price label text', async ({ request }) => {
    const token = await loginAdmin(request);
    const services = await (await request.get('/api/services')).json();
    const boarding = services.find(s => s.billing_unit === 'night');
    expect(boarding, 'expected a seeded per-night service').toBeTruthy();

    // 3-night stay -> rate * 3.
    const b1 = await createPublicBooking(request, {
      email: 'bill1@test.local', service_id: boarding.id,
      start_date: '2026-06-01', end_date: '2026-06-04'
    });
    expect(b1.amount_cents).toBe(boarding.price_cents * 3);

    // Relabel so the text no longer contains "night"; billing_unit stays 'night'.
    const upd = await request.put(`/api/services/${boarding.id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { price_label: 'Flat rate per overnight stay' }
    });
    expect(upd.status()).toBe(200);

    const b2 = await createPublicBooking(request, {
      email: 'bill2@test.local', service_id: boarding.id,
      start_date: '2026-06-01', end_date: '2026-06-04'
    });
    // Still billed per night despite the label no longer saying "night".
    expect(b2.amount_cents).toBe(boarding.price_cents * 3);
  });

  test('email-verified single-booking fetch no longer exists', async ({ request }) => {
    // Removed: booking ids are sequential and emails are guessable, so
    // id + email was not real verification.
    const b = await createPublicBooking(request, { email: 'verify@test.local' });
    const res = await request.post(`/api/bookings/customer/${b.id}`, {
      data: { email: 'VERIFY@test.local' }
    });
    expect(res.status()).toBe(404);
  });
});
