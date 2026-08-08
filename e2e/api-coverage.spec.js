// Coverage for routes that didn't have a dedicated spec yet: newsletter
// subscribers, public site settings, the password-reset flow, and admin
// campaign sends. Plus a few cross-cutting checks that only made sense once
// every other suite had its own home (audit-log persistence, GET /payments
// /config visibility, photo edit + delete).

const { test, expect } = require('@playwright/test');
const {
  resetAll,
  loginAdmin,
  registerCustomer,
  createPublicBooking,
  getEmails,
  TINY_PNG,
  STRONG_PASSWORD
} = require('./utils');


test.describe('SendGrid event webhooks', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('persists events and updates booking delivery status', async ({ request }) => {
    const booking = await createPublicBooking(request, { email: 'deliverystatus@test.local' });

    const eventRes = await request.post('/api/sendgrid/events', {
      data: [{
        email: 'deliverystatus@test.local',
        event: 'delivered',
        timestamp: 1800000000,
        sg_event_id: `evt-${booking.id}`,
        sg_message_id: `msg-${booking.id}`,
        booking_id: String(booking.id),
        email_type: 'booking_received'
      }]
    });
    expect(eventRes.status()).toBe(202);
    await expect(eventRes.json()).resolves.toMatchObject({ received: 1, inserted: 1 });

    const adminToken = await loginAdmin(request);
    const bookingRes = await request.get(`/api/bookings/${booking.id}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(bookingRes.status()).toBe(200);
    await expect(bookingRes.json()).resolves.toMatchObject({
      id: booking.id,
      email_delivery_status: 'delivered',
      email_delivery_last_event: 'delivered'
    });

    const eventsRes = await request.get(`/api/sendgrid/events/booking/${booking.id}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(eventsRes.status()).toBe(200);
    const events = await eventsRes.json();
    expect(events[0]).toMatchObject({
      event_type: 'delivered',
      booking_id: booking.id,
      email_type: 'booking_received'
    });
  });
});

