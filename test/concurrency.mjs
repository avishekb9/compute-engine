// concurrency.mjs — prove the global concurrency ceiling actually sheds load.
// Fires 30 DISTINCT, cache-missing jobs (each does real R work ~1-2s) from unique
// IPs (so the per-IP/min limit can't fire) → they must pile past MAX_CONCURRENT.
const BASE = process.env.BASE || "http://127.0.0.1:3200";
const post = (b, ip) => fetch(BASE + "/api/compute/run", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(b),
}).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: e.message }));

const series = ["Argentina","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Mexico","Russia","SouthAfrica","SouthKorea","Turkey","UK","USA"];
const jobs = [];
for (let i = 0; i < 18; i++) jobs.push({ method: "dfa_hurst", params: { series: [series[i]] } });
for (let i = 0; i < 12; i++) jobs.push({ method: "garch", params: { series: [series[i]] } });

const t0 = Date.now();
const R = await Promise.all(jobs.map((j, i) => post(j, `192.168.1.${i + 1}`)));
const tally = R.reduce((t, r) => ((t[r.status] = (t[r.status] || 0) + 1), t), {});
console.log("30 concurrent DISTINCT cache-missing runs, unique IPs:", JSON.stringify(tally), `in ${Date.now() - t0}ms`);
console.log("  expect ~8×200 + ~22×503 (MAX_CONCURRENT=8)");
const s503 = R.find(r => r.status === 503);
console.log("  sample 503:", s503 ? s503.body.slice(0, 140) : "(NONE — ceiling NOT triggered)");
console.log("  any non-503 5xx (bad):", R.some(r => r.status >= 500 && r.status !== 503));
console.log("  /metrics:", await (await fetch(BASE + "/metrics")).text());
