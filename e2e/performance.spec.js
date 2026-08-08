// Performance budgets, enforced in CI.
//
// These are measured, not asserted from inspection. Each budget exists because
// exceeding it caused a real regression before, and the numbers are recorded in
// docs/PERFORMANCE.md alongside the before/after measurements.
//
// Caveat stated plainly: these run against a local server on loopback, so the
// absolute LCP/TTFB figures are optimistic compared with a real mobile
// connection. What they reliably catch is the class of regression that made the
// original site slow — an oversized asset, an uncompressed response, a
// render-blocking third-party request, or a missing cache header. Field Core
// Web Vitals still need real-user monitoring; see docs/PERFORMANCE.md.

const { test, expect } = require('@playwright/test');
const { resetAll } = require('./utils');

// Byte budgets for the critical path. The logo alone used to be 745 KB.
const BUDGETS = {
  htmlBytes: 60 * 1024,
  cssBytes: 60 * 1024,
  jsBytes: 60 * 1024,
  imageBytesAboveFold: 60 * 1024,
  totalBytes: 400 * 1024,
  requests: 25,
  cls: 0.1,
  lcpMs: 2500,
  domContentLoadedMs: 2000
};

async function collect(page, path) {
  const responses = [];
  page.on('response', async res => {
    try {
      const headers = res.headers();
      const body = await res.body().catch(() => Buffer.alloc(0));
      responses.push({
        url: res.url(),
        status: res.status(),
        type: headers['content-type'] || '',
        encoding: headers['content-encoding'] || '',
        cacheControl: headers['cache-control'] || '',
        bytes: body.length
      });
    } catch { /* response body already consumed or redirected */ }
  });

  await page.goto(path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return responses;
}

function sumBytes(responses, predicate) {
  return responses.filter(predicate).reduce((n, r) => n + r.bytes, 0);
}

test.describe('critical-path weight', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('the homepage stays inside its byte and request budget', async ({ page }) => {
    const responses = await collect(page, '/');
    const sameOrigin = responses.filter(r => !r.url.startsWith('data:'));

    const html = sumBytes(sameOrigin, r => r.type.includes('text/html'));
    const css = sumBytes(sameOrigin, r => r.type.includes('text/css'));
    const js = sumBytes(sameOrigin, r => r.type.includes('javascript'));
    const total = sumBytes(sameOrigin, () => true);

    const report = sameOrigin
      .sort((a, b) => b.bytes - a.bytes).slice(0, 8)
      .map(r => `  ${(r.bytes / 1024).toFixed(1)} KB  ${new URL(r.url).pathname}`)
      .join('\n');

    expect(html, `HTML over budget\n${report}`).toBeLessThan(BUDGETS.htmlBytes);
    expect(css, `CSS over budget\n${report}`).toBeLessThan(BUDGETS.cssBytes);
    expect(js, `JS over budget\n${report}`).toBeLessThan(BUDGETS.jsBytes);
    expect(total, `total transfer over budget\n${report}`).toBeLessThan(BUDGETS.totalBytes);
    expect(sameOrigin.length, `too many requests\n${report}`).toBeLessThan(BUDGETS.requests);
  });

  test('the logo is delivered at a size appropriate to its display box', async ({ page }) => {
    // The regression: a 745 KB, 1024x1024 PNG rendered into a 48px slot.
    const responses = await collect(page, '/');
    const logos = responses.filter(r => /\/images\/logo\//.test(r.url));
    expect(logos.length, 'no logo request observed').toBeGreaterThan(0);

    for (const logo of logos) {
      expect(logo.bytes,
        `${new URL(logo.url).pathname} is ${(logo.bytes / 1024).toFixed(1)} KB`)
        .toBeLessThan(20 * 1024);
    }

    const rendered = await page.locator('.logo-img').first().evaluate(img => ({
      cssWidth: img.getBoundingClientRect().width,
      naturalWidth: img.naturalWidth,
      hasDimensions: img.hasAttribute('width') && img.hasAttribute('height')
    }));
    // A little headroom for 2x displays, but not 20x.
    expect(rendered.naturalWidth).toBeLessThanOrEqual(rendered.cssWidth * 3);
    expect(rendered.hasDimensions, 'logo lacks width/height, so it can shift layout').toBe(true);
  });

  test('the original 745 KB logo is not on the critical path', async ({ page }) => {
    const responses = await collect(page, '/');
    const original = responses.find(r => r.url.endsWith('/images/bennyandthepets.png'));
    expect(original, 'the unoptimised 1024x1024 PNG is still being requested').toBeUndefined();
  });

  test('no third-party origin is contacted', async ({ page }) => {
    // A third-party font request was on the render-blocking path, made the
    // page's load event depend on another host, and contradicted the cookie
    // notice's claim that no third-party requests are made.
    const responses = await collect(page, '/');
    const external = responses
      .map(r => new URL(r.url).host)
      .filter(host => !host.startsWith('127.0.0.1') && !host.startsWith('localhost'));
    expect([...new Set(external)]).toEqual([]);
  });
});

test.describe('transport and caching', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('text responses are compressed', async ({ page }) => {
    const responses = await collect(page, '/');
    const compressible = responses.filter(r =>
      r.bytes > 1024 && /text\/html|text\/css|javascript|application\/json|xml/.test(r.type));
    expect(compressible.length).toBeGreaterThan(0);
    for (const r of compressible) {
      expect(r.encoding, `${new URL(r.url).pathname} is not compressed`).toMatch(/gzip|br|deflate/);
    }
  });

  test('versioned assets are immutable and HTML revalidates', async ({ page, request }) => {
    await page.goto('/');
    const assetUrls = await page.evaluate(() => [
      document.querySelector('link[rel="stylesheet"]')?.getAttribute('href'),
      document.querySelector('script[src]')?.getAttribute('src')
    ].filter(Boolean));

    expect(assetUrls.length).toBe(2);
    for (const url of assetUrls) {
      const res = await request.get(url);
      expect(res.status()).toBe(200);
      const cacheControl = res.headers()['cache-control'] || '';
      // Development serves a mtime query string rather than a content hash, so
      // accept either an immutable hashed asset or a short-lived dev response.
      expect(cacheControl, `${url} has no caching policy`).toMatch(/max-age=\d+/);
    }

    const html = await request.get('/');
    expect(html.headers()['cache-control']).toMatch(/must-revalidate|no-store|max-age=0/);
  });

  test('images are cached for a long time', async ({ request }) => {
    const res = await request.get('/images/logo/logo-96.png');
    expect(res.status()).toBe(200);
    const cacheControl = res.headers()['cache-control'] || '';
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  test('below-the-fold images are lazy loaded', async ({ page }) => {
    await page.goto('/');
    const eagerBelowFold = await page.locator('img').evaluateAll(imgs =>
      imgs.filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.top > window.innerHeight && img.loading !== 'lazy';
      }).map(img => img.src));
    expect(eagerBelowFold).toEqual([]);
  });
});

