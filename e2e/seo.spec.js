// SEO foundations: unique metadata per URL, canonicals, crawler files,
// structured data validity, status codes and crawlable service pages.
//
// Baseline before this work: one shared <title>, no meta description, no
// canonical, no robots.txt, no sitemap.xml, no Open Graph, no structured data,
// and every service link pointing at the same "#services" homepage anchor.

const { test, expect } = require('@playwright/test');
const { resetAll } = require('./utils');

async function meta(page, selector, attr = 'content') {
  const el = page.locator(selector);
  if (await el.count() === 0) return null;
  return el.first().getAttribute(attr);
}

async function jsonLdNodes(page) {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map(b => JSON.parse(b));
}

test.describe('crawler surfaces', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('robots.txt is served, allows the site and points at the sitemap', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    const body = await res.text();
    expect(body).toMatch(/^User-agent: \*/m);
    expect(body).toMatch(/^Allow: \/$/m);
    expect(body).toMatch(/^Sitemap: https?:\/\/.+\/sitemap\.xml$/m);
    // Private areas must not be advertised to crawlers.
    expect(body).toMatch(/^Disallow: \/admin$/m);
    expect(body).toMatch(/^Disallow: \/api\/$/m);
  });

  test('sitemap.xml is valid XML and lists every indexable page', async ({ request }) => {
    const services = await (await request.get('/api/services')).json();
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');

    const body = await res.text();
    expect(body.startsWith('<?xml')).toBe(true);
    expect(body).toContain('<urlset');

    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs.length).toBeGreaterThan(5);
    // Absolute URLs only — relative <loc> entries are invalid.
    for (const loc of locs) expect(loc).toMatch(/^https?:\/\//);
    // No duplicates.
    expect(new Set(locs).size).toBe(locs.length);

    for (const service of services) {
      expect(locs.some(l => l.endsWith(`/services/${service.slug}`))).toBe(true);
    }
    expect(locs.some(l => l.endsWith('/legal/privacy'))).toBe(true);
    expect(locs.some(l => l.endsWith('/legal/terms'))).toBe(true);
    // Private pages must not be in the sitemap.
    expect(locs.some(l => l.includes('/admin'))).toBe(false);
    expect(locs.some(l => l.includes('/my-bookings'))).toBe(false);
  });

  test('every sitemap URL actually resolves with a 200', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const res = await request.get(path);
      expect(res.status(), `${path} is in the sitemap but returns ${res.status()}`).toBe(200);
    }
  });

  test('a web manifest is served with icons', async ({ request }) => {
    const res = await request.get('/site.webmanifest');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBeTruthy();
    expect(body.icons.length).toBeGreaterThan(0);
  });

  test('an unknown page returns 404, not a 200 soft-404', async ({ request }) => {
    expect((await request.get('/services/does-not-exist')).status()).toBe(404);
    expect((await request.get('/legal/does-not-exist')).status()).toBe(404);
    expect((await request.get('/no-such-page')).status()).toBe(404);
  });
});

