// Unit tests for placeholder detection and business-profile validation.
// No database is touched — only the pure validation surface.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-not-for-production';
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL
  || 'postgresql://unused:unused@127.0.0.1:1/unused?sslmode=disable';

const { isPlaceholder, validateValue, FIELDS, LAUNCH_REQUIRED } = require('../../server/businessProfile');
const field = key => FIELDS.find(f => f.key === key);

test('the exact placeholder values that shipped are rejected', () => {
  for (const value of [
    '123 Pawsome Lane',
    'Dogtown, CA 90210',
    '(555) BENNY-PET',
    '(555) 236-6973',
    'woof@bennyandthepets.com'
  ]) {
    assert.equal(isPlaceholder(value), true, `${value} should be treated as a placeholder`);
  }
});

test('any US directory-reserved 555 number is rejected, not just the seeded ones', () => {
  assert.equal(isPlaceholder('(555) 010-1234'), true);
  assert.equal(isPlaceholder('555-867-5309'), true);
  assert.equal(isPlaceholder('555.123.4567'), true);
});

test('empty and whitespace-only values are absent, never published', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder('   '), true);
  assert.equal(isPlaceholder(null), true);
  assert.equal(isPlaceholder(undefined), true);
});

test('a plausible real value passes', () => {
  assert.equal(isPlaceholder('412 Mill Road'), false);
  assert.equal(isPlaceholder('hello@bennyandthepetsboardingllc.com'), false);
  // "555" only reads as fictional as a leading area code — a real number that
  // merely contains 555 elsewhere must still be publishable.
  assert.equal(isPlaceholder('(412) 555-0199'), false);
});

test('emails must be structurally valid', () => {
  assert.equal(validateValue(field('contact_email'), 'ben@bennyandthepetsboardingllc.com'), null);
  assert.ok(validateValue(field('contact_email'), 'not-an-email'));
  assert.ok(validateValue(field('contact_email'), 'woof@bennyandthepets.com')); // seeded placeholder
});

test('social URLs must be absolute https', () => {
  assert.equal(validateValue(field('instagram_url'), 'https://instagram.com/example'), null);
  assert.ok(validateValue(field('instagram_url'), 'http://instagram.com/example'));
  assert.ok(validateValue(field('instagram_url'), '#'));
  assert.ok(validateValue(field('instagram_url'), 'instagram.com/example'));
});

test('a dead "#" social link can never be stored', () => {
  // The footer originally carried href="#" for Instagram and TikTok.
  assert.ok(validateValue(field('tiktok_url'), '#'));
  assert.ok(validateValue(field('facebook_url'), '#'));
});

test('phone numbers need enough digits to be real', () => {
  assert.equal(validateValue(field('contact_phone_display'), '(412) 867-5309'), null);
  assert.ok(validateValue(field('contact_phone_display'), '123'));
  assert.ok(validateValue(field('contact_phone_display'), '(555) BENNY-PET'));
});

test('a trading-start year must be a real past year', () => {
  const thisYear = new Date().getUTCFullYear();
  assert.equal(validateValue(field('years_in_operation'), String(thisYear - 5)), null);
  assert.ok(validateValue(field('years_in_operation'), String(thisYear + 1)));
  assert.ok(validateValue(field('years_in_operation'), '12'));
});

test('the launch-blocking field set covers identity, contact and hours', () => {
  for (const key of ['business_name', 'legal_business_name', 'contact_email',
    'contact_phone_display', 'service_area', 'hours_weekday', 'emergency_contact']) {
    assert.ok(LAUNCH_REQUIRED.includes(key), `${key} should block launch`);
  }
});
