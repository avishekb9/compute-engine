// loadtest.mjs — Tier-0 adversarial load test for the compute engine.
// Verifies the guards (per-IP/min, per-IP/day, global concurrency, body cap,
// length cap, param validation) return CLEAN coded responses (429/503/413/400),
// never 500s, and that the credit-bearing Gemini endpoints are never actually hit.
//
// IMPORTANT: points at a LOCAL instance only. Chat tests use OVER-LENGTH messages
// so they are rejected (413) BEFORE any Gemini call — zero credit spent.
//
//   node test/loadtest.mjs            (BASE defaults to http://127.0.0.1:3200)

const BASE = process.env.BASE || "http://127.0.0.1:3200";

const post = (path, body, ip) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }));
const get = (p) => fetch(BASE + p).then(r => r.text()).catch(e => e.message);
const tally = (rs) => rs.reduce((t, r) => ((t[r.status] = (t[r.status] || 0) + 1), t), {});
const sample = (rs, code) => { const h = rs.find(r => r.status === code); return h ? h.body.slice(0, 130) : "(none)"; };

(async () => {
  console.log("=== metrics BEFORE ===\n" + (await get("/metrics")) + "\n");

  // ── A: per-IP per-minute limit + concurrency, single IP, 60 concurrent runs ──
  const run = { method: "unit_root", params: { series: ["India"] } };
  const A = await Promise.all(Array.from({ length: 60 }, () => post("/api/compute/run", run, "10.0.0.1")));
  const tA = tally(A);
  console.log("[A] 60× concurrent /api/compute/run from ONE IP:", JSON.stringify(tA));
  console.log("    expect: ~8×200, some 503 (concurrency), rest 429 (per-min). UNEXPECTED 5xx(non-503):",
    A.some(r => r.status >= 500 && r.status !== 503));
  console.log("    sample 429:", sample(A, 429));
  console.log("    sample 503:", sample(A, 503));

  // ── B: GLOBAL concurrency ceiling, 30 concurrent each from a UNIQUE IP ──
  const B = await Promise.all(Array.from({ length: 30 }, (_, i) => post("/api/compute/run", run, `172.16.0.${i + 1}`)));
  const tB = tally(B);
  console.log("\n[B] 30× concurrent runs, each a DIFFERENT IP (per-IP limit can't fire):", JSON.stringify(tB));
  console.log("    expect: ~8×200 (= MAX_CONCURRENT), rest 503. UNEXPECTED 5xx(non-503):",
    B.some(r => r.status >= 500 && r.status !== 503));

  // ── C: chat rate limit + length cap, ONE IP, OVER-LENGTH (no Gemini) ──
  const longMsg = JSON.stringify({ message: "x".repeat(5000) });
  const C = await Promise.all(Array.from({ length: 15 }, () => post("/api/chat", longMsg, "10.0.0.2")));
  console.log("\n[C] 15× /api/chat OVER-LENGTH from ONE IP:", JSON.stringify(tally(C)));
  console.log("    expect: 413 (length) for the ≤10 that pass /min, 429 for the rest. NO 200, NO Gemini call.");
  console.log("    sample 413:", sample(C, 413));

  // ── D/E/F: single requests from fresh IPs → reach validation/body checks ──
  const D = await post("/api/compute/run", { method: "unit_root", params: { series: ["India"], pad: "y".repeat(70000) } }, "10.0.0.3");
  console.log("\n[D] oversized body (>64KB):", D.status, D.body.slice(0, 90));
  const E = await post("/api/compute/run", { method: "DROP_TABLE; rm -rf /", params: {} }, "10.0.0.4");
  console.log("[E] unknown method:", E.status, E.body.slice(0, 90));
  const F = await post("/api/compute/run", { method: "unit_root", params: { series: ["Atlantis"] } }, "10.0.0.5");
  console.log("[F] unknown series:", F.status, F.body.slice(0, 90));
  const G = await post("/api/research", JSON.stringify({ query: "z".repeat(5000) }), "10.0.0.6");
  console.log("[G] research OVER-LENGTH query:", G.status, G.body.slice(0, 90), "(413 before Gemini)");

  console.log("\n=== metrics AFTER ===\n" + (await get("/metrics")));
})();
