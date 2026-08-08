// Guest enquiries.
//
// The gap this closes: every "contact us" and "ask about this service" call to
// action pointed at the #contact section, which renders contact DETAILS — and
// those are hidden while the owner has not supplied verified ones. A visitor
// who was not ready to create an account reached a dead end, and the
// enquiry-only services had no way to enquire.

const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin, safeBody, getEmails } = require('./utils');

test.describe('the contact section is not a dead end', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a visitor can reach a working contact form with no account', async ({ page }) => {
    await page.goto('/');
    // The hero's secondary call to action must land on something actionable.
    await page.getByRole('link', { name: /ask a question first/i }).first().click();
    await expect(page.locator('#inquiryForm')).toBeVisible();
    await expect(page.locator('#inquiryName')).toBeVisible();
    await expect(page.locator('#inquiryMessage')).toBeVisible();
  });

  test('an enquiry-only service offers a route to enquire', async ({ page, request }) => {
    const token = await loginAdmin(request);
    const all = await (await request.get('/api/services/all', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    const inquiryOnly = all.find(s => s.booking_mode === 'inquiry');

    // Publish it so it appears on the homepage.
    await request.put(`/api/services/${inquiryOnly.id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { active: true }
    });

    await page.goto('/');
    const card = page.locator('.service-card', {
      has: page.getByRole('heading', { name: inquiryOnly.name })
    });
    await card.getByRole('link', { name: /ask about/i }).click();
    await expect(page.locator('#inquiryForm')).toBeVisible();
  });

  test('the service selector offers every service, including enquiry-only ones', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    await page.goto('/');
    const options = page.locator('#inquiryService option');
    // One "General question" option plus one per service.
    await expect(options).toHaveCount(services.length + 1);
  });

  test('submitting the form stores the enquiry and confirms to the visitor', async ({ page, request }) => {
    await page.goto('/');
    await page.locator('#inquiryName').fill('Prospective Customer');
    await page.locator('#inquiryEmail').fill('prospect@test.local');
    await page.locator('#inquiryPhone').fill('0123 456 7890');
    await page.locator('#inquiryMessage').fill(
      'Do you take reactive dogs? Mine is fine with people but wary of other dogs.');

    const posted = page.waitForResponse(r => r.url().endsWith('/api/inquiries'));
    await page.locator('#inquiryForm button[type="submit"]').click();
    expect((await posted).status()).toBe(201);

    await expect(page.locator('#inquiryMsg')).toContainText(/reply by email/i);
    await expect(page.locator('#inquiryMsg')).toHaveClass(/success/);
    // The form resets so a second enquiry does not resend the first.
    await expect(page.locator('#inquiryName')).toHaveValue('');

    const token = await loginAdmin(request);
    const queue = await (await request.get('/api/inquiries', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(queue).toHaveLength(1);
    expect(queue[0].name).toBe('Prospective Customer');
    expect(queue[0].email).toBe('prospect@test.local');
    expect(queue[0].status).toBe('new');
    expect(queue[0].message).toContain('reactive dogs');
  });

  test('the owner is notified, with reply-to set to the enquirer', async ({ request }) => {
    const res = await request.post('/api/inquiries', {
      data: {
        name: 'Email Test', email: 'emailtest@test.local',
        message: 'Could you tell me about your daycare hours please?'
      }
    });
    expect(res.status(), await safeBody(res)).toBe(201);

    const sent = await getEmails(request, { subject: 'Website enquiry' });
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain('emailtest@test.local');
  });

  test('a validation failure is reported inline and focuses the field', async ({ page }) => {
    await page.goto('/');
    await page.locator('#inquiryForm button[type="submit"]').click();
    await expect(page.locator('#inquiryMsg')).toContainText(/your name/i);
    await expect(page.locator('#inquiryName')).toBeFocused();

    await page.locator('#inquiryName').fill('Someone');
    await page.locator('#inquiryForm button[type="submit"]').click();
    await expect(page.locator('#inquiryEmail')).toBeFocused();
  });
});

test.describe('enquiry API', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  const valid = {
    name: 'Valid Person',
    email: 'valid@test.local',
    message: 'This is a long enough message to be a real question.'
  };

  test('validates name, email and message', async ({ request }) => {
    const cases = [
      [{ ...valid, name: '' }, /name/i],
      [{ ...valid, email: 'nope' }, /email/i],
      [{ ...valid, email: '' }, /email/i],
      [{ ...valid, message: 'short' }, /what you need/i]
    ];
    for (const [data, pattern] of cases) {
      const res = await request.post('/api/inquiries', { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).error).toMatch(pattern);
    }
  });

  test('records the service the enquiry is about', async ({ request }) => {
    const services = await (await request.get('/api/services')).json();
    const res = await request.post('/api/inquiries', {
      data: { ...valid, service_id: services[0].id }
    });
    expect(res.status()).toBe(201);

    const token = await loginAdmin(request);
    const queue = await (await request.get('/api/inquiries', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(queue[0].service_name).toBe(services[0].name);
  });

  test('the honeypot silently absorbs a bot without storing anything', async ({ request }) => {
    const res = await request.post('/api/inquiries', {
      data: { ...valid, website: 'http://spam.example' }
    });
    // 200, not 201, and nothing stored — the bot believes it worked.
    expect(res.status()).toBe(200);

    const token = await loginAdmin(request);
    const queue = await (await request.get('/api/inquiries', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(queue).toHaveLength(0);
  });

  test('the queue and its stats are admin-only', async ({ request }) => {
    expect((await request.get('/api/inquiries')).status()).toBe(401);
    expect((await request.get('/api/inquiries/stats')).status()).toBe(401);
    expect((await request.put('/api/inquiries/1', { data: { status: 'answered' } })).status()).toBe(401);
  });

  test('an admin can work the queue', async ({ request }) => {
    await request.post('/api/inquiries', { data: valid });
    const token = await loginAdmin(request);
    const headers = { authorization: `Bearer ${token}` };

    const before = await (await request.get('/api/inquiries/stats', { headers })).json();
    expect(before.new_count).toBe(1);

    const created = (await (await request.get('/api/inquiries', { headers })).json())[0];
    const updated = await request.put(`/api/inquiries/${created.id}`, {
      headers, data: { status: 'answered', admin_notes: 'Replied by email.' }
    });
    expect(updated.status(), await safeBody(updated)).toBe(200);
    const body = (await updated.json()).inquiry;
    expect(body.status).toBe('answered');
    expect(body.handled_at).toBeTruthy();
    expect(body.handled_by).toBeTruthy();

    const after = await (await request.get('/api/inquiries/stats', { headers })).json();
    expect(after.new_count).toBe(0);
    expect(after.total).toBe(1);
  });

  test('an unknown status is refused', async ({ request }) => {
    await request.post('/api/inquiries', { data: valid });
    const token = await loginAdmin(request);
    const headers = { authorization: `Bearer ${token}` };
    const created = (await (await request.get('/api/inquiries', { headers })).json())[0];

    const res = await request.put(`/api/inquiries/${created.id}`, {
      headers, data: { status: 'whatever' }
    });
    expect(res.status()).toBe(400);
  });

  test('the public endpoint is rate limited', async ({ request }) => {
    let lastStatus = 0;
    for (let i = 0; i < 14; i++) {
      const res = await request.post('/api/inquiries', {
        data: { ...valid, email: `flood-${i}@test.local` }
      });
      lastStatus = res.status();
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

test.describe('admin enquiry panel', () => {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('./utils');

  test.beforeEach(async ({ request }) => { await resetAll(request); });

  async function signIn(page) {
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();
  }

  test('an enquiry appears in the panel and can be worked', async ({ page, request }) => {
    await request.post('/api/inquiries', {
      data: {
        name: 'Panel Person', email: 'panel@test.local',
        message: 'Do you have space over the bank holiday weekend?'
      }
    });

    await signIn(page);
    // The unanswered count is visible without opening the panel.
    await expect(page.locator('#inquiryBadge')).toHaveText('1');

    await page.click('a[data-panel="inquiries"]');
    const row = page.locator('#inquiriesTable tr', { hasText: 'Panel Person' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('bank holiday');

    await row.getByRole('button', { name: /mark answered/i }).click();

    // Default filter is "new", so the answered enquiry leaves the queue and the
    // badge clears.
    await expect(page.locator('#inquiriesTable tr', { hasText: 'Panel Person' })).toHaveCount(0);
    await expect(page.locator('#inquiryBadge')).toBeHidden();
  });

  test('the panel shows an honest empty state', async ({ page }) => {
    await signIn(page);
    await page.click('a[data-panel="inquiries"]');
    await expect(page.locator('#inquiriesTable')).toContainText(/no enquiries/i);
    await expect(page.locator('#inquiryBadge')).toBeHidden();
  });
});
