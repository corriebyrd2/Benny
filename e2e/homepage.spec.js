const { test, expect } = require('@playwright/test');
const { resetAll } = require('./utils');

test.describe('homepage + static pages', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('renders exactly the services the catalog exposes', async ({ page, request }) => {
    // The homepage is server-rendered from the same catalog the API serves, so
    // the two can no longer disagree — the original defect was four hardcoded
    // marketing cards against two API services.
    const apiServices = await (await request.get('/api/services')).json();

    await page.goto('/');
    await expect(page).toHaveTitle(/Benny/i);
    await expect(page.locator('.services-grid .service-card')).toHaveCount(apiServices.length);
    for (const service of apiServices) {
      await expect(page.getByRole('heading', { name: service.name })).toBeVisible();
    }
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
