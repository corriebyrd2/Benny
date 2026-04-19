const { test, expect } = require('@playwright/test');
const { resetAll } = require('./utils');

test.describe('homepage + static pages', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('serves index.html with seeded services rendered', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Benny/i);
    // Four services are seeded; wait for dynamic load from /api/services
    await expect(page.locator('.services-grid .service-card')).toHaveCount(4, { timeout: 10_000 });
    await expect(page.getByText('Overnight Boarding')).toBeVisible();
    await expect(page.getByText('Doggy Daycare')).toBeVisible();
  });

  test('admin page loads', async ({ page }) => {
    await page.goto('/admin');
    // Admin SPA renders a login form or dashboard shell
    await expect(page.locator('body')).toBeVisible();
  });

  test('customer portal page loads', async ({ page }) => {
    await page.goto('/my-bookings');
    await expect(page.locator('body')).toBeVisible();
  });

  test('healthz reports ok', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('does not leak server.js or package.json', async ({ request }) => {
    const a = await request.get('/server.js');
    const b = await request.get('/package.json');
    expect(a.status()).toBe(404);
    expect(b.status()).toBe(404);
  });
});
