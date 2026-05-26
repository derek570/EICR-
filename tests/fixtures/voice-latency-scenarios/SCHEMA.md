# Voice-latency scenario schema

Scenarios are YAML files consumed by
`scripts/voice-latency-bench/transcript-replay.mjs`. Each file describes
a single replayable interaction: connect to backend WS, send N
`transcript` messages with timing offsets, capture every response,
optionally pull the chunked TTS audio for each `confirmations[]` entry,
assert expectations declared in the file.

## File layout

```yaml
name: short_kebab_case_id
description: |
  Multi-line free text describing what this scenario exercises and
  what bug it pins (if any).

# Optional. Used to filter via --suite. Folder name should match.
suite: protocol | stage2_streaming | stage3_suppression | stage4_fast_path | stage5_ask_user | baseline

# Optional capability bits the iOS-simulated client advertises in
# session_start. Defaults to {} (no capabilities — baseline behaviour).
capabilities:
  voice_latency:
    version: 1
    supports:
      - streaming_http_audio
      - source_field_in_tts_post
      - voice_latency_ack

# Optional initial job state. Mirrors the jobState payload iOS sends in
# session_start. Defaults to a minimal single-board state.
job_state:
  boards:
    - id: main
      designation: Main DB
      circuits:
        - number: 1
          designation: Lighting
          ocpd_rating: 6
          ocpd_type: B

# Replay timeline. Each `transcript` entry is sent at `at_ms` from the
# start of the run. Multiple final segments allowed (e.g. Flux
# duplicate-final scenarios).
transcript:
  - at_ms: 0
    text: "Circuit one number of points five."
    isFinal: true
    regexResults:  # optional iOS-side regex hint payload
      - field: number_of_points
        circuit: 1
        rawValue: "5"
        canonicalValue: "5"
        confidence: 0.97

# Assertions evaluated after the run completes (server emits
# session_ack stopped, or the configured timeout elapses).
expect:
  # Expect at least one `extraction` envelope.
  extraction_count: { min: 1 }
  # Expect the merged extracted_readings on the final extraction to
  # include this circuit field combination.
  has_reading:
    - circuit: 1
      field: number_of_points
      value: 5
  # Latency budget on the audible TTS path. Measured from the latest
  # transcript send → first byte of the corresponding /api/proxy/
  # elevenlabs-tts response (which the harness fetches on demand).
  audible_latency_ms_p50: { max: 2500 }
  # Optional: assert no ask_user fired.
  ask_user_count: { max: 0 }
  # Optional: assert specific server events arrived.
  saw_event_types:
    - extraction
    - cost_update

# Per-run config. Defaults shown.
config:
  timeout_ms: 30000           # hard cap on the whole scenario
  fetch_tts: true              # POST /api/proxy/elevenlabs-tts for each
                               # confirmations[] entry and time the response
  session_stop_at_end: true    # send session_stop after assertions or expire
```

## Output

The harness writes one JSON result line per scenario to stdout (or to
the `--output` directory if `--output=` is passed). Schema:

```json
{
  "name": "...",
  "suite": "...",
  "pass": true | false,
  "failures": ["assertion strings that failed"],
  "timings": {
    "session_start_to_ack_ms": ...,
    "first_transcript_to_extraction_p50_ms": ...,
    "first_transcript_to_audible_p50_ms": ...,
    "transcripts_sent": ...,
    "extractions_received": ...,
    "confirmations_total": ...,
    "tts_fetches": [
      { "text": "...", "first_byte_ms": ..., "total_ms": ..., "bytes": ... }
    ]
  },
  "events": [
    { "at_ms": ..., "type": "extraction", "summary": "..." },
    ...
  ]
}
```

`pass = true` requires all `expect.*` predicates to hold AND no
unhandled errors.

## Conventions

- All timing constants in milliseconds (ms).
- All `at_ms` offsets are wall-clock from `run_start_t0`.
- `regexResults` mirrors the iOS `TranscriptFieldMatcher` output shape.
- Currently the harness does NOT play audio — TTS bytes are fetched
  and timed but discarded. iOS-side playback latency is measured by
  the Stage 0.A bench (separate concern).

## Field names — use LEGACY wire-format names in `has_reading`

`has_reading` runs against `extraction.result.readings[]` (the message
the harness receives over WS). Stage 6's bundler writes Sonnet's
CANONICAL `record_reading` field names into the result, and then
`validateAndCorrectFields` in `src/extraction/sonnet-stream.js`
REWRITES every canonical name to its legacy wire form via
`src/extraction/field-name-corrections.js` BEFORE the WS send. So
scenarios that assert `has_reading[].field` must use the LEGACY name
after rewrite. Quick map for the common ones:

| Canonical (Sonnet emits) | Legacy (wire / iOS / harness sees) |
|---|---|
| `measured_zs_ohm` | `zs` |
| `r1_r2_ohm` | `r1_plus_r2` |
| `rcd_time_ms` | `rcd_trip_time` |
| `ir_live_live_mohm` | `insulation_resistance_l_l` |
| `ir_live_earth_mohm` | `insulation_resistance_l_e` |
| `ir_test_voltage_v` | `ir_test_voltage` |
| `ring_r1_ohm` | `ring_continuity_r1` |
| `ring_rn_ohm` | `ring_continuity_rn` |
| `ring_r2_ohm` | `ring_continuity_r2` |
| `r2_ohm` | `r2` |
| `ocpd_rating_a` | `ocpd_rating` |
| `cpc_csa_mm2` | `cable_size_earth` |
| `live_csa_mm2` | `cable_size` |
| `polarity_confirmed` | `polarity` |
| `circuit_designation` | `designation` |
| `rcd_rating_ma` | `rcd_rating_a` |
| `earth_loop_impedance_ze` | `ze` |
| `prospective_fault_current` | `pfc` |

Names in the LEFT column will NOT match the wire shape. If you must
add a new mapping, see `KNOWN_FIELDS` + `FIELD_CORRECTIONS` in
`src/extraction/sonnet-stream.js` and
`src/extraction/field-name-corrections.js` respectively.
