#!/usr/bin/env node
// knowledge-bank.test.mjs — failable eval for the read-only /api/knowledge route's
// data contract (zero deps). Loads the bundled manifest and asserts: valid shape,
// the shared turnpike invariant, the certification ledger, and CROSS-LINK INTEGRITY
// (every cross_link points to an existing game). Also checks the query-filter
// contract the route implements (by slot, by topic substring). Run: node test/knowledge-bank.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); fails++; } else console.log("ok:", m); };

let kb;
try { kb = JSON.parse(readFileSync(join(ENGINE_DIR, "knowledge-bank.json"), "utf8")); }
catch (e) { console.error("FAIL: knowledge-bank.json not loadable:", e.message); process.exit(1); }

ok(kb.schema === "econstellar.knowledge-bank/v1", "schema tag present");
ok(kb.shared_invariants && kb.shared_invariants.turnpike_eta_bar === 0.9675, "turnpike invariant eta_bar=0.9675");
ok(kb.shared_invariants.turnpike_root === 0.4603, "turnpike root 0.4603");
ok(kb.certification_ledger && Array.isArray(kb.certification_ledger.STRONG), "certification ledger present");
ok(Array.isArray(kb.games) && kb.games.length >= 5, "games array (>=5)");

const ids = new Set(kb.games.map(g => g.id));
for (const g of kb.games) {
  ok(g.id && g.slot && g.title && g.status, `game ${g.id || "?"} has id/slot/title/status`);
  for (const link of (g.cross_links || []))
    ok(ids.has(link), `cross-link ${g.id} -> ${link} resolves to a real game`);
}

// the V.5 evolutionary game must carry its sorry-free formal layer + the no-oscillation result
const v5 = kb.games.find(g => g.id === "frontiers-v5-evolutionary");
ok(v5 && v5.formal && /0 sorry/.test(v5.formal.status), "V.5 formal layer recorded as 0 sorry");
ok(v5 && v5.key_results.T2_decentralisation.turnpike_invariant_held === true, "V.5 turnpike invariant held");

// query-filter contract the route implements
const bySlot = kb.games.filter(g => (g.slot || "").toLowerCase() === "v.5");
ok(bySlot.length === 1 && bySlot[0].id === "frontiers-v5-evolutionary", "filter by slot V.5 -> the evolutionary game");
const byTopic = kb.games.filter(g => JSON.stringify(g).toLowerCase().includes("no_oscillation"));
ok(byTopic.length >= 1, "filter by topic 'no_oscillation' -> at least one game");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
