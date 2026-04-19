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

test.describe('payments', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('admin sends payment link: returns checkout URL and emails customer', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'pay1@test.local' });
    const token = await loginAdmin(request);

    const res = await request.post('/api/payments/send-payment-link', {
      headers: { authorization: `Bearer ${token}` },
      data: { booking_id: booking.id }
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.checkout_url).toMatch(/^https:\/\/stripe\.test\/checkout\//);

    const emails = await getEmails(request, { to: 'pay1@test.local' });
    const linkEmail = emails.find(e => /payment link/i.test(e.subject));
    expect(linkEmail, 'expected payment-link email').toBeTruthy();
    expect(linkEmail.html).toContain(body.checkout_url);
  });

  test('webhook checkout.session.completed flips booking to paid + sends receipts', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'webhook1@test.local' });
    const adminToken = await loginAdmin(request);

    const hook = await simulateStripeWebhook(request, {
      type: 'checkout.session.completed',
      booking_id: booking.id,
      payment_id: 'pi_test_abc'
    });
    expect(hook.status()).toBe(200);

    const after = await request.get(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const row = await after.json();
    expect(row.payment_status).toBe('paid');
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_id).toBe('pi_test_abc');

    const customerEmails = await getEmails(request, { to: 'webhook1@test.local' });
    expect(customerEmails.some(e => /Payment received/i.test(e.subject))).toBe(true);

    const ownerEmails = await getEmails(request, { subject: 'Payment received' });
    expect(ownerEmails.length).toBeGreaterThanOrEqual(1);
  });

  test('duplicate webhook does not double-email or double-update', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'dup@test.local' });

    await simulateStripeWebhook(request, {
      type: 'checkout.session.completed',
      booking_id: booking.id,
      payment_id: 'pi_test_dup'
    });
    await simulateStripeWebhook(request, {
      type: 'payment_intent.succeeded',
      booking_id: booking.id,
      payment_id: 'pi_test_dup'
    });

    const receipts = await getEmails(request, { to: 'dup@test.local' });
    const paymentReceipts = receipts.filter(e => /Payment received/i.test(e.subject));
    expect(paymentReceipts.length).toBe(1);
  });

  test('webhook with bad signature is rejected', async ({ request }) => {
    const res = await request.post('/api/payments/webhook', {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=bad'
      },
      data: { fake: true }
    });
    expect(res.status()).toBe(400);
  });

  test('customer-checkout creates a session for their own booking', async ({ request }) => {
    const { token, customer } = await registerCustomer(request, { email: 'customerpay@test.local' });
    const serviceId = await firstServiceId(request);

    const created = await request.post('/api/bookings/customer-book', {
      headers: { authorization: `Bearer ${token}` },
      data: { service_id: serviceId, dog_name: customer.dogs[0].name }
    });
    const { id: bookingId } = await created.json();

    const checkout = await request.post('/api/payments/customer-checkout', {
      headers: { authorization: `Bearer ${token}` },
      data: { booking_id: bookingId }
    });
    expect(checkout.status()).toBe(200);
    const body = await checkout.json();
    expect(body.checkout_url).toMatch(/^https:\/\/stripe\.test\/checkout\//);
  });

  test('customer-checkout refuses another customer\'s booking', async ({ request }) => {
    const a = await registerCustomer(request, { email: 'a@test.local' });
    const b = await registerCustomer(request, { email: 'b@test.local' });
    const serviceId = await firstServiceId(request);

    const created = await request.post('/api/bookings/customer-book', {
      headers: { authorization: `Bearer ${a.token}` },
      data: { service_id: serviceId, dog_name: a.customer.dogs[0].name }
    });
    const { id: bookingId } = await created.json();

    const res = await request.post('/api/payments/customer-checkout', {
      headers: { authorization: `Bearer ${b.token}` },
      data: { booking_id: bookingId }
    });
    expect(res.status()).toBe(404);
  });

  test('already-paid booking cannot be paid again', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'alreadypaid@test.local' });
    await simulateStripeWebhook(request, {
      type: 'checkout.session.completed',
      booking_id: booking.id,
      payment_id: 'pi_first'
    });

    const token = await loginAdmin(request);
    const res = await request.post('/api/payments/create-payment-intent', {
      headers: { authorization: `Bearer ${token}` },
      data: { booking_id: booking.id }
    });
    expect(res.status()).toBe(400);
  });
});
