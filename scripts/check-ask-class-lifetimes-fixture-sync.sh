#!/usr/bin/env bash
# PLAN-CD (feedback-2026-09-17 wave; Decision 22) — the CD2 ask-class
# classifier guard.
#
# `config/ask-class-lifetimes-v1.json` is the ONLY statement of how a client
# classifies an interactive `ask_user_started` by its `tool_call_id`, and of
# how long each class stays live. Both clients read it: web compiles in a
# GENERATED module, iOS bundles a byte-identical copy and reads it at runtime.
# The backend never reads the file. Its lifetimes are DERIVED from backend
# constants, so this script also reads those constants from backend SOURCE.
#
# Four obligations, each a separate failure with its own message:
#   1. Byte identity: the canonical file, the iOS bundle copy and the
#      committed generated web module (regenerated to a temp path and
#      compared) all carry the same bytes.
#   2. Values: no row, and not the default, is SHORTER than the backend
#      constant its class derives from (ASK_USER_TIMEOUT_MS for dispatcher
#      rows; every dialogue-engine schema's hardTimeoutMs for the
#      dialogue-script row; the longer of the two for the default).
#   3. Class map: every live `toolCallIdPrefix` in
#      src/extraction/dialogue-engine/schemas/*.js begins with the
#      dialogue-script row's prefix. The legacy `*-script.js` twins are not
#      construction sites and are never read.
#   4. Vectors: every vector resolves to its expected class and lifetime
#      under the fixture's own `match` rule. Each client's classifier test
#      walks the same vectors against its own code; this check catches a
#      fixture edit that breaks its own vectors before either suite runs.
#
# Run as a NAMED hard-fail pre-TestFlight step (CertMateUnified's
# deploy-testflight.sh, ASK_CLASS_LIFETIMES_SYNC_SCRIPT) and by hand.
#
# Exit 0: all four hold. Exit 1: any failure, a missing file, or a generator
# failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANONICAL="$EICR_ROOT/config/ask-class-lifetimes-v1.json"
GENERATOR="$EICR_ROOT/scripts/generate-ask-class-lifetimes-module.mjs"
GENERATED="$EICR_ROOT/web/src/lib/recording/ask-class-lifetimes-v1.generated.ts"
# A BUNDLE resource, not a Tests/ fixture: the iOS app reads it at runtime.
# The iOS checkout is nested inside the EICR working copy by convention;
# IOS_REPO_ROOT overrides for non-standard layouts (CI, worktrees).
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Sources/Resources/ask-class-lifetimes-v1.json"

TMP_GENERATED=""
cleanup() { [ -n "$TMP_GENERATED" ] && rm -f "$TMP_GENERATED"; }
trap cleanup EXIT

