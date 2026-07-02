# E2E Testing

End-to-end tests live in `e2e/` and run via Playwright against a dedicated
Neon database branch so they never touch production data.

## Setup (one-time)

### 1. Create a Neon branch for tests

In the Neon dashboard:

1. Open your project → **Branches** → **New Branch**.
2. Name it `e2e` (or whatever you like).
3. Copy its **Pooled** connection string.

The `e2e` branch is isolated from your production data. Tests truncate and
reseed every table between specs, so it's safe to reuse forever — but never
point tests at your production branch.

### 2. Local config

```sh
cp .env.test.example .env.test
# Paste the Neon e2e branch URL into E2E_DATABASE_URL
```

### 3. Install dependencies

```sh
npm ci
npx playwright install chromium
```

## Running tests

```sh
npm test              # headless, all specs
npm run test:ui       # Playwright UI mode — recommended for iterating
npm run test:headed   # run in a visible browser
npm run test:debug    # step through with the inspector
```

Individual spec:

```sh
npx playwright test e2e/booking.spec.js
npx playwright test -g "approve"   # run a single test by name
```

View the last HTML report:

```sh
npx playwright show-report
```

## What's covered

| Spec | Scope |
| --- | --- |
| `homepage.spec.js` | Index/admin/customer pages load, services render, `/healthz`, static file lockdown |
| `auth.spec.js` | Admin login (happy/sad/rate-limit), customer register/login, duplicate email, JWT-type boundaries |
| `booking.spec.js` | Public booking, customer-portal booking, lookup, admin approve/cancel/delete, filtering, owner verification |
| `payment.spec.js` | Payment-link email, webhook flips status, duplicate-webhook idempotency, bad signatures, ownership, already-paid guard |
| `dogs.spec.js` | Dog CRUD, document upload/download visibility, cross-customer isolation, validation |
| `dashboard.spec.js` | Stats arithmetic, services CRUD + active filter, photo upload mime validation |
| `security.spec.js` | Magic-byte upload sniffing, public-endpoint rate limits (lookup, booking creation), password policy (length + letter + digit), email subject sanitization, malformed-recipient rejection, JSON 404, JWT type boundaries and tampering, settings-key whitelist |
| `api-coverage.spec.js` | Newsletter subscribers (idempotency, rate limit, validation), site settings GET/PUT + whitelist, password-reset flow (request, single-use token, second-request invalidation, brute-force limit), SendGrid event webhook persistence, campaign stats and validation, photo edit/delete, payments config visibility |
| `headers.spec.js` | Helmet hardening headers, rate-limit headers on auth responses, JSON content-type on errors, ETag-off invariant |
| `ui.spec.js` | Browser-driven flows: homepage services + newsletter signup, customer register/login (success, weak password, wrong password), admin login success and failure |

## How the harness works

When `TEST_MODE=1`, `server.js` loads `server/testHarness.js` which:

- Overrides the SendGrid transport with an in-memory log (tests read it via
  `GET /api/__test__/emails`).
- Swaps the Stripe client with a deterministic stub (`checkout.sessions.create`
  returns `https://stripe.test/checkout/<id>`). **Webhook signature
  verification still uses real HMAC-SHA256** against `STRIPE_WEBHOOK_SECRET`,
  so that code path is genuinely tested.
- Mounts `/api/__test__/*`:
  - `GET /emails` / `DELETE /emails` — inspect or clear the capture log
  - `POST /db/reset` — truncate every app table and reseed admin + services
  - `POST /rate-limits/reset` — clear in-memory rate-limit counters
  - `POST /stripe/webhook` — sign a synthetic event and forward it through
    the production webhook handler

These endpoints exist **only** when `TEST_MODE=1`. In production (`TEST_MODE`
unset or `NODE_ENV=production`) the harness is never loaded.

## CI

GitHub Actions runs the suite on every PR and push to `main`
(`.github/workflows/e2e.yml`). Set one repository secret:

- `E2E_DATABASE_URL` — the Neon e2e branch connection string

All other env vars are hard-coded to test-safe values in the workflow.

## Troubleshooting

- **"E2E_DATABASE_URL is required"** — you haven't created `.env.test` or the
  value is blank.
- **Webhook tests fail with 500** — check `E2E_STRIPE_WEBHOOK_SECRET` is set
  and matches between `.env.test` and the harness. The default works; if you
  override locally, make sure both places agree.
- **Rate-limit test fails because limit wasn't hit** — the harness resets
  rate limits on `beforeEach`. If you add tests that share a spec and both
  exercise login attempts, call `POST /api/__test__/rate-limits/reset` between
  them.
- **DB state leaking between tests** — `beforeEach` calls `resetAll`, which
  truncates and reseeds. If you add a new table, add it to the TRUNCATE list
  in `server/testHarness.js`.
