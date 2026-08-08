// Admin portal, driven through the browser.
//
// This was the thinnest area of the suite: four functional tests plus
// accessibility scans, against the panel the business is actually run from. The
// inline-handler conversion the CSP forced touched every button in here, and
// nothing proved those buttons still worked.

const { test, expect } = require('@playwright/test');
const {
  resetAll, loginAdmin, registerCustomer, firstServiceId, safeBody,
  simulateStripeWebhook, ADMIN_EMAIL, ADMIN_PASSWORD, TINY_PNG, TINY_PDF
} = require('./utils');

async function signIn(page) {
  await page.goto('/admin');
  await page.fill('#loginEmail', ADMIN_EMAIL);
  await page.fill('#loginPassword', ADMIN_PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#adminLayout')).toBeVisible();
}

async function seedBooking(request, overrides = {}) {
  const serviceId = await firstServiceId(request);
  const res = await request.post('/api/bookings', {
    data: {
      owner_name: 'Panel Customer',
      email: `panel-${Math.random().toString(36).slice(2, 8)}@test.local`,
      phone: '0123456789',
      dog_name: 'Rex',
      service_id: serviceId,
      start_date: '2026-10-20',
      end_date: '2026-10-22',
      message: 'He is nervous around bikes.',
      ...overrides
    }
  });
  expect(res.status(), await safeBody(res)).toBe(201);
  return res.json();
}

test.describe('sign-in and shell', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('bad credentials never reveal the panel', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', 'wrong-password');
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#adminLayout')).toBeHidden();
  });

  test('the session survives a reload and ends on sign-out', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.locator('#adminLayout')).toBeVisible();

    await page.locator('#logoutBtn').click();
    await expect(page.locator('#loginScreen')).toBeVisible();

    // Reloading after sign-out must NOT restore the panel — the session ended
    // on the server, not just in this tab.
    await page.reload();
    await expect(page.locator('#adminLayout')).toBeHidden();
  });

  test('every sidebar panel opens without error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await signIn(page);
    const panels = await page.locator('.sidebar-nav a[data-panel]').evaluateAll(
      els => els.map(e => e.dataset.panel));
    expect(panels.length).toBeGreaterThan(5);

    for (const panel of panels) {
      await page.click(`a[data-panel="${panel}"]`);
      await expect(page.locator(`#panel-${panel}`)).toBeVisible();
    }
    expect(errors, `console errors while opening panels:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('bookings workflow', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  // Every booking action lives behind "View", in the detail modal.
  async function openBooking(page) {
    await page.click('a[data-panel="bookings"]');
    const row = page.locator('#bookingsTable tr', { hasText: 'Panel Customer' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^view$/i }).click();
    await expect(page.locator('#modal')).toBeVisible();
    return page.locator('#modal');
  }

  test('a booking can be approved from the panel', async ({ page, request }) => {
    await seedBooking(request);
    await signIn(page);
    const modal = await openBooking(page);

    await modal.getByRole('button', { name: /approve/i }).click();
    await expect(page.locator('#bookingsTable tr', { hasText: 'Panel Customer' }))
      .toContainText('confirmed');

    // And the change is real, not just rendered.
    const token = await loginAdmin(request);
    const bookings = await (await request.get('/api/bookings', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(bookings[0].status).toBe('confirmed');
    expect(bookings[0].payment_status).toBe('requested');
  });

  test('a booking can be viewed in detail', async ({ page, request }) => {
    await seedBooking(request);
    await signIn(page);
    const modal = await openBooking(page);

    // The free-text note the customer wrote must reach the person acting on it.
    await expect(modal).toContainText('nervous around bikes');
    await page.locator('#modalClose').click();
    await expect(modal).toBeHidden();
  });

  test('a quote-breaking name cannot escape its attribute', async ({ page, request }) => {
    // The admin panel builds rows with string interpolation. escapeHtml used to
    // go through textContent, which leaves double quotes alone — so a value
    // like this one broke out of `value="..."` in the detail modal.
    await seedBooking(request, { dog_name: 'Rex" autofocus onfocus="window.__xss=1' });
    await signIn(page);
    await openBooking(page);

    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#modal')).toContainText('autofocus onfocus=');
  });

  test('cancelling asks for a reason and records it', async ({ page, request }) => {
    const { id } = await seedBooking(request);
    await signIn(page);
    const modal = await openBooking(page);

    await modal.getByRole('button', { name: /cancel request/i }).click();
    await page.locator('#cancelReasonInput').fill('Fully booked that weekend');
    await modal.getByRole('button', { name: /confirm cancellation/i }).click();
    await expect(modal).toBeHidden();

    const token = await loginAdmin(request);
    const booking = await (await request.get(`/api/bookings/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(booking.status).toBe('cancelled');
    expect(booking.cancel_reason).toContain('Fully booked');
  });

  test('the filter narrows the list', async ({ page, request }) => {
    const first = await seedBooking(request, { email: 'filter-a@test.local' });
    await seedBooking(request, { email: 'filter-b@test.local' });

    const token = await loginAdmin(request);
    await request.post(`/api/bookings/${first.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });

    await signIn(page);
    await page.click('a[data-panel="bookings"]');
    await expect(page.locator('#bookingsTable tr')).toHaveCount(2);

    await page.selectOption('#bookingFilter', 'pending');
    await expect(page.locator('#bookingsTable tr')).toHaveCount(1);
  });
});

test.describe('services', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a price change from the panel reaches the public homepage', async ({ page, request }) => {
    await signIn(page);
    await page.click('a[data-panel="services"]');

    const card = page.locator('.service-mgmt-card', { hasText: 'Overnight Boarding' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /edit/i }).click();
    await expect(page.locator('#modal')).toBeVisible();

    await page.locator('#svcPriceCents').fill('6250');
    await page.locator('#modal').getByRole('button', { name: /save changes/i }).click();
    await expect(page.locator('#modal')).toBeHidden();

    // The label is derived, so the homepage must follow with no second edit.
    const services = await (await request.get('/api/services')).json();
    const boarding = services.find(s => s.name === 'Overnight Boarding');
    expect(boarding.price_cents).toBe(6250);
    expect(boarding.price_label).toContain('$62.50');

    await page.goto('/');
    const publicCard = page.locator('.service-card', {
      has: page.getByRole('heading', { name: 'Overnight Boarding' })
    });
    await expect(publicCard.locator('.service-price')).toContainText('$62.50');
  });
});

test.describe('reviews and enquiries moderation', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('an approved review appears publicly, a rejected one does not', async ({ page, request }) => {
    await request.post('/api/reviews', {
      data: { reviewer_name: 'Approve Me', rating: 5, review_text: 'A genuinely lovely stay for our dog.' }
    });
    await request.post('/api/reviews', {
      data: { reviewer_name: 'Reject Me', rating: 1, review_text: 'Spam spam spam spam spam spam.' }
    });

    await signIn(page);
    await page.click('a[data-panel="reviews"]');

    // The panel filters to Pending by default, so a moderated review leaves
    // the list. Wait for that before acting on the next row — the table is
    // re-rendered wholesale and a click on a detached row goes nowhere.
    await page.locator('#reviewsTable tr', { hasText: 'Approve Me' })
      .getByRole('button', { name: /^approve$/i }).click();
    await expect(page.locator('#reviewsTable tr', { hasText: 'Approve Me' })).toHaveCount(0);

    await page.locator('#reviewsTable tr', { hasText: 'Reject Me' })
      .getByRole('button', { name: /^reject$/i }).click();
    await expect(page.locator('#reviewsTable tr', { hasText: 'Reject Me' })).toHaveCount(0);

    const published = await (await request.get('/api/reviews')).json();
    expect(published.map(r => r.reviewer_name)).toEqual(['Approve Me']);

    await page.goto('/');
    await expect(page.locator('.testimonial-card')).toHaveCount(1);
    await expect(page.locator('.testimonial-card')).toContainText('Approve Me');
  });
});

test.describe('customer records', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a client and their documents are visible to an admin', async ({ page, request }) => {
    const customer = await registerCustomer(request, {
      email: 'visible@test.local', dog_name: 'Paperwork'
    });
    const headers = { authorization: `Bearer ${customer.token}` };
    const dogs = await (await request.get('/api/dogs', { headers })).json();
    await request.post(`/api/dogs/${dogs[0].id}/documents`, {
      headers,
      multipart: { document: { name: 'vaccines.pdf', mimeType: 'application/pdf', buffer: TINY_PDF } }
    });

    await signIn(page);
    await page.click('a[data-panel="clients"]');
    await expect(page.locator('#clientsList')).toContainText('visible@test.local');
    await expect(page.locator('#clientsList')).toContainText('Paperwork');
  });
});

test.describe('settings', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a verified contact detail saved here appears on the homepage', async ({ page }) => {
    await signIn(page);
    await page.click('a[data-panel="settings"]');

    await page.locator('#set_contact_email').fill('hello@bennyandthepetsboardingllc.test');
    await page.locator('#settingsForm button[type="submit"]').click();
    await expect(page.locator('#toastContainer')).toContainText(/saved/i);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'hello@bennyandthepetsboardingllc.test' }))
      .toBeVisible();
  });

  test('a placeholder value is refused, with the reason and the field marked', async ({ page }) => {
    await signIn(page);
    await page.click('a[data-panel="settings"]');

    await page.locator('#set_contact_phone_display').fill('(555) BENNY-PET');
    await page.locator('#settingsForm button[type="submit"]').click();

    // The toast carries the reason rather than failing silently...
    await expect(page.locator('#toastContainer')).toContainText(/placeholder/i);
    // ...and the offending field is identifiable without reading it.
    await expect(page.locator('#set_contact_phone_display')).toHaveClass(/is-rejected/);
  });

  test('every launch-required business fact is editable here', async ({ page, request }) => {
    await signIn(page);
    await page.click('a[data-panel="settings"]');

    // The form is generated from the server's catalogue; drift between the two
    // is what left `service_area` and `emergency_contact` required but with
    // nowhere to type them.
    const token = await loginAdmin(request);
    const { fields } = await (await request.get('/api/settings/admin', {
      headers: { authorization: `Bearer ${token}` }
    })).json();

    for (const field of fields) {
      await expect(page.locator(`#set_${field.key}`), `no input for ${field.key}`).toHaveCount(1);
    }
    expect(fields.some(f => f.key === 'emergency_contact' && f.required === 'launch')).toBe(true);
  });

  test('the launch checklist names what is still missing', async ({ page }) => {
    await signIn(page);
    await page.click('a[data-panel="settings"]');

    // A fresh install has no verified business facts, so the panel must say so
    // rather than looking ready.
    const status = page.locator('#launchStatus');
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(/blocked/);
    await expect(status).toContainText(/before launch/i);
    await expect(status).toContainText('Verified phone number');
  });
});
