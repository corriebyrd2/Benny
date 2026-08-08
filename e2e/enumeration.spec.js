// User enumeration, and email verification.
//
// Registration answered 409 "An account with this email already exists", which
// let anyone test an address list against the site and learn who is a customer.
// It now answers identically in both cases and issues no session either way;
// the person who OWNS the address is told by email that someone tried.

const { test, expect } = require('@playwright/test');
const { resetAll, getEmails, safeBody, STRONG_PASSWORD } = require('./utils');

function registration(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    name: `Enumeration Tester ${suffix}`,
    email: `enum-${suffix}@test.local`,
    password: STRONG_PASSWORD,
    accept_policies: { terms: true, privacy: true },
    ...overrides
  };
}

test.describe('registration reveals nothing about who is a customer', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the response is byte-identical for a new and an existing address', async ({ request }) => {
    const existing = registration({ email: 'known@test.local' });
    expect((await request.post('/api/customer/register', { data: existing })).status()).toBe(202);

    const repeat = await request.post('/api/customer/register', {
      data: registration({ email: 'known@test.local' })
    });
    const brandNew = await request.post('/api/customer/register', {
      data: registration({ email: 'unknown@test.local' })
    });

    expect(repeat.status()).toBe(brandNew.status());
    expect(await repeat.text()).toBe(await brandNew.text());
    // And nothing in the headers gives it away either.
    expect(repeat.headers()['content-length']).toBe(brandNew.headers()['content-length']);
  });

  test('case differences do not change the answer', async ({ request }) => {
    expect((await request.post('/api/customer/register',
      { data: registration({ email: 'MixedCase@test.local' }) })).status()).toBe(202);

    const lower = await request.post('/api/customer/register',
      { data: registration({ email: 'mixedcase@test.local' }) });
    expect(lower.status()).toBe(202);

    // Still exactly one account.
    const login = await request.post('/api/customer/login', {
      data: { email: 'mixedcase@test.local', password: STRONG_PASSWORD }
    });
    expect(login.status()).toBe(200);
  });

  test('no session is issued by registration, for either case', async ({ request }) => {
    const data = registration({ email: 'nosession@test.local' });
    const first = await request.post('/api/customer/register', { data });
    const second = await request.post('/api/customer/register', { data: registration({ email: data.email }) });

    for (const res of [first, second]) {
      const body = await res.json();
      expect(body.token).toBeUndefined();
      expect(body.csrf_token).toBeUndefined();
      // No Set-Cookie carrying a session either.
      const setCookie = res.headers()['set-cookie'] || '';
      expect(setCookie).not.toContain('bp_session=');
    }
  });

  test('a duplicate attempt does not overwrite the existing account', async ({ request }) => {
    const original = registration({ email: 'original@test.local', name: 'Original Owner' });
    await request.post('/api/customer/register', { data: original });

    await request.post('/api/customer/register', {
      data: registration({ email: 'original@test.local', name: 'Impostor', password: 'attacker9999' })
    });

    // The attacker's password does not work...
    expect((await request.post('/api/customer/login', {
      data: { email: 'original@test.local', password: 'attacker9999' }
    })).status()).toBe(401);

    // ...and the original owner is untouched.
    const login = await request.post('/api/customer/login', {
      data: { email: 'original@test.local', password: original.password }
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).customer.name).toBe('Original Owner');
  });

  test('the address owner is told, and the submitter is not', async ({ request }) => {
    const owner = registration({ email: 'owner@test.local', name: 'Real Owner' });
    await request.post('/api/customer/register', { data: owner });

    await request.post('/api/customer/register', {
      data: registration({ email: 'owner@test.local', name: 'Someone Else' })
    });

    const notices = await getEmails(request, { to: 'owner@test.local' });
    const attempt = notices.find(e => /tried to create an account/i.test(e.subject));
    expect(attempt, 'the address owner must be notified').toBeTruthy();
    // The notice must not disclose anything the owner does not already know.
    expect(attempt.text).not.toContain('Someone Else');
    expect(attempt.text.toLowerCase()).not.toContain('password:');
  });

  test('login is generic for an unknown address and a wrong password alike', async ({ request }) => {
    await request.post('/api/customer/register', { data: registration({ email: 'real@test.local' }) });

    const unknown = await request.post('/api/customer/login',
      { data: { email: 'nobody@test.local', password: STRONG_PASSWORD } });
    const wrongPassword = await request.post('/api/customer/login',
      { data: { email: 'real@test.local', password: 'not-the-password' } });

    expect(unknown.status()).toBe(401);
    expect(wrongPassword.status()).toBe(401);
    expect(await unknown.text()).toBe(await wrongPassword.text());
  });

  test('password reset stays generic too', async ({ request }) => {
    await request.post('/api/customer/register', { data: registration({ email: 'resetme@test.local' }) });

    const known = await request.post('/api/customer/forgot-password',
      { data: { email: 'resetme@test.local' } });
    const unknown = await request.post('/api/customer/forgot-password',
      { data: { email: 'never-existed@test.local' } });

    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
  });
});

