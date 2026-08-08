# Performance

## What was measured, and how

Lab measurements taken with Playwright driving Chromium against the application
server on loopback, via `e2e/performance.spec.js`. Run them yourself:

```sh
npx playwright test e2e/performance.spec.js
```

Transfer sizes were taken directly from the server:

```sh
curl -s http://localhost:3000/            | wc -c   # uncompressed
curl -s -H 'Accept-Encoding: gzip' http://localhost:3000/ | wc -c   # over the wire
```

**Stated limitation.** Loopback has no RTT and no bandwidth constraint, so the
absolute LCP and TTFB figures below are optimistic compared with a real phone on
a real network. What these numbers do establish is the *weight* and *shape* of
the critical path, which is what actually regressed here. Field Core Web Vitals
at the 75th percentile require real-user monitoring against production traffic;
that is listed as outstanding in `docs/OWNER-CHECKLIST.md`.

## The headline defect: the logo

The homepage, the footer and both portals loaded
`images/bennyandthepets.png` — a **745,014 byte, 1024×1024 PNG** — and rendered
it into a 48×50 pixel box. It was the single largest asset on the site by two
orders of magnitude, it was on the critical path, and it carried no `width`/
`height` so it could shift layout as it arrived.

| Variant | Bytes | vs original |
|---|---:|---:|
| `images/bennyandthepets.png` (original, 1024²) | 745,014 | — |
| `images/logo/logo-48.avif` | 996 | **−99.87%** |
| `images/logo/logo-48.webp` | 1,264 | −99.83% |
| `images/logo/logo-48.png` (fallback) | 6,351 | −99.15% |

Delivered through `<picture>` with AVIF → WebP → PNG sources, a `srcset` at
48/96/144 px for high-density displays, `sizes="48px"`, and explicit
`width`/`height` attributes so the box is reserved before the bytes arrive.
`e2e/performance.spec.js` asserts the original PNG is no longer requested and
that no logo variant exceeds 20 KB.

## Third-party fonts removed

Both the homepage and the portals loaded Fredoka One and Nunito from
`fonts.googleapis.com` on a **render-blocking** `<link>`. That cost a DNS
lookup, a TLS handshake and two round trips before first paint, made the page's
`load` event depend on a host outside our control, and contradicted the cookie
notice's statement that the site makes no third-party requests.

This was not a theoretical cost: while building the test suite, page navigations
timed out at 30 seconds in a network-restricted environment because `load` never
fired — waiting on the font host.

Removed in favour of a system font stack that renders immediately. Consequences:

- One fewer origin in the CSP (`style-src` and `font-src` are now `'self'` only).
- `e2e/performance.spec.js` asserts **zero** external origins are contacted.
- The brand faces are gone. To restore them, self-host: drop the WOFF2 files
  under `/fonts`, add `@font-face` with `font-display: swap`, and `preload` only
  the one face used above the fold.

## Caching

| Response | Policy | Why |
|---|---|---|
| `/css/style.<hash>.css`, `/js/main.<hash>.js` | `public, max-age=31536000, immutable` | The hash changes when the bytes change, so a deploy invalidates the URL for free. Previously served at a stable path with 7 days, which forced a choice between stale clients and no caching. |
| `/images/**` | `public, max-age=30d, immutable` | Content-addressed by name. |
| HTML | `public, max-age=0, must-revalidate` | Prices and the service catalog are rendered into the HTML; a stale copy would show a stale price. |
| Portal HTML (`/admin`, `/my-bookings`) | `no-store` | Each response carries a unique CSP nonce; a cached copy would carry a nonce that no longer matches the header. |
| `/robots.txt`, `/sitemap.xml` | `public, max-age=3600` | |

Compression is `compression()` middleware (gzip/br). `e2e/performance.spec.js`
fails if any text response over 1 KB arrives uncompressed.

## Measured results

Chromium, loopback, cold navigation, after the changes:

| Metric | Measured | Budget | Target (75th pct, field) |
|---|---:|---:|---:|
| TTFB | 7 ms | — | ≤ 800 ms |
| FCP | 128 ms | — | — |
| LCP | 128 ms | < 2500 ms | ≤ 2500 ms |
| CLS | 0.0000 | < 0.1 | ≤ 0.1 |
| DOMContentLoaded | 47 ms | < 2000 ms | — |
| `GET /api/services` | 4 ms | < 500 ms | — |

Transfer sizes for the homepage:

| Asset | Uncompressed | Over the wire (gzip) |
|---|---:|---:|
| `/` (HTML) | 20,005 B | **5,419 B** |
| `/css/style.css` | 38,543 B | **8,901 B** |
| `/js/main.js` | 17,217 B | **5,152 B** |
| Logo (AVIF, 48px) | 996 B | 996 B |

Enforced budgets (`e2e/performance.spec.js`): HTML < 60 KB, CSS < 60 KB,
JS < 60 KB, total < 400 KB, < 25 requests, CLS < 0.1, LCP < 2500 ms.

**INP is not measured here.** It requires real interaction traces; the closest
proxies in place are the removal of all render-blocking third-party requests and
a total JS payload of ~5 KB over the wire. Real INP needs field data.

## Other changes with a measured basis

- **Scroll handler throttled** to one `requestAnimationFrame` per frame. It
  previously ran the navbar class toggle on every scroll event.
- **Section-highlight scroll listener** removed; it walked every `section[id]`
  and every nav link on every scroll event.
- **Decorative paw-print emitter** stops when the tab is hidden, and never
  starts under `prefers-reduced-motion`. It previously ran a `setInterval`
  forever, appending and removing DOM nodes in background tabs.
- **Card tilt** is skipped on coarse pointers and under reduced motion.
- **Database indexes** added for the queries on the render path:
  `services (active, display_order)`, `bookings (customer_id, created_at DESC)`,
  `bookings (status)`, `bookings (payment_status)`,
  `booking_events (booking_id, created_at DESC)`,
  `policy_acceptances (customer_id, policy_slug, accepted_at DESC)`,
  and a partial index on active subscribers.
- **Statement timeout** of 15 s on the connection pool, so one pathological
  query cannot pin a connection indefinitely.
- **List endpoints bounded**: homepage reviews cap at 24, photos at 60, booking
  events at 500.

## What has *not* been optimised, and why

Each of these was considered and rejected because measurement did not support
it — per the brief, an optimisation is not recommended without evidence:

- **Route-level code splitting.** Total JS over the wire is ~5 KB. Splitting it
  would add requests, not remove bytes.
- **A CDN.** Origin TTFB is 7 ms on loopback and the assets are already
  immutable and hashed. A CDN is worth revisiting once real-user data shows
  where the traffic is, not before.
- **Critical CSS inlining.** The whole stylesheet is 8.9 KB gzipped and arrives
  in the same round trip as the HTML. Inlining would duplicate bytes and
  complicate the CSP.
- **Breaking up `admin.html` / `customer.html`.** They are large (99 KB and
  82 KB), but they are behind authentication and are not part of any
  public-facing metric. The inline-handler conversion was done because the CSP
  required it; a full refactor was not, and doing it without a regression suite
  covering those portals would trade a measured non-problem for an unmeasured
  risk.
