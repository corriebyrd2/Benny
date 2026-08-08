# Deployment, rollback and incident procedures

Companion to `DEPLOY.md`, which covers first-time setup. This document covers
running the thing: releasing a change, backing out, restoring data, rotating a
secret, and what to do at 2am.

---

## 1. Configuration

### Required in production — the process refuses to start without them

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | |
| `NEON_DATABASE_URL` (or `DATABASE_URL`) | Pooled Neon connection string |
| `JWT_SECRET` | ≥ 48 random bytes. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seeds the first admin on an empty database |

`server.js` validates these at boot and calls `process.exit(1)` in production
rather than starting with insecure defaults. `TEST_MODE=1` combined with
`NODE_ENV=production` is also a hard refusal — the test harness stubs Stripe and
swallows email, so a production process running it would silently drop real mail
and never charge anyone.

### Required before public launch — checked, not enforced at boot

Business identity. Missing values hide their public component rather than
publishing a placeholder, and are reported at boot and by
`GET /api/settings/launch-check`.

```
BUSINESS_LEGAL_NAME  BUSINESS_EMAIL  BUSINESS_PHONE
BUSINESS_SERVICE_AREA  BUSINESS_HOURS_WEEKDAY  BUSINESS_EMERGENCY_CONTACT
```

These can equally be set through Admin → Settings, which is the expected route.
See `docs/OWNER-CHECKLIST.md`.

**Why this is not a boot failure:** the site is already live. Refusing to start
on missing business configuration would convert an incomplete profile into an
outage. The gate is enforced in the deploy pipeline instead (§3).

### Other

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | request host | Canonical origin for canonicals, sitemap and email links |
| `FRONTEND_ORIGIN` | empty | Comma-separated CORS allowlist. Empty in production means same-origin only |
| `DATABASE_SSL` | `require`-ish | `disable` for a local/CI Postgres, `verify-full` to enforce chain validation |
| `PGPOOL_MAX` | `10` | Connection pool ceiling. Must stay under the Neon plan's limit |
| `PG_STATEMENT_TIMEOUT_MS` | `15000` | Caps how long one query can pin a connection |
| `UPLOAD_DIR`, `DOG_DOC_UPLOAD_DIR` | | Ignored when R2 is configured |
| `DAILY_CAPACITY` | `10` | Dog places per day. Booking creation enforces it, not just the availability display |
| `REQUIRE_EMAIL_VERIFICATION` | off | `1` blocks sign-in until the address is confirmed. **Do not turn this on until transactional email is verified working** — it converts a mail misconfiguration into "nobody can sign in" |
| `CUSTOMER_SESSION_ABSOLUTE_MS` / `_IDLE_MS` | 7d / 48h | Customer session lifetimes |
| `ADMIN_SESSION_ABSOLUTE_MS` / `_IDLE_MS` | 12h / 1h | Admin session lifetimes — shorter, because an admin session reaches every customer's data |
| `MALWARE_SCAN_COMMAND` | unset | e.g. `clamscan --no-summary`. Unset means uploads are recorded `not_scanned` |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | | Payments |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | | Transactional email |
| `R2_*` | | Object storage |

---

## 2. Secrets

Secrets live only in the Railway Variables tab. They are never in the
repository, never in a browser bundle, and never logged: the central error
handler returns a generic message for 500s in production, and no route echoes
configuration back to a client.

### Rotating `JWT_SECRET`

Sessions are server-side and do NOT depend on this value, so rotating it no
longer signs everyone out. It is still used to key HMACs — unsubscribe links,
and the salted IP hashes on acceptance and enquiry records — so after rotation
previously issued unsubscribe links stop verifying. Account-level opt-out still
works.

1. Generate the new value.
2. Set it in Railway. The service restarts.
3. Everyone is signed out and signs in again.
4. Announce it beforehand unless you are rotating *because* of a compromise, in
   which case do it immediately.

