// Data export and account deletion.
//
// The published Privacy Policy stated that both were available. Neither was
// implemented, so the policy promised something the software did not do.

const { test, expect } = require('@playwright/test');
const {
  resetAll, registerCustomer, loginAdmin, firstServiceId, safeBody,
  anonymousRequest, TINY_PDF, STRONG_PASSWORD
} = require('./utils');

async function customerWithData(request) {
  const customer = await registerCustomer(request, { dog_name: 'Exportable' });
  const headers = { authorization: `Bearer ${customer.token}` };

  const dogs = await (await request.get('/api/dogs', { headers })).json();
  await request.post(`/api/dogs/${dogs[0].id}/documents`, {
    headers,
    multipart: { document: { name: 'rabies.pdf', mimeType: 'application/pdf', buffer: TINY_PDF } }
  });

  const serviceId = await firstServiceId(request);
  await request.post('/api/bookings/customer-book', {
    headers,
    data: {
      dog_names: ['Exportable'], service_id: serviceId,
      start_date: '2026-11-02', end_date: '2026-11-04',
      message: 'Please give him his evening tablet.'
    }
  });

  return { ...customer, headers, dogId: dogs[0].id };
}

test.describe('data export', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a customer can export everything held about them', async ({ request }) => {
    const { headers, password, email } = await customerWithData(request);

    const res = await request.post('/api/customer/account/export', {
      headers, data: { password }
    });
    expect(res.status(), await safeBody(res)).toBe(200);
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['cache-control']).toContain('no-store');

    const data = JSON.parse(await res.text());
    expect(data.export_format_version).toBe(1);
    expect(data.profile.email).toBe(email);
    expect(data.dogs).toHaveLength(1);
    expect(data.dogs[0].name).toBe('Exportable');
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].original_name).toBe('rabies.pdf');
    expect(data.bookings).toHaveLength(1);
    expect(data.bookings[0].message).toContain('evening tablet');
    expect(data.bookings[0].amount).toMatch(/^\$/);
    expect(data.policy_acceptances.length).toBeGreaterThanOrEqual(2);
    expect(data.active_sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.notes.length).toBeGreaterThan(0);
  });

  test('the export never contains a password hash or a session token', async ({ request }) => {
    const { headers, password, token } = await customerWithData(request);
    const res = await request.post('/api/customer/account/export', { headers, data: { password } });
    const text = await res.text();

    expect(text).not.toContain('password_hash');
    expect(text).not.toContain(password);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/\$2[aby]\$/); // a bcrypt hash
  });

  test('exporting requires the password, not just a session', async ({ request }) => {
    const { headers } = await customerWithData(request);

    const noPassword = await request.post('/api/customer/account/export', { headers, data: {} });
    expect(noPassword.status()).toBe(400);
    expect((await noPassword.json()).reauthentication_required).toBe(true);

    // 403, not 401: the session is fine, the confirmation was wrong. Answering
    // 401 made the client sign the customer out for mistyping their password.
    const wrongPassword = await request.post('/api/customer/account/export', {
      headers, data: { password: 'not-the-password' }
    });
    expect(wrongPassword.status()).toBe(403);
    expect((await wrongPassword.json()).reauthentication_failed).toBe(true);
  });

  test('exporting requires authentication', async ({ request, playwright, baseURL }) => {
    await customerWithData(request);
    const anon = await anonymousRequest(playwright, baseURL);
    expect((await anon.post('/api/customer/account/export',
      { data: { password: STRONG_PASSWORD } })).status()).toBe(401);
    await anon.dispose();
  });

  test('one customer cannot export another customer', async ({ request }) => {
    const a = await registerCustomer(request, { email: 'export-a@test.local', dog_name: 'ADog' });
    await registerCustomer(request, { email: 'export-b@test.local', dog_name: 'BDog' });

    const res = await request.post('/api/customer/account/export', {
      headers: { authorization: `Bearer ${a.token}` },
      data: { password: a.password }
    });
    const data = JSON.parse(await res.text());
    expect(data.profile.email).toBe('export-a@test.local');
    expect(data.dogs.map(d => d.name)).toEqual(['ADog']);
  });
});

