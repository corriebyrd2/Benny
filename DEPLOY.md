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
   `/healthz`, which answers without touching the database — a probe that
   queried Postgres on a schedule would stop Neon ever suspending an idle
   compute. A deployment that cannot reach its database still fails, because
   migrations run before the server starts listening. Use `/readyz` when you
   want to ask specifically whether the database is reachable.

## 3. Attach a persistent volume (uploads only)

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

## 5a. Configure SendGrid

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

### 5b. Configure SendGrid Event Webhooks

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

## 5c. Dog document uploads

Customers can upload documents to their dog profiles (for example vaccine
records, care instructions, or forms). These files are stored outside the
public `/uploads` static tree by default and are only served through authenticated
customer/admin download endpoints. On Railway, keep `UPLOAD_DIR` on the mounted
volume (for example `/data/uploads`); dog documents default to `/data/dog-documents`.
Set `DOG_DOC_UPLOAD_DIR` only if you want a different private path.

## 6. Configure the Stripe webhook

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

## 8. First-run checklist

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

## 9. Migrating existing data from the old SQLite database

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

## 10. Going live

1. Switch Stripe from test to live mode; replace `STRIPE_SECRET_KEY` and
   `STRIPE_PUBLISHABLE_KEY`, then create a **new** webhook endpoint (live mode
   has its own signing secret). Update `STRIPE_WEBHOOK_SECRET`.
2. Verify `NODE_ENV=production` so the env validator enforces strong secrets.
3. Confirm Neon backups are enabled (see §11).

## 11. Backups (Neon)

## 9. Backups

- **Database**: Neon keeps continuous point-in-time restore on paid plans and
  7-day history on free. Verify the retention window in your Neon project
  settings matches your risk tolerance.
- **Uploads**: the Railway Volume is single-copy. For peace of mind, periodically
  sync `/data/uploads` to S3/R2, or migrate uploads off the Volume entirely.

---

## 12. Known limitations / future work

- No customer email verification on registration (SendGrid transactional sends
  do not imply the recipient owns the address).
- E2E tests — planned next.
- Uploaded photos still live on a Railway Volume; S3/R2 migration is a future
  cleanup.
