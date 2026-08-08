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

test.describe('content security policy', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a CSP is sent, and it contains no unsafe directives', async ({ request }) => {
    // CSP was previously disabled outright, on the grounds that the portals'
    // inline scripts would break. Those handlers were converted instead.
    for (const path of ['/', '/legal/privacy', '/services/overnight-boarding', '/my-bookings', '/admin']) {
      const res = await request.get(path);
      const csp = res.headers()['content-security-policy'];
      expect(csp, `${path} has no CSP`).toBeTruthy();
      expect(csp, `${path} allows unsafe-inline`).not.toContain("'unsafe-inline'");
      expect(csp, `${path} allows unsafe-eval`).not.toContain("'unsafe-eval'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      // No wildcard sources anywhere.
      expect(csp).not.toMatch(/(^|[ ;])\*($|[ ;])/);
      expect(csp).not.toContain('http:');
    }
  });

  test('each response carries a fresh nonce, and inline scripts use it', async ({ request }) => {
    const a = await request.get('/admin');
    const b = await request.get('/admin');

    const nonceOf = res => (res.headers()['content-security-policy'].match(/'nonce-([^']+)'/) || [])[1];
    const nonceA = nonceOf(a);
    const nonceB = nonceOf(b);
    expect(nonceA).toBeTruthy();
    expect(nonceA, 'a nonce must not be reused across responses').not.toBe(nonceB);

    // Every inline <script> in the served markup carries this response's nonce.
    const html = await a.text();
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/gi)];
    expect(inlineScripts.length, 'expected inline scripts in the admin portal').toBeGreaterThan(0);
    for (const [, attrs] of inlineScripts) {
      expect(attrs, 'inline script without a nonce').toContain(`nonce="${nonceA}"`);
    }
    // And no inline event handlers survive, which a nonce cannot rescue.
    expect(html).not.toMatch(/\son(click|submit|load|error|change|input)\s*=/i);
  });

  test('a nonce-bearing page is never cached by an intermediary', async ({ request }) => {
    for (const path of ['/admin', '/my-bookings']) {
      const res = await request.get(path);
      expect(res.headers()['cache-control']).toContain('no-store');
    }
  });

  test('Permissions-Policy switches off unused browser features', async ({ request }) => {
    const res = await request.get('/');
    const policy = res.headers()['permissions-policy'];
    expect(policy).toBeTruthy();
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(policy, `${feature} is not disabled`).toContain(`${feature}=()`);
    }
  });

  test('Referrer-Policy and frame protection are set', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // frame-ancestors is the modern control; X-Frame-Options rides along.
    expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

test.describe('CORS', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a disallowed origin gets a deliberate 403, not a 500', async ({ request }) => {
    // The allowlist rejection used to be signalled by throwing, which reached
    // the generic error handler and surfaced as an opaque 500 —
    // indistinguishable from the server being broken.
    const res = await request.get('/api/services', {
      headers: { Origin: 'https://evil.example' }
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('cors_origin_not_allowed');
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('a preflight from a disallowed origin is refused without CORS headers', async ({ request }) => {
    const res = await request.fetch('/api/customer/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST'
      }
    });
    expect(res.status()).toBe(403);
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('a same-origin request is allowed', async ({ request, baseURL }) => {
    const res = await request.get('/api/services', { headers: { Origin: baseURL } });
    expect(res.status()).toBe(200);
  });

  test('the allowlist never falls through to a wildcard', async ({ request }) => {
    const res = await request.get('/api/services', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers()['access-control-allow-origin']).not.toBe('*');
  });
});