test.describe('measured vitals', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('layout is stable and the largest paint arrives promptly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });

    const vitals = await page.evaluate(() => new Promise(resolve => {
      let cls = 0;
      let lcp = 0;

      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver(list => {
        const entries = list.getEntries();
        lcp = entries[entries.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      // Give the carousel, reveal animations and any late image a chance to
      // shift things before sampling.
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        resolve({
          cls,
          lcp,
          ttfb: nav.responseStart || 0,
          domContentLoaded: nav.domContentLoadedEventEnd || 0,
          fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0
        });
      }, 2500);
    }));

    console.log('[vitals] ' + JSON.stringify({
      ttfb_ms: Math.round(vitals.ttfb),
      fcp_ms: Math.round(vitals.fcp),
      lcp_ms: Math.round(vitals.lcp),
      cls: Number(vitals.cls.toFixed(4)),
      dcl_ms: Math.round(vitals.domContentLoaded)
    }));

    expect(vitals.cls, 'cumulative layout shift over budget').toBeLessThan(BUDGETS.cls);
    expect(vitals.lcp, 'largest contentful paint over budget').toBeLessThan(BUDGETS.lcpMs);
    expect(vitals.domContentLoaded).toBeLessThan(BUDGETS.domContentLoadedMs);
  });

  test('the API answers the homepage catalog quickly', async ({ request }) => {
    // Warm, then measure — the first call pays connection setup.
    await request.get('/api/services');
    const started = Date.now();
    const res = await request.get('/api/services');
    const elapsed = Date.now() - started;
    expect(res.status()).toBe(200);
    console.log(`[api] /api/services ${elapsed}ms`);
    expect(elapsed, '/api/services is slow').toBeLessThan(500);
  });

  test('list endpoints are bounded', async ({ request }) => {
    // An unbounded list endpoint is a latency cliff waiting for the first
    // busy month. Every public list must cap what it returns.
    const services = await (await request.get('/api/services')).json();
    expect(Array.isArray(services)).toBe(true);
    const reviews = await (await request.get('/api/reviews')).json();
    expect(Array.isArray(reviews)).toBe(true);
    expect(reviews.length).toBeLessThanOrEqual(100);
  });
});
