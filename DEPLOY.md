# Deployment Guide — Railway + Neon

This app is a Node.js/Express server with a Neon (Postgres) database, file
uploads stored on a Railway volume, and Stripe payments. Railway hosts the web
service; Neon hosts the database.

---

## 1. Prerequisites

- A Railway account (https://railway.com)
- A Neon account (https://neon.tech)
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

## 4. Attach a persistent volume (for uploaded photos only)

The database lives in Neon, but uploaded photos are still written to the
container's filesystem. Without a volume they are wiped on every redeploy.

1. Service → **Settings → Volumes → New Volume**.
2. Mount path: `/data`
3. Size: 1 GB is plenty for photos.

## 5. Configure environment variables

In the service → **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Generate a strong random string (see below) |
| `ADMIN_EMAIL` | The owner's email for the first admin login |
| `ADMIN_PASSWORD` | A strong password for the first admin login |
| `DATABASE_URL` | Neon **pooled** connection string (ends in `?sslmode=require`) |
| `UPLOAD_DIR` | `/data/uploads` |
| `STRIPE_SECRET_KEY` | Your `sk_test_...` (switch to `sk_live_...` at go-live) |
| `STRIPE_PUBLISHABLE_KEY` | Your `pk_test_...` / `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Fill in after step 7 |

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

## 7. Configure the Stripe webhook

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
4. Redeploy once (push any commit). Confirm the booking and photo survive the
   redeploy — this validates both Neon persistence and the Railway volume.

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

Neon provides point-in-time restore and branching out of the box:

- **Point-in-time restore**: Neon console → project → **Restore** picks any
  moment within the configured history window. Default window depends on plan.
- **Branches as snapshots**: create a named branch (e.g. `pre-upgrade-2026-01`)
  before any risky change. Branches are copy-on-write and cheap.

No separate backup cron is needed.

---

## 12. Known limitations / future work

- File uploads still live on a Railway volume (single replica, no replication).
  Migrate to S3/R2 when traffic warrants it.
- No email notifications (booking confirmed, payment received). Add nodemailer
  + a transactional provider (Postmark / Resend) when needed.
- No customer email verification on registration.
- No automated tests.
