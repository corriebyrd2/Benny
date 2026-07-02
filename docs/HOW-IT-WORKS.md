# Benny and the Pets — How the Website & Admin Dashboard Work

This guide explains, in plain language, how the Benny and the Pets website
works: what customers see, how the admin dashboard runs the business, how
bookings flow from request to payment, and which third‑party tools power it all.

It is written for the business owner and staff — no coding knowledge required —
but it is precise enough to hand to a future developer.

---

## 1. The big picture

Benny and the Pets is a **dog‑care booking website**. It does three jobs:

1. **Markets the business** — a public homepage showing services, photos of the
   dogs, contact details, and social links.
2. **Takes bookings** — customers request boarding, daycare, grooming, or
   training for their dog(s), and pay online by card.
3. **Runs the back office** — a password‑protected admin dashboard where the
   owner approves bookings, collects payments, manages clients, edits the site,
   and sends marketing emails.

Everything lives in one application. There are three "front doors":

| Page | Web address | Who uses it |
| --- | --- | --- |
| **Homepage** | `/` | The public — anyone browsing |
| **Customer portal** | `/my-bookings` | Customers, to book and pay |
| **Admin dashboard** | `/admin` | The owner and staff |

---

## 2. The public website (homepage)

The homepage (`index.html`) is the marketing shop window. It contains:

- **Hero banner** with a "Book a Stay" button.
- **"Meet Ben & The Pack"** — the about section / owner story.
- **Services** — the four offerings (Overnight Boarding, Doggy Daycare, Spa &
  Grooming, Training Sessions), each with a price and a list of perks. These are
  pulled live from the database, so when the owner changes a price or description
  in the admin dashboard, the homepage updates automatically.
- **Photo gallery** ("The Puppy Parade") — photos the owner uploads in the admin
  dashboard.
- **Happy Tails** — testimonials.
- **Contact section** — address, phone, email, opening hours, and social media
  links. These are also editable from the admin "Company Info" panel.
- **Newsletter sign‑up** — visitors can enter their email to join the mailing
  list. That address is stored and can later be emailed via a campaign.

Every "Book a Stay" / "Book" / "Log In to Book" button on the homepage sends the
visitor to the **customer portal** at `/my-bookings`, where the actual booking
happens.

The homepage is public — no login needed to view it.

---

## 3. How booking works

Booking always happens through the **customer portal** (`/my-bookings`).

### 3.1 Customers create an account

A customer registers with their name, email, phone, and a password (minimum 10
characters, must include a letter and a number). They can add one or more **dog
profiles** (name, breed, weight, age, notes) so they don't have to retype the
details each time. Passwords are never stored directly — only a securely
scrambled ("hashed") version is kept, so even the owner can't read them.

If a customer forgets their password, they click **"Forgot password"**, receive
a reset link by email, and the link works once and expires after one hour.

### 3.2 Placing a booking request

From their dashboard, a logged‑in customer:

1. Picks a **service** (e.g. Overnight Boarding).
2. Chooses **which dog(s)** — they can select several saved dogs or type new
   names. The number of dogs is counted automatically from the selection.
3. Picks **dates** (a start date, and an end date for overnight stays) or types
   preferred dates, and can add a **message**.
4. Submits.

As they pick a date, the portal checks **availability** in the background. The
business is set to a **capacity of 10 dogs per day**; if a day is at or near
capacity, the customer sees a warning.

When they submit, the booking is saved with a status of **"pending"** and a
price is calculated automatically (see next section). Two emails go out
immediately:

- **To the customer:** "We got your booking request" (confirmation of receipt).
- **To the owner:** "New booking request" (so the owner knows to review it).

At this stage nothing is confirmed and nothing is paid — it's a **request**.

### 3.3 How the price is calculated

The price is worked out automatically from the service's rate, the length of
stay, and the number of dogs:

- **Boarding** is billed **per night** (rate × number of nights).
- **Daycare** is billed **per day** (rate × number of days).
- **Grooming** and **Training** are **flat per session** (a single fee).
- **Every service is charged per dog** — a booking for two dogs costs twice as
  much.

For example, Overnight Boarding at $45/night for **3 nights** and **2 dogs** =
$45 × 3 × 2 = **$270**. The owner can always override this price manually before
the customer pays (see §4.3).

---

## 4. How the owner processes a booking (admin dashboard)

