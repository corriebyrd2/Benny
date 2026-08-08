# Deployment Guide — Railway + Neon

This app is a Node.js/Express server with a Neon (Postgres) database, file
uploads stored on a Railway volume, and Stripe payments. Railway hosts the web
service; Neon hosts the database.

---

## 1. Prerequisites

- A Railway account (https://railway.com)
- A Neon account with a project + database (https://neon.tech)
- A Stripe account (test mode first, live mode at go-live)
- A custom domain, e.g. `bennyandthepets.com`

---

## 2. Create the Neon database

1. Neon console → **New Project**. Name it, pick a region close to Railway's.
2. In the project's **Connection Details** panel, copy the **Pooled connection**
   string (it has `-pooler` in the host). This becomes `DATABASE_URL` in Railway.
3. Keep the default `main` branch. You can create a `dev` branch later for
   testing migrations or running the data-migration script.

Schema is created automatically on first boot via `server/migrations/*.sql`.

## 3. Create the Railway service

1. **New Project → Deploy from GitHub repo** → pick `corriebyrd2/benny`.
2. Railway auto-detects Node via `package.json`. Build via Nixpacks; start via
   `node server.js`. `railway.json` locks this in and wires a health check at
   `/healthz`.

## 4. Attach a persistent volume (uploads only)

The database lives on Neon, so it survives redeploys automatically. **Uploaded
photos** still sit on the Railway container's filesystem, which is ephemeral —
without a Volume, photos wipe on every redeploy.

1. Service → **Settings → Volumes → New Volume**.
2. Mount path: `/data`
3. Size: 1 GB is fine to start.

Then set `UPLOAD_DIR=/data/uploads` in the env vars below. (Future work: move
uploads to S3/Cloudflare R2 and drop the Volume.)

## 5. Configure environment variables

In the service → **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Generate a strong random string (see below) |
| `ADMIN_EMAIL` | The owner's email for the first admin login |
| `ADMIN_PASSWORD` | A strong password for the first admin login |
| `NEON_DATABASE_URL` | The **pooled** connection string from the Neon dashboard |
| `UPLOAD_DIR` | `/data/uploads` |
| `DOG_DOC_UPLOAD_DIR` | Optional private dog-document directory; defaults beside `UPLOAD_DIR` |
| `STRIPE_SECRET_KEY` | Your `sk_test_...` (switch to `sk_live_...` at go-live) |
| `STRIPE_PUBLISHABLE_KEY` | Your `pk_test_...` / `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Fill in after step 6 |
| `SENDGRID_API_KEY` | API key from SendGrid (Mail Send permission) |
| `SENDGRID_FROM_EMAIL` | **Verified** sender email |
| `SENDGRID_FROM_NAME` | Display name (optional, defaults to "Benny and the Pets") |
| `SENDGRID_BOOKING_RECEIVED_TEMPLATE_ID` | Optional Dynamic Template ID for booking request receipt emails |
| `SENDGRID_BOOKING_CONFIRMED_TEMPLATE_ID` | Optional Dynamic Template ID for booking confirmation emails |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | Public key from SendGrid Event Webhook security settings |
| `OWNER_NOTIFICATION_EMAIL` | Where new-booking / payment notifications go (defaults to `ADMIN_EMAIL`) |
| `PUBLIC_URL` | `https://bennyandthepets.com` — used for links in emails |

### Business facts (required before the site can go live)

The site publishes a contact detail only when it is present **and** structurally
valid, and hides the component otherwise — it never renders placeholder text.
These can be set either as environment variables **or**, preferably, in
**Admin → Company Info**, which shows a live checklist of what is still
missing. A setting saved in the admin panel takes precedence over the variable.

| Variable | Admin field | Notes |
| --- | --- | --- |
| `BUSINESS_NAME` | Public trading name | |
| `BUSINESS_LEGAL_NAME` | Registered legal entity name | The name on the LLC registration; appears in the policies |
| `BUSINESS_EMAIL` | Support email | Must be a valid address |
| `BUSINESS_PHONE` | Verified phone number | A 555 number is rejected |
| `BUSINESS_SERVICE_AREA` | Service-area statement | |
| `BUSINESS_HOURS_WEEKDAY` | Weekday operating hours | |
| `BUSINESS_EMERGENCY_CONTACT` | Emergency / after-hours instructions | |

Optional, and hidden until set: address lines and structured-data locality,
region, postal code and country; weekend hours; Facebook / Instagram / TikTok /
Google Business URLs (must be `https`); licence number and authority; insurance
statement; year the business started trading.

### Operational variables (all optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAILY_CAPACITY` | `10` | Dog places per day. Bookings beyond it are refused, not merely reported. |
| `PRICE_CURRENCY` | `usd` | |
| `REQUIRE_EMAIL_VERIFICATION` | off | Require customers to verify their address before booking |
| `METRICS_TOKEN` | unset | Bearer token for `/metrics`. **Unset means loopback-only**, which is the safe default on Railway. |
| `MALWARE_SCAN_COMMAND` | unset | e.g. `clamscan --no-summary`. Unset means uploads are recorded honestly as `not_scanned`. |
| `CUSTOMER_SESSION_ABSOLUTE_MS` / `CUSTOMER_SESSION_IDLE_MS` | 7 d / 48 h | |
| `ADMIN_SESSION_ABSOLUTE_MS` / `ADMIN_SESSION_IDLE_MS` | 12 h / 1 h | |
| `PGPOOL_MAX`, `PG_STATEMENT_TIMEOUT_MS` | 10, 15000 | |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | unset | Cloudflare R2 for dog documents; falls back to local disk |

Generate a JWT secret locally:
```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`PORT` is set by Railway automatically — do **not** override it.

`FRONTEND_ORIGIN` is **not needed** since the frontend and API share the same
origin. Leave it unset.

## 6. Deploy and attach a custom domain

1. Trigger a deploy. Watch the logs for `Benny and the Pets server listening`.
   On first boot you should also see `[migrate] applied 0001_init.sql`.
2. **Settings → Domains → Custom Domain** → add your domain
   (e.g. `bennyandthepets.com` and/or `www.bennyandthepets.com`).
3. Create the CNAME/ALIAS records Railway shows in your DNS provider.
4. Railway issues a TLS cert automatically (HTTPS is enforced).

### Public URLs

Once the domain is live:

| Page | URL |
| --- | --- |
| Marketing homepage | `https://bennyandthepets.com/` |
| Customer booking portal | `https://bennyandthepets.com/my-bookings` |
| Admin portal | `https://bennyandthepets.com/admin` |

## 7. Configure SendGrid

Emails (new booking notifications, payment receipts, confirmations,
cancellations) go through SendGrid. If `SENDGRID_API_KEY` or
`SENDGRID_FROM_EMAIL` is unset, the app silently skips sends and logs a
warning — it will not crash.

1. In SendGrid → **Settings → Sender Authentication**. Either:
   - **Single Sender Verification** (quick): verify one email address via the
     click-link SendGrid emails to you, or
   - **Domain Authentication** (recommended): add the DNS records SendGrid
     gives you to your DNS provider so `from @bennyandthepets.com` works.
2. Create an API key at **Settings → API Keys** with at least **Mail Send**
   permission. Paste into Railway as `SENDGRID_API_KEY`.
3. Set `SENDGRID_FROM_EMAIL` to the verified sender.
4. Set `PUBLIC_URL` to `https://bennyandthepets.com` so links in emails
   point to the right place.
5. Optional but recommended: create SendGrid **Dynamic Templates** for customer
   booking receipts and booking confirmations, then set
   `SENDGRID_BOOKING_RECEIVED_TEMPLATE_ID` and
   `SENDGRID_BOOKING_CONFIRMED_TEMPLATE_ID`. Without these IDs, the app uses
   its built-in HTML/text email copy. Template data includes `booking_id`,
   `owner_name`, `dog_name`, `service_name`, `amount`, `stay`, `portal_url`,
   and (for confirmations) `checkout_url` / `has_checkout_url`.

Send a test: trigger a booking from `/my-bookings` — both the owner and the
customer should receive email within seconds. Approve that booking from `/admin`
to verify the SendGrid confirmation template and checkout link. Check SendGrid →
**Activity** if a send is missing.

### Recommended SendGrid improvements

- Use **Domain Authentication** rather than only Single Sender Verification so
  SPF/DKIM align with `bennyandthepets.com`, improving deliverability.
- Add SendGrid **Event Webhooks** for delivered, bounced, deferred, dropped,
  spam-report, and unsubscribe events. The app accepts those events at
  `/api/sendgrid/events`, verifies signed requests when
  `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` is set, stores each event in
  `email_events`, and updates booking/subscriber delivery status from
  `custom_args.booking_id` / `email_type`.
- Keep booking emails on Dynamic Templates so copy and branding changes can ship
  without a code deploy; use versioned templates and test data before making a
  version active.
- Create separate API keys for production and staging with only **Mail Send**
  permission, and rotate them periodically.

### 7b. SendGrid Event Webhooks

1. SendGrid dashboard → **Settings → Mail Settings → Event Webhook**.
2. Endpoint URL: `https://bennyandthepets.com/api/sendgrid/events`.
3. Enable signed Event Webhook requests and copy the verification public key
   into Railway as `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`. In non-production, the
   app accepts unsigned events only when this key is unset; production requires
   a valid signature.
4. Select at least these events: `processed`, `delivered`, `deferred`,
   `bounce`, `dropped`, `spamreport`, `unsubscribe`, and
   `group_unsubscribe`.
5. SendGrid event payloads are persisted in `email_events`. Events containing
   `booking_id` update the booking's `email_delivery_status`, and events
   matching a newsletter subscriber update subscriber suppression/unsubscribe
   fields.

## 8. Dog document uploads

Customers can upload documents to their dog profiles (for example vaccine
records, care instructions, or forms). These files are stored outside the
public `/uploads` static tree by default and are only served through authenticated
customer/admin download endpoints. On Railway, keep `UPLOAD_DIR` on the mounted
volume (for example `/data/uploads`); dog documents default to `/data/dog-documents`.
Set `DOG_DOC_UPLOAD_DIR` only if you want a different private path.

## 9. Configure the Stripe webhook

1. Stripe dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://bennyandthepets.com/api/payments/webhook`
3. Events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
4. Reveal the **Signing secret** and paste it into Railway as
   `STRIPE_WEBHOOK_SECRET`. Redeploy.

Test from the Stripe dashboard's "Send test webhook" button; Railway logs
should show a 200 response.

---

## 10. First-run checklist

After the first successful deploy:

1. Hit `/admin`, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Upload a few photos; verify they render on the homepage and at
   `/uploads/<filename>`.
3. Create a test booking from `/my-bookings`, send a payment link from the
   admin panel, pay with Stripe's test card `4242 4242 4242 4242`. Verify the
   booking flips to `paid` and the webhook logged 200.
4. Redeploy once (push any commit). Confirm the booking survives (Neon
   persists) and the photo survives (Volume is working).

Schema migrations in `server/migrations/*.sql` run automatically on every boot;
each file is applied at most once (tracked in the `schema_migrations` table).
To evolve the schema, add a new numbered `.sql` file — never edit old ones.

---

## 11. Migrating existing data from the old SQLite database

If you ran an earlier version of this app on SQLite and have a `benny.db` file
you want to bring over:

1. Install better-sqlite3 temporarily: `npm install better-sqlite3`.
2. Put the old SQLite file somewhere accessible, e.g. `./benny.db`.
3. Point at a **fresh, empty** Neon branch (create one in the Neon console to
   avoid polluting production during testing).
4. Run the app once against that branch so migrations create the empty schema.
5. Run the one-shot script:
   ```sh
   SQLITE_PATH=./benny.db DATABASE_URL='postgres://...?sslmode=require' \
     node scripts/migrate-sqlite-to-pg.js
   ```
6. Verify row counts per table, then uninstall better-sqlite3:
   `npm uninstall better-sqlite3`.

## 12. Going live

### The launch gate

```sh
npm run check:launch
```

It exits non-zero while any launch-required business fact is missing or still
placeholder text, and prints exactly which. **Run it against production config
and let a non-zero exit stop the release** — that is the whole point of it. It
also exits non-zero if it cannot reach the database, so a connection problem
fails the deploy rather than waving it through.

The same information is on screen in **Admin → Company Info**, which shows a
live checklist and refuses to save an obviously fictional value.

### Before taking real money

1. `npm run check:launch` passes.
2. **The policies are reviewed.** All ten ship marked *draft pending review by
   qualified counsel*, and that banner is visible to customers. Taking payment
   under draft terms is a business decision, not a technical one — see
   `docs/LEGAL-REVIEW.md` for what a reviewer needs to look at.
3. Stripe is in **live** mode: replace `STRIPE_SECRET_KEY` and
   `STRIPE_PUBLISHABLE_KEY`, create a **new** webhook endpoint (live mode has
   its own signing secret), update `STRIPE_WEBHOOK_SECRET`.
4. **Take one real payment and refund it**, end to end, before announcing the
   site. The test suite exercises the payment path against a deterministic
   stub with real HMAC signature verification — it has never run against
   Stripe itself.
5. `NODE_ENV=production`, so the env validator enforces strong secrets and
   refuses to boot without them.
6. Neon backups confirmed (§13), and `DAILY_CAPACITY` set to the real number of
   dogs that can be boarded at once.
7. Decide about the two inactive services. Grooming and training are seeded
   **inactive** because their rates were never verified; they stay invisible
   until an admin sets a real price and activates them.

### Smoke test after the first live deploy

```sh
curl -fsS https://bennyandthepets.com/healthz     # {"ok":true}
curl -fsS https://bennyandthepets.com/readyz      # ready:true — proves the DB is reachable
curl -fsS https://bennyandthepets.com/robots.txt
```

Then in a browser: the homepage shows real contact details (not a "being
confirmed" placeholder), `/legal` lists ten policies, `/admin` signs in, and a
booking can be created and approved.

## 13. Backups

- **Database**: Neon keeps continuous point-in-time restore on paid plans and
  7-day history on free. Verify the retention window in your Neon project
  settings matches your risk tolerance.
- **Uploads**: the Railway Volume is single-copy. For peace of mind, periodically
  sync `/data/uploads` to S3/R2, or migrate uploads off the Volume entirely.

---

## 14. Known limitations / future work

Accurate as of the remediation merge — the three items previously listed here
(no email verification, no E2E tests, uploads on a Volume) are done: email
verification exists behind `REQUIRE_EMAIL_VERIFICATION`, the suite is 372
Playwright tests plus 24 unit tests, and dog documents go to R2 when it is
configured.

What is genuinely still open:

- **The payment path has never run against real Stripe.** No sandbox
  credentials were available. See §12 step 4.
- **No staging environment.** Changes go from CI straight to production.
- **No screen-reader pass.** axe-core scans the accessibility tree across 11
  surfaces, which is not the same as hearing the result.
- **No malware scanning** unless `MALWARE_SCAN_COMMAND` is set. Uploads are
  recorded as `not_scanned` rather than falsely as clean.
- **Nothing scrapes `/metrics`**, and there is no external uptime probe.
- **Backups are not scheduled.** `npm run drill:restore` proves the *procedure*
  works; nothing runs it or produces the dumps on a timer.
- **Homepage photos** still live on the Railway Volume; only dog documents
  moved to R2.
- All ten legal policies remain **draft pending counsel**.
