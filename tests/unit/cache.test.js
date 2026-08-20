// Unit tests for the reference-data cache.
//
// The E2E suite proves the cache SAVES queries. What it cannot practically
// prove is the set of ways a cache goes wrong: an invalidation the statement
// sniffer fails to notice, a stampede on a cold entry, or a read that was
// already in flight when a write landed and then republishes the rows it
// fetched beforehand. Each of those publishes stale content to real visitors,
// so each is pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../../server/cache');

// Every test registers its own entry: registration is process-wide and a key
// may only be claimed once, exactly as it is in the application.
let seq = 0;
function freshKey(name) {
  seq += 1;
  return `${name}:${seq}`;
}

// A loader that counts its calls, so "was the database hit?" is a number.
function countingLoader(values) {
  const state = { calls: 0 };
  const loader = async () => {
    const value = Array.isArray(values) ? values[Math.min(state.calls, values.length - 1)] : values;
    state.calls += 1;
    return value;
  };
  return { loader, state };
}

test.beforeEach(() => {
  process.env.REFERENCE_CACHE_TTL_MS = '30000';
  cache.clear();
});

test.after(() => { delete process.env.REFERENCE_CACHE_TTL_MS; });

test('a repeated read is served without calling the loader again', async () => {
  const { loader, state } = countingLoader('first');
  const read = cache.register(freshKey('svc'), ['services'], loader);

  assert.equal(await read(), 'first');
  assert.equal(await read(), 'first');
  assert.equal(await read(), 'first');
  assert.equal(state.calls, 1, 'three reads should have cost one query');
});

test('a mutating statement against the entry\'s table invalidates it', async () => {
  const { loader, state } = countingLoader(['before', 'after']);
  const read = cache.register(freshKey('svc'), ['services'], loader);

  assert.equal(await read(), 'before');
  cache.onMutation('UPDATE services SET price_cents = $1 WHERE id = $2');
  assert.equal(await read(), 'after', 'an administrator\'s edit must be visible on the next request');
  assert.equal(state.calls, 2);
});

test('a read of the same table does NOT invalidate', async () => {
  const { loader, state } = countingLoader(['before', 'after']);
  const read = cache.register(freshKey('svc'), ['services'], loader);

  assert.equal(await read(), 'before');
  cache.onMutation('SELECT * FROM services WHERE active = TRUE');
  assert.equal(await read(), 'before');
  assert.equal(state.calls, 1, 'a SELECT must not expire the entry it just populated');
});

test('a write to an unrelated table does NOT invalidate', async () => {
  const { loader, state } = countingLoader(['before', 'after']);
  const read = cache.register(freshKey('svc'), ['services'], loader);

  assert.equal(await read(), 'before');
  cache.onMutation('INSERT INTO bookings (customer_id) VALUES ($1)');
  assert.equal(await read(), 'before');
  assert.equal(state.calls, 1);
});

test('a TRUNCATE naming many tables invalidates each entry it names', async () => {
  const services = countingLoader(['s1', 's2']);
  const photos = countingLoader(['p1', 'p2']);
  const readServices = cache.register(freshKey('svc'), ['services'], services.loader);
  const readPhotos = cache.register(freshKey('photo'), ['photos'], photos.loader);

  await readServices();
  await readPhotos();
  cache.onMutation('TRUNCATE TABLE photos, services, site_settings RESTART IDENTITY CASCADE');

  assert.equal(await readServices(), 's2');
  assert.equal(await readPhotos(), 'p2');
});

test('a table name that merely contains another\'s does not cross-invalidate', async () => {
  const { loader, state } = countingLoader(['before', 'after']);
  const read = cache.register(freshKey('settings'), ['site_settings'], loader);

  await read();
  // `settings` is a substring of `site_settings`. Word boundaries, not
  // substring matching, decide.
  cache.onMutation('UPDATE settings SET value = $1');
  assert.equal(await read(), 'before');
  assert.equal(state.calls, 1);
});

test('concurrent reads of a cold entry collapse into one query', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = cache.register(freshKey('svc'), ['services'], async () => {
    calls += 1;
    await gate;
    return 'value';
  });

  const inFlight = [read(), read(), read(), read()];
  release();
  const results = await Promise.all(inFlight);

  assert.deepEqual(results, ['value', 'value', 'value', 'value']);
  assert.equal(calls, 1, 'a burst against a cold cache must not fan out into one query each');
});

test('a write during an in-flight read is not overwritten by that read', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = cache.register(freshKey('svc'), ['services'], async () => {
    calls += 1;
    if (calls === 1) await gate;
    return calls === 1 ? 'stale' : 'fresh';
  });

  const pending = read();
  // The write lands while the first read is still waiting on the database.
  cache.onMutation('UPDATE services SET price_cents = 1');
  release();
  assert.equal(await pending, 'stale', 'the in-flight caller still gets the rows it asked for');

  // ...but those rows must not have been published to anyone else.
  assert.equal(await read(), 'fresh');
});

test('a failing loader is not cached', async () => {
  let calls = 0;
  const read = cache.register(freshKey('svc'), ['services'], async () => {
    calls += 1;
    if (calls === 1) throw new Error('database unreachable');
    return 'recovered';
  });

  await assert.rejects(read(), /database unreachable/);
  assert.equal(await read(), 'recovered', 'a failure must not pin an error state for the whole TTL');
});

test('REFERENCE_CACHE_TTL_MS=0 disables caching entirely', async () => {
  process.env.REFERENCE_CACHE_TTL_MS = '0';
  const { loader, state } = countingLoader('value');
  const read = cache.register(freshKey('svc'), ['services'], loader);

  await read();
  await read();
  assert.equal(state.calls, 2, 'the escape hatch has to actually turn the cache off');
});

test('an entry expires once its TTL has passed', async () => {
  process.env.REFERENCE_CACHE_TTL_MS = '1';
  const { loader, state } = countingLoader(['before', 'after']);
  const read = cache.register(freshKey('svc'), ['services'], loader);

  assert.equal(await read(), 'before');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await read(), 'after');
  assert.equal(state.calls, 2);
});

test('registering the same key twice is refused', () => {
  const key = freshKey('svc');
  cache.register(key, ['services'], async () => 1);
  assert.throws(() => cache.register(key, ['services'], async () => 2), /already registered/);
});

test('an entry must declare at least one table', () => {
  assert.throws(() => cache.register(freshKey('svc'), [], async () => 1), /must declare the tables/);
});
