/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    config/ocpd-bs-suggestions.json
 * Generator: scripts/generate-ocpd-bs-suggestions.mjs
 *
 * Regenerate with `node scripts/generate-ocpd-bs-suggestions.mjs` whenever the
 * manifest changes. `scripts/check-ocpd-bs-fixture-sync.sh` regenerates to a
 * temp path and byte-compares this file, so an edit here without an edit there
 * fails the pre-TestFlight gate.
 *
 * See the generator's header for why web compiles these bytes in instead of
 * importing the JSON.
 */

/** SHA-256 of config/ocpd-bs-suggestions.json at generation time. */
export const OCPD_BS_SUGGESTIONS_DIGEST =
  'd6a5fba96d07a43f34d21338aec058254074ff0387be950a04fc029ea3401fb3';

export const OCPD_BS_SUGGESTIONS = {
  "$comment": "PLAN-CC (feedback-2026-09-17 wave) — OCPD BS(EN) standard manifest. CROSS-PLATFORM CONTRACT and the NORMATIVE source for the canonicalisation alias table: the rendering in PLAN-CC § CC1 has no independent authority, and if the two disagree this file wins. Shape mirrors config/closed-enum-vectors.json. web/ compiles it in through the generated module web/src/lib/recording/ocpd-bs-suggestions.generated.ts (the production Docker builder never copies root config/, so web cannot import this path at runtime) and a web test re-reads THIS file and asserts digest + deep equality; CertMateUnified keeps a byte-identical copy at Tests/CertMateUnifiedTests/Fixtures/ocpd-bs-suggestions.json pinned by paired SHA-256 digest constants, and scripts/check-ocpd-bs-fixture-sync.sh byte-compares them as a named hard-fail pre-TestFlight step. `accepted_value_vectors` IS the canonical mapping — there is no separate alias layer. A miss is a `rejected_value_vectors` entry, never an accepted entry with a null expected. `tier1`/`tier2` are CURATED picker suggestions, not a closed list: ocpd_bs_en accepts any grammar-valid standard, and BS EN 61008 / BS 4293 / BS 7288 are accepted when dictated but deliberately appear in NEITHER tier. The backend twin parseOcpdStandard and its conformance test are PLAN-CS's deliverable (PLAN-CC § Integration note).",
  "plan": "PLAN-CC-v29.md (feedback-2026-09-17 wave)",
  "schema_source": "config/field_schema.json",
  "cap": 24,
  "tier1": [
    "BS EN 60898",
    "BS EN 61009",
    "BS EN 60947-2",
    "BS EN 60269-2",
    "BS 88-2",
    "BS 88-3",
    "BS 3036",
    "BS 1361",
    "BS 1362",
    "N/A"
  ],
  "tier2": [
    "BS EN 60269-1",
    "BS EN 60269-3",
    "BS EN 60269-4",
    "BS 88-1",
    "BS 88-6",
    "BS EN 60947-3",
    "BS EN 60947-4-1",
    "BS 3871",
    "BS EN 62423",
    "BS EN 62606",
    "BS EN 60127",
    "BS 4752",
    "BS 646",
    "BS 2950"
  ],
  "accepted_value_vectors": [
    {
      "input": "60898",
      "expected": "BS EN 60898"
    },
    {
      "input": "60898-1",
      "expected": "BS EN 60898"
    },
    {
      "input": "61009",
      "expected": "BS EN 61009"
    },
    {
      "input": "61009-1",
      "expected": "BS EN 61009"
    },
    {
      "input": "60909",
      "expected": "BS EN 61009"
    },
    {
      "input": "3871",
      "expected": "BS 3871"
    },
    {
      "input": "3871-1",
      "expected": "BS 3871"
    },
    {
      "input": "88-1",
      "expected": "BS 88-1"
    },
    {
      "input": "88-2",
      "expected": "BS 88-2"
    },
    {
      "input": "88-3",
      "expected": "BS 88-3"
    },
    {
      "input": "88-6",
      "expected": "BS 88-6"
    },
    {
      "input": "60269-1",
      "expected": "BS EN 60269-1"
    },
    {
      "input": "60269-2",
      "expected": "BS EN 60269-2"
    },
    {
      "input": "60269-3",
      "expected": "BS EN 60269-3"
    },
    {
      "input": "60269-4",
      "expected": "BS EN 60269-4"
    },
    {
      "input": "60947-2",
      "expected": "BS EN 60947-2"
    },
    {
      "input": "60947-3",
      "expected": "BS EN 60947-3"
    },
    {
      "input": "60947-4-1",
      "expected": "BS EN 60947-4-1"
    },
    {
      "input": "62423",
      "expected": "BS EN 62423"
    },
    {
      "input": "62606",
      "expected": "BS EN 62606"
    },
    {
      "input": "60127",
      "expected": "BS EN 60127"
    },
    {
      "input": "3036",
      "expected": "BS 3036"
    },
    {
      "input": "1361",
      "expected": "BS 1361"
    },
    {
      "input": "1362",
      "expected": "BS 1362"
    },
    {
      "input": "4752",
      "expected": "BS 4752"
    },
    {
      "input": "646",
      "expected": "BS 646"
    },
    {
      "input": "2950",
      "expected": "BS 2950"
    },
    {
      "input": "61008",
      "expected": "BS EN 61008"
    },
    {
      "input": "4293",
      "expected": "BS 4293"
    },
    {
      "input": "7288",
      "expected": "BS 7288"
    },
    {
      "input": "BS 3871",
      "expected": "BS 3871"
    },
    {
      "input": "b s 3871",
      "expected": "BS 3871"
    },
    {
      "input": "BS EN 60898-1",
      "expected": "BS EN 60898"
    },
    {
      "input": "BS EN 60909",
      "expected": "BS EN 61009"
    },
    {
      "input": "88 dash 2",
      "expected": "BS 88-2"
    },
    {
      "input": "88 hyphen 3",
      "expected": "BS 88-3"
    },
    {
      "input": "a b s 60898",
      "expected": "BS EN 60898"
    },
    {
      "input": "b. s. e. n. 61009-1",
      "expected": "BS EN 61009"
    },
    {
      "input": "6 zero 8 9 8",
      "expected": "BS EN 60898"
    },
    {
      "input": "bs   en   12345",
      "expected": "BS EN 12345"
    },
    {
      "input": "b s en 12345 - 12 - 3",
      "expected": "BS EN 12345-12-3"
    },
    {
      "input": "BS   EN   60898",
      "expected": "BS EN 60898"
    },
    {
      "input": "BS          EN          12345-12-3",
      "expected": "BS EN 12345-12-3"
    },
    {
      "input": "12345",
      "expected": "BS 12345"
    },
    {
      "input": "BS 9999",
      "expected": "BS 9999"
    },
    {
      "input": "N/A",
      "expected": "N/A"
    }
  ],
  "rejected_value_vectors": [
    {
      "input": "88",
      "reason": "bare_two_digit_no_suffix",
      "why": "cannot say which of BS 88-1/-2/-3/-6 was dictated (step 8a)"
    },
    {
      "input": "bs 88",
      "reason": "bare_two_digit_no_suffix",
      "why": "step 8a is prefix-independent"
    },
    {
      "input": "bs en 88",
      "reason": "bare_two_digit_no_suffix",
      "why": "step 8a is prefix-independent"
    },
    {
      "input": "BS 123456",
      "reason": "six_digits",
      "why": "the capture grammar admits at most five digits (step 7)"
    },
    {
      "input": "There is no RCBO",
      "reason": "prose",
      "why": "the whole-value grammar consumes nothing; a miss re-asks"
    }
  ]
} as const;

/** Picker primary suggestions. */
export const OCPD_BS_TIER1: readonly string[] = OCPD_BS_SUGGESTIONS.tier1;

/** Picker secondary suggestions, behind the "More standards" disclosure. */
export const OCPD_BS_TIER2: readonly string[] = OCPD_BS_SUGGESTIONS.tier2;

/** Picker control character cap. */
export const OCPD_BS_INPUT_CAP: number = OCPD_BS_SUGGESTIONS.cap;
