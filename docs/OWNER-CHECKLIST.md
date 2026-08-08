# Owner and counsel checklist

Everything below is blocked on a decision or a fact that only the business owner
or a qualified lawyer can supply. None of it can be invented by engineering, and
none of it has been guessed at: where a value is missing, the affected component
is hidden and `npm run check:launch` reports it.

Check progress at any time:

```sh
npm run check:launch                 # exits non-zero while anything is blocking
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/settings/launch-check
```

---

## 1. Launch blockers — the site should not be publicly promoted until these are set

Set each in **Admin → Settings**, or as the environment variable shown.

| Field | Environment variable | What it must be |
|---|---|---|
| `legal_business_name` | `BUSINESS_LEGAL_NAME` | The registered entity name, exactly as filed (this is what appears in the footer copyright and in the policies). |
| `contact_email` | `BUSINESS_EMAIL` | A monitored mailbox on the business domain. A free webmail address will be accepted by the validator but undermines the trust it is there to establish. |
| `contact_phone_display` | `BUSINESS_PHONE` | A real, answered number. The system rejects any `555` directory-reserved number. |
| `service_area` | `BUSINESS_SERVICE_AREA` | e.g. "Serving the greater Pittsburgh area". This drives the homepage headline, the meta description and the `areaServed` field in structured data — it is the single most valuable field for local search. |
| `hours_weekday` | `BUSINESS_HOURS_WEEKDAY` | Actual opening hours. |
| `emergency_contact` | `BUSINESS_EMERGENCY_CONTACT` | What a customer should do out of hours if something is wrong with their dog. Referenced by the emergency veterinary authorisation. |

Until these are set the contact section shows "Our published contact details are
being confirmed" rather than a fabricated address, and no `PostalAddress` is
emitted in structured data.

## 2. Optional but high-value

| Field | Why it matters |
|---|---|
| `contact_address_line1` / `line2`, `address_locality`, `address_region`, `address_postal_code`, `address_country` | Enables a real "Visit us" card with a working Google Maps link, and a complete `PostalAddress` in LocalBusiness structured data. Leave blank if you operate from a private home address and would rather publish only a service area. |
| `hours_weekend` | Shown beneath weekday hours. |
| `instagram_url`, `tiktok_url` | The footer originally linked both to `href="#"`. Links now render **only** for a stored `https://` URL, so supply the real profile URLs or leave them out. |
| `google_business_url` | Feeds `sameAs` in structured data and gives customers a place to leave a public review. |
| `license_number`, `license_authority` | Published under "Verified details" only when supplied. Do not supply unless you hold the licence. |
| `insurance_statement` | Same. One sentence, factual. |
| `years_in_operation` | The **year you started trading**, not a count. The site computes years from it. This replaces the "12+ Years Experience" claim that had nothing behind it. |
| `footer_tagline` | Cosmetic. |

## 3. Service catalog decisions

The catalog is the single source of truth for both the marketing cards and the
booking form, so a change here moves every surface at once.

- [ ] **Grooming and training are currently inactive.** They were previously
      advertised as immediately bookable while the API served only boarding and
      daycare. Decide for each: do you offer it? At what rate? Then set it
      `active` with `booking_mode` = `bookable` (online booking) or `inquiry`
      (shown with a contact CTA, no online booking).
- [ ] **"Certified trainers"** was listed as a perk of the training service.
      That is a credential claim. It has been removed; restore it only if you
      can name the certification.
- [ ] **Confirm the boarding and daycare rates** ($45/night, $30/day per dog).
      Whatever `price_cents` says is what the customer is charged — labels are
      derived from it, so the two can no longer disagree.
- [ ] **Service perks** ("Private suites", "Evening walk included",
      "Breakfast & dinner", "Supervised group play", "Nap time included",
      "Photo updates") are facility claims. Confirm each is true or edit it.
- [ ] **Capacity** is hard-coded at 10 dogs per day in the availability check.
      Confirm or correct.

## 4. Facts still asserted on the site that you should verify

