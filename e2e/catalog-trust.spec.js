// Catalog integrity, pricing consistency end-to-end, and the absence of
// fabricated or placeholder content on every public surface.
//
// These are the regressions the original audit found on the live site:
//   * Homepage advertised 4 services; the API served 2.
//   * Daycare: homepage "$30/day", API price_cents 3000, API label "From $35/day".
//   * Placeholder address, phone and email published as if real.
//   * "500+ Happy Dogs", "12+ Years Experience", "100% Tail Wags" — unsupported,
//     and rendered as "0+" / "5%" in the deployed build.
//   * Four invented testimonials attributed to named people.
//   * Instagram and TikTok footer links pointing at href="#".

const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin, safeBody } = require('./utils');

test.describe('service catalog integrity', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('marketing cards and the booking catalog come from one source', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    await page.goto('/');

    const cards = page.locator('.services-grid .service-card');
    await expect(cards).toHaveCount(services.length);

    // Every card links to a real detail page and shows the API's price label.
    for (const service of services) {
      const card = page.locator('.service-card', { has: page.getByRole('heading', { name: service.name }) });
      await expect(card.locator('.service-price')).toContainText(service.price_label);
      await expect(card.getByRole('link', { name: service.name, exact: true }))
        .toHaveAttribute('href', `/services/${service.slug}`);
    }
  });

  test('every public service declares a booking mode and only bookable ones offer booking', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    expect(services.length).toBeGreaterThan(0);

    await page.goto('/');
    for (const service of services) {
      expect(['bookable', 'inquiry', 'unavailable']).toContain(service.booking_mode);
      const card = page.locator('.service-card', { has: page.getByRole('heading', { name: service.name }) });
      if (service.booking_mode === 'bookable') {
        await expect(card.getByRole('link', { name: new RegExp(`request ${service.name}`, 'i') })).toBeVisible();
      } else {
        await expect(card.locator('.service-status')).toBeVisible();
        await expect(card.getByRole('link', { name: /request/i })).toHaveCount(0);
      }
    }
  });

  test('a non-bookable service is refused by the booking API', async ({ request }) => {
    const token = await loginAdmin(request);
    const all = await (await request.get('/api/services/all', {
      headers: { Authorization: `Bearer ${token}` }
    })).json();

    const inquiryOnly = all.find(s => s.booking_mode === 'inquiry');
    expect(inquiryOnly, 'seed should include an enquiry-only service').toBeTruthy();

    const res = await request.post('/api/bookings', {
      data: {
        owner_name: 'Test Owner', email: 'catalog@test.local',
        dog_name: 'Rex', service_id: inquiryOnly.id
      }
    });
    expect(res.status(), await safeBody(res)).toBe(400);
    expect((await res.json()).error).toMatch(/not available for instant booking|Invalid service/i);
  });

  test('price_label cannot be written by an admin', async ({ request }) => {
    const token = await loginAdmin(request);
    const services = await (await request.get('/api/services')).json();
    const res = await request.put(`/api/services/${services[0].id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { price_label: 'From $1/night' }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/derived/i);
  });

  test('changing the price changes every label with it', async ({ page, request }) => {
    const token = await loginAdmin(request);
    const services = await (await request.get('/api/services')).json();
    const target = services.find(s => s.bookable);

    const put = await request.put(`/api/services/${target.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { price_cents: 5250 }
    });
    expect(put.status(), await safeBody(put)).toBe(200);

    const updated = (await (await request.get('/api/services')).json())
      .find(s => s.id === target.id);
    expect(updated.price_cents).toBe(5250);
    expect(updated.price_label).toContain('$52.50');

    // Homepage card, detail page and API all agree without any manual edit.
    await page.goto('/');
    const card = page.locator('.service-card', { has: page.getByRole('heading', { name: target.name }) });
    await expect(card.locator('.service-price')).toContainText('$52.50');

    await page.goto(`/services/${updated.slug}`);
    await expect(page.locator('.service-detail-price')).toContainText('$52.50');
  });

  test('the booked amount matches the advertised rate exactly', async ({ request }) => {
    const services = await (await request.get('/api/services')).json();
    const boarding = services.find(s => s.billing_unit === 'night' && s.bookable);
    test.skip(!boarding, 'no per-night bookable service seeded');

    const res = await request.post('/api/bookings', {
      data: {
        owner_name: 'Price Check', email: 'pricecheck@test.local',
        dog_name: 'Rex', service_id: boarding.id,
        start_date: '2026-03-01', end_date: '2026-03-04', dog_count: 2
      }
    });
    expect(res.status(), await safeBody(res)).toBe(201);
    // 3 nights x 2 dogs at the advertised per-night rate.
    expect((await res.json()).amount_cents).toBe(boarding.price_cents * 3 * 2);
  });
});

