# Accessibility

Target: **WCAG 2.2 Level AA** across the public site, the customer account area,
and the booking and payment flow.

## How it is verified

Two layers, because automated checks alone cannot establish conformance —
they catch roughly a third of WCAG failures and none of the ones about whether
an interface actually *works* for someone using it non-visually.

### Automated (blocks a merge)

`e2e/accessibility.spec.js`, run in CI on every push:

```sh
npx playwright test e2e/accessibility.spec.js
```

axe-core scans tagged `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` across:

| Surface | Result |
|---|---|
| Homepage | 0 violations |
| `/services/overnight-boarding` | 0 violations |
| `/legal` | 0 violations |
| `/legal/privacy` | 0 violations |
| `/legal/accessibility` | 0 violations |
| Customer portal, signed out | 0 violations |
| Customer dashboard, signed in | 0 violations |
| Admin portal, signed out | 0 violations |
| Admin dashboard, signed in | 0 violations |

Plus behavioural assertions axe cannot make: skip-link focus and activation,
accessible names on every control, keyboard operation of the boop button /
rating radiogroup / carousel, live-region announcements, error state not
conveyed by colour alone, target sizes, 320 px reflow, SC 1.4.12 text spacing,
and `prefers-reduced-motion`.

22 tests, all passing.

### Manual (recorded here)

Automated checks were the *starting* point. The following walkthroughs were
performed by hand against the running application.

#### Keyboard-only, Chromium, homepage → booking

| Step | Result |
|---|---|
| Load `/`, press Tab once | Skip link receives focus and becomes visible at the top-left |
| Activate skip link | Focus and the viewport move to `<main id="main">`; the nav is skipped |
| Tab through the header | Logo link → menu button (at ≤968 px) or the nav links in source order |
| Open the mobile menu with Enter/Space | `aria-expanded` flips to `true`, first link is reachable |
| Press Escape | Menu closes and focus returns to the toggle |
| Tab into the services grid | Each card's heading link, then its CTA, in visual order |
| Tab to the review form | Every field announces its own visible label |
| Rating: arrow keys | Selection moves; exactly one star reports `aria-checked="true"` |
| Submit an empty form | Focus moves to the first empty field; the message is announced through `role="status"` and carries a ⚠ marker, not just red text |
| Carousel | Prev/Next reachable and operable; dots are a tablist with arrow-key navigation; the slide number is announced; off-screen slides leave the tab order (`tabindex="-1"`) |
| Boop button | Reachable, operable with both Enter and Space, announces as a button with the name "Boop the dog" |
| Newsletter | The consent checkbox is reachable, starts unticked, and submitting without it is refused with an announced message |
| Tab across the whole page | Focus is visible at every stop (3 px ring, inverted on dark sections); order never jumps backwards |

#### Keyboard-only, customer portal

| Step | Result |
|---|---|
| Sign in | Fields labelled; error announced inline |
| Register | Consent fieldset reachable; the required box is announced as required via its visible "Required" marker and refuses submission when unticked |
| Dashboard tabs | Operable with Enter/Space |
| Add a dog | Form reachable; submit works from the keyboard |

#### Screen-reader-oriented checks

