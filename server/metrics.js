// Application metrics, in Prometheus text format.
//
// docs/OPERATIONS.md listed the things worth alerting on — authentication
// failures, upload failures, payment failures, webhook failures, email
// failures, API latency, elevated 5xx — but nothing counted any of them, so the
// alert thresholds were aspirational. These are the counters behind them.
//
// Deliberately in-process and unlabelled by user or path:
//   * No per-path labels. An attacker probing random URLs would otherwise grow
//     the label set without bound, which is how a metrics endpoint becomes a
//     memory-exhaustion vector.
//   * No user or customer identifiers. Metrics are operational, not personal
//     data, and they are exposed to whatever scrapes them.
//
// Counters reset when the process restarts. That is normal for Prometheus,
// which computes rates from monotonic increases and handles resets.

const counters = new Map();
const gauges = new Map();

// Latency buckets, in milliseconds. Chosen around the thresholds that matter
// here: sub-100ms is healthy, 800ms is the TTFB budget, past 3s something is
// wrong.
const LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 800, 1500, 3000, 10000];
const histograms = new Map();

function key(name, labels) {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '')}"`);
  return `${name}{${parts.join(',')}}`;
}

function increment(name, labels, by = 1) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}

function setGauge(name, value, labels) {
  gauges.set(key(name, labels), value);
}

function observe(name, ms, labels) {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { counts: new Array(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
    histograms.set(k, h);
  }
  h.sum += ms;
  h.count += 1;
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (ms <= LATENCY_BUCKETS[i]) h.counts[i] += 1;
  }
}

/**
 * Express middleware: request counts, 4xx/5xx rates and latency.
 *
 * Labelled by METHOD and STATUS only. The route pattern is deliberately not a
 * label — see the note above about unbounded label sets.
 */
function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const status = res.statusCode;
    const group = `${Math.floor(status / 100)}xx`;
    increment('benny_http_requests_total', { method: req.method, status: group });
    observe('benny_http_request_duration_ms', ms, {});
    if (status >= 500) increment('benny_http_server_errors_total', {});
  });
  next();
}

function render() {
  const lines = [];

  lines.push('# HELP benny_http_requests_total HTTP requests by method and status class.');
  lines.push('# TYPE benny_http_requests_total counter');
  lines.push('# HELP benny_http_server_errors_total Responses with a 5xx status.');
  lines.push('# TYPE benny_http_server_errors_total counter');
  lines.push('# HELP benny_auth_failures_total Failed authentication attempts by kind.');
  lines.push('# TYPE benny_auth_failures_total counter');
  lines.push('# HELP benny_payment_failures_total Payment operations that failed.');
  lines.push('# TYPE benny_payment_failures_total counter');
  lines.push('# HELP benny_webhook_events_total Stripe webhook events by outcome.');
  lines.push('# TYPE benny_webhook_events_total counter');
  lines.push('# HELP benny_email_failures_total Transactional emails that could not be sent.');
  lines.push('# TYPE benny_email_failures_total counter');
  lines.push('# HELP benny_upload_rejections_total Uploads refused, by reason.');
  lines.push('# TYPE benny_upload_rejections_total counter');
  // Managed Postgres bills for a compute that cannot go idle, so the query rate
  // is an operational signal in its own right: a flat, non-zero rate with no
  // traffic means something is polling the database on a timer.
  lines.push('# HELP benny_db_queries_total Statements issued to the database.');
  lines.push('# TYPE benny_db_queries_total counter');
  lines.push('# HELP benny_reference_cache_total Reference-data reads, by cache result.');
  lines.push('# TYPE benny_reference_cache_total counter');

  for (const [k, v] of [...counters.entries()].sort()) {
    lines.push(`${k} ${v}`);
  }

  for (const [k, v] of [...gauges.entries()].sort()) {
    lines.push(`${k} ${v}`);
  }

  for (const [k, h] of [...histograms.entries()].sort()) {
    const base = k.includes('{') ? k.slice(0, k.indexOf('{')) : k;
    lines.push(`# TYPE ${base} histogram`);
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      lines.push(`${base}_bucket{le="${LATENCY_BUCKETS[i]}"} ${h.counts[i]}`);
    }
    lines.push(`${base}_bucket{le="+Inf"} ${h.count}`);
    lines.push(`${base}_sum ${h.sum.toFixed(2)}`);
    lines.push(`${base}_count ${h.count}`);
  }

  lines.push('# HELP benny_process_uptime_seconds Seconds since this process started.');
  lines.push('# TYPE benny_process_uptime_seconds gauge');
  lines.push(`benny_process_uptime_seconds ${Math.round(process.uptime())}`);

  return lines.join('\n') + '\n';
}

// Test-only.
function reset() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

module.exports = { increment, observe, render, requestMetrics, reset, setGauge };
