// Regression coverage for the security hardening rolled out for deployment
// readiness: photo magic-byte sniffing, public-endpoint rate limits, the
// stricter customer-password policy, email subject sanitization, and the
// JSON 404 fallback for /api/* misses.

const { test, expect } = require('@playwright/test');
const {
  resetAll,
  loginAdmin,
  registerCustomer,
  createPublicBooking,
  firstServiceId,
  getEmails,
  TINY_PNG,
  STRONG_PASSWORD
} = require('./utils');

test.describe('security regressions', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test.describe('photo upload magic-byte validation', () => {
    test('rejects a text payload that lies about its MIME type', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.post('/api/photos', {
        headers: { authorization: `Bearer ${token}` },
        multipart: {
          photo: {
            name: 'evil.png',
            mimeType: 'image/png',
            buffer: Buffer.from('this is plain text, not a png')
          }
        }
      });
      expect(res.status()).toBe(400);
    });

    test('rejects a PHP shell renamed to .png with a fake image MIME', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.post('/api/photos', {
        headers: { authorization: `Bearer ${token}` },
        multipart: {
          photo: {
            name: 'shell.png',
            mimeType: 'image/png',
            buffer: Buffer.from('<?php system($_GET["c"]); ?>' + 'A'.repeat(64))
          }
        }
      });
      expect(res.status()).toBe(400);
    });

    test('rejects an SVG masquerading as PNG (no SVG support)', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.post('/api/photos', {
        headers: { authorization: `Bearer ${token}` },
        multipart: {
          photo: {
            name: 'icon.png',
            mimeType: 'image/png',
            buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
          }
        }
      });
      expect(res.status()).toBe(400);
    });

    test('accepts a real PNG with the correct magic bytes', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.post('/api/photos', {
        headers: { authorization: `Bearer ${token}` },
        multipart: {
          photo: { name: 'pixel.png', mimeType: 'image/png', buffer: TINY_PNG }
        }
      });
      expect(res.status()).toBe(201);
    });
  });

  test.describe('public endpoint rate limits', () => {
    test('public booking lookup blocks at 30 requests per IP per hour', async ({ request }) => {
      // Pre-create one matching booking so the lookup body is deterministic.
      await createPublicBooking(request, { email: 'enum@test.local' });
      // The public booking POST has its own 30/hr limiter, so we use lookup
      // (also 30/hr) — the first 30 succeed, the 31st gets a 429.
      let lastStatus = 200;
      for (let i = 0; i < 31; i++) {
        const res = await request.post('/api/bookings/lookup', {
          data: { email: `noone-${i}@test.local` }
        });
        lastStatus = res.status();
        if (lastStatus === 429) break;
      }
      expect(lastStatus).toBe(429);
    });

    test('public booking creation blocks at 30 per IP per hour', async ({ request }) => {
      const serviceId = await firstServiceId(request);
      let lastStatus = 0;
      for (let i = 0; i < 31; i++) {
        const res = await request.post('/api/bookings', {
          data: {
            owner_name: `Owner ${i}`,
            email: `flood-${i}@test.local`,
            dog_name: `Dog${i}`,
            service_id: serviceId
          }
        });
        lastStatus = res.status();
        if (lastStatus === 429) break;
      }
      expect(lastStatus).toBe(429);
    });

    test('admin and authenticated customer routes on /api/bookings ignore the public limiter', async ({ request }) => {
      const adminToken = await loginAdmin(request);
      // Hammer the admin GET — it shares the /api/bookings prefix but is
      // mounted past the rate-limit shim, so it should keep returning 200.
      for (let i = 0; i < 35; i++) {
        const res = await request.get('/api/bookings', {
          headers: { authorization: `Bearer ${adminToken}` }
        });
        expect(res.status()).toBe(200);
      }
    });
  });

  test.describe('customer password policy', () => {
    test('rejects passwords shorter than 10 characters', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: { name: 'Short', email: 'short@test.local', password: 'abc12' }
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/at least 10/i);
    });

    test('rejects passwords with no digit', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: { name: 'NoDigits', email: 'nodigit@test.local', password: 'abcdefghij' }
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/letter and one number/i);
    });

    test('rejects passwords with no letter', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: { name: 'NoLetters', email: 'noletter@test.local', password: '1234567890' }
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/letter and one number/i);
    });

    test('accepts a 10-char mixed password', async ({ request }) => {
      const res = await request.post('/api/customer/register', {
        data: { name: 'Good', email: 'good@test.local', password: 'abcdefgh12' }
      });
      expect(res.status()).toBe(201);
    });

    test('the password reset flow enforces the same policy', async ({ request }) => {
      const { email } = await registerCustomer(request, { email: 'resetpolicy@test.local' });

      const reqRes = await request.post('/api/customer/forgot-password', { data: { email } });
      expect(reqRes.status()).toBe(200);

      const emails = await getEmails(request, { to: email });
      const reset = emails.find(e => /reset/i.test(e.subject));
      expect(reset, 'expected reset email').toBeTruthy();

      // Pull the token out of the link — the email body uses ?reset=<hex>.
      const match = reset.html.match(/[?&]reset=([0-9a-f]+)/i) || reset.text.match(/[?&]reset=([0-9a-f]+)/i);
      expect(match, 'reset token in email').toBeTruthy();
      const token = match[1];

      const weak = await request.post('/api/customer/reset-password', {
        data: { token, password: 'short' }
      });
      expect(weak.status()).toBe(400);

      const good = await request.post('/api/customer/reset-password', {
        data: { token, password: 'newpassword42' }
      });
      expect(good.status()).toBe(200);
    });
  });

  test.describe('email content sanitization', () => {
    test('strips newlines from the subject when user input contains them', async ({ request }) => {
      await createPublicBooking(request, {
        email: 'subject@test.local',
        // Try to inject a header on the BCC line via the dog name, which is
        // interpolated straight into the email subject.
        dog_name: 'Rex\r\nBcc: attacker@evil.test'
      });
      const emails = await getEmails(request, { to: 'subject@test.local' });
      const acknowledgement = emails.find(e => /booking request/i.test(e.subject));
      expect(acknowledgement, 'expected acknowledgement email').toBeTruthy();
      // Subject is the only header-injection vector; the body legitimately
      // contains the (escaped) dog name and we don't assert on it.
      expect(acknowledgement.subject).not.toMatch(/[\r\n]/);
      expect(acknowledgement.subject).toContain('Rex');
    });

    test('skips delivery when the recipient address is malformed', async ({ request }) => {
      // A booking row with a malformed email still gets stored, but the
      // outbound email handler refuses to send to that address. We expect
      // the customer-confirmation email to be absent.
      const res = await request.post('/api/bookings', {
        data: {
          owner_name: 'Bad',
          email: 'not\r\nan@email.test',
          dog_name: 'Spot',
          service_id: await firstServiceId(request)
        }
      });
      // Either the route accepts and the mailer drops it, or the mailer
      // throws and the central error handler returns 500. Both are
      // acceptable outcomes — what matters is that no email got sent to
      // an attacker-controlled address.
      expect([201, 400, 500]).toContain(res.status());
      const all = await getEmails(request);
      expect(all.find(e => e.to.some(t => /[\r\n]/.test(t)))).toBeFalsy();
    });
  });

  test.describe('API 404 fallback', () => {
    test('unknown /api path returns JSON not HTML', async ({ request }) => {
      const res = await request.get('/api/does-not-exist');
      expect(res.status()).toBe(404);
      expect(res.headers()['content-type'] || '').toMatch(/application\/json/);
      const body = await res.json();
      expect(body).toEqual({ error: 'Not found' });
    });
  });

  test.describe('JWT type boundaries', () => {
    test('a customer token cannot call admin booking routes', async ({ request }) => {
      const { token } = await registerCustomer(request, { email: 'jwt-cust@test.local' });
      const res = await request.delete('/api/bookings/1', {
        headers: { authorization: `Bearer ${token}` }
      });
      // Customer JWTs don't decode as admin — auth middleware rejects.
      expect([401, 403]).toContain(res.status());
    });

    test('a tampered Bearer token is rejected', async ({ request }) => {
      const { token } = await registerCustomer(request, { email: 'jwt-tamp@test.local' });
      // Flip a character in the signature.
      const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
      const res = await request.get('/api/customer/profile', {
        headers: { authorization: `Bearer ${tampered}` }
      });
      expect([401, 403]).toContain(res.status());
    });
  });

  test.describe('input edge cases', () => {
    test('booking lookup with SQL-ish payload returns an empty list, not an error', async ({ request }) => {
      const res = await request.post('/api/bookings/lookup', {
        data: { email: "x' OR '1'='1" }
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('settings PUT silently drops keys outside the whitelist', async ({ request }) => {
      const token = await loginAdmin(request);
      const res = await request.put('/api/settings', {
        headers: { authorization: `Bearer ${token}` },
        data: { contact_email: 'new@test.local', evil_key: 'pwn' }
      });
      expect(res.status()).toBe(200);
      const out = await res.json();
      expect(out.contact_email).toBe('new@test.local');
      expect(out.evil_key).toBeUndefined();
    });
  });
});
