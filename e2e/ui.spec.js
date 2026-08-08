// Browser-level UI coverage. Drives the actual HTML pages the way a user
// would: filling forms, clicking submit, watching for the success/failure
// state to render. The earlier specs poke the API directly; these guard
// against breakage that lives in the inline scripts.

const { test, expect } = require('@playwright/test');
const { resetAll, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./utils');

test.describe('homepage UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('renders services from the catalog and the hero CTA links to the customer portal', async ({ page, request }) => {
    const apiServices = await (await request.get('/api/services')).json();
    await page.goto('/');
    await expect(page.locator('.services-grid .service-card')).toHaveCount(apiServices.length);
    await expect(page.getByRole('heading', { name: 'Overnight Boarding' })).toBeVisible();

    const cta = page.getByRole('link', { name: /request a booking/i }).first();
    await expect(cta).toHaveAttribute('href', '/my-bookings');
  });

  test('newsletter signup requires explicit consent, then posts', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newsletterEmail').fill('home-subscribe@test.local');

    // Consent box starts UNTICKED and submitting without it must not send.
    await expect(page.locator('#newsletterConsent')).not.toBeChecked();
    await page.locator('#newsletterForm button[type="submit"]').click();
    await expect(page.locator('#newsletterMsg')).toContainText(/tick the box/i);

    const formResponse = page.waitForResponse(res => res.url().endsWith('/api/subscribe'));
    await page.locator('#newsletterConsent').check();
    await page.locator('#newsletterForm button[type="submit"]').click();
    expect((await formResponse).status()).toBe(200);
    await expect(page.locator('#newsletterMsg')).toContainText(/subscribed/i);
  });
});

test.describe('customer portal UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('register form: invalid password is rejected before navigation', async ({ page }) => {
    await page.goto('/my-bookings');

    // Switch to the register tab (any link/button that activates #registerForm).
    const switchLink = page.locator('a, button', { hasText: /sign up|create account|register/i }).first();
    if (await switchLink.count()) await switchLink.click();

    await page.locator('#regName').fill('UI Tester');
    await page.locator('#regEmail').fill('ui-weak@test.local');
    // The HTML now has minlength=10, so a 7-char password is blocked client-side.
    // Use evaluate() to bypass the constraint and confirm the server agrees.
    await page.locator('#regPassword').evaluate((el, v) => { el.value = v; }, 'short12');
    await page.locator('#regBtn').click();

    // Either the browser blocks submission with HTML5 validation, or the
    // request hits the server and returns 400. In both cases the dashboard
    // should NOT have appeared.
    await expect(page.locator('#dashboard')).not.toHaveClass(/active/);
  });

  test('register → dashboard appears with a welcome message', async ({ page }) => {
    await page.goto('/my-bookings');
    const switchLink = page.locator('a, button', { hasText: /sign up|create account|register/i }).first();
    if (await switchLink.count()) await switchLink.click();

    await page.locator('#regName').fill('Penny');
    await page.locator('#regEmail').fill('penny-ui@test.local');
    await page.locator('#regPassword').fill('uistrongpw1');
    await page.locator('#regDog').fill('Biscuit');

    // Contractual acceptance is required and starts unticked. Submitting
    // without it must be refused in the browser, before any request is made.
    await expect(page.locator('#regAcceptTerms')).not.toBeChecked();
    await page.locator('#regBtn').click();
    await expect(page.locator('#registerError')).toContainText(/Terms of Service/i);
    await expect(page.locator('#dashboard')).not.toHaveClass(/active/);

    // Marketing consent stays optional and separately unticked.
    await expect(page.locator('#regMarketing')).not.toBeChecked();
    await page.locator('#regAcceptTerms').check();

    const reg = page.waitForResponse((r) => r.url().endsWith('/api/customer/register'));
    await page.locator('#regBtn').click();
    const res = await reg;
    expect(res.status()).toBe(201);

    await expect(page.locator('#dashboard')).toHaveClass(/active/);
    await expect(page.locator('#welcomeText')).toContainText('Penny');
  });

  test('login with valid credentials reveals the dashboard', async ({ page, request }) => {
    // Pre-create the account through the API so we don't depend on the
    // register-form spec passing first.
    const reg = await request.post('/api/customer/register', {
      data: {
        name: 'Logged In',
        email: 'login-ui@test.local',
        password: 'uipassword11',
        dog_name: 'Daisy',
        accept_policies: { terms: true, privacy: true }
      }
    });
    expect(reg.status()).toBe(201);

    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill('login-ui@test.local');
    await page.locator('#loginPassword').fill('uipassword11');

    const login = page.waitForResponse((r) => r.url().endsWith('/api/customer/login'));
    await page.locator('#loginBtn').click();
    const res = await login;
    expect(res.status()).toBe(200);

    await expect(page.locator('#dashboard')).toHaveClass(/active/);
    await expect(page.locator('#welcomeText')).toContainText('Logged In');
  });

  test('login with the wrong password surfaces an inline error', async ({ page, request }) => {
    await request.post('/api/customer/register', {
      data: { name: 'Wrong', email: 'wrong-ui@test.local', password: 'uipassword11' }
    });

    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill('wrong-ui@test.local');
    await page.locator('#loginPassword').fill('definitelywrong1');

    const login = page.waitForResponse((r) => r.url().endsWith('/api/customer/login'));
    await page.locator('#loginBtn').click();
    const res = await login;
    expect(res.status()).toBe(401);

    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#dashboard')).not.toHaveClass(/active/);
  });
});

test.describe('admin portal UI', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('login form lands on the admin layout', async ({ page }) => {
    await page.goto('/admin');

    await page.locator('#loginEmail').fill(ADMIN_EMAIL);
    await page.locator('#loginPassword').fill(ADMIN_PASSWORD);

    const login = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
    await page.locator('#loginForm button[type="submit"]').click();
    const res = await login;
    expect(res.status()).toBe(200);

    await expect(page.locator('#adminLayout')).toBeVisible();
    await expect(page.locator('#loginScreen')).toBeHidden();
  });

  test('login form shows an error on bad credentials and does not reveal the layout', async ({ page }) => {
    await page.goto('/admin');

    await page.locator('#loginEmail').fill(ADMIN_EMAIL);
    await page.locator('#loginPassword').fill('definitely-wrong');

    const login = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
    await page.locator('#loginForm button[type="submit"]').click();
    await login;

    await expect(page.locator('#loginError')).toBeVisible();
    // adminLayout should still be hidden — the inline JS only flips it on
    // successful login.
    await expect(page.locator('#adminLayout')).toBeHidden();
  });
});
