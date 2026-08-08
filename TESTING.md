# E2E Testing

Two suites:

- **Unit** (`tests/unit/`, `node --test`) — pricing arithmetic and label
  derivation, business-profile validation and placeholder detection. No
  database, no browser, runs in about a second.
- **End-to-end** (`e2e/`, Playwright) — the application driven over HTTP and
  through a real browser.

E2E runs against a throwaway Postgres, never production data.

## Setup (one-time)

### Quickest path: a local Postgres

```sh
createdb benny_e2e
cp .env.test.example .env.test
# E2E_DATABASE_URL=postgresql://<user>@127.0.0.1:5432/benny_e2e?sslmode=disable
```

`sslmode=disable` matters: the driver otherwise negotiates TLS against a server
that does not offer it and every query fails.

CI uses a Postgres **service container** and needs no secret at all. The
`E2E_DATABASE_URL` repository secret is optional and only used to point CI at a
Neon branch for reproducing a provider-specific issue.

### Alternative: a Neon branch

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
npm run test:unit     # unit tests only — fast
npm run test:all      # unit + e2e
npm test              # headless, all e2e specs
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
| `booking.spec.js` | Public booking, customer-portal booking, removed email-only lookup endpoints stay removed, admin approve/cancel/delete, filtering |
| `payment.spec.js` | Payment-link email, webhook flips status, duplicate-webhook idempotency, bad signatures, ownership, already-paid guard |
| `dogs.spec.js` | Dog CRUD, document upload/download visibility, cross-customer isolation, validation |
| `dashboard.spec.js` | Stats arithmetic, services CRUD + active filter, photo upload mime validation |
| `security.spec.js` | Magic-byte upload sniffing, public-endpoint rate limits (booking creation), password policy (length + letter + digit), email subject sanitization, malformed-recipient rejection, JSON 404, JWT type boundaries and tampering, settings-key whitelist, cross-customer data isolation (bookings, payment sync, dogs, documents, profile) |
| `api-coverage.spec.js` | Newsletter subscribers (idempotency, rate limit, validation), site settings GET/PUT + whitelist, password-reset flow (request, single-use token, second-request invalidation, brute-force limit), SendGrid event webhook persistence, campaign stats and validation, photo edit/delete, payments config visibility |
| `headers.spec.js` | Helmet hardening headers, rate-limit headers on auth responses, JSON content-type on errors, ETag-off invariant |
| `ui.spec.js` | Browser-driven flows: homepage services + newsletter consent, customer register/login (success, weak password, wrong password, missing consent), admin login success and failure |
| `catalog-trust.spec.js` | Marketing cards and the booking catalog come from one source; booking modes; `price_label` is unwritable; a price change propagates to every surface; the booked amount matches the advertised rate; no fabricated stat, testimonial, address or dead social link is published; the settings API rejects placeholders; the launch check blocks |
| `legal.spec.js` | All ten policy pages reachable, indexable, versioned; draft banners; contextual linking; versioned acceptance (refused without it, refused on partial, refused on truthy-but-not-true, server-chosen version); marketing consent separate from contractual; unsubscribe honoured by campaigns |
| `seo.spec.js` | robots.txt, sitemap.xml (valid, complete, every URL resolves), unique titles and descriptions, self-referencing canonicals, Open Graph, structured data validity and non-fabrication, 404s rather than soft-404s, crawlable per-service pages, no dead internal links |
| `accessibility.spec.js` | axe-core WCAG 2.2 AA scans across nine surfaces, plus skip link, accessible names, keyboard operation of custom widgets, live regions, target size, 320px reflow, text spacing, reduced motion |
| `responsive.spec.js` | Eight viewports from 320x568 to 1920x1080, landscape, long unbreakable user content, both portals on mobile, iOS focus-zoom prevention |
| `performance.spec.js` | Byte and request budgets, logo sizing, no third-party origins, compression, cache headers, lazy loading, measured LCP/CLS/TTFB, bounded list endpoints |
| `documents.spec.js` | Dog-document content validation (executables, HTML, SVG, polyglots, oversized, empty), path traversal, safe delivery headers, cross-customer isolation, admin-vs-customer authorisation, duplicate submission, deletion cascade, audit trail |

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
