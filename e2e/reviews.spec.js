// Customer reviews: public submission from the homepage, the admin
// moderation queue (approve / reject / delete), and the visibility rule that
// only approved reviews ever reach the public GET that feeds the homepage
// carousel.

const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin, safeBody } = require('./utils');

async function submitReview(request, overrides = {}) {
  const res = await request.post('/api/reviews', {
    data: {
      reviewer_name: 'Happy Owner',
      pet_name: 'Biscuit',
      rating: 5,
      review_text: 'Our pup had the best week of his life.',
      ...overrides
    }
  });
  expect(res.status(), await safeBody(res)).toBe(201);
  return res.json();
}

test.describe('Reviews API', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('submitted reviews are pending and hidden until approved', async ({ request }) => {
    const { id } = await submitReview(request);

    // Not public yet.
    const publicBefore = await request.get('/api/reviews');
    await expect(publicBefore.json()).resolves.toEqual([]);

    // Visible to the admin as pending.
    const token = await loginAdmin(request);
    const allRes = await request.get('/api/reviews/all?status=pending', {
      headers: { authorization: `Bearer ${token}` }
    });
    const pending = await allRes.json();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id, reviewer_name: 'Happy Owner', status: 'pending' });

    // Approve → appears publicly.
    const approveRes = await request.put(`/api/reviews/${id}/status`, {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'approved' }
    });
    expect(approveRes.status()).toBe(200);

    const publicAfter = await (await request.get('/api/reviews')).json();
    expect(publicAfter).toHaveLength(1);
    expect(publicAfter[0]).toMatchObject({ id, reviewer_name: 'Happy Owner', rating: 5 });
    // The public payload must not leak moderation state.
    expect(publicAfter[0].status).toBeUndefined();

    // Reject again → disappears from the public feed.
    await request.put(`/api/reviews/${id}/status`, {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'rejected' }
    });
    await expect((await request.get('/api/reviews')).json()).resolves.toEqual([]);
  });

  test('validates submissions', async ({ request }) => {
    const cases = [
      { data: { pet_name: 'Rex', rating: 5, review_text: 'no name' } },
      { data: { reviewer_name: 'A', rating: 5, review_text: '' } },
      { data: { reviewer_name: 'A', rating: 0, review_text: 'bad rating' } },
      { data: { reviewer_name: 'A', rating: 6, review_text: 'bad rating' } },
      { data: { reviewer_name: 'A', rating: 'five', review_text: 'bad rating' } },
      { data: { reviewer_name: 'x'.repeat(81), rating: 5, review_text: 'name too long' } },
      { data: { reviewer_name: 'A', rating: 5, review_text: 'x'.repeat(1001) } }
    ];
    for (const { data } of cases) {
      // More cases than the hourly submission cap — the limiter counts
      // invalid attempts too, so clear it between probes.
      await request.post('/api/__test__/rate-limits/reset');
      const res = await request.post('/api/reviews', { data });
      expect(res.status(), JSON.stringify(data).slice(0, 80)).toBe(400);
    }
  });

  test('moderation endpoints require admin auth', async ({ request }) => {
    const { id } = await submitReview(request);

    expect((await request.get('/api/reviews/all')).status()).toBe(401);
    expect((await request.put(`/api/reviews/${id}/status`, {
      data: { status: 'approved' }
    })).status()).toBe(401);
    expect((await request.delete(`/api/reviews/${id}`)).status()).toBe(401);
  });

  test('rejects unknown status values and missing ids', async ({ request }) => {
    const { id } = await submitReview(request);
    const token = await loginAdmin(request);

    const bad = await request.put(`/api/reviews/${id}/status`, {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'published' }
    });
    expect(bad.status()).toBe(400);

    const missing = await request.put('/api/reviews/9999/status', {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'approved' }
    });
    expect(missing.status()).toBe(404);
  });

  test('admin can delete a review', async ({ request }) => {
    const { id } = await submitReview(request);
    const token = await loginAdmin(request);

    const del = await request.delete(`/api/reviews/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);

    const all = await (await request.get('/api/reviews/all', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(all).toEqual([]);
  });

  test('rate-limits public submissions', async ({ request }) => {
    for (let i = 0; i < 5; i++) {
      await submitReview(request, { reviewer_name: `Owner ${i}` });
    }
    const res = await request.post('/api/reviews', {
      data: { reviewer_name: 'One Too Many', rating: 5, review_text: 'blocked' }
    });
    expect(res.status()).toBe(429);
  });
});

test.describe('Reviews UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('homepage form submits and approved reviews join the carousel', async ({ page, request }) => {
    await page.goto('/');

    await page.fill('#reviewName', 'UI Tester');
    await page.fill('#reviewPetName', 'Waffles');
    await page.click('.review-star[data-rating="4"]');
    await page.fill('#reviewText', 'Booked a weekend stay and got adorable photo updates.');
    await page.click('#reviewForm button[type="submit"]');
    await expect(page.locator('#reviewFormMsg')).toHaveClass(/success/);

    // Approve it via the API, then reload: the carousel should grow by one
    // card that reuses the hardcoded testimonial template.
    const token = await loginAdmin(request);
    const pending = await (await request.get('/api/reviews/all?status=pending', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(pending).toHaveLength(1);
    await request.put(`/api/reviews/${pending[0].id}/status`, {
      headers: { authorization: `Bearer ${token}` },
      data: { status: 'approved' }
    });

    await page.goto('/');
    const cards = page.locator('.testimonial-card');
    await expect(cards).toHaveCount(5); // 4 hardcoded + 1 approved
    await expect(page.locator('.carousel-dot')).toHaveCount(5);
    const newCard = cards.last();
    await expect(newCard).toContainText('UI Tester');
    await expect(newCard).toContainText("Waffles's human");
    await expect(newCard.locator('.testimonial-stars')).toHaveText('⭐⭐⭐⭐');
  });

  test('admin panel lists pending reviews and approves from the queue', async ({ page, request }) => {
    await request.post('/api/reviews', {
      data: { reviewer_name: 'Queue Person', rating: 5, review_text: 'Waiting for a thumbs up.' }
    });

    await page.goto('/admin');
    await page.fill('#loginEmail', process.env.E2E_ADMIN_EMAIL || 'admin@test.local');
    await page.fill('#loginPassword', process.env.E2E_ADMIN_PASSWORD || 'test-admin-password-e2e');
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();

    await page.click('a[data-panel="reviews"]');
    const row = page.locator('#reviewsTable tr', { hasText: 'Queue Person' });
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: 'Approve' }).click();

    // Default filter is "pending", so the approved review leaves the queue…
    await expect(page.locator('#reviewsTable tr', { hasText: 'Queue Person' })).toHaveCount(0);

    // …and is now served publicly.
    const publicReviews = await (await request.get('/api/reviews')).json();
    expect(publicReviews).toHaveLength(1);
    expect(publicReviews[0].reviewer_name).toBe('Queue Person');
  });
});
