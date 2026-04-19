// Thin wrapper around the Stripe SDK so tests can swap the client without
// monkey-patching require cache. Call setClient(mock) from the test harness.
let override = null;

function configured() {
  const key = process.env.STRIPE_SECRET_KEY;
  return !!(key && key !== 'sk_test_placeholder');
}

function getStripe() {
  if (override) return override;
  if (!configured()) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

function setClient(client) {
  override = client;
}

module.exports = { getStripe, setClient, configured };
