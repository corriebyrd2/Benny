// WCAG 2.2 AA conformance.
//
// Two layers:
//   1. axe-core scans, which catch the machine-detectable failures (contrast,
//      names, roles, landmarks, form labels) across every public page and both
//      authenticated portals.
//   2. Explicit behavioural assertions for the things axe cannot see — focus
//      order, focus visibility, keyboard operation of custom widgets, live
//      region announcements, target size, reflow at 400% zoom, and
//      prefers-reduced-motion.
//
// Automated checks are necessary but not sufficient; docs/ACCESSIBILITY.md
// records the manual keyboard and screen-reader walkthroughs alongside these.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { resetAll, registerCustomer, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./utils');

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page, { include } = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  return builder.analyze();
}

function describeViolations(results) {
  return results.violations
    .map(v => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}\n    ${v.nodes.map(n => n.target.join(' ')).join('\n    ')}`)
    .join('\n');
}

test.describe('automated WCAG scans', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  const PUBLIC_PAGES = [
    ['homepage', '/'],
    ['service detail', '/services/overnight-boarding'],
    ['policy index', '/legal'],
    ['privacy policy', '/legal/privacy'],
    ['accessibility statement', '/legal/accessibility']
  ];

  for (const [name, path] of PUBLIC_PAGES) {
    test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(path);
      const results = await scan(page);
      expect(describeViolations(results)).toBe('');
    });
  }

  test('the customer portal sign-in and register views are clean', async ({ page }) => {
    await page.goto('/my-bookings');
    const results = await scan(page);
    expect(describeViolations(results)).toBe('');
  });

  test('the signed-in customer dashboard is clean', async ({ page, request }) => {
    const { email, password } = await registerCustomer(request);
    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    const results = await scan(page, { include: '#dashboard' });
    expect(describeViolations(results)).toBe('');
  });

  test('the admin login view is clean', async ({ page }) => {
    await page.goto('/admin');
    const results = await scan(page);
    expect(describeViolations(results)).toBe('');
  });

  test('the admin dashboard is clean', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();

    const results = await scan(page, { include: '#adminLayout' });
    expect(describeViolations(results)).toBe('');
  });

  // The admin does most of its work in modals, and nothing scanned them. The
  // service form's inputs had no `for` on their labels at all.
  test('the admin modals are clean', async ({ page, request }) => {
    const { firstServiceId } = require('./utils');
    const serviceId = await firstServiceId(request);
    await request.post('/api/bookings', {
      data: {
        owner_name: 'Modal Scan', email: 'modal@test.local', dog_name: 'Rex',
        service_id: serviceId, start_date: '2026-11-04', end_date: '2026-11-06'
      }
    });

    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();

    await page.click('a[data-panel="services"]');
    await page.locator('.service-mgmt-card', { hasText: 'Overnight Boarding' })
      .getByRole('button', { name: /edit/i }).click();
    await expect(page.locator('#modal')).toBeVisible();
    expect(describeViolations(await scan(page, { include: '#modal' })), 'service form').toBe('');
    await page.locator('#modalClose').click();

    await page.click('a[data-panel="bookings"]');
    await page.locator('#bookingsTable tr', { hasText: 'Modal Scan' })
      .getByRole('button', { name: /^view$/i }).click();
    await expect(page.locator('#modal')).toBeVisible();
    expect(describeViolations(await scan(page, { include: '#modal' })), 'booking detail').toBe('');
  });

  test('the settings form the owner fills in is clean', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await page.click('a[data-panel="settings"]');
    // Generated from the field catalogue, so a scan here covers every field.
    await expect(page.locator('#set_business_name')).toBeVisible();

    expect(describeViolations(await scan(page, { include: '#panel-settings' }))).toBe('');
  });
});

test.describe('keyboard operation', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the first Tab reaches a working skip link @xbrowser', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveClass(/skip-link/);
    // It must be visible once focused — a permanently off-screen skip link is
    // no better than no skip link.
    await expect(focused).toBeInViewport();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator('#main')).toBeVisible();
  });

  test('every interactive control has an accessible name', async ({ page }) => {
    await page.goto('/');
    const unnamed = await page.locator('a, button, input, select, textarea').evaluateAll(els =>
      els.filter(el => {
        if (el.closest('[aria-hidden="true"]')) return false;
        if (el.disabled) return false;
        const name = (
          el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') &&
            document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) ||
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
          el.closest('label')?.textContent ||
          el.textContent ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          ''
        ).trim();
        return name.length === 0;
      }).map(el => el.tagName + (el.id ? `#${el.id}` : '') + (el.className ? `.${String(el.className).split(' ')[0]}` : ''))
    );
    expect(unnamed).toEqual([]);
  });

  test('the boop control is a real button, not a clickable div @xbrowser', async ({ page }) => {
    await page.goto('/');
    const boop = page.locator('#boopDog');
    // It was a <div> with a click handler: unreachable by keyboard and
    // announced as nothing.
    expect(await boop.evaluate(el => el.tagName)).toBe('BUTTON');

    await boop.focus();
    await expect(boop).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#boopCount')).toHaveText('1');
    await page.keyboard.press('Space');
    await expect(page.locator('#boopCount')).toHaveText('2');
  });

  test('the review rating is an operable radiogroup @xbrowser', async ({ page }) => {
    await page.goto('/');
    const group = page.locator('#reviewRating');
    await expect(group).toHaveAttribute('role', 'radiogroup');

    // Exactly one star is checked at a time, and arrows move the selection.
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(1);
    await group.locator('[data-rating="5"]').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(group.locator('[data-rating="4"]')).toHaveAttribute('aria-checked', 'true');
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(1);
  });

  test('the reviews carousel is keyboard operable and announces the slide', async ({ page, request }) => {
    // Two approved reviews so the carousel actually has controls.
    const { loginAdmin } = require('./utils');
    const token = await loginAdmin(request);
    for (const name of ['Reviewer One', 'Reviewer Two']) {
      const created = await request.post('/api/reviews', {
        data: { reviewer_name: name, rating: 5, review_text: `${name} had a good stay with us.` }
      });
      const { id } = await created.json();
      await request.put(`/api/reviews/${id}/status`, {
        headers: { authorization: `Bearer ${token}` }, data: { status: 'approved' }
      });
    }

    await page.goto('/');
    await expect(page.locator('.testimonial-card')).toHaveCount(2);
    await expect(page.locator('#carouselStatus')).toHaveText('Review 1 of 2');

    const next = page.getByRole('button', { name: /next review/i });
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#carouselStatus')).toHaveText('Review 2 of 2');

    // Off-screen slides must leave the tab order.
    const hidden = page.locator('.testimonial-card[aria-hidden="true"]');
    await expect(hidden).toHaveCount(1);
  });

  test('the mobile menu is a disclosure that Escape closes @xbrowser', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const toggle = page.locator('#navToggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('focus is always visible on interactive controls @xbrowser', async ({ page }) => {
    await page.goto('/');
    for (const selector of ['.skip-link', '#boopDog', '#reviewName', '#newsletterEmail']) {
      const el = page.locator(selector).first();
      await el.focus();
      const outlineWidth = await el.evaluate(node =>
        parseFloat(getComputedStyle(node).outlineWidth) || 0);
      expect(outlineWidth, `${selector} has no visible focus ring`).toBeGreaterThanOrEqual(2);
    }
  });
});

