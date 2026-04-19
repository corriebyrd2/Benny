# Deployment Guide — Railway + Squarespace

This app is a Node.js/Express server with SQLite, file uploads, and Stripe
payments. Railway hosts the app and database; Squarespace serves the marketing
site and links to the Railway-hosted customer/admin portals.

---

## 1. Prerequisites

- A Railway account (https://railway.com)
- A Stripe account (test mode first)
- The Squarespace site (marketing pages)
- A custom domain for the app, e.g. `app.bennyandthepets.com`

---

## 2. Create the Railway service

1. **New Project → Deploy from GitHub repo** → pick `corriebyrd2/benny`.
2. Railway auto-detects Node via `package.json`. Build via Nixpacks; start via
   `node server.js`. `railway.json` locks this in and wires a health check at
   `/healthz`.

## 3. Attach a persistent volume (CRITICAL)

Railway containers have ephemeral filesystems. Without a volume, the SQLite
database and uploaded photos are wiped on every redeploy.

1. In the service → **Settings → Volumes → New Volume**.
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
| `FRONTEND_ORIGIN` | Comma-separated Squarespace origins (see §7) |
| `DB_PATH` | `/data/benny.db` |
| `UPLOAD_DIR` | `/data/uploads` |
| `STRIPE_SECRET_KEY` | Your `sk_test_...` (switch to `sk_live_...` later) |
| `STRIPE_PUBLISHABLE_KEY` | Your `pk_test_...` / `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Fill in after step 6 |

Generate a JWT secret locally:
```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`PORT` is set by Railway automatically — do **not** override it.

## 5. Deploy and attach a custom domain

1. Trigger a deploy. Watch the logs for `Benny and the Pets server listening`.
2. **Settings → Domains → Custom Domain** → add `app.bennyandthepets.com`.
3. Create the CNAME record Railway shows you in your DNS provider.
4. Railway issues a TLS cert automatically (HTTPS is enforced).

## 6. Configure the Stripe webhook

1. In the Stripe dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://app.bennyandthepets.com/api/payments/webhook`
3. Events to send:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
4. After creation, reveal the **Signing secret** and paste it into Railway as
   `STRIPE_WEBHOOK_SECRET`. Redeploy.

Test from the Stripe dashboard's "Send test webhook" button; the Railway logs
should show a 200 response.

## 7. Wire the Squarespace marketing site

The cleanest pattern is: Squarespace for marketing pages, Railway for the app.
Link visitors from Squarespace into the Railway portals.

### 7a. Link buttons on Squarespace

- **Book / Customer portal button** → `https://app.bennyandthepets.com/my-bookings`
- **Admin login** (footer link, usually hidden) → `https://app.bennyandthepets.com/admin`

### 7b. FRONTEND_ORIGIN

Set on Railway to the origins the customer portal may be embedded from or
called cross-origin from. Typical value:

```
https://bennyandthepets.com,https://www.bennyandthepets.com
```

If you do not embed the app in Squarespace and only link to it, CORS is still
worth locking down. Leave blank temporarily if you hit CORS issues and need
to debug, but restore it before go-live.

### 7c. (Optional) Embed the booking form on Squarespace

If the client wants the booking form to appear inside a Squarespace page:

1. Add a **Code Block** in Squarespace.
2. Paste an iframe:
   ```html
   <iframe src="https://app.bennyandthepets.com/my-bookings"
           style="width:100%;height:1400px;border:0;" loading="lazy"></iframe>
   ```
3. If Squarespace's frame-ancestors policy blocks it, you may need to expose a
   dedicated lighter booking page. Ask for a follow-up if this is required.

---

## 8. First-run checklist

After the first successful deploy:

1. Hit `https://app.bennyandthepets.com/admin`, log in with `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`, then **change the admin password** inside the app if that
   feature exists — or rotate the env var and redeploy.
2. Upload a few photos; verify they appear at `/uploads/<filename>`.
3. Create a test booking from `/my-bookings`, request a payment link from the
   admin panel, pay with Stripe's test card `4242 4242 4242 4242`. Verify the
   booking flips to `paid` and the webhook logged 200.
4. Redeploy once (push any commit). Confirm the booking and photo survive the
   redeploy — this validates the Volume is working.

---

## 9. Going live

1. Switch Stripe from test mode to live mode; replace `STRIPE_SECRET_KEY`,
   `STRIPE_PUBLISHABLE_KEY`, and create a **new** webhook endpoint (live mode
   has separate signing secrets). Update `STRIPE_WEBHOOK_SECRET`.
2. Verify `NODE_ENV=production` so the env validator enforces strong secrets.
3. Set up a backup cron (see §10).
4. Link from the live Squarespace site.

## 10. Backups (SQLite)

SQLite on the mounted volume survives redeploys but is still a single file on
one machine. Options, cheapest first:

- **Manual**: `railway run sqlite3 /data/benny.db ".backup /tmp/backup.db"` and
  download periodically. Fine for a small business during the first months.
- **Scheduled (recommended)**: add a Railway cron service that runs a nightly
  `.backup` and uploads to S3 / Backblaze / a Google Drive folder. Ask for a
  follow-up to implement this.

---

## 11. Known limitations / future work

- No email notifications (booking confirmed, payment received). Add nodemailer
  + a transactional provider (Postmark / Resend) when needed.
- No customer email verification on registration.
- No automated tests.
- SQLite does not scale horizontally — fine for this workload, but a future
  migration to Postgres would be straightforward (Railway offers managed PG).
