/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    config/ask-class-lifetimes-v1.json
 * Generator: scripts/generate-ask-class-lifetimes-module.mjs
 *
 * Regenerate with `node scripts/generate-ask-class-lifetimes-module.mjs` whenever
 * the fixture changes. `scripts/check-ask-class-lifetimes-fixture-sync.sh`
 * regenerates to a temp path and byte-compares this file, so an edit here
 * without an edit there fails the pre-TestFlight gate.
 *
 * See the generator's header for why web compiles these bytes in instead of
 * importing the JSON.
 */

/** SHA-256 of config/ask-class-lifetimes-v1.json at generation time. */
export const ASK_CLASS_LIFETIMES_DIGEST =
  'b682bed1d1b099651ba39b6adce29c5d9d91d573fc9aae55e7f9ad04461c654f';

export const ASK_CLASS_LIFETIMES = {
  "$comment": "PLAN-CD (feedback-2026-09-17 wave; Decision 22, 2026-09-21) — the CD2 ask-class lifetime CLASSIFIER. CROSS-PLATFORM CONTRACT AND THE RULE ITSELF: both clients classify an interactive ask_user_started by its tool_call_id exactly as `match` specifies, against `rows` and `default`. `match` is the only statement of the matching semantics anywhere; neither client hard-codes a prefix or a lifetime, and PLAN-CD's prose states no rule. Canonical here; CertMateUnified carries a byte-identical BUNDLED copy at Sources/Resources/ask-class-lifetimes-v1.json (read at runtime, not a Tests/ fixture) pinned by paired SHA-256 digest constants; web compiles in a module GENERATED from these bytes (scripts/generate-ask-class-lifetimes-module.mjs → web/src/lib/recording/ask-class-lifetimes-v1.generated.ts); and scripts/check-ask-class-lifetimes-fixture-sync.sh byte-compares all three as a named pre-TestFlight step. Every `lifetime_ms` is DERIVED from the backend constant named in `backend_source`; the check script fails when any is shorter than its source, and when the script-class row's prefix stops matching every live dialogue-engine schema's toolCallIdPrefix. The default row carries the LONGER class lifetime on purpose — under-holding reopens a silent loss, over-holding costs one audible re-ask (PLAN-CD § the asymmetry argument). Do NOT shorten it.",
  "plan": "PLAN-CD (feedback-2026-09-17 wave)",
  "schema_version": 1,
  "policy_id": "AskClassLifetimesV1",
  "policy_version": 1,
  "match": {
    "input": "the `tool_call_id` bytes exactly as received on the ask_user_started frame — no trimming, no case folding, no normalisation",
    "order": "walk `rows` in array order; the first row that matches wins",
    "row_matches_when": "the row's `prefix` is a leading byte-prefix of the input, compared case-sensitively",
    "no_row_matches": "use `default`"
  },
  "rows": [
    {
      "prefix": "srv-",
      "class": "dialogue-script",
      "lifetime_ms": 180000,
      "backend_source": "hardTimeoutMs in src/extraction/dialogue-engine/schemas/{ocpd,rcbo,rcd,insulation-resistance,ring-continuity}.js; prefix is each schema's toolCallIdPrefix"
    },
    {
      "prefix": "call_",
      "class": "dispatcher",
      "lifetime_ms": 45000,
      "backend_source": "ASK_USER_TIMEOUT_MS in src/extraction/stage6-dispatcher-ask.js; the OpenAI Responses call id passed through openai-responses-adapter.js unchanged"
    },
    {
      "prefix": "mdr-",
      "class": "dispatcher",
      "lifetime_ms": 45000,
      "backend_source": "ASK_USER_TIMEOUT_MS; brokerRegisteredAsk with idPrefix 'mdr'"
    },
    {
      "prefix": "pvr-",
      "class": "dispatcher",
      "lifetime_ms": 45000,
      "backend_source": "ASK_USER_TIMEOUT_MS; brokerRegisteredAsk with idPrefix 'pvr'"
    },
    {
      "prefix": "broker-",
      "class": "dispatcher",
      "lifetime_ms": 45000,
      "backend_source": "ASK_USER_TIMEOUT_MS; brokerRegisteredAsk safePrefix fallback 'broker' (the source appends the dash)"
    }
  ],
  "default": {
    "class": "unrecognised",
    "lifetime_ms": 180000,
    "backend_source": "the longer of the two class constants above — fail-safe by design; see PLAN-CD § the asymmetry argument"
  },
  "vectors": [
    {
      "id": "live_openai_call",
      "tool_call_id": "call_8f3kQ2mN7pL1vX9c",
      "expect_class": "dispatcher",
      "expect_lifetime_ms": 45000
    },
    {
      "id": "broker_mdr",
      "tool_call_id": "mdr-0f1e2d3c4b5a6",
      "expect_class": "dispatcher",
      "expect_lifetime_ms": 45000
    },
    {
      "id": "broker_pvr",
      "tool_call_id": "pvr-0f1e2d3c4b5a6",
      "expect_class": "dispatcher",
      "expect_lifetime_ms": 45000
    },
    {
      "id": "broker_fallback",
      "tool_call_id": "broker-0f1e2d3c4b5a6",
      "expect_class": "dispatcher",
      "expect_lifetime_ms": 45000
    },
    {
      "id": "script_srv_rcs_slot",
      "tool_call_id": "srv-rcs-3387D15C-2-ring_r1_ohm-1758480000000",
      "expect_class": "dialogue-script",
      "expect_lifetime_ms": 180000
    },
    {
      "id": "script_srv_ocpd_which",
      "tool_call_id": "srv-ocpd-3387D15C-which-1758480000000",
      "expect_class": "dialogue-script",
      "expect_lifetime_ms": 180000
    },
    {
      "id": "zzz_unknown_1",
      "tool_call_id": "zzz-unknown-1",
      "expect_class": "unrecognised",
      "expect_lifetime_ms": 180000
    },
    {
      "id": "anthropic_toolu_not_a_row",
      "tool_call_id": "toolu_01A2B3C4D5E6F7",
      "expect_class": "unrecognised",
      "expect_lifetime_ms": 180000
    },
    {
      "id": "uppercase_srv_is_not_srv",
      "tool_call_id": "SRV-rcs-3387D15C-2-ring_r1_ohm-1758480000000",
      "expect_class": "unrecognised",
      "expect_lifetime_ms": 180000
    },
    {
      "id": "empty_id",
      "tool_call_id": "",
      "expect_class": "unrecognised",
      "expect_lifetime_ms": 180000
    }
  ]
} as const;
