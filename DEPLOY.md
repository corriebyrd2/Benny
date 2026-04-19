# Deployment Guide — Railway

This app is a Node.js/Express server with SQLite, file uploads, and Stripe
payments. Railway hosts everything: the marketing homepage, the customer
booking portal, the admin portal, and the API — all on a single domain.

---

## 1. Prerequisites

- A Railway account (https://railway.com)
- A Stripe account (test mode first, live mode at go-live)
- A custom domain, e.g. `bennyandthepets.com`

---

## 2. Create the Railway service

1. **New Project → Deploy from GitHub repo** → pick `corriebyrd2/benny`.
2. Railway auto-detects Node via `package.json`. Build via Nixpacks; start via
   `node server.js`. `railway.json` locks this in and wires a health check at
   `/healthz`.

## 3. Attach a persistent volume (CRITICAL)

Railway containers have ephemeral filesystems. Without a volume, the SQLite
database and uploaded photos are wiped on every redeploy.

1. Service → **Settings → Volumes → New Volume**.
2. Mount path: `/data`
3. Size: start with 1 GB (plenty for SQLite + photos).

The `DB_PATH` and `UPLOAD_DIR` env vars (below) must point inside `/data`.

## 4. Configure environment variables

In the service → **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Generate a strong random string (see below) |
| `ADMIN_EMAIL` | The owner's email for the first admin login |
| `ADMIN_PASSWORD` | A strong password for the first admin login |
| `DB_PATH` | `/data/benny.db` |
| `UPLOAD_DIR` | `/data/uploads` |
| `STRIPE_SECRET_KEY` | Your `sk_test_...` (switch to `sk_live_...` at go-live) |
| `STRIPE_PUBLISHABLE_KEY` | Your `pk_test_...` / `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Fill in after step 6 |

Generate a JWT secret locally:
```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`PORT` is set by Railway automatically — do **not** override it.

`FRONTEND_ORIGIN` is **not needed** since the frontend and API share the same
origin. Leave it unset.

## 5. Deploy and attach a custom domain

1. Trigger a deploy. Watch the logs for `Benny and the Pets server listening`.
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

## 7. First-run checklist

After the first successful deploy:

1. Hit `/admin`, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Upload a few photos; verify they render on the homepage and at
   `/uploads/<filename>`.
3. Create a test booking from `/my-bookings`, send a payment link from the
   admin panel, pay with Stripe's test card `4242 4242 4242 4242`. Verify the
   booking flips to `paid` and the webhook logged 200.
4. Redeploy once (push any commit). Confirm the booking and photo survive the
   redeploy — this validates the Volume is working.

---

## 8. Going live

1. Switch Stripe from test to live mode; replace `STRIPE_SECRET_KEY` and
   `STRIPE_PUBLISHABLE_KEY`, then create a **new** webhook endpoint (live mode
   has its own signing secret). Update `STRIPE_WEBHOOK_SECRET`.
2. Verify `NODE_ENV=production` so the env validator enforces strong secrets.
3. Set up backups (see §9).

## 9. Backups (SQLite)

SQLite on the mounted volume survives redeploys but is still a single file on
one machine. Options, cheapest first:

- **Manual**: `railway run sqlite3 /data/benny.db ".backup /tmp/backup.db"` and
  download periodically. Fine for a small business during the first months.
- **Scheduled (recommended)**: add a Railway cron service that runs a nightly
  `.backup` and uploads to S3 / Backblaze / a Google Drive folder. Ask for a
  follow-up to implement this.

---

## 10. Known limitations / future work

- No email notifications (booking confirmed, payment received). Add nodemailer
  + a transactional provider (Postmark / Resend) when needed.
- No customer email verification on registration.
- No automated tests.
- SQLite does not scale horizontally — fine for this workload, but a future
  migration to Postgres would be straightforward (Railway offers managed PG).
