// Responsive smoke tests across the supported viewport range.
//
// The failure this guards against is the one that actually breaks a phone
// booking: something wider than the viewport creates a horizontal scrollbar,
// the layout shifts sideways, and controls end up off-screen. Long
// customer-supplied strings (dog names, uploaded filenames) are the usual
// culprit, so they are tested explicitly rather than assumed.

const { test, expect } = require('@playwright/test');
const { resetAll, registerCustomer, ADMIN_EMAIL, ADMIN_PASSWORD, loginAdmin } = require('./utils');

const VIEWPORTS = [
  { name: 'iPhone SE 320x568', width: 320, height: 568 },
  { name: 'iPhone X 375x812', width: 375, height: 812 },
  { name: 'Pixel 390x844', width: 390, height: 844 },
  { name: 'iPhone Pro Max 430x932', width: 430, height: 932 },
  { name: 'iPad portrait 768x1024', width: 768, height: 1024 },
  { name: 'iPad landscape 1024x768', width: 1024, height: 768 },
  { name: 'laptop 1440x900', width: 1440, height: 900 },
  { name: 'desktop 1920x1080', width: 1920, height: 1080 }
];

const PUBLIC_PATHS = ['/', '/services/overnight-boarding', '/legal', '/legal/terms'];

// Elements that stick out past the viewport, with enough detail to fix them.
async function overflowingElements(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // Deliberately off-screen utilities are not overflow.
      if (style.position === 'fixed' && parseFloat(style.top) < -50) continue;
      if (el.classList.contains('visually-hidden') || el.classList.contains('skip-link')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > limit + 1 || rect.left < -1) {
        out.push(`${el.tagName}.${String(el.className).split(' ')[0] || '(none)'} ` +
          `left=${Math.round(rect.left)} right=${Math.round(rect.right)} limit=${limit}`);
      }
    }
    return out.slice(0, 12);
  });
}

async function documentOverflow(page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('public pages at every supported viewport', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  for (const viewport of VIEWPORTS) {
    test(`no horizontal overflow at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const path of PUBLIC_PATHS) {
        await page.goto(path);
        const overflow = await documentOverflow(page);
        const offenders = overflow > 1 ? await overflowingElements(page) : [];
        expect(overflow, `${path} overflows by ${overflow}px:\n${offenders.join('\n')}`)
          .toBeLessThanOrEqual(1);
      }
    });
  }

  test('the primary call to action is reachable without scrolling sideways at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    const cta = page.locator('.hero-buttons').getByRole('link', { name: /request a booking/i });
    await expect(cta).toBeInViewport();
    const box = await cta.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(321);
    expect(box.height, 'CTA is below the comfortable touch target').toBeGreaterThanOrEqual(44);
  });

  test('navigation is usable on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const toggle = page.locator('#navToggle');
    await expect(toggle).toBeVisible();
    const box = await toggle.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);

    await toggle.click();
    const firstLink = page.locator('#navLinks a').first();
    await expect(firstLink).toBeVisible();
    await expect(firstLink).toBeInViewport();
  });

  test('landscape phone still fits', async ({ page }) => {
    await page.setViewportSize({ width: 812, height: 375 });
    await page.goto('/');
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
    // A sticky navbar must not eat a landscape viewport whole.
    const navHeight = await page.locator('#navbar').evaluate(el => el.getBoundingClientRect().height);
    expect(navHeight).toBeLessThan(375 * 0.35);
  });
});

test.describe('long user-supplied content does not break the layout', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a very long review and dog name stay inside the viewport', async ({ page, request }) => {
    const token = await loginAdmin(request);
    const longWord = 'Bartholomew'.repeat(12); // no spaces to break on
    const created = await request.post('/api/reviews', {
      data: {
        reviewer_name: longWord.slice(0, 80),
        pet_name: longWord.slice(0, 80),
        rating: 5,
        review_text: `${longWord} ${longWord} ${longWord}`.slice(0, 1000)
      }
    });
    const { id } = await created.json();
    await request.put(`/api/reviews/${id}/status`, {
      headers: { authorization: `Bearer ${token}` }, data: { status: 'approved' }
    });

    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const overflow = await documentOverflow(page);
      const offenders = overflow > 1 ? await overflowingElements(page) : [];
      expect(overflow, `unbroken text overflows at ${width}px:\n${offenders.join('\n')}`)
        .toBeLessThanOrEqual(1);
    }
  });

  test('a long service name does not push the card off screen', async ({ page, request }) => {
    const token = await loginAdmin(request);
    await request.post('/api/services', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: 'Supercalifragilisticexpialidociousovernightboardingservice',
        description: 'A deliberately unbreakable name to prove the card wraps.',
        price_cents: 4500,
        billing_unit: 'night',
        perks: ['Averyveryverylongperknamewithnospacesatallinit']
      }
    });

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    const overflow = await documentOverflow(page);
    const offenders = overflow > 1 ? await overflowingElements(page) : [];
    expect(overflow, `long service name overflows:\n${offenders.join('\n')}`).toBeLessThanOrEqual(1);
  });
});

test.describe('authenticated portals on mobile', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the customer dashboard fits a phone', async ({ page, request }) => {
    const { email, password } = await registerCustomer(request);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/my-bookings');
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#dashboard')).toHaveClass(/active/);

    const overflow = await documentOverflow(page);
    const offenders = overflow > 1 ? await overflowingElements(page) : [];
    expect(overflow, `customer dashboard overflows:\n${offenders.join('\n')}`).toBeLessThanOrEqual(1);
  });

  test('the admin dashboard and its tables fit a tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();

    const overflow = await documentOverflow(page);
    const offenders = overflow > 1 ? await overflowingElements(page) : [];
    expect(overflow, `admin dashboard overflows:\n${offenders.join('\n')}`).toBeLessThanOrEqual(1);
  });
});

test.describe('forms on mobile', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('inputs are at least 16px so iOS does not zoom on focus', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    // Only text-entry controls trigger the iOS focus zoom; a checkbox's font
    // size is irrelevant to it.
    const TEXT_TYPES = ['text', 'email', 'tel', 'password', 'search', 'url', 'number', 'date'];
    const tooSmall = await page.locator('input, textarea, select').evaluateAll((els, types) =>
      els.filter(el => {
        if (el.offsetParent === null) return false;
        if (el.tagName === 'INPUT' && !types.includes(el.type)) return false;
        return parseFloat(getComputedStyle(el).fontSize) < 16;
      }).map(el => `${el.id || el.name}: ${getComputedStyle(el).fontSize}`), TEXT_TYPES);
    expect(tooSmall).toEqual([]);
  });

  test('form controls fit the viewport width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    for (const selector of ['#reviewName', '#reviewText', '#newsletterEmail']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x + box.width, `${selector} extends past the viewport`).toBeLessThanOrEqual(321);
    }
  });
});