test.describe('email verification', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  async function registerAndGetLink(request, email) {
    const data = registration({ email });
    const res = await request.post('/api/customer/register', { data });
    expect(res.status(), await safeBody(res)).toBe(202);

    const emails = await getEmails(request, { to: email });
    const verification = emails.find(e => /confirm your email/i.test(e.subject));
    expect(verification, 'expected a verification email').toBeTruthy();
    const token = (verification.html || verification.text).match(/[?&]verify=([0-9a-f]+)/i)[1];
    return { token, data };
  }

  test('a new registration is emailed a working confirmation link', async ({ request }) => {
    const { token } = await registerAndGetLink(request, 'verify-me@test.local');

    const res = await request.post('/api/customer/verify-email', { data: { token } });
    expect(res.status(), await safeBody(res)).toBe(200);
    expect((await res.json()).email).toBe('verify-me@test.local');
  });

  test('a confirmation link is single-use', async ({ request }) => {
    const { token } = await registerAndGetLink(request, 'single-use@test.local');
    expect((await request.post('/api/customer/verify-email', { data: { token } })).status()).toBe(200);

    const replay = await request.post('/api/customer/verify-email', { data: { token } });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toMatch(/invalid or has expired/i);
  });

  test('a forged token is rejected', async ({ request }) => {
    await registerAndGetLink(request, 'forged@test.local');
    for (const token of ['', 'deadbeef', 'a'.repeat(64)]) {
      expect((await request.post('/api/customer/verify-email', { data: { token } })).status()).toBe(400);
    }
  });

  test('the portal confirms the address from the emailed link', async ({ page, request }) => {
    const { token, data } = await registerAndGetLink(request, 'portal-verify@test.local');

    await page.goto(`/my-bookings?verify=${token}`);
    await expect(page.locator('#toast')).toContainText(/email confirmed/i);
    // The single-use token is scrubbed from the address bar rather than left in
    // history for the next person on a shared machine.
    await expect(page).not.toHaveURL(/verify=/);
    await expect(page.locator('#loginEmail')).toHaveValue(data.email);
  });

  test('verification is not required to sign in by default', async ({ request }) => {
    // Gating sign-in on a verified address would turn a mail misconfiguration
    // into "nobody can sign in". REQUIRE_EMAIL_VERIFICATION=1 is the owner's
    // switch once sending is confirmed working.
    const data = registration({ email: 'unverified@test.local' });
    await request.post('/api/customer/register', { data });

    const login = await request.post('/api/customer/login',
      { data: { email: data.email, password: data.password } });
    expect(login.status()).toBe(200);
    expect((await login.json()).customer.email_verified).toBe(false);
  });

  test('a signed-in customer can request another confirmation email', async ({ request }) => {
    const data = registration({ email: 'resend@test.local' });
    await request.post('/api/customer/register', { data });
    const { token } = await (await request.post('/api/customer/login',
      { data: { email: data.email, password: data.password } })).json();

    const res = await request.post('/api/customer/resend-verification', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status(), await safeBody(res)).toBe(200);

    const emails = await getEmails(request, { to: data.email });
    expect(emails.filter(e => /confirm your email/i.test(e.subject)).length).toBe(2);
  });

  test('resending requires authentication', async ({ request }) => {
    expect((await request.post('/api/customer/resend-verification')).status()).toBe(401);
  });
});
