// Serve the admin and customer single-page apps with a per-request CSP nonce.
//
// admin.html and customer.html are large hand-written pages with many inline
// <script> and <style> blocks. Rewriting them into external modules is a big,
// risky refactor; allowing 'unsafe-inline' in the CSP to accommodate them would
// defeat the point of having a policy. The middle path taken here is to stamp
// a nonce onto every inline block.
//
// The regex rewrite happens ONCE at load: the file is transformed into a
// template containing a sentinel token, and each request only substitutes the
// token for that request's nonce. That keeps the per-request cost to a single
// string replace and means a malformed page fails loudly at boot rather than
// silently per request.

const fs = require('fs');
const path = require('path');

const TOKEN = '__CSP_NONCE__';
const IS_PROD = process.env.NODE_ENV === 'production';

const templates = new Map();

// Only tags WITHOUT a src/href attribute are inline, and only those need a
// nonce. `<script src=...>` is covered by script-src 'self'.
function addNonces(html) {
  return html
    .replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (m, attrs) => `<script nonce="${TOKEN}"${attrs}>`)
    .replace(/<style(?![^>]*\bhref=)([^>]*)>/gi, (m, attrs) => `<style nonce="${TOKEN}"${attrs}>`);
}

function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const templated = addNonces(raw);
  if (raw.includes(TOKEN)) {
    throw new Error(`${file} already contains the nonce sentinel ${TOKEN}`);
  }
  return templated;
}

function get(file) {
  if (IS_PROD && templates.has(file)) return templates.get(file);
  const tpl = load(file);
  templates.set(file, tpl);
  return tpl;
}

/**
 * Express handler that serves `file` with the request's nonce applied.
 * HTML is never cached by intermediaries — the nonce must be unique per
 * response, so a cached copy would carry a nonce that no longer matches the
 * CSP header.
 */
function serve(file) {
  const abs = path.resolve(file);
  // Fail at wiring time, not on the first request, if the path is wrong.
  fs.accessSync(abs, fs.constants.R_OK);
  return (req, res) => {
    const html = get(abs).split(TOKEN).join(res.locals.cspNonce);
    res.type('html')
      .set('Cache-Control', 'no-store')
      .send(html);
  };
}

module.exports = { serve, addNonces, TOKEN };
