// Unit tests for boot-time configuration validation.
//
// These exist because the E2E suite structurally cannot cover this surface: it
// boots the server with NODE_ENV=test, where the same problems only warn. A
// check that wrongly refused a PRODUCTION boot was therefore invisible to every
// test in the repository until someone deployed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { configProblems } = require('../../server/envCheck');

// A configuration that should be accepted, using the variable names the
// deployment documentation actually tells an operator to set.
const documented = () => ({
  NEON_DATABASE_URL: 'postgresql://user:pw@host/db',
  JWT_SECRET: 'a'.repeat(96),
  ADMIN_EMAIL: 'owner@example.com',
  ADMIN_PASSWORD: 'a-strong-admin-password'
});

test('NEON_DATABASE_URL alone is sufficient — this is what every deploy doc says to set', () => {
  const problems = configProblems(documented());
  assert.deepEqual(problems, [],
    'a config following .env.example and DEPLOY.md must boot in production');
});

test('DATABASE_URL alone is also sufficient', () => {
  const env = documented();
  delete env.NEON_DATABASE_URL;
  env.DATABASE_URL = 'postgresql://user:pw@host/db';
  assert.deepEqual(configProblems(env), []);
});

test('setting both is accepted', () => {
  const env = documented();
  env.DATABASE_URL = 'postgresql://user:pw@host/db';
  assert.deepEqual(configProblems(env), []);
});

test('neither database variable set is the one database failure', () => {
  const env = documented();
  delete env.NEON_DATABASE_URL;
  const problems = configProblems(env);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NEON_DATABASE_URL \(or DATABASE_URL\)/);
});

test('no problem ever demands DATABASE_URL on its own', () => {
  // The regression: a second, unconditional check required DATABASE_URL even
  // when NEON_DATABASE_URL was set, so production refused to start and named a
  // variable no document mentions.
  for (const env of [documented(), {}]) {
    for (const problem of configProblems(env)) {
      assert.doesNotMatch(problem, /^DATABASE_URL must be set/,
        'DATABASE_URL must never be required independently of NEON_DATABASE_URL');
    }
  }
});

test('a missing or default JWT_SECRET is refused', () => {
  for (const value of [undefined, '', 'benny-pets-default-secret', 'change-this-to-a-random-secret-key']) {
    const env = documented();
    env.JWT_SECRET = value;
    assert.ok(configProblems(env).some(p => /JWT_SECRET/.test(p)),
      `JWT_SECRET=${JSON.stringify(value)} should be refused`);
  }
});

test('a missing or default ADMIN_PASSWORD is refused', () => {
  for (const value of [undefined, '', 'changeme123']) {
    const env = documented();
    env.ADMIN_PASSWORD = value;
    assert.ok(configProblems(env).some(p => /ADMIN_PASSWORD/.test(p)));
  }
});

test('a missing ADMIN_EMAIL is refused', () => {
  const env = documented();
  delete env.ADMIN_EMAIL;
  assert.ok(configProblems(env).some(p => /ADMIN_EMAIL/.test(p)));
});

test('an empty environment reports every problem at once, not just the first', () => {
  // An operator setting up a new deployment should see the whole list in one
  // pass rather than fixing one variable per failed boot.
  const problems = configProblems({});
  assert.equal(problems.length, 4);
});

test('business facts are NOT boot blockers — an incomplete profile must not be an outage', () => {
  // Contact details, hours and service area gate the LAUNCH (npm run
  // check:launch), never the boot. Refusing to start on a missing phone number
  // would take an already-live site down.
  assert.deepEqual(configProblems(documented()), []);
});

test('called with no argument it does not throw', () => {
  assert.ok(Array.isArray(configProblems()));
});
