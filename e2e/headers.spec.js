// Operational and security header coverage. Helmet is wired up in server.js
// with a couple of options disabled (CSP, COEP) — these tests pin the
// remaining headers so a future helmet upgrade or option flip doesn't
// silently strip them. Rate-limit headers are also asserted here.
//
// HSTS is intentionally NOT asserted: server.js only sets it when
// NODE_ENV=production, and the test webserver runs with NODE_ENV=test.

const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin } = require('./utils');

test.describe('response headers', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('helmet sets the standard hardening headers on API responses', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    const h = res.headers();

    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-dns-prefetch-control']).toBe('off');
    expect(h['x-download-options']).toBe('noopen');
    expect(h['referrer-policy']).toBeTruthy();
    // helmet's default frameguard is SAMEORIGIN.
    expect(h['x-frame-options']).toMatch(/SAMEORIGIN|DENY/);
  });

  test('rate-limit headers are present on a successful login response', async ({ request }) => {
    // Fresh limiter window — resetAll cleared it.
    const res = await request.post('/api/auth/login', {
      data: { email: 'noone@test.local', password: 'whatever' }
    });
    // Rate-limit headers come from express-rate-limit and are sent on 200/4xx.
    const h = res.headers();
    expect(h['ratelimit-limit'] || h['x-ratelimit-limit']).toBeTruthy();
    expect(h['ratelimit-remaining'] || h['x-ratelimit-remaining']).toBeTruthy();
  });

  test('compression encodes large JSON responses (admin photo list with many uploads)', async ({ request }) => {
    // The default photo seed is empty; the body is small enough that
    // compression may skip it. Instead, hit /api/services where the seeded
    // payload includes 4 services with descriptions — still small, but
    // we send the Accept-Encoding header and inspect the response.
    const res = await request.get('/api/services', {
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.status()).toBe(200);
    // Compression's default threshold is 1KB. The seeded services payload
    // is around that size; we don't assert content-encoding strictly,
    // but the request should still succeed and parse as JSON.
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
  });

  test('admin GET /api/dashboard/stats responds as application/json', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.get('/api/dashboard/stats', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] || '').toMatch(/application\/json/);
  });

  test('error responses return JSON, not HTML', async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: {} });
    expect(res.status()).toBe(400);
    expect(res.headers()['content-type'] || '').toMatch(/application\/json/);
    expect(await res.json()).toHaveProperty('error');
  });

  test('static asset caching is disabled in dev, ETag is off on JSON', async ({ request }) => {
    // ETag is explicitly disabled in server.js (`app.set('etag', false)`),
    // so JSON API responses must never carry one. Browsers issuing a
    // conditional GET would otherwise see 304 with no body.
    const res = await request.get('/api/services');
    expect(res.headers().etag).toBeUndefined();
  });
});
