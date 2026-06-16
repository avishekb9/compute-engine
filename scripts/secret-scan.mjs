#!/usr/bin/env node
// secret-scan.mjs — pre-commit / pre-deploy secret gate (Invariant 12, zero deps).
// Scans the given files (or the default Track-B deliverable set) for secret-shaped
// strings. Exits NON-ZERO (blocks) on a hit, 0 if clean. It NEVER prints a secret
// value — a match is reported by pattern name with a redacted fingerprint only, so
// the gate's own output can be safely logged.
//
//   node scripts/secret-scan.mjs [file ...]
//
// The engine references every credential by env NAME, so a clean tree is the
// expected state. A planted dummy token must make this exit non-zero (proven by
// test/upgrade.test.mjs), after which the dummy is removed and it exits 0.
// Point it at any path set for the pre-deploy gate; with no args it scans the
// files this upgrade adds.

import { readFileSync, existsSync } from "node:fs";

// Patterns match credential VALUES, not env-name references. Each pattern's source
// text is itself NOT a valid secret (the classes don't expand to literal keys), so
// scanning this file does not self-trigger.
const PATTERNS = [
  { name: "google_api_key",  re: /AIza[0-9A-Za-z_\-]{35}/g },
  { name: "gcp_oauth_token", re: /ya29\.[0-9A-Za-z_\-]{20,}/g },
  { name: "aws_access_key",  re: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key_pem", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: "github_token",    re: /gh[pousr]_[0-9A-Za-z]{36,}/g },
  { name: "slack_token",     re: /xox[baprs]-[0-9A-Za-z\-]{10,}/g },
  // value must be a real token (>=16 chars of base64/token alphabet, no code
  // punctuation) so env-NAME handling like "GOOGLE_API_KEY=".length) is NOT flagged
  { name: "assigned_secret", re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY)\b\s*[:=]\s*["'][A-Za-z0-9+/_=\-]{16,}["']/g },
];

// redact: never echo the secret — pattern + length + first2…last2 only
function fingerprint(m) {
  const s = String(m);
  return `${s.slice(0, 2)}…${s.slice(-2)} (len ${s.length})`;
}

const args = process.argv.slice(2);
const DEFAULT = [
  "server/upgrade-capabilities.mjs",
  "server/guards.mjs",
  "test/upgrade.test.mjs",
  "scripts/secret-scan.mjs",
];
const files = (args.length ? args : DEFAULT).filter(existsSync);

let hits = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        hits++;
        console.log(`HIT  ${f}:${i + 1}  [${p.name}]  ${fingerprint(m[0])}`);
      }
    }
  });
}

if (hits) {
  console.log(`\nSECRET-SCAN: BLOCKED — ${hits} secret-shaped match(es). Reference secrets by env name only (Invariant 12).`);
  process.exit(2);
}
console.log(`SECRET-SCAN: clean (${files.length} file(s) scanned).`);
process.exit(0);