test.describe('account deletion', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a preview says what will be deleted and what will be kept', async ({ request }) => {
    const { headers } = await customerWithData(request);
    const preview = await (await request.get('/api/customer/account/deletion-preview',
      { headers })).json();

    expect(preview.will_be_deleted.dogs).toBe(1);
    expect(preview.will_be_deleted.documents).toBe(1);
    expect(preview.will_be_anonymised.bookings).toBe(1);
    expect(preview.will_be_anonymised.reason).toBeTruthy();
    expect(preview.irreversible).toBe(true);
  });

  test('deleting removes the account, its dogs, documents and sessions', async ({ request }) => {
    const { headers, password, email, dogId } = await customerWithData(request);

    const documents = await (await request.get('/api/dogs', { headers })).json();
    const docId = documents[0].documents[0].id;

    const res = await request.delete('/api/customer/account', { headers, data: { password } });
    expect(res.status(), await safeBody(res)).toBe(200);
    expect((await res.json()).documents_deleted).toBe(1);

    // The session is dead immediately.
    expect((await request.get('/api/customer/profile', { headers })).status()).toBe(401);
    // And the credentials no longer work.
    expect((await request.post('/api/customer/login',
      { data: { email, password } })).status()).toBe(401);

    // The document is gone from admin too — the bytes, not just the row.
    const adminToken = await loginAdmin(request);
    expect((await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).status()).toBe(404);

    const adminDogs = await (await request.get('/api/dogs/admin/all', {
      headers: { authorization: `Bearer ${adminToken}` }
    })).json();
    expect(adminDogs.find(d => d.id === dogId)).toBeUndefined();
  });

  test('bookings are anonymised rather than destroyed', async ({ request }) => {
    const { headers, password, email } = await customerWithData(request);
    const adminToken = await loginAdmin(request);
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    const before = await (await request.get('/api/bookings', { headers: adminHeaders })).json();
    expect(before).toHaveLength(1);
    const bookingId = before[0].id;
    const amount = before[0].amount_cents;

    expect((await request.delete('/api/customer/account',
      { headers, data: { password } })).status()).toBe(200);

    // The financial record survives...
    const after = await (await request.get(`/api/bookings/${bookingId}`,
      { headers: adminHeaders })).json();
    expect(after.amount_cents).toBe(amount);
    expect(after.service_name).toBeTruthy();
    expect(after.start_date).toBeTruthy();

    // ...with nothing identifying left on it.
    expect(after.owner_name).toBe('Deleted customer');
    expect(after.email).toBe('');
    expect(after.phone).toBe('');
    expect(after.dog_name).toBe('Deleted');
    expect(after.message).toBe('');
    expect(after.customer_id).toBeNull();

    // A search of everything the admin can see must not turn up the address.
    const all = await (await request.get('/api/admin/clients', { headers: adminHeaders })).json();
    expect(JSON.stringify(all)).not.toContain(email);
  });

  test('the newsletter subscription goes with the account', async ({ request }) => {
    const customer = await registerCustomer(request, { email: 'deleteme@test.local' });
    const headers = { authorization: `Bearer ${customer.token}` };
    await request.post('/api/subscribe', {
      data: { email: 'deleteme@test.local', marketing_consent: true }
    });

    const adminToken = await loginAdmin(request);
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    expect((await (await request.get('/api/campaigns/stats',
      { headers: adminHeaders })).json()).subscriberCount).toBe(1);

    expect((await request.delete('/api/customer/account',
      { headers, data: { password: customer.password } })).status()).toBe(200);

    expect((await (await request.get('/api/campaigns/stats',
      { headers: adminHeaders })).json()).subscriberCount).toBe(0);
  });

  test('deleting requires the password', async ({ request }) => {
    const { headers } = await customerWithData(request);

    expect((await request.delete('/api/customer/account', { headers, data: {} })).status()).toBe(400);
    expect((await request.delete('/api/customer/account',
      { headers, data: { password: 'wrong' } })).status()).toBe(403);

    // Still there.
    expect((await request.get('/api/customer/profile', { headers })).status()).toBe(200);
  });

  test('one customer cannot delete another', async ({ request }) => {
    const a = await registerCustomer(request, { email: 'keep-a@test.local' });
    const b = await registerCustomer(request, { email: 'keep-b@test.local' });

    // B's session with B's password deletes B, never A.
    expect((await request.delete('/api/customer/account', {
      headers: { authorization: `Bearer ${b.token}` },
      data: { password: b.password }
    })).status()).toBe(200);

    expect((await request.get('/api/customer/profile', {
      headers: { authorization: `Bearer ${a.token}` }
    })).status()).toBe(200);
  });

  test('policy acceptance evidence survives without naming anyone', async ({ request }) => {
    const { headers, password } = await customerWithData(request);
    expect((await request.delete('/api/customer/account',
      { headers, data: { password } })).status()).toBe(200);

    // The acceptance rows persist for their evidentiary value, detached from the
    // deleted customer by the foreign key's ON DELETE SET NULL.
    const adminToken = await loginAdmin(request);
    const res = await request.get('/api/dashboard/stats', {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(res.status()).toBe(200);
  });
});

