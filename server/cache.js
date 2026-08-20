// Short-lived, in-process cache for read-only reference data.
//
// Why this exists
// ---------------
// Every public page render issued its own queries for the same four things:
// the business profile (site_settings), the public service catalogue, the
// homepage photos and the approved reviews. None of that changes more than a
// few times a month, yet a single homepage hit produced four round trips, and
// the pages are served `max-age=0, must-revalidate`, so every crawler, every
// bot and every uptime probe paid the full cost again.
//
// On managed Postgres that is not just latency. Neon suspends an idle compute
// after a few minutes; a steady trickle of reference reads keeps it awake
// permanently, so a site with almost no visitors bills as if it never stops.
//
// Scope, deliberately narrow
// --------------------------
// Catalogue and marketing data only. Nothing that decides money is served from
// here: bookings and payments read `services` by id straight from the database
// (server/routes/bookings.js, server/routes/payments.js) and are untouched by
// this module. A stale price on a marketing card for a few seconds is a
// cosmetic lag; a stale price on an invoice is a billing error.
//
// Freshness
// ---------
// Entries do not merely expire, they are invalidated: server/database.js sniffs
// every statement it issues and drops any entry whose table the statement
// mutates (see `onMutation`). An administrator's edit is therefore visible on
// the next request, not up to a TTL later. The TTL is the backstop for the
// cases sniffing cannot see — a second process, or someone editing the database
// by hand.
//
// Because of that backstop, this cache is only safe for data where a bounded
// staleness window is acceptable. Keep it that way.

const metrics = require('./metrics');

const DEFAULT_TTL_MS = 30_000;

// Read per call rather than at module load so a test can flip caching off (or
// shorten the window) without reloading the module graph.
function ttlMs() {
  const raw = process.env.REFERENCE_CACHE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_TTL_MS;
}

/** @type {Map<string, object>} */
const entries = new Map();

// A statement only invalidates when it could actually change rows. `SELECT *
// FROM services` must not drop the services entry, or the cache would never
// hold anything.
const MUTATION_RE = /\b(?:insert|update|delete|truncate|merge|drop|alter|create|replace)\b/i;

/**
 * Register a cacheable read.
 *
 * @param {string} key      unique name, used in errors only
 * @param {string[]} tables tables whose mutation must invalidate this entry
 * @param {() => Promise<any>} loader the uncached read
 * @returns {() => Promise<any>} the cached read
 */
function register(key, tables, loader) {
  if (entries.has(key)) throw new Error(`cache entry "${key}" is already registered`);
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error(`cache entry "${key}" must declare the tables it depends on`);
  }
  const entry = {
    key,
    // Precompiled: `onMutation` runs on every write the process makes.
    tableRe: new RegExp(`\\b(?:${tables.map(escapeRe).join('|')})\\b`, 'i'),
    loader,
    value: undefined,
    expiresAt: 0,
    pending: null,
    // Bumped by every invalidation. A load that started before an invalidation
    // must not store its result afterwards — see `read`.
    generation: 0
  };
  entries.set(key, entry);
  return () => read(entry);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function read(entry) {
  const ttl = ttlMs();

  if (ttl > 0 && entry.expiresAt > Date.now()) {
    metrics.increment('benny_reference_cache_total', { result: 'hit' });
    return entry.value;
  }
  metrics.increment('benny_reference_cache_total', { result: 'miss' });

  // Single flight. A cold cache under concurrent requests must not fan out into
  // one identical query per request — that is the stampede this cache exists to
  // prevent, and it is worst exactly when traffic arrives in a burst.
  if (entry.pending) return entry.pending;

  const generation = entry.generation;
  entry.pending = (async () => {
    try {
      const value = await entry.loader();
      // A write landed while this read was in flight, so the rows just fetched
      // may already be superseded. Serve them to this caller — they were
      // correct when the query ran — but do not publish them to later ones.
      if (ttl > 0 && entry.generation === generation) {
        entry.value = value;
        entry.expiresAt = Date.now() + ttl;
      }
      return value;
    } finally {
      entry.pending = null;
    }
  })();

  return entry.pending;
}

/**
 * Drop every entry the given SQL statement could have changed.
 *
 * Matching is deliberately generous: a statement that mutates and mentions a
 * cached table invalidates it, even if the mention is incidental. A needless
 * invalidation costs one extra query; a missed one publishes stale content.
 */
function onMutation(sql) {
  if (typeof sql !== 'string' || !MUTATION_RE.test(sql)) return;
  for (const entry of entries.values()) {
    if (entry.tableRe.test(sql)) invalidate(entry);
  }
}

function invalidate(entry) {
  entry.value = undefined;
  entry.expiresAt = 0;
  entry.generation += 1;
}

/** Drop everything. For the test harness, which truncates tables directly. */
function clear() {
  for (const entry of entries.values()) invalidate(entry);
}

module.exports = { register, onMutation, clear, DEFAULT_TTL_MS };