Note this is also the key for unsubscribe-link HMACs and the IP hashes on
policy acceptances — after rotation, previously issued unsubscribe links stop
verifying. If you rotate, expect unsubscribe complaints; the account-level
opt-out still works.

### Rotating `ADMIN_PASSWORD`

Changes the seed only; it does not change an existing admin's password. Change
that through the admin panel.

### Rotating Stripe keys

1. Create the new restricted key in Stripe.
2. Set it in Railway; the service restarts.
3. Create a **new** webhook endpoint, set `STRIPE_WEBHOOK_SECRET` to its secret,
   and only then delete the old endpoint — otherwise events land in the gap.

### If a secret leaks

Rotate first, investigate second. Then check `audit_logs` and `booking_events`
for anything done with it.

---

## 3. Deploying

```sh
# 1. Green locally
npm ci
npm run test:unit          # 24 tests
npx playwright test        # full suite

# 2. Configuration gate — NO `|| true` here, unlike CI
npm run check:launch

# 3. Merge to main. Railway builds and deploys from main.
```

`npm run check:launch` exits non-zero while any launch-required business field
is missing or still placeholder text. Wiring it into the release step is what
stops a deploy from publishing "123 Pawsome Lane" again.

### What happens on boot

1. `validateEnv()` — refuses to start on insecure production configuration.
2. `runMigrations()` — applies every unapplied `server/migrations/*.sql` in
   filename order, **each in its own transaction**, recording it in
   `schema_migrations`. A failure rolls that migration back and aborts boot, so
   the service never serves traffic against a half-migrated schema.
3. `seed()` — first-run only; idempotent.
4. R2 bucket probe, if configured.
5. Launch check report.
6. Listen.

### Smoke tests after every deploy

```sh
BASE=https://bennyandthepetsboardingllc.com

curl -fsS   $BASE/healthz                       # {"ok":true} — hits the database
curl -fsS   $BASE/ | grep -q "Request a booking"
curl -fsS   $BASE/api/services | head -c 200    # catalog resolves
curl -fsS   $BASE/robots.txt   | grep -q Sitemap
curl -fsS   $BASE/sitemap.xml  | grep -q urlset
curl -fsS   $BASE/legal/privacy > /dev/null
curl -fsSI  $BASE/ | grep -i 'content-security-policy'
curl -fsSI  $BASE/ | grep -i 'strict-transport-security'

# Prices agree end to end
curl -fsS $BASE/api/services | python3 -c "
import json,sys
for s in json.load(sys.stdin):
    cents=s['price_cents']; label=s['price_label']
    assert f'\${cents//100}' in label, (s['name'], cents, label)
print('price labels consistent')"

# No placeholder survived
curl -fsS $BASE/ | grep -qi 'pawsome lane\|(555)' && echo 'PLACEHOLDER LEAKED' && exit 1
echo 'smoke tests passed'
```

Then, by hand: sign in to `/admin`, sign in to `/my-bookings`, and take one
sandbox booking through approve → pay → confirmed.

---

## 4. Rollback

### Code only — no migration in the release

Railway → service → **Deployments** → the previous successful deployment →
**Redeploy**. Roughly 60 seconds. Re-run the smoke tests.

### The release included a migration

Every migration in this change set is written to be reversible, and each
migration file documents its own reversal at the top. Reversal is **manual and
deliberate** — there is no automatic `down` runner, because an automatic one
invites running a destructive step under pressure.

| Migration | Reversal | Data loss |
|---|---|---|
| `0014_service_catalog_and_pricing` | Re-add `price_label` and regenerate it from `price_cents`/`billing_unit` (recipe in the file); drop `booking_mode`, `price_is_from`, `currency` and the CHECK constraints | None — the label is fully derivable |
| `0015_purge_placeholder_business_profile` | Nothing to restore. It deleted fabricated placeholder rows | None worth restoring |
| `0016_payment_events_and_booking_audit` | `DROP TABLE booking_events, stripe_events;` drop the added indexes | Loses history; no live decision reads these tables |
| `0017_policy_acceptances` | `DROP TABLE policy_acceptances;` | **Loses consent evidence.** Export first |
| `0018_subscriber_consent` | `ALTER TABLE subscribers DROP COLUMN consent_at, consent_source, unsubscribed_at, unsubscribe_reason;` | **Loses consent and opt-out records.** Export first |