Performed by inspecting the computed accessibility tree (Chromium DevTools
"Accessibility" pane and Playwright's `getByRole` resolution) at each landmark
and control, which is what a screen reader consumes.

| Check | Result |
|---|---|
| Landmarks | `banner` (header), `navigation` (named "Primary"), `main`, `contentinfo` (footer). Each footer nav has its own accessible name. |
| Heading order | Single `h1` per page; no level skipped. |
| Prices | Every price is announced in full — the visual `From $45/night` is `aria-hidden` and paired with "Starting at $45 per night, per dog". |
| Star ratings | The emoji run is `aria-hidden`; "4 out of 5 stars" is announced. |
| Decorative emoji | `aria-hidden="true"` throughout, so the paw prints, icons and the bouncing dog are silent. |
| Gallery images | `<figure>`/`<figcaption>`; a captioned image carries an empty `alt` so the caption is not read twice. |
| Icon-only controls | Carousel arrows and social links pair an `aria-hidden` glyph with visually-hidden text; social links announce "opens in a new tab". |
| Status messages | Form outcomes, upload progress and carousel changes are in `role="status" aria-live="polite"` regions. |

## Specific defects fixed

| Defect | Fix |
|---|---|
| Review name, pet name and review text had **placeholder text only, no labels** | Visible `<label>` on each, `<fieldset>`/`<legend>` around the rating |
| **No skip link** | Added; first focusable element, visible on focus, verified to move focus |
| "Boop the Snoot" was a **click-handled `<div>`** | Real `<button>` with an accessible name; keyboard operable |
| Admin "Sign Out" was **`<a href="#">`** | Real `<button>` |
| **Carousel** had unlabelled dots, no keyboard support, no announcement, and off-screen slides in the tab order | Tablist with arrow keys, live-region announcement, `aria-hidden` + `tabindex="-1"` on off-screen slides, autoplay pauses on hover/focus and never starts under reduced motion |
| **Contrast**: `#FF6B35` buttons at 2.84:1, `#4ECDC4` at 1.93:1, admin status colours 2.19–3.82:1, footer text at 4.05:1 | AA-safe `--*-strong` variants introduced for every text-bearing surface; bright hues kept for decoration only |
| **No visible focus indicator** on the cream/orange palette | 3 px `#1b4dd8` ring, `#ffd166` on dark sections |
| **Target sizes** below 24×24 | 44×44 minimum on nav, footer, social, carousel and star controls; dots keep a 12 px visual with a 44 px hit area via `::after` |
| **Motion ignored `prefers-reduced-motion`** | All decorative animation suppressed; the paw-print emitter never starts; reveal animations resolve to visible |
| Error state signalled **by colour alone** | ✓ / ⚠ markers via `::before` in addition to colour |
| Gallery captions had **no semantic relationship** to their image | `<figure>` / `<figcaption>` |
| Mobile nav was **unusable at 769–968 px** (wrapped to a 197 px navbar) | Drawer breakpoint aligned with the layout breakpoint |
| Inputs below 16 px caused **iOS zoom on focus**, leaving the page scrolled sideways | Held at 16 px on small screens |
| The admin **service form's labels had no `for`**, and the booking modal's dog-count and amount inputs had no accessible name at all | `for` on every label; `aria-label` on the two inline number inputs; both modals are now scanned |
| The "forgot password" / "back to login" links were an inline `#ff6b9d` at **2.9:1** | `.auth-link` using `--primary-strong` (5.18:1), underlined |
| The admin sidebar footer was absolutely positioned over the nav list, making the **last item unreachable by pointer** | Sidebar is a flex column; the footer is a normal child with `margin-top: auto` |

## Known limitations

Stated rather than papered over:

1. **No testing with a real screen reader.** The checks above inspect the
   accessibility tree, which is what NVDA/JAWS/VoiceOver consume, but that is
   not the same as hearing the result. A pass with NVDA on Windows and VoiceOver
   on macOS/iOS is outstanding.
2. **Firefox and WebKit run only the `@xbrowser` subset** (52 tests), which
   includes reflow and skip-link behaviour but not the axe scans — those run in
   Chromium only.
3. **`admin.html` and `customer.html` are large hand-written pages.** The
   sign-in views, both dashboards, the settings form, the service form and the
   booking detail modal now scan clean. Views reachable only with specific data
   (a booking in an unusual state, a long document list) have not all been
   scanned.
4. **No user testing** with people who rely on assistive technology.

## Reporting a barrier

Anything on this site that is not usable should be reported through the contact
details on the site and is treated as a defect, not a feature request. The
public statement at `/legal/accessibility` says the same thing.