test.describe('status announcements', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('form outcomes land in a live region', async ({ page }) => {
    await page.goto('/');
    for (const id of ['reviewFormMsg', 'newsletterMsg']) {
      const region = page.locator(`#${id}`);
      await expect(region).toHaveAttribute('aria-live', 'polite');
      await expect(region).toHaveAttribute('role', 'status');
    }

    await page.fill('#reviewName', 'Live Region Tester');
    await page.fill('#reviewText', 'Checking that the outcome is announced, not just coloured.');
    await page.click('#reviewForm button[type="submit"]');
    await expect(page.locator('#reviewFormMsg')).toContainText(/approved/i);
  });

  test('an error is not signalled by colour alone', async ({ page }) => {
    await page.goto('/');
    await page.click('#reviewForm button[type="submit"]');
    const msg = page.locator('#reviewFormMsg');
    await expect(msg).toHaveClass(/error/);
    // The ::before marker carries the same information as the colour.
    const marker = await msg.evaluate(el => getComputedStyle(el, '::before').content);
    expect(marker).not.toBe('none');
    await expect(msg).not.toHaveText('');
  });
});

test.describe('target size and reflow', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('interactive targets meet the WCAG 2.2 minimum', async ({ page }) => {
    await page.goto('/');
    const tooSmall = await page.locator('a, button').evaluateAll(els =>
      els.filter(el => {
        if (el.closest('[aria-hidden="true"]') || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // Inline links inside a paragraph are exempt under 2.5.8.
        const inSentence = el.tagName === 'A' &&
          ['P', 'LI', 'SPAN', 'LABEL', 'FIGCAPTION', 'ADDRESS', 'BLOCKQUOTE'].includes(el.parentElement?.tagName);
        if (inSentence) return false;
        // A pseudo-element can extend the hit area beyond the border box.
        const after = getComputedStyle(el, '::after');
        const inset = parseFloat(after.inset) || 0;
        const w = rect.width + Math.abs(inset) * 2;
        const h = rect.height + Math.abs(inset) * 2;
        return w < 24 || h < 24;
      }).map(el => `${el.tagName}.${String(el.className).split(' ')[0]} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
    );
    expect(tooSmall).toEqual([]);
  });

  test('the page reflows at 400% zoom with no horizontal scrolling @xbrowser', async ({ page }) => {
    // 1280px at 400% zoom is the 320 CSS-pixel reflow condition in SC 1.4.10.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'page scrolls horizontally at 320px').toBeLessThanOrEqual(1);
  });

  test('increased text spacing does not clip content', async ({ page }) => {
    // The SC 1.4.12 metrics are appended to the real stylesheet response
    // rather than injected with addStyleTag: the CSP has no 'unsafe-inline',
    // so an injected <style> is correctly blocked. Rewriting the response
    // exercises the same rendering path a user's own stylesheet would.
    await page.route('**/style*.css', async route => {
      const response = await route.fetch();
      const css = await response.text();
      await route.fulfill({
        response,
        body: css + `
          * { line-height: 1.5 !important; letter-spacing: 0.12em !important;
              word-spacing: 0.16em !important; }
          p { margin-bottom: 2em !important; }`
      });
    });

    await page.goto('/');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('reduced motion', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('decorative animation is suppressed when the user asks for it', async ({ page }) => {
    // Set explicitly rather than through test.use: the context-level option
    // was not reaching window.matchMedia in this browser build, so the test
    // silently asserted the default-motion path.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    // The decorative paw-print emitter must not run at all.
    await page.waitForTimeout(500);
    expect(await page.locator('.paw-print').count()).toBe(0);

    // And nothing is left invisible by a reveal animation that never fires.
    const hidden = await page.locator('.service-card').evaluateAll(els =>
      els.filter(el => parseFloat(getComputedStyle(el).opacity) < 0.9).length);
    expect(hidden).toBe(0);
  });
});
