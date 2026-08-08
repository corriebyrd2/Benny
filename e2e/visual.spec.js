// Visual regression baselines for the pages a change is most likely to break.
//
// OPT-IN, and deliberately so:
//
//   VISUAL_BASELINES=1 npx playwright test --project=visual
//
// Snapshot bytes depend on the host's fonts, GPU and compositor. Baselines
// captured on one machine produce false failures on another, and this project
// removed its webfonts, so the page renders in whatever system font the host
// happens to have. Running these in CI would trade real signal for noise, and a
// suite that cries wolf gets ignored — including when it is right.
//
// Use them the way they are useful: run before and after a CSS change on the
// SAME machine, and look at the diff.
//
// Regenerate after an intentional design change:
//   VISUAL_BASELINES=1 npx playwright test --project=visual --update-snapshots

const { test, expect } = require('@playwright/test');
const { resetAll, loginAdmin } = require('./utils');

// Everything non-deterministic is hidden before the shot: the decorative paw
// emitter, the bouncing dog, and anything with a live timestamp. Otherwise the
// baseline changes every run and the test is worthless.
const STABILISE = `
  .paw-prints, .bouncing-dog, .scroll-indicator, .boop-reaction { visibility: hidden !important; }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

async function stabilise(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/style*.css', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + STABILISE });
  });
}

const SNAPSHOT = {
  // A little tolerance for sub-pixel text rendering, which differs between
  // machines even with identical fonts.
  maxDiffPixelRatio: 0.02,
  animations: 'disabled'
};

test.describe('public pages', () => {
  test.beforeEach(async ({ request, page }) => {
    await resetAll(request);
    await stabilise(page);
  });

  const PAGES = [
    ['homepage', '/'],
    ['service-detail', '/services/overnight-boarding'],
    ['policy-index', '/legal'],
    ['privacy-policy', '/legal/privacy']
  ];

  for (const [name, path] of PAGES) {
    test(`${name} at desktop width`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`${name}-desktop.png`, { ...SNAPSHOT, fullPage: true });
    });
  }

  test('homepage at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('homepage-mobile.png', { ...SNAPSHOT, fullPage: true });
  });

  test('the contact section, where the enquiry form lives', async ({ page }) => {
    await page.goto('/#contact');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#contact')).toHaveScreenshot('contact-section.png', SNAPSHOT);
  });
});

test.describe('authenticated pages', () => {
  test.beforeEach(async ({ request, page }) => {
    await resetAll(request);
    await stabilise(page);
  });

  test('customer portal sign-in', async ({ page }) => {
    await page.goto('/my-bookings');
    await expect(page.locator('#authSection')).toHaveScreenshot('customer-signin.png', SNAPSHOT);
  });

  test('admin sign-in', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('#loginScreen')).toHaveScreenshot('admin-signin.png', SNAPSHOT);
  });

  test('admin dashboard shell', async ({ page, request }) => {
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('./utils');
    await page.goto('/admin');
    await page.fill('#loginEmail', ADMIN_EMAIL);
    await page.fill('#loginPassword', ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await expect(page.locator('#adminLayout')).toBeVisible();
    // The sidebar only — the dashboard body carries live counts and dates.
    await expect(page.locator('.sidebar')).toHaveScreenshot('admin-sidebar.png', SNAPSHOT);
    expect(await loginAdmin(request)).toBeTruthy();
  });
});