- [ ] "We aim to respond to booking requests within one business day" — shown on
      the homepage and every service page.
- [ ] "Free cancellation up to 48 hours before the stay" — this is the
      cancellation policy the refund calculator implements. Changing the policy
      means changing `refundForCancellation` in `server/pricing.js` too.
- [ ] "Up-to-date vaccination records required for every dog" — confirm the
      exact vaccination list.
- [ ] The "Meet Ben" copy. Specific facility claims ("acres of safe, fenced play
      areas", "spacious grounds") were removed because they could not be
      verified; add back anything that is true.

## 5. Photography

- [ ] The gallery and the hero/about images render **only** real uploaded
      photos. The six invented captions ("Max playing fetch", "Bella nap time",
      …) are gone, and the gallery section is omitted entirely when there are no
      photos. Upload real photos of the facility and of dogs whose owners have
      given permission.

## 6. Reviews

- [ ] Four testimonials attributed to named people ("Sarah M.", "Mike T.",
      "Jessica R.", "David K.") were fabricated and have been removed. The
      carousel now shows only reviews a real customer submitted and an admin
      approved. If you have real reviews elsewhere (Google, Facebook), the
      cleanest route is to link to them rather than retype them.

---

## 7. For qualified counsel

All ten policy documents at `/legal/*` are **drafts written by the development
team** and render a visible "pending review by qualified counsel" banner. They
exist so the acceptance, versioning, linking and indexing machinery could be
built and tested. They are not legal advice.

Each contains bracketed markers where a decision is required:

- `[OWNER: …]` — a business fact or commercial decision.
- `[COUNSEL: …]` — wording that must be drafted for the governing jurisdiction.

Specific items needing legal input:

| Document | Outstanding |
|---|---|
| Terms of Service | Liability, limitation, indemnity, dispute resolution, governing law and venue. Nothing is drafted — a generic clause is worse than none. |
| Boarding Agreement | Assumption-of-risk and waiver wording for animal boarding; late-collection and uncollected-animal handling under local abandoned-animal law. |
| Emergency Vet Authorization | Whether a spending cap applies before further contact attempts, and how costs are invoiced. |
| Privacy Policy | Which privacy regimes apply (GDPR / CCPA-CPRA / state law), the response-time commitments, retention periods, and the minimum age threshold. |
| Cancellation Policy | Whether the 48h/24h refund tiers are enforceable locally, and whether early collection is refundable. |
| Payment Terms | Whether sales tax applies to pet boarding in the jurisdiction (the system models a tax line, currently zero), and whether a deposit is required. |
| Support Policy | Target response times, out-of-hours route, complaints escalation and any applicable regulator. |
| Pet Documents Policy | The exact required vaccination list and the compliance retention period. |

Once a document is reviewed:

1. Update the text in `server/legal.js`.
2. Bump its `version` (this forces re-acceptance on the next contractual action —
   a customer who accepted v1 is never retroactively bound to v2).
3. Set `draft: false`.
4. Record the reviewer, date and scope in `docs/LEGAL-REVIEW.md`.

The test suite asserts that every document still marked `draft` renders the
review banner, so clearing the flag without reviewing the text will not go
unnoticed in review.

## 8. External accounts and credentials still required

| What | Needed for | Status |
|---|---|---|
| Stripe **live** keys + webhook secret | Taking real payments | Test keys work; live keys not supplied |
| SendGrid API key + verified sender | Transactional email | Not verified in this environment |
| Cloudflare R2 bucket credentials | Uploaded photos and pet documents | Not verified in this environment |
| DNS access for `bennyandthepetsboardingllc.com` | Setting `PUBLIC_URL`, email domain authentication (SPF/DKIM/DMARC) | Not available |
| A Google Business Profile | Local search, and a place for genuine reviews | Unknown |
| Real-user monitoring (e.g. Vercel Analytics, Cloudflare RUM) | Field Core Web Vitals at the 75th percentile — lab measurements cannot substitute | Not configured |
