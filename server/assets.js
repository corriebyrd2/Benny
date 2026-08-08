// Content-hashed static assets.
//
// css/style.css and js/main.js were served at stable paths with a 7-day
// max-age, which forces a trade-off between stale clients and no caching at
// all. Hashing the content into the filename removes the trade-off: the URL
// changes whenever the bytes change, so the response can be marked
// `immutable` with a one-year max-age and a deploy invalidates it for free.
//
// The hash is computed once at boot. In development the file is re-read per
// request so edits show up without a restart.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const IS_PROD = process.env.NODE_ENV === 'production';

// logical path -> { dir, file, ext, contentType }
const ASSETS = {
  '/css/style.css': { file: path.join(ROOT, 'css', 'style.css'), contentType: 'text/css; charset=utf-8' },
  '/js/main.js': { file: path.join(ROOT, 'js', 'main.js'), contentType: 'text/javascript; charset=utf-8' }
};

const manifest = new Map();   // logical -> hashed url
const reverse = new Map();    // hashed url -> logical

function hashOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function build() {
  manifest.clear();
  reverse.clear();
  for (const [logical, meta] of Object.entries(ASSETS)) {
    const ext = path.extname(logical);
    const base = logical.slice(0, -ext.length);
    const hashed = `${base}.${hashOf(meta.file)}${ext}`;
    manifest.set(logical, hashed);
    reverse.set(hashed, logical);
  }
}

build();

function url(logical) {
  if (!IS_PROD) {
    // Cache-bust on mtime so a dev edit is picked up without a restart, without
    // paying the hashing cost on every request.
    const meta = ASSETS[logical];
    if (!meta) return logical;
    return `${logical}?v=${Math.floor(fs.statSync(meta.file).mtimeMs)}`;
  }
  return manifest.get(logical) || logical;
}

// Express middleware serving the hashed URLs. Unhashed paths keep working
// (express.static still handles them) so nothing breaks if a template is missed.
function middleware(req, res, next) {
  const logical = reverse.get(req.path);
  if (!logical) return next();
  const meta = ASSETS[logical];
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(meta.file).on('error', next).pipe(res);
}

module.exports = { build, manifest, middleware, url };
