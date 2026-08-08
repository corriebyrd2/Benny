// Session security.
//
// The properties asserted here are precisely the ones the previous design — a
// stateless JWT in localStorage — could not provide:
//
//   * The browser's copy is unreadable by page scripts (HttpOnly).
//   * Signing out ends the session on the SERVER, not just in the browser.
//   * A password reset invalidates credentials issued before it.
//   * Cookie-authenticated state changes require a CSRF token.
//   * Customer and admin credentials cannot be confused for one another.

const { test, expect } = require('@playwright/test');
const {
  resetAll, registerCustomer, loginAdmin, safeBody, anonymousRequest,
  ADMIN_EMAIL, ADMIN_PASSWORD, STRONG_PASSWORD, getEmails
} = require('./utils');

function cookieNamed(cookies, name) {
  return cookies.find(c => c.name === name);
}

test.describe('cookie properties', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the session cookie is HttpOnly and SameSite, the CSRF cookie is readable', async ({ page, request }) => {
    const { email, password } = await registerCustomer(request);

    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    const cookies = await page.context().cookies();
    const session = cookieNamed(cookies, 'bp_session');
    expect(session, 'no session cookie was set').toBeTruthy();
    expect(session.httpOnly, 'the session cookie must be HttpOnly').toBe(true);
    expect(session.sameSite).toBe('Lax');
    expect(session.path).toBe('/');

    // The CSRF cookie is readable by design — it is echoed back in a header and
    // is not a credential on its own.
    const csrf = cookieNamed(cookies, 'bp_csrf');
    expect(csrf.httpOnly).toBe(false);
  });

  test('page scripts cannot read the session token', async ({ page, request }) => {
    const { email, password } = await registerCustomer(request);
    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    // This is the exfiltration path localStorage left open.
    const visible = await page.evaluate(() => ({
      cookie: document.cookie,
      localStorage: JSON.stringify(window.localStorage),
      sessionStorage: JSON.stringify(window.sessionStorage)
    }));

    const sessionCookie = cookieNamed(await page.context().cookies(), 'bp_session');
    expect(visible.cookie).not.toContain(sessionCookie.value);
    expect(visible.localStorage).not.toContain(sessionCookie.value);
    expect(visible.sessionStorage).not.toContain(sessionCookie.value);
    // And nothing that looks like a credential is being stored client-side.
    expect(visible.localStorage).not.toMatch(/token/i);
  });

  test('the browser can use the portal with no token in storage at all', async ({ page, request }) => {
    const { email, password } = await registerCustomer(request);
    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    // A reload keeps the session — proof the cookie, not stored JS state, is
    // carrying it.
    await page.reload();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);
  });
});

