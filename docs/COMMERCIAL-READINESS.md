# Commercial readiness assessment

**Date:** 2026-08-09
**Commit assessed:** `90c259c`
**Verdict: B− (77/100) — not launch-ready today, but the remaining distance is
mostly *not* engineering work.**

The engineering is strong enough to take real money. The business cannot yet
trade on it: six launch-required business facts are unset, nine of ten legal
documents are unreviewed drafts, and no live payment or email credentials exist.

A configuration-validation bug that refused a production boot for anyone
following the deployment documentation was found during this assessment and is
**fixed in this change set** (B1). The grade is unchanged by that fix — the
remaining blockers are owner and counsel decisions, not code.

Everything below was verified by running it, not read off a document.

---

## Method

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm run test:unit` | **35/35 pass** (24 existing + 11 added with the B1 fix) |
| End-to-end suite | `playwright test --project=chromium` | **253/253 pass** (3.3 min) |
| Secret scan | `npm run check:secrets` | Clean, 136 files |
| Dependency audit | `npm audit --audit-level=high --omit=dev` | **0 vulnerabilities** |
| Migration reversal drill | `npm run drill:migrations` | Pass — up → down → up schema-identical (`109cce7701e1`) |
| Backup/restore drill | `npm run drill:restore` | Pass — 62.3 KB dump, 176 ms restore, row counts, FKs, sequences and CHECK constraints intact |
| Launch gate | `npm run check:launch` | **FAILS** — 6 required business fields missing |
| Production boot | `NODE_ENV=production node server.js` | Failed with the documented configuration; **fixed in this change set** (see B1) |

A local PostgreSQL 16 instance stood in for Neon. Every claim in
`docs/OPERATIONS.md`, `docs/LEGAL-REVIEW.md` and `docs/OWNER-CHECKLIST.md` that
could be tested here held up. The repository's self-assessment is honest — an
unusual and genuinely valuable property.

---

## Scorecard

| Dimension | Weight | Grade | Score |
|---|---|---|---|
| Security and authentication | 15% | A | 94 |
| Feature completeness | 15% | A− | 90 |
| Testing and CI | 10% | A | 95 |
| Payment and financial integrity | 10% | A− | 90 |
| Data layer, migrations, DR | 10% | C+ | 72 |
| Frontend architecture and maintainability | 10% | C | 72 |
| Observability and operations | 8% | B− | 78 |
| Legal and compliance readiness | 12% | D+ | 55 |
| Business configuration / go-live | 10% | F | 40 |
| **Weighted total** | | **B−** | **77** |

Split another way:

- **Engineering readiness: A−.** This is better instrumented, better tested and
  better documented than most funded startups' first production system.
- **Commercial readiness: D+.** The things standing between this code and a
  paying customer are almost entirely owner and counsel decisions.

---

## What is genuinely strong

**Security (A).** Server-side sessions with only SHA-256 hashes stored;
HttpOnly + SameSite=Lax + Secure cookies; double-submit CSRF exempting Bearer
callers; a real Content-Security-Policy with per-request nonces and no
`unsafe-inline` on script; `script-src-attr 'none'`; HSTS with preload;
Permissions-Policy; role-based access control read from the database on every
request so a demotion takes effect immediately; bcrypt password hashing;
registration and password reset that cannot be used to enumerate customers;
rate limits on every public write path. `e2e/security.spec.js` (26 tests) and
`e2e/enumeration.spec.js` (17 tests) hold the line on this.

**Payment integrity (A−).** Stripe webhooks are signature-verified and
processed exactly once through a claim-first `stripe_events` ledger, with the
claim released on failure so Stripe's retry can succeed. Failures answer 5xx
rather than swallowing a real payment. Refunds hold `SELECT … FOR UPDATE` across
the Stripe call *and* use a deterministic idempotency key derived from the
balance already refunded — two independent defences against a double refund.
Payment on a cancelled booking alerts the owner instead of emailing a receipt
for a stay that will not happen. No card data ever touches the application.

**Testing and CI (A).** 253 end-to-end tests plus 24 unit tests, covering
accessibility (axe-core against WCAG 2.2 AA, 0 violations on nine surfaces),
cross-browser, responsive layout at eight viewports, visual regression, SEO and
structured data, security headers, cross-customer isolation, and the full
booking → approve → pay → confirm → refund lifecycle. CI runs the cheap gates
(secret scan, dependency audit) first, then unit tests, then both operational
drills, then the browser suite.

**Operational discipline (B+ in the parts that exist).** Transactional
migrations with executable reversals from `0014` onward, proven by a drill that
compares schema fingerprints. A restore drill that verifies row counts, content,
foreign keys, sequences and constraints. `/healthz` and `/readyz` as distinct
signals. Prometheus metrics with no per-path labels, so the label set cannot be
grown by probing. Runbooks in `docs/OPERATIONS.md` covering rollback, secret
rotation, incident response and the specific queries to run at 2am.

**Commercial honesty.** Fabricated testimonials, invented photo captions, an
unbacked "12+ years experience" claim, a placeholder street address and
`(555)` phone number were all removed, and the code now *refuses to render* an
unconfigured business fact rather than inventing one. Prices derive from
`price_cents` and `billing_unit`, so the label a customer reads and the amount
Stripe charges cannot disagree. That class of integrity is rare and is worth
protecting.

---

## Blockers — cannot trade until these clear

### B1. Production refuses to boot on the documented configuration — ✅ **FIXED in this change set**

`validateEnv()` required `DATABASE_URL` unconditionally, immediately after
having already accepted `NEON_DATABASE_URL` **or** `DATABASE_URL`:

```js
if (!process.env.NEON_DATABASE_URL && !process.env.DATABASE_URL) { … }   // OK
…
if (!process.env.DATABASE_URL) {                                          // wrong
  problems.push('DATABASE_URL must be set (Neon Postgres connection string)');
}
```

`.env.example`, `DEPLOY.md:58` and `docs/OPERATIONS.md` all document
`NEON_DATABASE_URL` as the variable to set. An operator following them got:

```
Refusing to start: insecure configuration
  - DATABASE_URL must be set (Neon Postgres connection string)
