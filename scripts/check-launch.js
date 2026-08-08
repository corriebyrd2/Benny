#!/usr/bin/env node
// Deployment gate for business and legal configuration.
//
//   npm run check:launch
//
// Exits 0 when every launch-required business fact is configured and every
// policy document that must be publicly reachable exists. Exits 1 with a
// specific report otherwise, so a deploy pipeline can refuse to promote a build
// that would publish placeholder contact details or a missing privacy policy.
//
// This is deliberately a SEPARATE gate rather than a hard failure inside
// server.js: refusing to boot would take an already-live site down the moment
// this ships. The running server logs the same report at startup, hides every
// affected public component, and serves the machine-readable version at
// GET /api/settings/launch-check.

require('dotenv').config();

async function main() {
  const { launchCheck, formatLaunchReport } = require('../server/businessProfile');
  const { listPolicies } = require('../server/legal');

  const result = await launchCheck();
  console.log(formatLaunchReport(result));

  const problems = [];
  if (!result.ok) problems.push(`${result.blocking.length} required business field(s) missing`);

  // Every policy the footer and the acceptance flow reference must exist.
  const required = ['privacy', 'terms', 'boarding-agreement', 'cancellation-policy',
    'payment-terms', 'pet-documents-policy', 'emergency-vet-authorization',
    'cookies', 'accessibility', 'support-policy'];
  const present = new Set(listPolicies().map(p => p.slug));
  const missingPolicies = required.filter(s => !present.has(s));
  if (missingPolicies.length) {
    problems.push(`missing policy document(s): ${missingPolicies.join(', ')}`);
  }

  const drafts = listPolicies().filter(p => p.draft).map(p => p.slug);
  if (drafts.length) {
    console.log('');
    console.log(`NOTE: ${drafts.length} policy document(s) are still marked draft and render a`);
    console.log('"pending review by qualified counsel" banner:');
    console.log(`  ${drafts.join(', ')}`);
    console.log('This is not a launch blocker by itself — see docs/LEGAL-REVIEW.md.');
  }

  if (result.advisory.length) {
    console.log('');
    console.log('Advisory — these components stay hidden until supplied:');
    for (const a of result.advisory) console.log(`  - ${a.key}: ${a.label} (${a.reason})`);
  }

  if (problems.length) {
    console.error('');
    console.error('LAUNCH CHECK FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('');
  console.log('Launch check passed.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Launch check could not run:', err.message);
  process.exit(2);
});