Procedure:

```sh
# 1. Snapshot the current state before touching anything
pg_dump "$DATABASE_URL" > pre-rollback-$(date +%Y%m%dT%H%M%S).sql

# 2. Export anything the reversal destroys
psql "$DATABASE_URL" -c "\copy policy_acceptances TO 'acceptances.csv' CSV HEADER"
psql "$DATABASE_URL" -c "\copy (SELECT email, consent_at, consent_source, unsubscribed_at FROM subscribers) TO 'consent.csv' CSV HEADER"

# 3. Apply the reversal SQL from the migration file's header comment

# 4. Remove the row so the migration re-applies on a future roll-forward
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE name = '00XX_....sql'"

# 5. Redeploy the previous code
```

**Preferred alternative:** roll *forward* with a corrective migration. Rolling a
schema backwards under pressure is how data gets lost.

### Rolling back is not safe when

- Customers have paid against the new schema. Fix forward.
- The failure is in a webhook handler. Stripe retries with backoff; fix forward
  and let the retries land. `stripe_events` makes reprocessing idempotent.

---

## 5. Backups and restore

**Current state: Neon's automatic point-in-time recovery, and nothing else. No
restore drill has been performed in this environment because it requires access
to the production Neon project.** This is an open item — see §9.

What should be in place:

```sh
# Nightly logical backup, retained 30 days, stored off Neon
pg_dump --no-owner --format=custom "$DATABASE_URL" > "benny-$(date +%F).dump"
```

Restore drill, to be run quarterly against a scratch Neon branch:

```sh
# 1. Branch production in the Neon console (instant, copy-on-write)
# 2. Restore into it
pg_restore --clean --if-exists --no-owner -d "$SCRATCH_URL" benny-YYYY-MM-DD.dump
# 3. Point a scratch app instance at it
NEON_DATABASE_URL="$SCRATCH_URL" NODE_ENV=production node server.js
# 4. Verify: row counts, the newest booking, one document downloads,
#    /healthz, and one login
# 5. Record the date, the dump used, and the elapsed time below
# 6. Delete the branch
```

| Drill date | Dump | Time to restore | Result |
|---|---|---|---|
| _(none yet — blocked on production Neon access)_ | | | |

Object storage (R2) holds uploaded photos and pet documents. It has its own
durability but **no versioning is configured**, so a deletion is permanent.
Enabling object versioning on the bucket is an owner task.

---

## 6. Monitoring

### What exists

- `GET /healthz` — executes `SELECT 1`, so it fails when the database is
  unreachable rather than reporting a green process with a dead dependency.
  Railway is configured to probe it.
- Structured, privacy-safe logging: `[error]`, `[probe]`, `[webhook]`,
  `[sync]`, `[launch-check]`, `[r2]`, `[booking-audit]`. Stack traces, SQL,
  tokens and personal data are never returned to a client; production 500s
  return a generic message.
- `audit_logs`, `booking_events` and `stripe_events` in the database.

### What to alert on

| Signal | Where | Threshold |
|---|---|---|
| `/healthz` failing | Railway health check | 2 consecutive |
| 5xx rate | Railway metrics | > 1% over 5 min |
| `[webhook] processing failed` | Logs | Any occurrence |
| `stripe_events` rows with `processed_at IS NULL` older than 15 min | Query | Any |
| `[error] ... /api/payments/*` | Logs | Any |
| Bookings stuck `requested` > 72 h | Query | Any |
| Repeated 401 from one IP | Logs | > 20 in 15 min |
| `[r2] startup probe FAILED` | Logs | Any |
| `[launch-check] LAUNCH BLOCKED` | Logs | Any, after go-live |