test.describe('no fabricated or placeholder content is published', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  const FABRICATIONS = [
    '123 Pawsome Lane',
    'Dogtown, CA 90210',
    'BENNY-PET',
    'woof@bennyandthepets.com',
    'Years Experience',
    'Tail Wags',
    'Happy Dogs',
    'Sarah M.',
    'Mike T.',
    'Jessica R.',
    'David K.',
    'Acres of safe, fenced play areas',
    'Max playing fetch',
    'Bella nap time',
    'Certified trainers'
  ];

  test('the homepage contains none of the invented facts or testimonials', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    for (const phrase of FABRICATIONS) {
      expect(html, `homepage still contains "${phrase}"`).not.toContain(phrase);
    }
  });

  test('no page publishes a 555 phone number', async ({ page }) => {
    for (const path of ['/', '/legal', '/legal/privacy']) {
      await page.goto(path);
      expect(await page.content(), `${path} contains a 555 number`).not.toMatch(/\(555\)/);
    }
  });

  test('unconfigured contact details are absent, not faked', async ({ page }) => {
    await page.goto('/');
    // With nothing verified, the contact block says so rather than inventing one.
    await expect(page.locator('.contact-info')).toContainText(/being confirmed/i);
    await expect(page.locator('.contact-info address')).toHaveCount(0);
  });

  test('social links are only rendered when a real https URL is configured', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('.social-links a');
    const count = await links.count();
    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      expect(href, 'a social link must never be a dead "#"').not.toBe('#');
      expect(href).toMatch(/^https:\/\//);
    }
  });

  test('the settings API refuses to store a placeholder or a dead link', async ({ request }) => {
    const token = await loginAdmin(request);
    const headers = { Authorization: `Bearer ${token}` };

    for (const [key, value] of [
      ['contact_phone_display', '(555) BENNY-PET'],
      ['contact_email', 'not-an-email'],
      ['instagram_url', '#'],
      ['tiktok_url', 'http://tiktok.com/@example']
    ]) {
      const res = await request.put('/api/settings', { headers, data: { [key]: value } });
      expect(res.status(), `${key}=${value} should be rejected`).toBe(400);
    }
  });

  test('a verified value is accepted and then published', async ({ page, request }) => {
    const token = await loginAdmin(request);
    const res = await request.put('/api/settings', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        contact_email: 'hello@bennyandthepetsboardingllc.test',
        instagram_url: 'https://www.instagram.com/example'
      }
    });
    expect(res.status(), await safeBody(res)).toBe(200);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'hello@bennyandthepetsboardingllc.test' })).toBeVisible();
    await expect(page.locator('.social-links a[href="https://www.instagram.com/example"]')).toHaveCount(1);
  });

  test('the launch check blocks while required business facts are missing', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.get('/api/settings/launch-check', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.blocking.map(b => b.key)).toContain('contact_phone_display');
  });

  test('the public settings API never serves an unverified value', async ({ request }) => {
    const res = await request.get('/api/settings');
    const settings = await res.json();
    expect(settings.contact_address_line1).toBeUndefined();
    expect(settings.contact_phone_display).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain('555');
    expect(JSON.stringify(settings)).not.toContain('Pawsome');
  });
});
