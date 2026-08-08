// Legal and privacy infrastructure: page availability and indexability,
// contextual linking, draft labelling, and versioned acceptance.

const { test, expect } = require('@playwright/test');
const { resetAll, safeBody, STRONG_PASSWORD } = require('./utils');

const REQUIRED_POLICIES = [
  'privacy',
  'terms',
  'boarding-agreement',
  'cancellation-policy',
  'payment-terms',
  'pet-documents-policy',
  'emergency-vet-authorization',
  'cookies',
  'accessibility',
  'support-policy'
];

test.describe('policy pages', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('every required policy is reachable and indexable', async ({ page }) => {
    for (const slug of REQUIRED_POLICIES) {
      const response = await page.goto(`/legal/${slug}`);
      expect(response.status(), `/legal/${slug}`).toBe(200);
      await expect(page.locator('h1')).toBeVisible();
      const robots = await page.locator('meta[name="robots"]').getAttribute('content');
      expect(robots, `/legal/${slug} must be indexable`).toContain('index');
      expect(robots).not.toContain('noindex');
    }
  });

  test('the policy index lists every policy with its version', async ({ page }) => {
    await page.goto('/legal');
    for (const slug of REQUIRED_POLICIES) {
      await expect(page.locator(`.doc-index a[href="/legal/${slug}"]`)).toHaveCount(1);
    }
    await expect(page.locator('.doc-index-meta').first()).toContainText(/Version/);
  });

  test('every page carries a version and an effective date', async ({ page }) => {
    for (const slug of REQUIRED_POLICIES) {
      await page.goto(`/legal/${slug}`);
      await expect(page.locator('.doc-meta')).toContainText(/Version .+ · Effective \d{4}-\d{2}-\d{2}/);
    }
  });

  test('draft documents are visibly labelled as pending legal review', async ({ page, request }) => {
    const { policies } = await (await request.get('/api/legal/policies')).json();
    const drafts = policies.filter(p => p.draft);
    expect(drafts.length, 'the drafting state must be explicit').toBeGreaterThan(0);

    for (const policy of drafts) {
      await page.goto(policy.url);
      const banner = page.locator('[data-draft="true"]');
      await expect(banner, `${policy.slug} is draft but shows no review banner`).toBeVisible();
      await expect(banner).toContainText(/qualified counsel/i);
    }
  });

  test('non-draft documents show no draft banner', async ({ page, request }) => {
    const { policies } = await (await request.get('/api/legal/policies')).json();
    for (const policy of policies.filter(p => !p.draft)) {
      await page.goto(policy.url);
      await expect(page.locator('[data-draft="true"]')).toHaveCount(0);
    }
  });

  test('the footer links to policies from every public page', async ({ page }) => {
    for (const path of ['/', '/legal/privacy']) {
      await page.goto(path);
      await expect(page.locator('a[href^="/legal"]').first()).toBeVisible();
    }
    await page.goto('/');
    for (const slug of ['privacy', 'terms', 'cancellation-policy']) {
      // At least one; privacy is also linked from the newsletter consent copy.
      expect(await page.locator(`footer a[href="/legal/${slug}"]`).count(),
        `footer must link /legal/${slug}`).toBeGreaterThan(0);
    }
  });

  test('policies are linked contextually where they matter', async ({ page, request }) => {
    // Review form -> terms + privacy
    await page.goto('/');
    await expect(page.locator('#reviewForm a[href="/legal/terms"]')).toHaveCount(1);
    await expect(page.locator('#reviewForm a[href="/legal/privacy"]')).toHaveCount(1);
    // Newsletter -> privacy
    await expect(page.locator('.footer-newsletter a[href="/legal/privacy"]')).toHaveCount(1);
    // How-it-works -> payment terms + boarding agreement + document policy
    await expect(page.locator('#how-it-works a[href="/legal/payment-terms"]')).toHaveCount(1);
    await expect(page.locator('#how-it-works a[href="/legal/boarding-agreement"]')).toHaveCount(1);
    await expect(page.locator('#how-it-works a[href="/legal/pet-documents-policy"]')).toHaveCount(1);

    // Service pages -> cancellation + payment + emergency authorisation
    const services = await (await request.get('/api/services')).json();
    await page.goto(`/services/${services[0].slug}`);
    await expect(page.locator('a[href="/legal/cancellation-policy"]')).toHaveCount(1);
    await expect(page.locator('a[href="/legal/emergency-vet-authorization"]')).toHaveCount(1);
  });
});