The admin dashboard at `/admin` is the control centre. The owner logs in with an
email and password. There is a sidebar with eight sections:

**Dashboard · Bookings · Clients · Services · Homepage Photos · Company Info ·
Payments · Campaigns**

### 4.1 Dashboard (overview)

The landing screen shows headline numbers at a glance: total bookings, how many
are pending vs. confirmed, how many photos and active services exist, how many
bookings are paid, total revenue collected, and a list of the five most recent
bookings.

### 4.2 Bookings

A full list of every booking request. Each booking has two independent statuses:

- **Status:** `pending` → `confirmed` → `completed` (or `cancelled`).
- **Payment status:** `unpaid` → `requested` → `paid`.

From here the owner can:

- **Approve** a booking. This marks it **confirmed**, and — if online payments
  are set up — automatically creates a secure card‑payment link and emails the
  customer a "Your booking is confirmed" message with a **Pay now** button.
- **Send a payment request / link** without fully approving, if they prefer.
- **Cancel** a booking with a reason (the customer is emailed the reason).
- **Mark completed** once the stay is done (this also marks it paid).
- **Re‑price** a pending booking or change the dog count (see below).
- **Delete** a booking.

### 4.3 Re‑pricing safeguards

If the owner adjusts the price or dog count on a booking, the system protects
everyone from mistakes:

- A booking that is **already paid cannot be re‑priced** — the receipt must match
  what was actually charged.
- If a payment link was already sent, the old link is **cancelled** so the
  customer can't pay the outdated amount, and the owner must send a fresh link at
  the new price.
- If the customer happens to pay via the old link at the exact moment the owner
  is editing, the system detects the payment, keeps the booking marked paid, and
  refuses the edit.

### 4.4 Clients

A directory of everyone who has interacted with the business, combining
**registered customers** and **guest bookers** (matched by email). For each
client the owner sees their dogs, their booking history, how much they've spent,
and outstanding (unpaid) revenue. The top of the panel shows business‑wide
figures: total revenue, pending revenue, number of clients and dogs, average
spend per client, top spender, and most loyal client.

### 4.5 Services

Add, edit, reorder, activate/deactivate, or delete the services shown on the
homepage — including each service's name, description, icon, list of perks,
price, and price label (e.g. "From $45/night"). The price label is important: the
words "night" or "day" in it tell the system whether to bill per night, per day,
or as a flat session fee.

### 4.6 Homepage Photos

Upload and manage the dog photos shown on the site. Each photo can be assigned to
a **section** (Hero, About, or Gallery), given a caption, reordered, and shown or
hidden from the homepage. Uploaded images are checked to make sure they are
genuine image files (JPEG, PNG, WebP, or GIF, up to 10 MB).

### 4.7 Company Info

Edit the business details that appear on the homepage and in emails: business
name, tagline, address, phone numbers, contact email, opening hours, and social
media links (Facebook, Instagram, TikTok). Changes appear on the public site
immediately.

### 4.8 Payments

Shows whether online card payments are connected, plus a payment history. The
owner can also **re‑sync** a booking with the card processor here — useful if a
payment went through but the automatic update didn't land for some reason.

### 4.9 Campaigns (marketing email)

Write a one‑off email (subject + body) and send it to everyone on the newsletter
mailing list. The system sends in batches behind the scenes and reports how many
recipients it reached.

### 4.10 Staff roles

Admin accounts have one of three roles, controlling what they're allowed to do:

| Role | Can view | Can edit/approve | Can delete | Manage other admins |
| --- | --- | --- | --- | --- |
| **Viewer** | ✅ | — | — | — |
| **Manager** | ✅ | ✅ | ✅ | — |
| **Admin** | ✅ | ✅ | ✅ | ✅ |

Every meaningful admin action (logins, approvals, cancellations, deletions,
payment requests, etc.) is written to an **audit log** so there's a record of who
did what and when.

---

## 5. How payments work

Payments are handled by **Stripe**, a trusted card‑payment provider. Card details
are entered on Stripe's own secure checkout page — the Benny and the Pets site
never sees or stores card numbers.

The typical flow:

1. The owner **approves** a booking (or sends a payment link).
2. The system asks Stripe to create a **secure checkout link** for the exact
   amount and emails it to the customer with a **Pay now** button.
3. The customer clicks the link, pays by card on Stripe's page, and is sent back
   to their portal.