```

— naming a variable no document mentions, so the failure looked like a secrets
problem rather than a bug in the check.

**The fix.** The redundant check is gone, and the rules moved to
`server/envCheck.js` as a pure `configProblems(env)` function so they can be
tested. `server.js` keeps only the decision about what to do with the result:
exit in production, warn otherwise.

**Why it survived.** No test could reach it. The E2E suite boots the server with
`NODE_ENV=test`, where the same problems only warn — so a check that wrongly
refused a *production* boot was invisible to all 253 tests.
`tests/unit/envCheck.test.js` (11 tests) now covers the surface directly,
including an explicit assertion that no problem ever demands `DATABASE_URL`
independently of `NEON_DATABASE_URL`.

Verified after the fix: `NODE_ENV=production` with only `NEON_DATABASE_URL` set
now reaches `server listening on :3999 (production)`, while still reporting
`[launch-check] LAUNCH BLOCKED` — which is correct, because an incomplete
business profile must never be an outage (B2 below).

### B2. Six launch-required business facts are unset — *owner*

`npm run check:launch` exits non-zero on: `legal_business_name`,
`contact_email`, `contact_phone_display`, `service_area`, `hours_weekday`,
`emergency_contact`. The site degrades honestly rather than lying — the contact
section says details are being confirmed and no `PostalAddress` is emitted —
but a boarding business with no published phone number, hours or service area
cannot convert a visitor, and `service_area` is the single highest-value field
for local search.

### B3. Nine of ten legal documents are unreviewed drafts — *counsel*

Every `/legal/*` page except the Accessibility Statement carries a visible
"pending review by qualified counsel" banner. Missing entirely: liability
limitation, indemnity, governing law and venue (Terms); assumption-of-risk and
waiver wording plus uncollected-animal handling (Boarding Agreement); which
privacy regime applies and what the retention periods are (Privacy Policy);
whether a spending cap applies before further contact attempts (Emergency Vet
Authorization); whether sales tax applies to pet boarding locally (Payment
Terms).

Taking custody of live animals and money against undrafted liability terms is
the largest single risk in this assessment, and it is not an engineering risk.
The acceptance machinery underneath is sound — versioned, append-only,
server-authoritative, separate from marketing consent — so publishing reviewed
text is a content change, not a rebuild.

### B4. No live credentials — *owner*

Stripe live keys and webhook secret, a SendGrid API key with a verified sender
and SPF/DKIM/DMARC on the domain, R2 bucket credentials, and DNS access to set
`PUBLIC_URL`. All are configured-for but unverified in any environment. Until
transactional email is proven to deliver, `REQUIRE_EMAIL_VERIFICATION` must stay
off — turning it on before then converts a mail misconfiguration into "nobody
can sign in".

---

## Significant risks — should clear before scaling, not before launch

### R1. No scheduled backups (C)

The restore drill proves the *procedure* works; nothing produces the dumps.
Production relies solely on Neon's point-in-time recovery, and no restore has
been exercised against a production dump. R2 has no object versioning, so a
deleted vaccination record is gone permanently. A nightly `pg_dump` to
off-provider storage and enabling bucket versioning are both under an hour of
work and remove the only scenarios in this report that lose customer data
irrecoverably.

### R2. Nothing watches the running system (C+)

`/metrics` serves Prometheus text that nothing scrapes. There is no external
uptime probe and no error-tracking service. `docs/OPERATIONS.md` §6 lists
exactly what to alert on — webhook processing failures, `stripe_events` rows
unprocessed past 15 minutes, bookings stuck `requested` past 72 hours — and none
of it is wired to a pager. In practice the first notification of a payment
outage is a customer email.

### R3. Frontend is an unmaintainable monolith (C)

`admin.html` is 110 KB containing a single 67 KB inline `<script>`;
`customer.html` is 96 KB containing 54 KB. No modules, no bundler, no framework,
no frontend unit tests. There is no ESLint, Prettier, TypeScript or any static
analysis anywhere in the repository — the only `eslint-disable` comment in the
codebase has no ESLint behind it. The E2E suite is currently the *only* thing
standing between a typo and a broken admin portal, and it does that job well,
but the cost of every future change to these two files is high and rising.

### R4. Scale ceiling in the admin panel (B−)

`GET /api/admin/clients` loads customers, dogs, documents and bookings and
aggregates in application memory. It is bounded (default 2000, ceiling 5000) and
reports `truncated` honestly, so it degrades visibly rather than silently — but
it needs real pagination and SQL aggregation before a few thousand clients. It
is admin-only, so customer-facing latency is unaffected.

### R5. No staging environment (C)

Changes go from CI straight to production. Rollback is a Railway redeploy plus
manual migration reversal, which the documentation itself notes is "how data
gets lost" under pressure. Given the test suite's strength this is a smaller
risk than usual, but there is nowhere to rehearse a schema change against
production-shaped data.

### R6. Uploaded pet documents are not scanned (C+)

`MALWARE_SCAN_COMMAND` is unset, so every upload is recorded `not_scanned`. The
integration point exists and both the quarantine and scanner-error paths are
tested — honest, and the honesty is recorded in the database — but customers are
uploading files that admins later download.

---

## Minor findings

- **`POST /api/payments/confirm-payment`** (`server/routes/payments.js:177`) sets
  `payment_status = 'paid'` with no already-settled guard, no `booking_events`
  record and no notification, unlike every other path that marks a booking paid.
  It is admin-and-write gated legacy code for a flow the frontend no longer
  uses. Deleting it is cleaner than maintaining the inconsistency.
- **CSRF tokens are not bound to the session record.** `createSession` mints a
  token, returns it and never stores it, so the check is pure double-submit. An
  attacker able to write cookies for the origin could forge both halves. HSTS
  and `Secure` cookies make that hard in production; storing the token on the
  session row would close it outright.
- **The `style-src-attr 'unsafe-inline'` CSP exception** is a documented,
  defensible trade-off (a nonce cannot apply to a `style=` attribute, and the
  strict alternative silently broke both portals). The exfiltration channels are
  closed by same-origin `img-src`/`font-src`/`connect-src`. Removing the ~124
  remaining `style=` attributes would close it properly.
- **18 migrations predating `0014` have no reversal.** The drill says so plainly
  rather than implying otherwise. Rolling back past them means restoring a
  backup — which reinforces R1.

---

## What "commercially ready" would take

**Before taking a single real payment** (days, mostly not engineering):

1. ~~Fix the `DATABASE_URL` validation bug (B1).~~ ✅ Done in this change set.
2. Owner supplies the six launch fields; `npm run check:launch` exits 0 (B2).
3. Counsel reviews and clears at minimum Terms, Boarding Agreement, Privacy
   Policy and Emergency Vet Authorization; bump versions, clear `draft` (B3).
4. Live Stripe keys, a verified SendGrid sender with domain authentication, R2
   credentials, and `PUBLIC_URL` on the real domain (B4).
5. Run the documented post-deploy smoke tests, then take one sandbox booking
   through approve → pay → confirm → refund by hand.

**Within the first month** (engineering, roughly a week):

6. Nightly off-provider `pg_dump` on a schedule; enable R2 object versioning.
7. Point something at `/metrics`; add an external uptime probe and error
   tracking; wire the alerts already specified in `docs/OPERATIONS.md` §6.
8. Set `MALWARE_SCAN_COMMAND`.
9. Add ESLint and a `lint` CI step.

**Before scaling past a few hundred clients:**

10. Paginate `/api/admin/clients` in SQL.
11. Extract the two portal monoliths into modules with their own tests.
12. Stand up a staging environment.

---

## Bottom line

**B− (77/100).** The gap between this and a launched business is short, and
with B1 fixed, none of what remains is code: six facts only the owner knows,
and a lawyer's afternoon. The engineering underneath — exactly-once payment
processing, defended refunds, WCAG 2.2 AA conformance, 288 passing tests,
tested backups and reversible migrations — is materially better than the median
production application, and the project's willingness to write down what is
*not* done is the strongest signal in the whole repository.

The two things that would most change this grade are the ones that lose data or
money when they fail: scheduled backups, and something that notices when
payments stop working.