test.describe('customer portal — My Data', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  async function signIn(page, email, password) {
    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);
    await page.locator('.dash-tab[data-panel="privacy"]').click();
  }

  test('a customer can find and download their data', async ({ page, request }) => {
    const customer = await registerCustomer(request, { dog_name: 'Downloadable' });
    await signIn(page, customer.email, customer.password);

    await expect(page.locator('#deletionPreview')).toContainText(/dog profile/i);

    await page.locator('#exportPassword').fill(customer.password);
    const download = page.waitForEvent('download');
    await page.locator('#exportBtn').click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^benny-and-the-pets-data-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.locator('#exportMsg')).toHaveClass(/success/);
  });

  test('a wrong password is reported, not swallowed', async ({ page, request }) => {
    const customer = await registerCustomer(request);
    await signIn(page, customer.email, customer.password);

    await page.locator('#exportPassword').fill('definitely-wrong');
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportMsg')).toHaveClass(/error/);
    await expect(page.locator('#exportMsg')).toContainText(/not correct/i);
  });

  test('deletion needs an explicit, unticked confirmation', async ({ page, request }) => {
    const customer = await registerCustomer(request);
    await signIn(page, customer.email, customer.password);

    await expect(page.locator('#deleteConfirm')).not.toBeChecked();
    await page.locator('#deletePassword').fill(customer.password);
    await page.locator('#deleteAccountBtn').click();
    await expect(page.locator('#deleteMsg')).toContainText(/cannot be undone/i);
    // Still signed in — nothing irreversible ran.
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    await page.locator('#deleteConfirm').check();
    await page.locator('#deleteAccountBtn').click();
    await expect(page.locator('#authSection')).toBeVisible();

    // The account is really gone.
    expect((await request.post('/api/customer/login', {
      data: { email: customer.email, password: customer.password }
    })).status()).toBe(401);
  });
});

test.describe('the customer portal actually loads its data', () => {
  // Regression cover for a self-inflicted bug: a bulk rewrite that routed every
  // authenticated call through authedFetch also rewrote the fetch INSIDE
  // authedFetch, making it infinitely recursive. Every authenticated call in the
  // portal failed, and the existing tests missed it because they only asserted
  // that the dashboard appeared — an empty list looks the same as a broken one.
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('bookings and dogs render after signing in', async ({ page, request }) => {
    const customer = await registerCustomer(request, { dog_name: 'Rendered' });
    const serviceId = await firstServiceId(request);
    await request.post('/api/bookings/customer-book', {
      headers: { authorization: `Bearer ${customer.token}` },
      data: {
        dog_names: ['Rendered'], service_id: serviceId,
        start_date: '2026-12-01', end_date: '2026-12-03'
      }
    });

    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(customer.email);
    await page.locator('#loginPassword').fill(customer.password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    await page.locator('.dash-tab[data-panel="bookings"]').click();
    await expect(page.locator('#panelBookings')).toContainText('Rendered');

    await page.locator('.dash-tab[data-panel="dogs"]').click();
    await expect(page.locator('#dogsList')).toContainText('Rendered');
  });
});