4. Stripe notifies the site that payment succeeded (via a "webhook"). The booking
   is automatically marked **paid** and moved to **confirmed**.
5. Two receipt emails go out: one **to the customer** ("Payment received") and
   one **to the owner** ("Payment received").

**Belt‑and‑braces reconciliation:** webhooks occasionally fail to arrive
(network hiccups, misconfiguration). To cover that, the site also **double‑checks
directly with Stripe** when a customer returns from checkout, and the owner can
manually **re‑sync** any booking from the Payments panel. Because of this, a
payment is never lost — the booking will show as paid as soon as any of these
checks confirms it with Stripe.

Customers can also pay for any outstanding booking at any time from their own
portal by clicking a **Pay** button, which opens the same secure Stripe checkout.

---

## 6. Emails the system sends

All email is sent through **SendGrid** (a transactional email service). Automatic
emails include:

| Trigger | Sent to | Message |
| --- | --- | --- |
| New booking request | Customer | "We got your booking request" |
| New booking request | Owner | "New booking request" |
| Booking approved | Customer | "Your booking is confirmed" (+ Pay link) |
| Payment link sent | Customer | "Payment link for your booking" |
| Payment received | Customer | "Payment received" (receipt) |
| Payment received | Owner | "Payment received" |
| Booking cancelled | Customer | "Your booking was cancelled" (+ reason) |
| Forgot password | Customer | Password reset link (expires in 1 hour) |
| Marketing campaign | Mailing list | Whatever the owner writes |

If SendGrid isn't configured, the site keeps working — it simply skips sending
the emails rather than failing.

---

## 7. The tools and technologies used

Here is every major tool the site relies on and what each one does.

### Runs the application
- **Node.js + Express** — the web server software that powers the whole site
  (both the pages people see and the behind‑the‑scenes logic).
- **Railway** — the hosting service the application runs on, reachable at the
  business's web address.

### Stores the data
- **Neon (PostgreSQL)** — the cloud database that stores customers, dogs,
  bookings, services, photos, admins, settings, subscribers, and the audit log.
- **Cloudflare R2** — cloud storage for uploaded photos, so images survive site
  updates and load reliably. (If R2 isn't set up, photos are stored on the server
  instead.)

### Handles money
- **Stripe** — secure online card payments and checkout pages. The site holds
  Stripe "keys" to talk to it, and verifies Stripe's payment notifications with a
  signed secret so they can't be faked.

### Handles email
- **SendGrid** — sends all the transactional emails (confirmations, receipts,
  password resets) and the marketing campaigns.

### Keeps things secure
- **Password hashing (bcrypt)** — customer and admin passwords are stored only in
  scrambled form.
- **Login tokens (JWT)** — after logging in, customers and admins carry a secure
  digital "pass" (admins' expire after 24 hours, customers' after 7 days).
- **Rate limiting** — caps how often someone can attempt logins, registrations,
  password resets, bookings, and lookups, to block abuse and guessing attacks.
- **Security headers (Helmet), CORS rules, and input checks** — standard
  protections that harden the site against common web attacks.
- **Audit log** — a permanent record of admin actions.

### Behind the scenes
- **Automatic database setup (migrations)** — the correct database structure is
  created and kept up to date automatically when the app starts. On the very
  first run it also seeds the initial admin account and the four default
  services.
- **Health check** — a `/healthz` address the host pings to confirm the site and
  database are alive.
- **Automated tests (Playwright)** — end‑to‑end tests that exercise the booking
  and payment flows to catch problems before they reach customers.

---

## 8. A booking's full journey (summary)

Putting it all together, here's the life of a typical booking:

1. A visitor browses the **homepage** and clicks **Book a Stay**.
2. They **register/log in** on the customer portal and add their dog.
3. They **submit a booking request** — status *pending*, price auto‑calculated.
   The customer and owner both get an email.
4. The owner reviews it in the **admin dashboard** and clicks **Approve** —
   status becomes *confirmed* and a **Stripe payment link** is emailed to the
   customer.
5. The customer **pays by card** on Stripe's secure page.
6. Stripe confirms the payment; the booking is marked **paid**, and both parties
   get a **receipt email**.
7. After the stay, the owner marks the booking **completed**.

Every step is recorded, every payment is reconciled with Stripe, and the client
directory and dashboard figures update automatically along the way.
