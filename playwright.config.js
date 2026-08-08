// Playwright config for Benny and the Pets E2E tests.
//
// Requires E2E_DATABASE_URL (a Neon branch connection string) in the
// environment. Loads .env.test if present. Runs a single worker, serial,
// because all specs share one Neon branch and reset the DB between specs.

const { defineConfig } = require('@playwright/test');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env.test') });

if (!process.env.E2E_DATABASE_URL) {
  throw new Error(
    'E2E_DATABASE_URL is required (a Neon branch connection string). ' +
    'See TESTING.md.'
  );
}

const PORT = process.env.E2E_PORT || '3901';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Resolve the signing secret ONCE and give the same value to both the server
// under test and the test process. Specs that need to derive a signed value —
// e.g. an unsubscribe token — must sign with the key the server verifies with,
// and reading it from a second source is how they silently diverge.
const JWT_SECRET = process.env.E2E_JWT_SECRET || 'e2e-test-secret-do-not-use-in-prod';
process.env.JWT_SECRET = JWT_SECRET;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'node server.js',
    url: `${BASE_URL}/healthz`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      TEST_MODE: '1',
      PORT,
      NEON_DATABASE_URL: process.env.E2E_DATABASE_URL,
      JWT_SECRET,
      ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL || 'admin@test.local',
      ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD || 'test-admin-password-e2e',
      STRIPE_SECRET_KEY: 'sk_test_e2e_stub',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_e2e_stub',
      STRIPE_WEBHOOK_SECRET: process.env.E2E_STRIPE_WEBHOOK_SECRET || 'whsec_e2e_test_secret',
      PUBLIC_URL: BASE_URL,
      // Give the test server a NON-EMPTY CORS allowlist. With an empty list
      // outside production the middleware deliberately allows any origin so a
      // local frontend on another port can work — which means the rejection
      // path would never be exercised by the suite. Setting it explicitly makes
      // e2e/headers.spec.js test the behaviour production actually has.
      FRONTEND_ORIGIN: BASE_URL,
      // Keep SendGrid unset; the harness overrides the transport anyway.
      SENDGRID_FROM_EMAIL: 'test@bennyandthepets.test'
    }
  },
  projects: [
    // Chromium runs the full suite. Firefox and WebKit run a cross-browser
    // subset (tagged @xbrowser) rather than everything: the value is in
    // catching ENGINE differences — layout, form controls, date inputs, cookie
    // handling — not in re-running API assertions three times, which would
    // triple CI time for no extra signal.
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      grep: /@xbrowser/
    },
    {
      name: 'webkit',
      // WebKit is the engine behind Safari and Mobile Safari, which is where
      // the audit brief's iOS coverage actually comes from.
      use: { browserName: 'webkit' },
      grep: /@xbrowser/
    },
    // Visual regression is opt-in: see VISUAL_BASELINES in TESTING.md. Snapshot
    // bytes depend on the host's fonts and GPU, so baselines captured on one
    // machine produce false failures on another. Enforcing them in CI would
    // trade real signal for noise.
    {
      name: 'visual',
      testMatch: /visual\.spec\.js/,
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } }
    }
  ],
  // The visual project is excluded from a default run; ask for it by name.
  testIgnore: process.env.VISUAL_BASELINES ? [] : ['**/visual.spec.js']
});
