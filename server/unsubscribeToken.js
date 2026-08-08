// Signed unsubscribe tokens.
//
// Kept in its own module, free of any database import, so that the route, the
// email templates and the test suite can all derive the same token without
// dragging a connection pool along with it.
//
// A keyed HMAC of the address means the link works from an email client with no
// session, is unguessable by anyone who does not already know the address, and
// needs no per-subscriber column.

const crypto = require('crypto');

function unsubscribeToken(email) {
  const secret = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', secret)
    .update(`unsubscribe:${String(email).toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 32);
}

function tokenMatches(email, token) {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(token || ''));
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function unsubscribeUrl(baseUrl, email) {
  const params = new URLSearchParams({ e: email, t: unsubscribeToken(email) });
  return `${String(baseUrl).replace(/\/$/, '')}/api/subscribe/unsubscribe?${params.toString()}`;
}

module.exports = { unsubscribeToken, tokenMatches, unsubscribeUrl };
