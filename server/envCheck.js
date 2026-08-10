// Boot-time configuration validation.
//
// Extracted from server.js as a PURE function over an environment object so it
// can be unit tested. The bug this replaces could not be caught by any existing
// test: the E2E suite boots the server with NODE_ENV=test, where the same
// problems only produce a warning, so a check that wrongly refused a PRODUCTION
// boot was invisible until someone deployed.
//
// The rule for what belongs here: a value whose absence or default makes the
// process UNSAFE to run, not merely incomplete. Business facts (contact
// details, hours, service area) are deliberately NOT here — refusing to start
// on an incomplete business profile would convert a missing phone number into
// an outage. That gate is `npm run check:launch`, run in the deploy pipeline.

// Values that shipped as defaults at some point and must never reach production.
const REJECTED_JWT_SECRETS = new Set([
  'benny-pets-default-secret',
  'change-this-to-a-random-secret-key'
]);
const REJECTED_ADMIN_PASSWORDS = new Set(['changeme123']);

/**
 * @param {object} env - an environment object, normally process.env
 * @returns {string[]} human-readable problems; empty means the config is safe
 */
function configProblems(env = {}) {
  const problems = [];

  // Either variable is accepted, and server/database.js reads them the same
  // way: `NEON_DATABASE_URL || DATABASE_URL`. There must be exactly ONE check
  // here. A second, unconditional `DATABASE_URL` check used to follow this one,
  // which meant an operator who set only NEON_DATABASE_URL — the variable that
  // .env.example, DEPLOY.md and docs/OPERATIONS.md all tell them to set — had
  // production refuse to boot, reporting a variable no document mentions.
  if (!env.NEON_DATABASE_URL && !env.DATABASE_URL) {
    problems.push('NEON_DATABASE_URL (or DATABASE_URL) must be set');
  }

  if (!env.JWT_SECRET || REJECTED_JWT_SECRETS.has(env.JWT_SECRET)) {
    problems.push('JWT_SECRET must be set to a strong random value');
  }

  if (!env.ADMIN_PASSWORD || REJECTED_ADMIN_PASSWORDS.has(env.ADMIN_PASSWORD)) {
    problems.push('ADMIN_PASSWORD must be set (not the default)');
  }

  if (!env.ADMIN_EMAIL) {
    problems.push('ADMIN_EMAIL must be set');
  }

  return problems;
}

module.exports = { configProblems, REJECTED_JWT_SECRETS, REJECTED_ADMIN_PASSWORDS };