Useful queries:

```sql
-- Webhook events that were claimed but never completed
SELECT event_id, event_type, booking_id, received_at
FROM stripe_events WHERE processed_at IS NULL
  AND received_at < NOW() - INTERVAL '15 minutes';

-- Payments requested but never settled
SELECT id, email, service_name, amount_cents, updated_at
FROM bookings WHERE payment_status = 'requested'
  AND updated_at < NOW() - INTERVAL '72 hours';

-- Recent booking state changes
SELECT * FROM booking_events ORDER BY created_at DESC LIMIT 50;

-- Enquiries nobody has answered
SELECT id, name, email, created_at FROM inquiries
WHERE status = 'new' AND created_at < NOW() - INTERVAL '2 days';

-- Days at or over capacity in the next fortnight
SELECT d::date AS day, SUM(GREATEST(b.dog_count, 1))::int AS dogs
FROM generate_series(CURRENT_DATE, CURRENT_DATE + 14, '1 day') d
JOIN bookings b ON b.status != 'cancelled'
  AND b.start_date <= d AND COALESCE(b.end_date, b.start_date) >= d
GROUP BY 1 HAVING SUM(GREATEST(b.dog_count, 1)) >= 10 ORDER BY 1;
```

**Not in place:** metrics, distributed tracing, and an external uptime probe.
Railway's built-in metrics plus the health check are the current floor.

---

## 7. Incident response

1. **Assess.** `/healthz`, Railway metrics, recent deployments. Is it the app,
   Neon, Stripe or SendGrid? Check each provider's status page before assuming
   it is us.
2. **Stop the bleeding.** If a deployment caused it, roll back the code (§4).
   If it is a dependency, the app degrades rather than dies — a Stripe outage
   returns 503 on checkout while bookings still submit.
3. **Preserve evidence.** Export the relevant logs before they roll off.
4. **Payment incidents specifically.** Never reconcile by hand first. Use
   `POST /api/payments/sync-admin/:booking_id`, which asks Stripe what actually
   happened and is safe to repeat. `stripe_events` shows which webhooks were
   processed and `booking_events` shows every transition with a timestamp.
5. **Suspected credential compromise.** Rotate (§2), then audit `audit_logs`
   for admin actions and `booking_events` for changes in the window.
6. **Suspected data exposure.** Preserve logs, determine scope from
   `audit_logs`, and escalate to the owner and counsel — notification
   thresholds and timelines are a legal question, not an engineering one.
7. **Write it down.** What broke, the blast radius, the fix, and the test that
   now covers it. A fix without a test is an incident scheduled for later.

---

## 8. Scaling

Current posture, honestly stated: this comfortably serves hundreds of customers.
Thousands would need the items in §9.

- Connection pool capped at `PGPOOL_MAX` (default 10) with a 15 s statement
  timeout, so one bad query cannot exhaust the pool.
- Indexes on every query on the render path (listed in `docs/PERFORMANCE.md`).
- Public list endpoints are bounded.
- Rate limits: auth 10/15 min, registration 5/h, password reset 5/h,
  public bookings 30/h, reviews 5/h, newsletter 20/h.
- Static assets are content-hashed and immutable for a year.

**Known bottleneck.** `GET /api/admin/clients` loads every customer, dog,
document and booking and aggregates in memory. It is fine at hundreds of
clients and will not be at tens of thousands. It is admin-only, so it does not
affect customer-facing latency, but it needs pagination before that point.

---

## 9. Open operational items

1. No automated off-Neon backup, and **no completed restore drill**.
2. No object versioning on the R2 bucket.
3. No metrics, tracing or external uptime probe.
4. No dependency/secret scanning in CI (`npm audit` reports advisories today).
5. No staging environment — changes go from CI straight to production.
6. `/api/admin/clients` needs pagination before the client count grows.
7. Expired session rows are never swept. They are harmless (resolveSession
   rejects them) but the table grows without bound:
   `DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '30 days';`
