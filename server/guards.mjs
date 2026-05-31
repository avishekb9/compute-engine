// guards.mjs — production hardening for the compute engine (zero deps).
// In-memory response cache, per-IP sliding-window rate limiter, and a counters
// registry for /metrics. All state is process-local (resets on restart) — no
// Redis, no persistence, fine for a scale-to-zero Cloud Run service.

// ── response cache ────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const cacheStore = new Map();              // key -> { result, ts }

export function cacheKey(method, params) {
  return `${method}::${JSON.stringify(params || {})}`;
}
export function cacheGet(key) {
  const hit = cacheStore.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cacheStore.delete(key); return null; }
  return hit.result;
}
export function cacheSet(key, result) {
  // never cache errors — only good results
  if (!result || result.ok === false || result.error) return;
  cacheStore.set(key, { result, ts: Date.now() });
}

// ── per-IP sliding-window rate limiter ────────────────────────────────────────
const WINDOW_MS = 60 * 1000;               // 1 minute window
const hits = new Map();                    // `${ip}::${bucket}` -> number[] (timestamps)

// returns { ok:true } or { ok:false, retry_after_seconds }
export function rateLimit(ip, bucket, maxPerMin) {
  if (!maxPerMin) return { ok: true };     // unlimited bucket
  const key = `${ip}::${bucket}`;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= maxPerMin) {
    const retry = Math.ceil((WINDOW_MS - (now - arr[0])) / 1000);
    hits.set(key, arr);
    return { ok: false, retry_after_seconds: Math.max(1, retry) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true };
}

// periodically drop empty/expired buckets so the maps don't grow unbounded
export function sweep() {
  const now = Date.now();
  for (const [k, v] of hits) {
    const live = v.filter(t => now - t < WINDOW_MS);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
  for (const [k, v] of cacheStore) if (now - v.ts > CACHE_TTL_MS) cacheStore.delete(k);
}

// ── metrics registry ──────────────────────────────────────────────────────────
const startedAt = Date.now();
export const metrics = {
  requests_total: 0,
  cache_hits: 0,
  cache_misses: 0,
  errors_total: 0,
  rate_limited_total: 0,
  methods: {},          // method -> count
};
export function countMethod(m) {
  if (!m) return;
  metrics.methods[m] = (metrics.methods[m] || 0) + 1;
}
export function metricsSnapshot() {
  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    requests_total: metrics.requests_total,
    cache_hits: metrics.cache_hits,
    cache_misses: metrics.cache_misses,
    errors_total: metrics.errors_total,
    rate_limited_total: metrics.rate_limited_total,
    cache_entries: cacheStore.size,
    methods: { ...metrics.methods },
  };
}

// client IP from Cloud Run / proxy headers, falling back to the socket
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// one structured JSON log line per request (Cloud Run captures stdout as logs)
export function logLine(obj) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); } catch {}
}