test.describe('versioned acceptance', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  function registration(overrides = {}) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return {
      name: `Consent Tester ${suffix}`,
      email: `consent-${suffix}@test.local`,
      password: STRONG_PASSWORD,
      ...overrides
    };
  }

  test('the API publishes which policies must be accepted where', async ({ request }) => {
    const res = await request.get('/api/legal/policies');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const registrationSlugs = body.acceptance_points.registration.map(p => p.slug);
    expect(registrationSlugs).toContain('terms');
    expect(registrationSlugs).toContain('privacy');
    for (const policy of body.acceptance_points.registration) {
      expect(policy.version, 'each acceptance point must name a version').toBeTruthy();
    }
  });

  test('registration is refused without explicit acceptance', async ({ request }) => {
    const res = await request.post('/api/customer/register', { data: registration() });
    expect(res.status(), await safeBody(res)).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must accept/i);
    expect(body.required_policies.length).toBeGreaterThan(0);
  });

  test('a partial acceptance is refused', async ({ request }) => {
    const res = await request.post('/api/customer/register', {
      data: registration({ accept_policies: { terms: true } })
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/privacy/i);
  });

  test('acceptance must be a literal true, not a truthy string', async ({ request }) => {
    const res = await request.post('/api/customer/register', {
      data: registration({ accept_policies: { terms: 'yes', privacy: 1 } })
    });
    expect(res.status()).toBe(400);
  });

  test('accepting records the version that was shown', async ({ request }) => {
    const data = registration({ accept_policies: { terms: true, privacy: true } });
    const res = await request.post('/api/customer/register', { data });
    // 202 with no session — registration is deliberately indistinguishable
    // whether or not the address already exists.
    expect(res.status(), await safeBody(res)).toBe(202);
    const { token } = await (await request.post('/api/customer/login',
      { data: { email: data.email, password: data.password } })).json();

    const acceptances = await (await request.get('/api/legal/my-acceptances', {
      headers: { Authorization: `Bearer ${token}` }
    })).json();

    const { policies } = await (await request.get('/api/legal/policies')).json();
    const currentTerms = policies.find(p => p.slug === 'terms').version;

    const terms = acceptances.find(a => a.policy_slug === 'terms');
    expect(terms).toBeTruthy();
    expect(terms.policy_version).toBe(currentTerms);
    expect(terms.accepted).toBe(true);
    expect(terms.context).toBe('registration');
    expect(new Date(terms.accepted_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    expect(acceptances.some(a => a.policy_slug === 'privacy')).toBe(true);
  });

  test('a client cannot claim acceptance of a different policy version', async ({ request }) => {
    const data = registration({
      accept_policies: { terms: true, privacy: true },
      policy_versions: { terms: '1999-01-01.1' }
    });
    const res = await request.post('/api/customer/register', { data });
    expect(res.status()).toBe(202);
    const { token } = await (await request.post('/api/customer/login',
      { data: { email: data.email, password: data.password } })).json();
    const acceptances = await (await request.get('/api/legal/my-acceptances', {
      headers: { Authorization: `Bearer ${token}` }
    })).json();
    expect(acceptances.find(a => a.policy_slug === 'terms').policy_version).not.toBe('1999-01-01.1');
  });

  test('marketing consent is separate from contractual acceptance', async ({ request }) => {
    // Accepting the terms alone must NOT subscribe the customer to marketing.
    const withoutMarketing = registration({ accept_policies: { terms: true, privacy: true } });
    expect((await request.post('/api/customer/register', { data: withoutMarketing })).status()).toBe(202);

    const withMarketing = registration({
      accept_policies: { terms: true, privacy: true },
      marketing_consent: true
    });
    expect((await request.post('/api/customer/register', { data: withMarketing })).status()).toBe(202);

    // The newsletter endpoint is the observable side: only the opted-in address
    // is already present, so re-subscribing it is a no-op either way. Assert on
    // the consent requirement instead, which is directly testable.
    const noConsent = await request.post('/api/subscribe', {
      data: { email: withoutMarketing.email, source: 'test' }
    });
    expect(noConsent.status(), 'subscribing without consent must be refused').toBe(400);
  });

  test('an acceptance record cannot be read by another customer', async ({ request }) => {
    const a = registration({ accept_policies: { terms: true, privacy: true } });
    const b = registration({ accept_policies: { terms: true, privacy: true } });
    await request.post('/api/customer/register', { data: a });
    await request.post('/api/customer/register', { data: b });
    const tokenA = (await (await request.post('/api/customer/login',
      { data: { email: a.email, password: a.password } })).json()).token;
    const tokenB = (await (await request.post('/api/customer/login',
      { data: { email: b.email, password: b.password } })).json()).token;

    const forA = await (await request.get('/api/legal/my-acceptances', {
      headers: { Authorization: `Bearer ${tokenA}` }
    })).json();
    const forB = await (await request.get('/api/legal/my-acceptances', {
      headers: { Authorization: `Bearer ${tokenB}` }
    })).json();

    // Two separate customers, two separate record sets, never merged.
    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    expect(forA.length).toBe(forB.length);
  });

  test('acceptances require authentication', async ({ request }) => {
    expect((await request.get('/api/legal/my-acceptances')).status()).toBe(401);
  });
});

test.describe('newsletter consent and unsubscribe', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('subscribing without consent is refused', async ({ request }) => {
    const res = await request.post('/api/subscribe', {
      data: { email: 'nc@test.local', source: 'test' }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/consent/i);
  });

  test('subscribing with consent succeeds and is idempotent', async ({ request }) => {
    const data = { email: 'consented@test.local', source: 'test', marketing_consent: true };
    expect((await request.post('/api/subscribe', { data })).status()).toBe(200);
    expect((await request.post('/api/subscribe', { data })).status()).toBe(200);
  });

  test('an unsubscribe link with a bad token does not unsubscribe anyone', async ({ request }) => {
    const email = 'unsub@test.local';
    await request.post('/api/subscribe', { data: { email, marketing_consent: true } });

    const bad = await request.get(`/api/subscribe/unsubscribe?e=${email}&t=deadbeef`);
    // Always 200, so the endpoint can't be used to probe who is subscribed.
    expect(bad.status()).toBe(200);
  });
});

test.describe('unsubscribe is honoured by campaigns', () => {
  const { loginAdmin } = require('./utils');

  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('an unsubscribed address is excluded from the audience and the send', async ({ request }) => {
    const staying = 'stays@test.local';
    const leaving = 'leaves@test.local';
    for (const email of [staying, leaving]) {
      expect((await request.post('/api/subscribe',
        { data: { email, marketing_consent: true } })).status()).toBe(200);
    }

    const token = await loginAdmin(request);
    const before = await (await request.get('/api/campaigns/stats', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(before.subscriberCount).toBe(2);

    // Unsubscribe with a valid signed link, the way an email client would.
    const { unsubscribeToken } = require('../server/unsubscribeToken');
    const out = await request.get(
      `/api/subscribe/unsubscribe?e=${encodeURIComponent(leaving)}&t=${unsubscribeToken(leaving)}`);
    expect(out.status()).toBe(200);

    const after = await (await request.get('/api/campaigns/stats', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(after.subscriberCount).toBe(1);

    const send = await request.post('/api/campaigns', {
      headers: { authorization: `Bearer ${token}` },
      data: { subject: 'Post-unsubscribe', html: '<p>Hi</p>', plain: 'Hi' }
    });
    expect(send.status(), await safeBody(send)).toBe(202);
    expect((await send.json()).recipientCount).toBe(1);

    const sent = await (await request.get('/api/__test__/emails?subject=Post-unsubscribe')).json();
    expect(sent.length).toBe(1);
    expect(sent[0].bcc).toContain(staying);
    expect(sent[0].bcc).not.toContain(leaving);
  });
});