test.describe('subscribers (newsletter)', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('accepts a valid email and is idempotent on retry', async ({ request }) => {
    // Marketing consent is now mandatory and explicit; see e2e/legal.spec.js
    // for the refusal path.
    const a = await request.post('/api/subscribe',
      { data: { email: 'reader@test.local', marketing_consent: true } });
    expect(a.status()).toBe(200);

    // Second submit with the same address — no duplicate, still 200.
    const b = await request.post('/api/subscribe',
      { data: { email: 'READER@test.local', marketing_consent: true } });
    expect(b.status()).toBe(200);

    // Confirm there's only one row by sending a campaign and counting the BCC.
    const adminToken = await loginAdmin(request);
    const send = await request.post('/api/campaigns', {
      headers: { authorization: `Bearer ${adminToken}` },
      data: { subject: 'Hello', html: '<p>Hi</p>', plain: 'Hi' }
    });
    expect(send.status()).toBe(202);
    const body = await send.json();
    expect(body.recipientCount).toBe(1);
  });

  test('rejects malformed emails', async ({ request }) => {
    const cases = ['', 'no-at-sign', 'spaces in@email.com', 'a@b'];
    for (const email of cases) {
      const res = await request.post('/api/subscribe',
        { data: { email, marketing_consent: true } });
      expect(res.status(), `payload=${email}`).toBe(400);
    }
  });

  test('rate-limits after 20 attempts in a window', async ({ request }) => {
    let lastStatus = 0;
    for (let i = 0; i < 25; i++) {
      const res = await request.post('/api/subscribe', {
        data: { email: `flood-${i}@test.local`, marketing_consent: true }
      });
      lastStatus = res.status();
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

test.describe('site settings', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('public GET returns only verified values, never placeholders', async ({ request }) => {
    const res = await request.get('/api/settings');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.business_name).toBe('Benny and the Pets');
    // Contact details are no longer seeded — there is no truthful default —
    // so they must be absent rather than fictional.
    expect(body.contact_email).toBeUndefined();
    expect(body.contact_address_line1).toBeUndefined();
  });

  test('admin PUT updates whitelisted keys', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.put('/api/settings', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        business_name: 'Updated Name',
        // A real-looking number: the settings API now refuses to store a
        // directory-reserved 555 placeholder (see e2e/catalog-trust.spec.js).
        contact_phone_display: '(412) 867-5309'
      }
    });
    expect(res.status()).toBe(200);
    const out = await res.json();
    expect(out.business_name).toBe('Updated Name');
    expect(out.contact_phone_display).toBe('(412) 867-5309');

    // Public GET sees the change immediately.
    const pub = await request.get('/api/settings');
    expect((await pub.json()).business_name).toBe('Updated Name');
  });

  test('PUT without auth is rejected', async ({ request }) => {
    const res = await request.put('/api/settings', {
      data: { business_name: 'should not work' }
    });
    expect(res.status()).toBe(401);
  });

  test('PUT with no recognized keys returns 400', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.put('/api/settings', {
      headers: { authorization: `Bearer ${token}` },
      data: { not_a_real_key: 'x', also_not: 'y' }
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('password reset', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  // Pull the reset token out of the email body. The route renders both a text
  // and an html copy; either works.
  function tokenFromEmail(email) {
    const haystack = `${email.html}\n${email.text}`;
    const m = haystack.match(/[?&]reset=([0-9a-f]+)/i);
    return m ? m[1] : null;
  }

  test('forgot-password always returns 200, even for unknown email (no enumeration)', async ({ request }) => {
    const known = await request.post('/api/customer/forgot-password', {
      data: { email: 'nobody@test.local' }
    });
    expect(known.status()).toBe(200);

    // No email captured for an unknown address.
    const captured = await getEmails(request, { to: 'nobody@test.local' });
    expect(captured).toHaveLength(0);
  });

  test('end-to-end: request, reset, log in with the new password', async ({ request }) => {
    const { email } = await registerCustomer(request, { email: 'reset-flow@test.local' });

    const req1 = await request.post('/api/customer/forgot-password', { data: { email } });
    expect(req1.status()).toBe(200);

    const emails = await getEmails(request, { to: email });
    const reset = emails.find(e => /reset/i.test(e.subject));
    expect(reset).toBeTruthy();

    const token = tokenFromEmail(reset);
    expect(token).toBeTruthy();

    const update = await request.post('/api/customer/reset-password', {
      data: { token, password: 'brandnew123' }
    });
    expect(update.status()).toBe(200);

    // Login with the new password works.
    const fresh = await request.post('/api/customer/login', {
      data: { email, password: 'brandnew123' }
    });
    expect(fresh.status()).toBe(200);

    // The original password no longer works.
    const stale = await request.post('/api/customer/login', {
      data: { email, password: STRONG_PASSWORD }
    });
    expect(stale.status()).toBe(401);
  });

  test('reset token is single-use', async ({ request }) => {
    const { email } = await registerCustomer(request, { email: 'single-use@test.local' });

    await request.post('/api/customer/forgot-password', { data: { email } });
    const emails = await getEmails(request, { to: email });
    const token = tokenFromEmail(emails.find(e => /reset/i.test(e.subject)));

    const first = await request.post('/api/customer/reset-password', {
      data: { token, password: 'anothergood1' }
    });
    expect(first.status()).toBe(200);

    const second = await request.post('/api/customer/reset-password', {
      data: { token, password: 'replayed1234' }
    });
    expect(second.status()).toBe(400);
  });

  test('requesting a second reset invalidates the first email\'s token', async ({ request }) => {
    const { email } = await registerCustomer(request, { email: 'double-req@test.local' });

    await request.post('/api/customer/forgot-password', { data: { email } });
    await request.post('/api/customer/forgot-password', { data: { email } });

    const emails = await getEmails(request, { to: email });
    const both = emails.filter(e => /reset/i.test(e.subject));
    expect(both.length).toBe(2);
    const oldToken = tokenFromEmail(both[0]);
    const newToken = tokenFromEmail(both[1]);
    expect(oldToken).not.toBe(newToken);

    // The first link is dead.
    const dead = await request.post('/api/customer/reset-password', {
      data: { token: oldToken, password: 'firstpassA1' }
    });
    expect(dead.status()).toBe(400);

    // The second link still works.
    const ok = await request.post('/api/customer/reset-password', {
      data: { token: newToken, password: 'secondPassB2' }
    });
    expect(ok.status()).toBe(200);
  });

  test('reset-password is rate-limited so tokens can\'t be brute-forced', async ({ request }) => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request.post('/api/customer/reset-password', {
        data: { token: 'deadbeef'.repeat(8), password: 'whatever123' }
      });
      lastStatus = res.status();
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

test.describe('campaigns', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('admin sees subscriber count via /api/campaigns/stats', async ({ request }) => {
    await request.post('/api/subscribe', { data: { email: 's1@test.local', marketing_consent: true } });
    await request.post('/api/subscribe', { data: { email: 's2@test.local', marketing_consent: true } });

    const token = await loginAdmin(request);
    const res = await request.get('/api/campaigns/stats', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).subscriberCount).toBe(2);
  });

  test('campaign send rejects empty subject', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.post('/api/campaigns', {
      headers: { authorization: `Bearer ${token}` },
      data: { subject: '', html: '<p>hi</p>' }
    });
    expect(res.status()).toBe(400);
  });

  test('campaign send rejects empty html body', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.post('/api/campaigns', {
      headers: { authorization: `Bearer ${token}` },
      data: { subject: 'hi', html: '' }
    });
    expect(res.status()).toBe(400);
  });

  test('customer token cannot trigger a campaign', async ({ request }) => {
    const { token } = await registerCustomer(request, { email: 'no-campaigns@test.local' });
    const res = await request.post('/api/campaigns', {
      headers: { authorization: `Bearer ${token}` },
      data: { subject: 'evil', html: '<p>nope</p>' }
    });
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('photo metadata edit + delete', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('admin can edit caption and toggle homepage visibility', async ({ request }) => {
    const token = await loginAdmin(request);
    const upload = await request.post('/api/photos', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        photo: { name: 'p.png', mimeType: 'image/png', buffer: TINY_PNG },
        caption: 'first',
        layout: 'normal',
        show_on_homepage: '1'
      }
    });
    expect(upload.status()).toBe(201);
    const { id } = await upload.json();

    const update = await request.put(`/api/photos/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { caption: 'second', show_on_homepage: false }
    });
    expect(update.status()).toBe(200);

    // Public GET only returns homepage photos — hidden photo is gone.
    const pub = await request.get('/api/photos');
    const items = await pub.json();
    expect(items.find(p => p.id === id)).toBeFalsy();

    // Admin GET /all still sees it, with the updated caption.
    const all = await request.get('/api/photos/all', {
      headers: { authorization: `Bearer ${token}` }
    });
    const adminItems = await all.json();
    const found = adminItems.find(p => p.id === id);
    expect(found).toBeTruthy();
    expect(found.caption).toBe('second');
  });

  test('admin can delete an uploaded photo', async ({ request }) => {
    const token = await loginAdmin(request);
    const upload = await request.post('/api/photos', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        photo: { name: 'gone.png', mimeType: 'image/png', buffer: TINY_PNG }
      }
    });
    const { id } = await upload.json();

    const del = await request.delete(`/api/photos/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);

    const all = await request.get('/api/photos/all', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect((await all.json()).find(p => p.id === id)).toBeFalsy();
  });
});

test.describe('payments config endpoint', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('admin sees the configured flag and the publishable key (or null)', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.get('/api/payments/config', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('configured');
    expect(body).toHaveProperty('publishable_key');
  });

  test('config endpoint refuses unauthenticated callers', async ({ request }) => {
    const res = await request.get('/api/payments/config');
    expect(res.status()).toBe(401);
  });
});