test.describe('per-page metadata', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('titles and descriptions are unique across every indexable page', async ({ page, request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    const paths = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);

    const titles = new Map();
    const descriptions = new Map();
    for (const path of paths) {
      await page.goto(path);
      const title = await page.title();
      const description = await meta(page, 'meta[name="description"]');

      expect(title, `${path} has no title`).toBeTruthy();
      expect(title.length, `${path} title is too long`).toBeLessThanOrEqual(70);
      expect(description, `${path} has no meta description`).toBeTruthy();
      expect(description.length).toBeGreaterThan(50);

      expect(titles.has(title), `duplicate title "${title}" on ${path} and ${titles.get(title)}`).toBe(false);
      titles.set(title, path);
      expect(descriptions.has(description),
        `duplicate description on ${path} and ${descriptions.get(description)}`).toBe(false);
      descriptions.set(description, path);
    }
  });

  test('every page declares a self-referencing canonical', async ({ page, request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      await page.goto(path);
      const canonical = await meta(page, 'link[rel="canonical"]', 'href');
      expect(canonical, `${path} has no canonical`).toBeTruthy();
      expect(new URL(canonical).pathname, `${path} canonical points elsewhere`).toBe(path);
    }
  });

  test('Open Graph and Twitter card metadata are complete on the homepage', async ({ page }) => {
    await page.goto('/');
    expect(await meta(page, 'meta[property="og:title"]')).toBeTruthy();
    expect(await meta(page, 'meta[property="og:description"]')).toBeTruthy();
    expect(await meta(page, 'meta[property="og:type"]')).toBe('website');
    expect(await meta(page, 'meta[property="og:url"]')).toMatch(/^https?:\/\//);
    expect(await meta(page, 'meta[property="og:image"]')).toMatch(/^https?:\/\//);
    expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
  });

  test('the social preview image actually exists', async ({ page, request }) => {
    await page.goto('/');
    const image = await meta(page, 'meta[property="og:image"]');
    const res = await request.get(new URL(image).pathname);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/');
  });

  test('account areas are marked noindex-safe via robots.txt rather than indexed', async ({ page }) => {
    // The portals are excluded in robots.txt; confirm they are not in the
    // sitemap and carry no canonical claiming indexability.
    await page.goto('/my-bookings');
    const canonical = await meta(page, 'link[rel="canonical"]', 'href');
    expect(canonical).toBeNull();
  });
});

test.describe('structured data', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the homepage emits valid, non-fabricated LocalBusiness data', async ({ page }) => {
    await page.goto('/');
    const nodes = await jsonLdNodes(page);
    expect(nodes.length).toBeGreaterThan(0);

    const business = nodes.find(n => n['@type'] === 'AnimalBoardingFacility');
    expect(business, 'no business node').toBeTruthy();
    expect(business['@context']).toBe('https://schema.org');
    expect(business.name).toBeTruthy();
    expect(business.url).toMatch(/^https?:\/\//);

    // With no verified address configured, no address may be asserted.
    expect(business.address).toBeUndefined();
    expect(JSON.stringify(business)).not.toContain('Pawsome');
    expect(JSON.stringify(business)).not.toContain('555');
    // No aggregateRating without real reviews behind it.
    expect(business.aggregateRating).toBeUndefined();
  });

  test('offers in structured data match the catalog prices', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    await page.goto('/');
    const business = (await jsonLdNodes(page)).find(n => n['@type'] === 'AnimalBoardingFacility');

    const bookable = services.filter(s => s.bookable);
    expect(business.makesOffer.length).toBe(bookable.length);
    for (const offer of business.makesOffer) {
      const service = bookable.find(s => s.name === offer.name);
      expect(service).toBeTruthy();
      expect(Number(offer.price)).toBeCloseTo(service.price_cents / 100, 2);
      expect(offer.priceCurrency).toBe(service.currency.toUpperCase());
    }
  });

  test('service pages emit Service plus BreadcrumbList data', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    await page.goto(`/services/${services[0].slug}`);
    const nodes = await jsonLdNodes(page);

    const service = nodes.find(n => n['@type'] === 'Service');
    expect(service).toBeTruthy();
    expect(service.name).toBe(services[0].name);
    expect(service.provider['@id']).toContain('#business');

    const crumbs = nodes.find(n => n['@type'] === 'BreadcrumbList');
    expect(crumbs).toBeTruthy();
    expect(crumbs.itemListElement.length).toBe(3);
    expect(crumbs.itemListElement.map(i => i.position)).toEqual([1, 2, 3]);
  });

  test('all structured data parses as JSON on every indexable page', async ({ page, request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    const paths = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
    for (const path of paths) {
      await page.goto(path);
      const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
      for (const block of blocks) {
        expect(() => JSON.parse(block), `invalid JSON-LD on ${path}`).not.toThrow();
      }
    }
  });
});

test.describe('crawlable internal linking', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('each service links to its own page, not a shared anchor', async ({ page, request }) => {
    const services = await (await request.get('/api/services')).json();
    await page.goto('/');
    const footerLinks = page.locator('.footer-links a[href^="/services/"]');
    await expect(footerLinks).toHaveCount(services.length);

    const hrefs = await footerLinks.evaluateAll(els => els.map(e => e.getAttribute('href')));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test('no internal link on the homepage is a dead placeholder', async ({ page }) => {
    await page.goto('/');
    const hrefs = await page.locator('a[href]').evaluateAll(
      els => els.map(e => e.getAttribute('href')));
    for (const href of hrefs) {
      expect(href, 'found an href="#" placeholder').not.toBe('#');
      expect(href).not.toBe('');
      expect(href).not.toMatch(/^javascript:/i);
    }
  });

  test('every internal link on the homepage resolves', async ({ page, request }) => {
    await page.goto('/');
    const hrefs = await page.locator('a[href^="/"]').evaluateAll(
      els => [...new Set(els.map(e => e.getAttribute('href')))]);
    for (const href of hrefs) {
      const path = href.split('#')[0];
      if (!path) continue;
      const res = await request.get(path);
      expect(res.status(), `${href} is broken`).toBeLessThan(400);
    }
  });
});