fail() {
  echo "ask-class-lifetimes-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical fixture missing at $CANONICAL"
[ -f "$GENERATOR" ] || fail "generator missing at $GENERATOR"
[ -f "$GENERATED" ] || fail "generated web module missing at $GENERATED (run: node scripts/generate-ask-class-lifetimes-module.mjs)"
[ -f "$IOS_COPY" ] || fail "iOS bundle copy missing at $IOS_COPY (set IOS_REPO_ROOT if the checkout lives elsewhere)"

# ── Obligation 1: byte identity ────────────────────────────────────────────
if ! cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "obligation 1 (byte identity) — the iOS bundle copy differs from the canonical; re-copy the canonical file and update BOTH digest constants together"
fi
TMP_GENERATED="$(mktemp -t ask-class-lifetimes-generated.XXXXXX)"
if ! node "$GENERATOR" --out "$TMP_GENERATED" >/dev/null; then
  fail "obligation 1 (byte identity) — generator failed; cannot verify the committed web module"
fi
if ! cmp -s "$TMP_GENERATED" "$GENERATED"; then
  echo "committed:   $(shasum -a 256 "$GENERATED")" >&2
  echo "regenerated: $(shasum -a 256 "$TMP_GENERATED")" >&2
  fail "obligation 1 (byte identity) — the generated web module is stale or hand-edited; run: node scripts/generate-ask-class-lifetimes-module.mjs"
fi

# ── Obligations 2–4: read backend SOURCE, never a second copy ──────────────
EICR_ROOT="$EICR_ROOT" CANONICAL="$CANONICAL" node --input-type=module - <<'NODE' || exit 1
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.env.EICR_ROOT;
const fixture = JSON.parse(readFileSync(process.env.CANONICAL, 'utf8'));
const die = (msg) => {
  process.stderr.write(`ask-class-lifetimes-fixture-sync: FAIL — ${msg}\n`);
  process.exit(1);
};
const num = (s) => Number(String(s).replace(/_/g, ''));

// Backend constants, read from source.
const dispatcherSrc = readFileSync(
  path.join(root, 'src/extraction/stage6-dispatcher-ask.js'),
  'utf8'
);
const askMatch = dispatcherSrc.match(/export const ASK_USER_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/);
if (!askMatch) die('obligation 2 (values) — ASK_USER_TIMEOUT_MS not found in src/extraction/stage6-dispatcher-ask.js');
const dispatcherMs = num(askMatch[1]);

const schemaDir = path.join(root, 'src/extraction/dialogue-engine/schemas');
const schemaFiles = readdirSync(schemaDir).filter((f) => f.endsWith('.js'));
const scriptSchemas = [];
for (const file of schemaFiles) {
  const src = readFileSync(path.join(schemaDir, file), 'utf8');
  const prefixes = [...src.matchAll(/toolCallIdPrefix:\s*'([^']*)'/g)].map((m) => m[1]);
  if (prefixes.length === 0) continue;
  const timeouts = [...src.matchAll(/hardTimeoutMs:\s*([\d_]+)/g)].map((m) => num(m[1]));
  if (timeouts.length === 0) {
    die(`obligation 2 (values) — ${file} declares toolCallIdPrefix but no hardTimeoutMs`);
  }
  scriptSchemas.push({ file, prefixes, hardTimeoutMs: Math.max(...timeouts) });
}
if (scriptSchemas.length === 0) {
  die('obligation 3 (class map) — no toolCallIdPrefix declaration found under src/extraction/dialogue-engine/schemas');
}
const scriptMs = Math.max(...scriptSchemas.map((s) => s.hardTimeoutMs));
const floorFor = { dispatcher: dispatcherMs, 'dialogue-script': scriptMs };

// ── Obligation 2: values ──
if (!Array.isArray(fixture.rows) || fixture.rows.length === 0) die('obligation 2 (values) — the fixture has no rows');
for (const row of fixture.rows) {
  const floor = floorFor[row.class];
  if (floor === undefined) die(`obligation 2 (values) — row "${row.prefix}" has class "${row.class}", which derives from no known backend constant`);
  if (!(row.lifetime_ms >= floor)) {
    die(`obligation 2 (values) — row "${row.prefix}" (${row.class}) lifetime_ms ${row.lifetime_ms} is shorter than its backend constant ${floor}`);
  }
}
const longest = Math.max(dispatcherMs, scriptMs);
if (!fixture.default || !(fixture.default.lifetime_ms >= longest)) {
  die(`obligation 2 (values) — default lifetime_ms ${fixture.default?.lifetime_ms} is shorter than the longer class constant ${longest}`);
}

// ── Obligation 3: class map ──
const scriptRows = fixture.rows.filter((r) => r.class === 'dialogue-script');
if (scriptRows.length !== 1) die(`obligation 3 (class map) — expected exactly one dialogue-script row, found ${scriptRows.length}`);
const scriptPrefix = scriptRows[0].prefix;
for (const s of scriptSchemas) {
  for (const p of s.prefixes) {
    if (!p.startsWith(scriptPrefix)) {
      die(`obligation 3 (class map) — ${s.file} mints toolCallIdPrefix '${p}', which does not begin with the dialogue-script row's prefix '${scriptPrefix}'`);
    }
  }
}

// ── Obligation 4: vectors under the fixture's own `match` rule ──
// match: exact input bytes; rows in array order; first leading
// case-sensitive byte-prefix wins; otherwise `default`.
const classify = (id) => {
  for (const row of fixture.rows) {
    if (id.startsWith(row.prefix)) return { cls: row.class, ms: row.lifetime_ms };
  }
  return { cls: fixture.default.class, ms: fixture.default.lifetime_ms };
};
if (!Array.isArray(fixture.vectors) || fixture.vectors.length === 0) die('obligation 4 (vectors) — the fixture has no vectors');
for (const v of fixture.vectors) {
  const got = classify(v.tool_call_id);
  if (got.cls !== v.expect_class || got.ms !== v.expect_lifetime_ms) {
    die(`obligation 4 (vectors) — vector "${v.id}" resolves to ${got.cls}/${got.ms}, expected ${v.expect_class}/${v.expect_lifetime_ms}`);
  }
}
process.stdout.write(
  `backend constants: ASK_USER_TIMEOUT_MS=${dispatcherMs}; hardTimeoutMs=${scriptMs} across ${scriptSchemas.length} schemas (${scriptSchemas.flatMap((s) => s.prefixes).join(', ')})\n`
);
NODE

echo "ask-class-lifetimes-fixture-sync: OK — iOS copy and generated web module track the canonical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1)); values, class map and vectors hold against backend source"
