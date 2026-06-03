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
// last-good result even if past TTL — for graceful degradation: serve stale data
// (clearly flagged) rather than a hard error when a live run fails or is shed.
export function cacheGetStale(key) {
  const hit = cacheStore.get(key);
  return hit ? hit.result : null;
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

// ── global concurrency ceiling ──────────────────────────────────────────────────
// Bounds simultaneously in-flight metered requests on this instance so a burst
// cannot fan out into unbounded R/Gemini work (and unbounded credit). Combined
// with Cloud Run --max-instances this gives a hard global ceiling across the fleet.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "8", 10);
let inFlight = 0;
export function acquire() { if (inFlight >= MAX_CONCURRENT) return false; inFlight++; return true; }
export function release() { if (inFlight > 0) inFlight--; }
export function concurrencyState() { return { in_flight: inFlight, max: MAX_CONCURRENT }; }

// ── per-IP DAILY quota (paid LLM endpoints) ─────────────────────────────────────
// On top of the per-minute limiter: cap Gemini-backed calls per IP per UTC day so
// sustained low-rate abuse cannot slowly drain the credit. Resets at UTC midnight.
const dayHits = new Map();                  // `${ip}::${bucket}` -> { day, count }
const utcDay = () => new Date().toISOString().slice(0, 10);
export function dailyLimit(ip, bucket, maxPerDay) {
  if (!maxPerDay) return { ok: true };
  const key = `${ip}::${bucket}`;
  const day = utcDay();
  const rec = dayHits.get(key);
  if (!rec || rec.day !== day) { dayHits.set(key, { day, count: 1 }); return { ok: true, remaining: maxPerDay - 1 }; }
  if (rec.count >= maxPerDay) return { ok: false, remaining: 0 };
  rec.count++;
  return { ok: true, remaining: maxPerDay - rec.count };
}

// ── global per-instance DAILY cap on PAID (Gemini) calls ────────────────────────
// The hard backstop that bounds worst-case credit spend regardless of how many IPs
// attack. Per-instance × Cloud Run --max-instances ⇒ a bounded fleet-wide daily max.
const MAX_LLM_PER_DAY = parseInt(process.env.MAX_LLM_PER_DAY || "400", 10);
let llmDay = utcDay(), llmCount = 0;
export function llmBudget() {
  const d = utcDay();
  if (d !== llmDay) { llmDay = d; llmCount = 0; }
  if (llmCount >= MAX_LLM_PER_DAY) return { ok: false, used: llmCount, max: MAX_LLM_PER_DAY };
  llmCount++;
  return { ok: true, used: llmCount, max: MAX_LLM_PER_DAY };
}
export function llmBudgetState() {
  const d = utcDay();
  return d !== llmDay ? { used: 0, max: MAX_LLM_PER_DAY } : { used: llmCount, max: MAX_LLM_PER_DAY };
}

// periodically drop empty/expired buckets so the maps don't grow unbounded
export function sweep() {
  const now = Date.now();
  for (const [k, v] of hits) {
    const live = v.filter(t => now - t < WINDOW_MS);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
  for (const [k, v] of cacheStore) if (now - v.ts > CACHE_TTL_MS) cacheStore.delete(k);
  const today = utcDay();
  for (const [k, v] of dayHits) if (v.day !== today) dayHits.delete(k);
}

// ── metrics registry ──────────────────────────────────────────────────────────
const startedAt = Date.now();
export const metrics = {
  requests_total: 0,
  cache_hits: 0,
  cache_misses: 0,
  errors_total: 0,
  rate_limited_total: 0,
  daily_limited_total: 0,
  concurrency_shed_total: 0,
  methods: {},          // method -> count
  events: {},           // aggregate, no-PII page/feature counters (T3.2)
};
export function countMethod(m) {
  if (!m) return;
  metrics.methods[m] = (metrics.methods[m] || 0) + 1;
}
// Aggregate, privacy-respecting usage counter — stores only a count per allowlisted
// event name. No IP, no cookie, no user-agent, no per-visitor record. The caller
// validates the name against a fixed allowlist first, so the map stays bounded.
export function countEvent(name) {
  if (!name) return;
  metrics.events[name] = (metrics.events[name] || 0) + 1;
}
export function metricsSnapshot() {
  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    requests_total: metrics.requests_total,
    cache_hits: metrics.cache_hits,
    cache_misses: metrics.cache_misses,
    errors_total: metrics.errors_total,
    rate_limited_total: metrics.rate_limited_total,
    daily_limited_total: metrics.daily_limited_total,
    concurrency_shed_total: metrics.concurrency_shed_total,
    in_flight: concurrencyState().in_flight,
    max_concurrent: concurrencyState().max,
    llm_calls_today: llmBudgetState().used,
    llm_cap_per_day: llmBudgetState().max,
    cache_entries: cacheStore.size,
    methods: { ...metrics.methods },
    events: { ...metrics.events },
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
