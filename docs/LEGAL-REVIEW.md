# Legal review record

Every policy document served at `/legal/*` is defined in `server/legal.js` with
a `version`, an `effective` date and a `draft` flag.

**`draft: true` renders a visible "pending review by qualified counsel" banner
on the page.** `e2e/legal.spec.js` asserts that banner is present for every
document still marked draft, so clearing the flag without reviewing the text
cannot pass silently.

## Review status

| Document | Version | Draft | Reviewed by | Date | Scope of review |
|---|---|---|---|---|---|
| Privacy Policy | 2026-08-08.1 | **Yes** | — | — | — |
| Terms of Service | 2026-08-08.1 | **Yes** | — | — | — |
| Boarding and Service Agreement | 2026-08-08.1 | **Yes** | — | — | — |
| Cancellation and Refund Policy | 2026-08-08.1 | **Yes** | — | — | — |
| Payment and Deposit Terms | 2026-08-08.1 | **Yes** | — | — | — |
| Pet Document and Vaccination Record Policy | 2026-08-08.1 | **Yes** | — | — | — |
| Emergency Veterinary Authorization | 2026-08-08.1 | **Yes** | — | — | — |
| Cookie and Analytics Notice | 2026-08-08.1 | **Yes** | — | — | — |
| Accessibility Statement | 2026-08-08.1 | No | Engineering | 2026-08-08 | Factual statement of what was tested and what was found. Contains no legal representations, so it is published as final. |
| Contact and Support Policy | 2026-08-08.1 | **Yes** | — | — | — |

Nine of ten documents are unreviewed drafts. What counsel needs to decide for
each is listed in `docs/OWNER-CHECKLIST.md` §7 and marked inline in the text as
`[OWNER: …]` and `[COUNSEL: …]`.

## How to publish a reviewed document

1. Update the text in `server/legal.js`.
2. **Bump `version`.** Acceptance records store the version that was shown, so a
   customer who accepted v1 is never retroactively bound to v2. Bumping is what
   forces re-acceptance at the next contractual action.
3. Set `draft: false`.
4. Add a row to the table above: reviewer, date, and what was actually reviewed.
5. Run `npx playwright test e2e/legal.spec.js`.

## Previously flagged over-claims — now resolved

The drafted Privacy Policy promised a machine-readable data export and
self-service account deletion when neither existed. Both are now implemented
and covered by tests (`e2e/account.spec.js`), and the policy text describes what
the software actually does, including that paid bookings are anonymised rather
than deleted because they are financial records.

Remaining engineering gaps that touch privacy commitments are listed in
`docs/PRIVACY-INVENTORY.md` — none of them currently contradict the published
text.

## What the acceptance machinery already does

Independent of the wording, and covered by tests:

- Registration requires explicit acceptance of the Terms and the Privacy
  Policy. Nothing is pre-checked, and a missing field is a refusal rather than
  a default.
- The version recorded is the version the **server** is serving. A client that
  claims to have accepted an older version does not get that version recorded.
- Required contractual acceptance and optional marketing consent are separate
  records with separate controls. Accepting the terms never subscribes anyone
  to marketing.
- Acceptances carry a timestamp, the acceptance context (`registration` /
  `booking`), the related booking where applicable, a salted IP hash rather than
  a raw address, and the user agent.
- Rows are append-only; a withdrawal is a new row, so the history of what
  someone agreed to at a point in time survives.
- Every policy page is publicly reachable, indexable, versioned and dated, and
  linked from the footer plus contextually beside the review form, the
  newsletter, the booking steps and each service page.
