// Shared helpers for Playwright specs: DB + email + rate-limit reset, API
// client that threads the baseURL, and fixture builders for common entities.

const { expect, request: pwRequest } = require('@playwright/test');

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@test.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'test-admin-password-e2e';

async function resetAll(request) {
  // Order matters: emails + rate limits first (cheap), then DB (truncates
  // everything except the seeded admin/services).
  await request.delete('/api/__test__/emails');
  await request.post('/api/__test__/rate-limits/reset');
  const res = await request.post('/api/__test__/db/reset');
  expect(res.status(), await safeBody(res)).toBe(200);
}

async function safeBody(res) {
  try { return JSON.stringify(await res.json()); } catch { return res.status(); }
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
  });
  expect(res.status(), await safeBody(res)).toBe(200);
  const body = await res.json();
  return body.token;
}

async function registerCustomer(request, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const data = {
    name: `Test Customer ${suffix}`,
    email: `customer-${suffix}@test.local`,
    password: 'password123',
    phone: '555-0100',
    dog_name: 'Buddy',
    ...overrides
  };
  const res = await request.post('/api/customer/register', { data });
  expect(res.status(), await safeBody(res)).toBe(201);
  const body = await res.json();
  return { token: body.token, customer: body.customer, password: data.password, email: data.email };
}

async function firstServiceId(request) {
  const res = await request.get('/api/services');
  expect(res.status()).toBe(200);
  const services = await res.json();
  expect(services.length, 'expected seeded services').toBeGreaterThan(0);
  return services[0].id;
}

// Create a booking through the authenticated customer flow. Every booking is
// tied to an account now (there is no anonymous booking endpoint), so this
// registers a fresh customer for the given email — or a generated one — and
// books via /customer-book. Returns the customer-book response plus the
// email/token/customer so callers can keep acting as that customer.
async function createPublicBooking(request, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = overrides.email || `owner-${suffix}@test.local`;
  const dogName = overrides.dog_name || 'Rex';

  const { token, customer } = await registerCustomer(request, {
    name: overrides.owner_name || 'Public Owner',
    email,
    phone: overrides.phone || '555-0101',
    dog_name: dogName
  });

  const serviceId = overrides.service_id || await firstServiceId(request);
  const data = {
    service_id: serviceId,
    dog_name: dogName,
    preferred_dates: overrides.preferred_dates || 'next weekend',
    message: overrides.message || 'please be gentle'
  };
  if (overrides.start_date) data.start_date = overrides.start_date;
  if (overrides.end_date) data.end_date = overrides.end_date;
  if (overrides.dog_count) data.dog_count = overrides.dog_count;

  const res = await request.post('/api/bookings/customer-book', {
    headers: { authorization: `Bearer ${token}` },
    data
  });
  expect(res.status(), await safeBody(res)).toBe(201);
  const body = await res.json();
  return { ...body, email, token, customer };
}

async function getEmails(request, filters = {}) {
  const qs = new URLSearchParams(filters).toString();
  const res = await request.get(`/api/__test__/emails${qs ? `?${qs}` : ''}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function simulateStripeWebhook(request, { type, booking_id, payment_id }) {
  const res = await request.post('/api/__test__/stripe/webhook', {
    data: { type, booking_id, payment_id }
  });
  return res;
}

// 1x1 transparent PNG used by upload tests that need a payload that survives
// the magic-byte sniff in server/routes/photos.js.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex'
);

// Strong password that satisfies the policy in server/customerAuth.js
// (>=10 chars, contains a letter and a digit). Used by every fixture that
// creates a customer so individual specs don't have to invent one.
const STRONG_PASSWORD = 'password123';

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  STRONG_PASSWORD,
  TINY_PNG,
  resetAll,
  safeBody,
  loginAdmin,
  registerCustomer,
  firstServiceId,
  createPublicBooking,
  getEmails,
  simulateStripeWebhook
};
