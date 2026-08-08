const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./utils');

test.describe('auth', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test.describe('admin login', () => {
    test('succeeds with seeded credentials', async ({ request }) => {
      const res = await request.post('/api/auth/login', {
        data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('token');
      expect(body.admin).toMatchObject({ email: ADMIN_EMAIL, role: 'admin' });
    });

    test('rejects wrong password', async ({ request }) => {
      const res = await request.post('/api/auth/login', {
        data: { email: ADMIN_EMAIL, password: 'wrong' }
      });
      expect(res.status()).toBe(401);
    });

    test('rejects unknown email', async ({ request }) => {
      const res = await request.post('/api/auth/login', {
        data: { email: 'nobody@test.local', password: 'whatever' }
      });
      expect(res.status()).toBe(401);
    });

    test('rejects missing fields', async ({ request }) => {
      const res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL } });
      expect(res.status()).toBe(400);
    });

    test('rate-limits after 10 attempts in window', async ({ request }) => {
      for (let i = 0; i < 10; i++) {
        await request.post('/api/auth/login', {
          data: { email: ADMIN_EMAIL, password: 'wrong' }
        });
      }
      const res = await request.post('/api/auth/login', {
        data: { email: ADMIN_EMAIL, password: 'wrong' }
      });
      expect(res.status()).toBe(429);
    });
  });

  test.describe('customer registration & login', () => {
    test('registers a new customer and returns a token', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: {
          name: 'Jane Doe',
          email: 'jane@test.local',
          password: 'password123',
          phone: '555-0100',
          dog_name: 'Fido',
          accept_policies: { terms: true, privacy: true }
        }
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty('token');
      expect(body.customer.email).toBe('jane@test.local');
      expect(body.customer.dogs).toHaveLength(1);
      expect(body.customer.dogs[0].name).toBe('Fido');
    });

    test('rejects short passwords', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: { name: 'A', email: 'a@test.local', password: '123' }
      });
      expect(res.status()).toBe(400);
    });

    test('rejects duplicate email (case-insensitive)', async ({ request }) => {
      await request.post('/api/customer/register', {
        data: {
          name: 'First', email: 'dup@test.local', password: 'password123',
          accept_policies: { terms: true, privacy: true }
        }
      });
      const res = await request.post('/api/customer/register', {
        data: {
          name: 'Second', email: 'DUP@test.local', password: 'password123',
          accept_policies: { terms: true, privacy: true }
        }
      });
      expect(res.status()).toBe(409);
    });

    test('customer can log in and fetch profile', async ({ request }) => {
      await request.post('/api/customer/register', {
        data: {
          name: 'Login Tester',
          email: 'login@test.local',
          password: 'password123',
          dog_name: 'Rover',
          accept_policies: { terms: true, privacy: true }
        }
      });
      const loginRes = await request.post('/api/customer/login', {
        data: { email: 'login@test.local', password: 'password123' }
      });
      expect(loginRes.status()).toBe(200);
      const { token } = await loginRes.json();

      const profile = await request.get('/api/customer/profile', {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(profile.status()).toBe(200);
      const body = await profile.json();
      expect(body.email).toBe('login@test.local');
      expect(body.dogs).toHaveLength(1);
    });

    test('login rejects wrong password', async ({ request }) => {
      await request.post('/api/customer/register', {
        data: { name: 'X', email: 'x@test.local', password: 'password123' }
      });
      const res = await request.post('/api/customer/login', {
        data: { email: 'x@test.local', password: 'wrong' }
      });
      expect(res.status()).toBe(401);
    });
  });

  test.describe('authorization boundaries', () => {
    test('admin-only routes reject missing token', async ({ request }) => {
      const res = await request.get('/api/dashboard/stats');
      expect(res.status()).toBe(401);
    });

    test('admin-only routes reject customer token', async ({ request }) => {
      const reg = await request.post('/api/customer/register', {
        data: { name: 'C', email: 'c@test.local', password: 'password123' }
      });
      const { token } = await reg.json();
      const res = await request.get('/api/dashboard/stats', {
        headers: { authorization: `Bearer ${token}` }
      });
      // Customer JWTs don't decode as admin; auth middleware rejects with 403
      expect([401, 403]).toContain(res.status());
    });

    test('customer-only routes reject admin token', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.get('/api/bookings/my', {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(res.status()).toBe(403);
    });
  });
});
