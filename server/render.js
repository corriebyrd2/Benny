// Minimal server-side HTML rendering.
//
// The site was previously a set of static files served with sendFile, which
// made three things impossible:
//
//   * Per-page SEO metadata. Every URL shared one <title>, one description and
//     no canonical, so nothing but the homepage could rank.
//   * A Content-Security-Policy without 'unsafe-inline'. The admin and customer
//     portals carry large inline <script> blocks; a nonce has to be minted per
//     response and stamped into the markup.
//   * Rendering only the business facts that are actually configured, rather
//     than shipping placeholder contact details in the HTML.
//
// The templating is deliberately tiny — no dependency, no logic in templates:
//   {{key}}    HTML-escaped substitution
//   {{{key}}}  raw substitution (caller is responsible for escaping)
// A missing key renders as an empty string so a partially-configured page
// degrades to "component absent" rather than printing "undefined".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIEW_DIR = path.join(__dirname, '..', 'views');
const IS_PROD = process.env.NODE_ENV === 'production';

const cache = new Map();

function readView(name) {
  if (IS_PROD && cache.has(name)) return cache.get(name);
  const file = path.join(VIEW_DIR, `${name}.html`);
  const source = fs.readFileSync(file, 'utf8');
  cache.set(name, source);
  return source;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON embedded in a <script type="application/ld+json"> block must not be able
// to close the script element or open an HTML comment.
function escapeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function interpolate(template, data) {
  return template
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_m, key) => resolve(data, key) ?? '')
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => escapeHtml(resolve(data, key) ?? ''));
}

function resolve(data, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), data);
}

function newNonce() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Render a body view inside the shared layout.
 *
 * meta: { title, description, canonicalPath, ogType, ogImage, robots,
 *         jsonLd (object | array), headExtra, bodyClass }
 */
function renderPage({ view, meta = {}, data = {}, nonce, baseUrl }) {
  const body = interpolate(readView(view), { ...data, nonce });
  const canonical = meta.canonicalPath ? new URL(meta.canonicalPath, baseUrl).toString() : '';
  const jsonLdBlocks = []
    .concat(meta.jsonLd || [])
    .filter(Boolean)
    .map(obj => `<script type="application/ld+json">${escapeJsonLd(obj)}</script>`)
    .join('\n  ');

  return interpolate(readView('layout'), {
    ...data,
    nonce,
    title: meta.title || '',
    description: meta.description || '',
    canonical,
    robots: meta.robots || 'index, follow',
    og_type: meta.ogType || 'website',
    og_image: meta.ogImage ? new URL(meta.ogImage, baseUrl).toString() : '',
    og_image_alt: meta.ogImageAlt || '',
    body_class: meta.bodyClass || '',
    head_extra: meta.headExtra || '',
    json_ld: jsonLdBlocks,
    body
  });
}

// Absolute origin for canonicals and sitemaps. PUBLIC_URL wins so that links
// generated behind a proxy or a preview deployment still point at the canonical
// host; otherwise fall back to the request's own scheme+host.
function baseUrlFor(req) {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = {
  baseUrlFor,
  escapeHtml,
  escapeJsonLd,
  interpolate,
  newNonce,
  readView,
  renderPage
};
