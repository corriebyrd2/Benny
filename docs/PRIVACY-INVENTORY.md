# Data inventory and privacy controls

An engineering inventory of what this application collects, where it lives, who
can reach it, and how long it is kept. It is **not** a legal assessment — the
counsel checklist at the end is what needs a lawyer.

## What is collected

| Data | Where | Collected because | Who can read it |
|---|---|---|---|
| Name, email, phone | `customers` | Taking and fulfilling bookings | The customer; admins |
| Password | `customers.password_hash` | Authentication | Nobody — bcrypt hash, cost 10, never returned by any endpoint |
| Dog name, breed, weight, age, care notes | `dogs` | Animal care | The owning customer; admins |
| Uploaded documents (typically vaccination records) | `dog_documents` + object storage | Admission requirements | The owning customer; admins |
| Booking history: dates, service, dog count, amount, free-text message | `bookings` | Contract performance | The owning customer; admins |
| Payment references (`stripe_session_id(s)`, `stripe_payment_id`) | `bookings` | Reconciliation, refunds, disputes | Admins. **No card data ever reaches this application** — Stripe hosts the payment page |
| Booking/payment state transitions | `booking_events` | Dispute evidence, audit | Admins |
| Stripe webhook event ids | `stripe_events` | Idempotency, replay resistance | Admins |
| Reviews (name, dog name, rating, text) | `reviews` | Published social proof, after moderation | Public once approved |
| Newsletter subscription + consent timestamp and source | `subscribers` | Marketing, on consent only | Admins |
| Policy acceptances: policy, version, timestamp, context, salted IP hash, user agent | `policy_acceptances` | Evidence of agreement | Admins |
| Admin action log | `audit_logs` | Accountability | Admins |
| Email delivery events | `email_events` | Diagnosing non-delivery | Admins |
| Password reset tokens | `password_reset_tokens` | Reset flow | Nobody — SHA-256 hash only, single-use, 1 hour TTL |
| Server request logs | Host log stream | Operations | Operators |

**Not collected**: card numbers, government identifiers, precise location,
biometrics, behavioural advertising identifiers. No third-party analytics,
advertising or tracking script runs on this site — enforced by a test that
asserts zero external origins are contacted, and by a CSP whose `connect-src`,
`script-src` and `style-src` are `'self'` only.

## Data minimisation

Changes made in this remediation:

- **Raw IP addresses are not stored** on policy acceptance. A keyed HMAC
  (truncated to 32 hex characters) distinguishes one actor from another without
  retaining the identifier.
- **The public settings endpoint returns only validated business fields.**
  It previously returned every row of `site_settings` verbatim.
- **The email-only booking lookup endpoints stay removed.** Knowing an email
  address must never be enough to read someone's bookings.
- **List endpoints are bounded** (reviews 24, photos 60, booking events 500),
  so a single response cannot dump the whole table.

## Consent

Two separate, independent records — never one checkbox:

| Consent | Where recorded | Rule |
|---|---|---|
| Terms of Service + Privacy Policy | `policy_acceptances`, context `registration` | **Required** to register. Must be a literal `true`; a missing field is a refusal. Never pre-checked. The version stored is the version the *server* was serving, not one the client claims. |
| Boarding Agreement + Emergency Vet Authorization | `policy_acceptances`, context `booking`, with `booking_id` | Per booking, because the animal and circumstances differ each time |
| Marketing email | `subscribers.consent_at`, `consent_source` | **Optional**, separate checkbox, unticked by default. `POST /api/subscribe` rejects a request without `marketing_consent: true` |

Withdrawal: unsubscribe links carry a keyed HMAC of the address, so they work
from an email client with no session and cannot be used to unsubscribe an
address the sender does not already know. The endpoint always answers 200, so it
cannot be used to probe who is on the list. Re-subscribing is a fresh, explicit
consent that clears the prior opt-out and records a new timestamp.

## Retention

| Data | Current behaviour | Owner decision needed |
|---|---|---|
| Account + bookings | Kept indefinitely | Retention period after last booking (commonly 6–7 years for financial records) |
| Uploaded documents | Deleted when the customer deletes the document or the dog | Compliance retention period after the last stay |
| Reset tokens | Invalidated on use; superseded by a newer request | — |
| Server logs | Host default | 30 days is stated in the policy — confirm the host honours it |
| `booking_events`, `audit_logs`, `stripe_events` | Kept indefinitely | Retention period |

`[OWNER]` markers for each of these appear in the published privacy policy.

## Access control

- Customer data is scoped by `customer_id` from a verified token on every
  authenticated route. Cross-customer isolation is covered by tests in
  `e2e/security.spec.js` for bookings, payment sync, dogs, documents and
  profile.
- Admin and customer tokens are distinguishable: a customer token is explicitly
  rejected by `authenticateToken`, so it cannot reach read-only admin routes.
- Role hierarchy: `admin` > `manager` > `viewer`, enforced per route by
  `requirePermission`.
- Admin actions are written to `audit_logs`.

## Known gaps — engineering work still required

Listed rather than glossed over. None of these is fixed by this change set.

1. **Sessions are still bearer tokens in `localStorage`.** A JWT with a 7-day
   lifetime for customers (24 hours for admins) is stored where any script on
   the page can read it. The CSP added here removes the realistic injection
   route, but the correct fix is an HttpOnly, Secure, SameSite cookie with
   server-side revocation. Until then there is **no way to revoke a session** —
   logout only clears the client copy, and a password reset does not invalidate
   tokens already issued.
2. **No self-service data export.** The privacy policy says a machine-readable
   export is available; it is not implemented.
3. **No self-service account deletion.** Same — stated in the policy,
   not implemented.
4. **No malware scanning** on uploaded documents.
5. **No automated backups or a tested restore.** See `DEPLOY.md`.
6. **No documented processor list.** The policy names categories; the actual
   vendor list and the data-processing agreements are an owner task.

Items 1–3 are the ones that make the published privacy policy currently
*over-claim*, and they should be built before that policy is finalised.

## For counsel

- Which regimes apply: GDPR (any EU/UK customers?), CCPA/CPRA, other state law.
- Lawful basis for each processing purpose as characterised above.
- Retention periods, and which records must survive an account deletion.
- Minimum age and whether any children's-data rules apply.
- Whether the salted IP hash on acceptance records is proportionate.
- Whether the audit and booking-event trails need a defined retention limit.
- Breach notification thresholds and timelines.
- The processor list and the data-processing agreements behind it.