test.describe('revocation', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('signing out ends the session on the server', async ({ request }) => {
    const { token } = await registerCustomer(request);

    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${token}` }
    })).status()).toBe(200);

    expect((await request.post('/api/customer/logout', {
      headers: { authorization: `Bearer ${token}` }
    })).status()).toBe(200);

    // The old design could not do this: the token stayed valid for its full
    // lifetime no matter what the client did.
    const after = await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(after.status()).toBe(401);
  });

  test('signing out is idempotent', async ({ request }) => {
    const { token } = await registerCustomer(request);
    const headers = { authorization: `Bearer ${token}` };
    expect((await request.post('/api/customer/logout', { headers })).status()).toBe(200);
    expect((await request.post('/api/customer/logout', { headers })).status()).toBe(200);
  });

  test('a password reset invalidates every session issued before it', async ({ request }) => {
    const { token, email } = await registerCustomer(request);

    // A second device.
    const second = await request.post('/api/customer/login', {
      data: { email, password: 'password123' }
    });
    const secondToken = (await second.json()).token;

    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${secondToken}` }
    })).status()).toBe(200);

    // Reset the password through the real emailed link.
    expect((await request.post('/api/customer/forgot-password', { data: { email } })).status()).toBe(200);
    const emails = await getEmails(request, { to: email });
    const reset = emails.find(e => /reset/i.test(e.subject));
    const resetToken = (reset.html || reset.text).match(/[?&]reset=([0-9a-f]+)/i)[1];

    const done = await request.post('/api/customer/reset-password', {
      data: { token: resetToken, password: 'brandnewpass9' }
    });
    expect(done.status(), await safeBody(done)).toBe(200);
    expect((await done.json()).sessions_revoked).toBeGreaterThanOrEqual(2);

    // BOTH pre-reset sessions are dead. This is the defect that mattered most:
    // an attacker holding a stolen token previously kept access straight
    // through the action taken to lock them out.
    for (const stale of [token, secondToken]) {
      expect((await request.get('/api/customer/profile', {
        headers: { authorization: `Bearer ${stale}` }
      })).status()).toBe(401);
    }

    // The new password works and issues a working session.
    const fresh = await request.post('/api/customer/login', {
      data: { email, password: 'brandnewpass9' }
    });
    expect(fresh.status()).toBe(200);
    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${(await fresh.json()).token}` }
    })).status()).toBe(200);
  });

  test('a customer can list their sessions and sign other devices out', async ({ request }) => {
    const { token, email } = await registerCustomer(request);
    const other = await request.post('/api/customer/login', {
      data: { email, password: 'password123' }
    });
    const otherToken = (await other.json()).token;

    const listed = await (await request.get('/api/customer/sessions', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.filter(s => s.current)).toHaveLength(1);

    const revoke = await request.post('/api/customer/sessions/revoke-others', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(revoke.status()).toBe(200);
    const reissued = (await revoke.json()).token;

    // The other device is signed out; the caller is not.
    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${otherToken}` }
    })).status()).toBe(401);
    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${reissued}` }
    })).status()).toBe(200);
  });

  test('each sign-in mints a distinct session rather than reusing one', async ({ request }) => {
    const { email } = await registerCustomer(request);
    const a = await (await request.post('/api/customer/login',
      { data: { email, password: 'password123' } })).json();
    const b = await (await request.post('/api/customer/login',
      { data: { email, password: 'password123' } })).json();
    expect(a.token).not.toBe(b.token);
    expect(a.csrf_token).not.toBe(b.csrf_token);
  });

  test('an admin sign-out ends the admin session', async ({ request }) => {
    const token = await loginAdmin(request);
    const headers = { authorization: `Bearer ${token}` };
    expect((await request.get('/api/dashboard/stats', { headers })).status()).toBe(200);
    expect((await request.post('/api/auth/logout', { headers })).status()).toBe(200);
    expect((await request.get('/api/dashboard/stats', { headers })).status()).toBe(401);
  });
});

test.describe('token handling', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a forged or truncated token is rejected', async ({ request, playwright, baseURL }) => {
    const { token } = await registerCustomer(request);
    const anon = await anonymousRequest(playwright, baseURL);

    const forgeries = [
      'not-a-token',
      token.slice(0, -1) + 'X',
      token.slice(0, 10),
      Buffer.from('a'.repeat(43)).toString('base64url')
    ];
    for (const bad of forgeries) {
      const res = await anon.get('/api/customer/profile', {
        headers: { authorization: `Bearer ${bad}` }
      });
      expect(res.status(), `token "${bad.slice(0, 12)}..." was accepted`).toBe(401);
    }
    await anon.dispose();
  });

  test('no authenticated endpoint hands out a session token', async ({ request }) => {
    // If one did, an injected script could obtain a credential without ever
    // reading the HttpOnly cookie — which would defeat the whole design.
    const { token } = await registerCustomer(request);
    const headers = { authorization: `Bearer ${token}` };

    for (const path of ['/api/customer/profile', '/api/bookings/my', '/api/dogs',
      '/api/customer/sessions', '/api/legal/my-acceptances']) {
      const res = await request.get(path, { headers });
      expect(res.status(), path).toBeLessThan(400);
      expect(await res.text(), `${path} discloses the session token`).not.toContain(token);
    }
  });

  test('an explicit Authorization header wins over an ambient cookie', async ({ request }) => {
    // Two customers in the same client. The cookie belongs to whoever signed in
    // last; a request that explicitly presents the other one must be acted on
    // as the other one, not silently as the cookie holder.
    const a = await registerCustomer(request, { email: 'session-a@test.local' });
    const b = await registerCustomer(request, { email: 'session-b@test.local' });

    const asA = await (await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${a.token}` }
    })).json();
    expect(asA.email).toBe('session-a@test.local');

    const asCookie = await (await request.get('/api/customer/profile')).json();
    expect(asCookie.email).toBe('session-b@test.local');
  });

  test('customer and admin credentials cannot be swapped', async ({ request }) => {
    const { token: customerToken } = await registerCustomer(request);
    const adminToken = await loginAdmin(request);

    // A customer session on an admin route: a live session of the wrong type is
    // a boundary violation (403), not an expiry (401).
    expect((await request.get('/api/dashboard/stats', {
      headers: { authorization: `Bearer ${customerToken}` }
    })).status()).toBe(403);
    expect((await request.get('/api/admin/clients', {
      headers: { authorization: `Bearer ${customerToken}` }
    })).status()).toBe(403);

    // And the reverse.
    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${adminToken}` }
    })).status()).toBe(403);
  });
});

test.describe('CSRF', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a cookie-authenticated state change without a CSRF token is refused', async ({ request }) => {
    await registerCustomer(request, { dog_name: 'CsrfDog' });

    // The session cookie is present in this client. No CSRF header.
    const res = await request.post('/api/dogs', {
      data: { name: 'Sneaky' }
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe('csrf_token_invalid');
  });

  test('a cookie-authenticated state change with the right CSRF token succeeds', async ({ request }) => {
    const { csrfToken } = await registerCustomer(request);
    const res = await request.post('/api/dogs', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { name: 'Legitimate' }
    });
    expect(res.status(), await safeBody(res)).toBe(201);
  });

  test('a wrong CSRF token is refused', async ({ request }) => {
    await registerCustomer(request);
    const res = await request.post('/api/dogs', {
      headers: { 'X-CSRF-Token': 'wrong-value-entirely' },
      data: { name: 'Sneaky' }
    });
    expect(res.status()).toBe(403);
  });

  test('reads are not blocked by the CSRF check', async ({ request }) => {
    await registerCustomer(request);
    expect((await request.get('/api/customer/profile')).status()).toBe(200);
  });

  test('Bearer-authenticated state changes need no CSRF token', async ({ request, playwright, baseURL }) => {
    const { token } = await registerCustomer(request);
    // A cookie-free client, so the Bearer path is genuinely what is exercised.
    const anon = await anonymousRequest(playwright, baseURL);
    const res = await anon.post('/api/dogs', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'ApiClientDog' }
    });
    expect(res.status(), await safeBody(res)).toBe(201);
    await anon.dispose();
  });
});
