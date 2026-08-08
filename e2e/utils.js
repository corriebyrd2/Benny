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
    // Registration requires explicit acceptance of the terms and privacy
    // policy. Fixtures accept, so specs that are not about consent aren't
    // coupled to it; e2e/legal.spec.js covers the refusal paths.
    accept_policies: { terms: true, privacy: true },
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

async function createPublicBooking(request, overrides = {}) {
  const serviceId = await firstServiceId(request);
  const res = await request.post('/api/bookings', {
    data: {
      owner_name: 'Public Owner',
      email: 'publicowner@test.local',
      phone: '555-0101',
      dog_name: 'Rex',
      service_id: serviceId,
      preferred_dates: 'next weekend',
      message: 'please be gentle',
      ...overrides
    }
  });
  expect(res.status(), await safeBody(res)).toBe(201);
  return res.json();
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
