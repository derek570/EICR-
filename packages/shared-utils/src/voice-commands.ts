/**
 * Voice command parser + dispatcher.
 *
 * Ported from iOS `CertMateUnified/Sources/Recording/VoiceCommandExecutor.swift`.
 *
 * `parseVoiceCommand` mirrors iOS's on-device intent set exactly: only
 * `calculate_impedance` and `apply_field` are recognised locally. Every
 * other phrasing (set / move / query) returns null so the transcript
 * flows to Sonnet via the WS, and Sonnet's structured
 * `voice_command_response` is executed by the caller through
 * `applyVoiceCommand`. iOS canon: `DeepgramRecordingViewModel.swift:1755`
 * (CalculateImpedanceIntent) and `:1772` (ApplyFieldIntent) — nothing
 * else early-returns; everything else is forwarded with
 * `appendToTranscriptAndExtract`.
 *
 * Before 2026-05-10 the web parser also matched `set X to Y`,
 * `move circuit N to M`, and `what is X` regex shapes — that caused
 * the in-field bug on session sess_mp09cuea_wzkf where a Deepgram
 * garble matched QUERY_RE with field="is" and the parser spoke
 * "I don't know the field 'is'." then consumed the transcript so
 * Sonnet never saw the inspector's words. iOS-canon scope (Calculate +
 * Apply only) avoids that whole class of over-match because the
 * remaining regexes don't have empty-field failure modes.
 *
 * The module is PURE. It reads the JobDetail snapshot, returns a partial
 * JobDetail patch + a spoken response string. The caller (recording
 * context) wires the patch into `updateJob()` and the response into the
 * TTS helper.
 */

import {
  canonicaliseClosedEnumValue,
  cleanClosedEnumResidue,
  GUARDED_CLOSED_ENUM_FIELDS,
  isGuardedClosedEnumField,
  isValueCheckedCircuitField,
  reaskForClosedEnumOutcome,
  renderClosedEnumReask,
  type ClosedEnumReaskReason,
  type ClosedEnumSparePolicy,
  type GuardedClosedEnumField,
  type GuardedTarget,
} from './closed-enum-guard';
import { canonicaliseOcpdStandard, canonicaliseOcpdStandardForImport } from './ocpd-standard';
import { applyOcpdAwarePatch } from './max-zs-lookup';
import { repairCircuitDesignation } from './designation-canonicaliser';
import { resolveJobZe, type JobZeLike } from './circuit-derivations';

// We use local structural types rather than pulling from @certmate/shared-types
// because the iOS-oriented shared-types `JobDetail` uses nested sections
// (`installation_details`, `supply_characteristics`) while the web client
// stores them flat on the JobDetail (`installation`, `supply`). The voice
// command executor is consumed by the web recording context, so the flat
// shape is the right abstraction here.

/** Structural subset of the web's CircuitRow — only the keys the voice
 *  command executor touches. Accepts `unknown` values so callers can pass
 *  their wider CircuitRow in without a cast. */
export interface VoiceCommandCircuit {
  id?: string;
  circuit_ref?: string;
  number?: string;
  circuit_designation?: string;
  [key: string]: unknown;
}

/** Structural subset of the web's JobDetail — section bags are
 *  permissive so any app-specific extensions pass through unchanged. */
export interface VoiceCommandJob {
  circuits?: VoiceCommandCircuit[];
  supply?: Record<string, unknown>;
  installation?: Record<string, unknown>;
  board?: Record<string, unknown>;
  extent?: Record<string, unknown>;
  design?: Record<string, unknown>;
  /** A01P — the REAL web job keys the local Calculate route reads
   *  (`resolveJobZe`). The singular `supply` / `board` bags above are
   *  unpopulated on the web JobDetail and were the original Ze bug. */
  supply_characteristics?: Record<string, unknown> | null;
  boards?: Array<Record<string, unknown>> | null;
  board_info?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Discriminated union over the commands we recognise. Keep this flat
 *  (no nested shapes) so parseVoiceCommand stays trivially testable. */
/** Scope of a calculate / apply-field command. Mirrors iOS's
 *  CalculateImpedanceIntent.Scope (VoiceCommandExecutor.swift:581–588)
 *  and the same shape applies to ApplyFieldIntent. */
export type VoiceCommandScope =
  | { kind: 'all' }
  | { kind: 'single'; circuit: number }
  | { kind: 'range'; from: number; to: number };

export type VoiceCommand =
  | {
      type: 'update_field';
      /** Field key; normalised to the shared-types canonical name. */
      field: string;
      value: string;
      /** 1-based circuit ref. When absent, the field is interpreted as
       *  a supply/installation field (circuit 0 in the iOS executor). */
      circuit?: number;
    }
  | {
      type: 'reorder_circuits';
      from: number;
      to: number;
    }
  | {
      type: 'query_field';
      field: string;
      circuit?: number;
    }
  | {
      /** Calculate Zs (Ze + R1+R2) or R1+R2 (Zs - Ze) across the scope.
       *  Mirrors iOS executeCalculateImpedance (VoiceCommandExecutor.swift:314).
       *  `kind` matches iOS's params.calculate strings exactly. */
      type: 'calculate_impedance';
      kind: 'zs' | 'r1_r2';
      scope: VoiceCommandScope;
      /** A01P — additive remainder metadata: the normalised text left
       *  after the scope match, terminal punctuation stripped (`''` when
       *  the scope consumed everything). The CALLER forwards a Calculate
       *  with unconsumed text ("… on the garage board") as an ordinary
       *  transcript; the parser's recognition set is unchanged. */
      remainder?: string;
    }
  | {
      /** Apply a single (field, value) to every circuit in the scope.
       *  Mirrors iOS executeApplyField. Direct-mutation semantics —
       *  the inspector's deliberate command overrides any pre-existing
       *  value, unlike the auto-extraction priority gate. */
      type: 'apply_field';
      field: string;
      value: string;
      scope: VoiceCommandScope;
      /** PLAN-F item 1 (2026-08-12, feedback id 115) — orthogonal spare
       *  filter, composes with `scope`. 'automatic' or undefined resolves
       *  per field family (device-attribute fields include spares by
       *  default; reading fields exclude). Set ONLY when the inspector
       *  explicitly said "including spares" / "excluding spares". */
      sparePolicy?: 'automatic' | 'include' | 'exclude';
    }
  | {
      /** PLAN-F item 1, Decision 3 — the utterance named BOTH include- and
       *  exclude-shaped spare language in one instruction ("including
       *  spares but excluding the spare way"). The local parser CONSUMES
       *  this: it speaks a deterministic refusal and does NOT fall
       *  through to the server (an unforwarded local reject would
       *  otherwise reach a backend with no contradiction branch, which
       *  may pick one scope and mutate anyway). */
      type: 'apply_field_contradiction';
    }
  | {
      /** PLAN-B2 — legacy `add_circuit` action from the
       *  SONNET_TOOL_CALLS=off rollback prompt path
       *  (`config/prompts/sonnet_extraction_system.md` §add_circuit:
       *  `{type:"add_circuit",params:{description}}`). iOS has owned
       *  this since the legacy era (`executeAddCircuit`); web's mapper
       *  previously had NO case, so it spoke the server's success text
       *  while silently dropping the mutation. Board/ref semantics
       *  MIRROR iOS's today (round-14 revert): `boards.first?.id`
       *  attribution + GLOBAL next-ref — deliberately imperfect on
       *  multi-board jobs, identically imperfect on both clients. */
      type: 'add_circuit';
      description: string;
    };

export interface VoiceCommandOutcome {
  /** Truthful local execution status used by the speech owner. */
  actionOutcome?: 'applied' | 'unapplied' | 'failed' | 'unsupported';
  actionReason?: string;
  appliedResults?: Array<{ circuit: number | string; field: string; value: string }>;
  /** A01P — rows the local calculator deliberately left alone because the
   *  destination was already occupied (a meter reading always wins). */
  skippedResults?: Array<{ circuit: number | string; reason: CalculateSkipReason }>;
  /** Partial JobDetail patch; undefined for pure query commands.
   *  Callers cast to their richer JobDetail shape — the structural
   *  typing here only requires the keys the applier might touch. */
  patch?: Record<string, unknown>;
  /** Natural-language response to speak back to the inspector. */
  response: string;
  /** Snake-case keys the patch actually changed. Callers feed these
   *  into the live-fill flash registry so voice-driven edits animate
   *  the same as Sonnet-driven ones. Empty / omitted for queries. */
  changedKeys?: string[];
  /** PLAN-C (feedback id 129) — the command targeted one of the six
   *  closed-enum circuit fields and the dictated value is NOT a member
   *  of that field's option list (or the value/target was structurally
   *  missing). `response` already holds the complete-restatement
   *  re-ask; this flag is what lets the speak seam give it PRECEDENCE
   *  over the server's own `spoken_response` and force it audible under
   *  confirmations-OFF. NEVER infer rejection from an absent patch —
   *  a legitimately no-op apply also has no patch. */
  invalidClosedEnum?: boolean;
  /** PLAN-C — the command targeted a closed-enum field and the dictated
   *  value was CANONICALISED to a different string than the inspector
   *  said ("60898" → "BS EN 60898", "twin and earth" → "A"). The
   *  inspector must hear what was actually STORED, so `response` takes
   *  precedence over the server's speech (below an enum re-ask, above
   *  PLAN-B2's designation override). Absent when the dictated value
   *  was already byte-identical to the canonical option. */
  canonicalSuccess?: boolean;
  /** PLAN-C (Codex cycle 1) — the command targeted a closed-enum field,
   *  the VALUE was accepted, and the write still did not land because the
   *  named circuit does not exist. Nothing was mutated, so the server's
   *  "Set wiring type to A on circuit 12." would be read back over a
   *  certificate that has no circuit 12 (the same lie PLAN-B2's Codex r1
   *  closed for designations). `response` holds the truthful local line;
   *  this flag gives it the same speak-seam precedence a re-ask gets.
   *  Deliberately distinct from `invalidClosedEnum` — the value was fine
   *  and the TARGET was not, and the telemetry must tell them apart. */
  guardedWriteFailed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Field vocabulary — maps spoken phrases onto the canonical circuit or
// job-level field name. Mirrors the iOS executor's switch statements so
// voice commands produce byte-identical field writes across platforms.
// ─────────────────────────────────────────────────────────────────────────

// Mirrors iOS `VoiceCommandExecutor.setCircuitField` switch (lines 207–256).
// Key = lowercased phrase the inspector might dictate; value = canonical
// snake_case field name on CircuitRow.
const CIRCUIT_FIELD_ALIASES: Record<string, string> = {
  // Designation. The canonical wire name maps to itself — Codex diff
  // review r1: a server action carrying field:"circuit_designation"
  // previously resolved as UNKNOWN on web (no patch, raw server speech)
  // while iOS accepted it, diverging the cross-client contract.
  circuit_designation: 'circuit_designation',
  designation: 'circuit_designation',
  description: 'circuit_designation',
  // OCPD
  ocpd: 'ocpd_rating_a',
  'ocpd rating': 'ocpd_rating_a',
  'ocpd amps': 'ocpd_rating_a',
  rating: 'ocpd_rating_a',
  'ocpd type': 'ocpd_type',
  type: 'ocpd_type',
  // PLAN-F item 1 (2026-08-12, feedback id 115) — BS/EN + breaking-capacity
  // + max-Zs aliases (web previously had none of these four; iOS/backend
  // parity — same OCPD/RCD field_groups union that defines
  // DEVICE_ATTRIBUTE_FIELDS below).
  'ocpd bs en': 'ocpd_bs_en',
  'ocpd standard': 'ocpd_bs_en',
  'ocpd breaking capacity': 'ocpd_breaking_capacity_ka',
  'breaking capacity': 'ocpd_breaking_capacity_ka',
  'ocpd max zs': 'ocpd_max_zs_ohm',
  'ocpd maximum zs': 'ocpd_max_zs_ohm',
  'rcd bs en': 'rcd_bs_en',
  'rcd standard': 'rcd_bs_en',
  // Cable
  'cable size': 'live_csa_mm2',
  cable: 'live_csa_mm2',
  'live csa': 'live_csa_mm2',
  'cpc size': 'cpc_csa_mm2',
  'cpc csa': 'cpc_csa_mm2',
  cpc: 'cpc_csa_mm2',
  // Impedance
  zs: 'measured_zs_ohm',
  'measured zs': 'measured_zs_ohm',
  'zed s': 'measured_zs_ohm',
  r1r2: 'r1_r2_ohm',
  'r1 r2': 'r1_r2_ohm',
  'r1 plus r2': 'r1_r2_ohm',
  'r one plus r two': 'r1_r2_ohm',
  'r 1 plus r 2': 'r1_r2_ohm',
  r2: 'r2_ohm',
  // Insulation
  'ir live earth': 'ir_live_earth_mohm',
  'ir live-earth': 'ir_live_earth_mohm',
  'insulation resistance live earth': 'ir_live_earth_mohm',
  'insulation resistance live-earth': 'ir_live_earth_mohm',
  'insulation resistance l e': 'ir_live_earth_mohm',
  'ir live live': 'ir_live_live_mohm',
  'ir live-live': 'ir_live_live_mohm',
  'insulation resistance live live': 'ir_live_live_mohm',
  'insulation resistance live-live': 'ir_live_live_mohm',
  'insulation resistance l l': 'ir_live_live_mohm',
  'insulation test voltage': 'ir_test_voltage_v',
  'ir test voltage': 'ir_test_voltage_v',
  'test voltage': 'ir_test_voltage_v',
  // RCD
  'rcd trip': 'rcd_time_ms',
  'rcd trip time': 'rcd_time_ms',
  'rcd time': 'rcd_time_ms',
  'rcd rating': 'rcd_rating_a',
  'rcd amps': 'rcd_rating_a',
  'rcd type': 'rcd_type',
  'rcd operating current': 'rcd_operating_current_ma',
  'rcd button': 'rcd_button_confirmed',
  'rcd test button': 'rcd_button_confirmed',
  // AFDD
  'afdd button': 'afdd_button_confirmed',
  'afdd test button': 'afdd_button_confirmed',
  // Polarity
  polarity: 'polarity_confirmed',
  // Wiring + reference method + disconnect time + points (iOS lines 231–242)
  'wiring type': 'wiring_type',
  wiring: 'wiring_type',
  'ref method': 'ref_method',
  'reference method': 'ref_method',
  'disconnect time': 'max_disconnect_time_s',
  'maximum disconnect time': 'max_disconnect_time_s',
  'max disconnect time': 'max_disconnect_time_s',
  'number of points': 'number_of_points',
  points: 'number_of_points',
};

// Mirrors iOS `setJobField` switch + bonding fields (lines ~270–305).
const SUPPLY_FIELD_ALIASES: Record<string, { section: 'supply' | 'installation'; field: string }> =
  {
    // Supply
    ze: { section: 'supply', field: 'ze' },
    'zed e': { section: 'supply', field: 'ze' },
    pfc: { section: 'supply', field: 'pfc' },
    'prospective fault current': { section: 'supply', field: 'pfc' },
    'earthing arrangement': { section: 'supply', field: 'earthing_arrangement' },
    earthing: { section: 'supply', field: 'earthing_arrangement' },
    // Bonding (BS 7671 main protective bonding — iOS supplyCharacteristics)
    'water bonding': { section: 'supply', field: 'bonding_water' },
    'bonding water': { section: 'supply', field: 'bonding_water' },
    'gas bonding': { section: 'supply', field: 'bonding_gas' },
    'bonding gas': { section: 'supply', field: 'bonding_gas' },
    'oil bonding': { section: 'supply', field: 'bonding_oil' },
    'bonding oil': { section: 'supply', field: 'bonding_oil' },
    'structural steel bonding': { section: 'supply', field: 'bonding_structural_steel' },
    'lightning protection bonding': { section: 'supply', field: 'bonding_lightning' },
    'main bonding continuity': { section: 'supply', field: 'main_bonding_continuity' },
    // Installation
    address: { section: 'installation', field: 'address' },
    postcode: { section: 'installation', field: 'postcode' },
    'client name': { section: 'installation', field: 'client_name' },
    client: { section: 'installation', field: 'client_name' },
    'client address': { section: 'installation', field: 'client_address' },
    'client postcode': { section: 'installation', field: 'client_postcode' },
    'client town': { section: 'installation', field: 'client_town' },
    'client county': { section: 'installation', field: 'client_county' },
  };

/** PLAN-C (feedback id 129) — the CANONICAL snake_case names the two
 *  alias tables resolve TO, indexed for direct lookup.
 *
 *  The alias tables are keyed by SPOKEN phrases ("wiring type", "ocpd bs
 *  en"); with one accidental exception (`circuit_designation`, whose
 *  alias key happens to equal its canonical name) a canonical key like
 *  `wiring_type` resolved to NOTHING. That mattered because the SERVER
 *  speaks canon: `voice_command_response.action.params.field` carries
 *  the snake_case field name straight from the Stage-6 tool call, so a
 *  server-originated `update_field{field:"wiring_type"}` fell through to
 *  `respondUnknown` — no write, and the guard below would never have
 *  been reached on the very path that most needs it.
 *
 *  Codex cycle 3 — the list is the INTERSECTION with iOS, hand-held, not
 *  `Object.values(CIRCUIT_FIELD_ALIASES)`. Deriving it from the alias
 *  table looked like the drift-proof choice, but it admitted fifteen
 *  further canonical keys — `measured_zs_ohm`, `r1_r2_ohm`,
 *  `ocpd_rating_a`, `polarity_confirmed`, `cpc_csa_mm2`, … — that iOS's
 *  `setCircuitField` has NO case for: it knows those same columns under
 *  shorter names (`zs`, `r1_r2`, `ocpd_rating`, `polarity`, `cpc_csa`).
 *  One identical `update_field{field:"measured_zs_ohm"}` frame would
 *  have written on web and done nothing on iOS — a cross-client storage
 *  divergence, on fields outside this plan's six, that nobody reviewed.
 *
 *  Narrowing all the way to the guarded six would have been the opposite
 *  error: `number_of_points` and `max_disconnect_time_s` ARE iOS cases,
 *  so refusing them here would invent a divergence in the other
 *  direction. iOS is canon, so the rule is exactly "what iOS's
 *  `setCircuitField` accepts under its canonical spelling".
 *
 *  Kept in sync by `web/tests/closed-enum-guard-appliers.test.ts`, which
 *  asserts both halves: every name here writes, and a canonical name iOS
 *  does not know still answers "I don't know the field". The wider
 *  vocabulary UNION (teaching both clients the `_ohm`/`_mm2` spellings)
 *  is a real question and a genuine both-clients decision — logged as a
 *  follow-up, not smuggled in under a guard plan.
 *
 *  (`circuit_designation` is unaffected either way: its ALIAS key equals
 *  its canonical name, so it never needed this fallback.) */
const CANONICAL_CIRCUIT_FIELDS: ReadonlySet<string> = new Set<string>([
  ...GUARDED_CLOSED_ENUM_FIELDS,
  // PLAN-CC — named explicitly because it LEFT the guarded set. Membership of
  // this set is about whether the canonical snake_case spelling RESOLVES to a
  // writable circuit field, which has nothing to do with whether its value is
  // checked against an option list: dropping it here would make a
  // server-originated `ocpd_bs_en` action answer "I don't know the field".
  'ocpd_bs_en',
  'number_of_points',
  'max_disconnect_time_s',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
]);
const CANONICAL_SUPPLY_ROUTES: Readonly<
  Record<string, { section: 'supply' | 'installation'; field: string }>
> = Object.fromEntries(Object.values(SUPPLY_FIELD_ALIASES).map((route) => [route.field, route]));

/** Resolve a spoken field phrase against both vocabularies, preferring
 *  the circuit field when the command has an explicit circuit number.
 *  Returns the canonical field + routing section, or null if unknown.
 *
 *  Alias lookups run FIRST and are unchanged, so every spoken phrase
 *  resolves byte-identically to before; the canonical fallbacks only
 *  fire on strings no alias claims. */
function resolveField(
  phrase: string,
  hasCircuit: boolean
): {
  circuitField?: string;
  supplyRoute?: { section: 'supply' | 'installation'; field: string };
} | null {
  const normalised = phrase.trim().toLowerCase();
  if (hasCircuit) {
    const circuitField = CIRCUIT_FIELD_ALIASES[normalised];
    if (circuitField) return { circuitField };
  } else {
    const supplyRoute = SUPPLY_FIELD_ALIASES[normalised];
    if (supplyRoute) return { supplyRoute };
  }
  // Either direction — inspectors sometimes elide the "circuit N" suffix.
  const circuitField = CIRCUIT_FIELD_ALIASES[normalised];
  if (circuitField) return { circuitField };
  const supplyRoute = SUPPLY_FIELD_ALIASES[normalised];
  if (supplyRoute) return { supplyRoute };
  // Canonical snake_case (server-originated actions) — same precedence
  // order as the alias passes above.
  if (hasCircuit && CANONICAL_CIRCUIT_FIELDS.has(normalised)) {
    return { circuitField: normalised };
  }
  const canonicalSupply = CANONICAL_SUPPLY_ROUTES[normalised];
  if (!hasCircuit && canonicalSupply) return { supplyRoute: canonicalSupply };
  if (CANONICAL_CIRCUIT_FIELDS.has(normalised)) return { circuitField: normalised };
  if (canonicalSupply) return { supplyRoute: canonicalSupply };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser — trivially small regex set. We deliberately keep the grammar
// narrow: inspectors use a handful of structured phrasings live, and
// false-positive matches on noise transcripts would be worse than
// "unrecognised" (Sonnet handles the freeform case already).
// ─────────────────────────────────────────────────────────────────────────

// Numbered capture groups (not named) — named groups require ES2018+
// and the shared-utils package targets ES2017 for broader consumer
// compatibility. Group indices are documented inline at each use site.

/** "calculate Zs|R1+R2 [for] [circuit N | circuits N to M | all]"
 *  Mirrors iOS CalculateImpedanceIntent.parse (VoiceCommandExecutor.swift:610).
 *  Captures: [1] = the kind phrase, [2] = the rest (scope). */
const CALCULATE_RE = /^calculate\s+(.+?)$/i;

/** "<field> <value> for [all|circuits N to M|circuit N]" — apply-field
 *  batch. Mirrors iOS ApplyFieldIntent.parse. The complementary
 *  "<field> for all|... is <value>" shape is handled in a second
 *  matcher inside parseApplyField so we can support the dictation
 *  garble Deepgram produces from "RCD trip time for all circuits is
 *  25 ms" etc. */
const APPLY_FIELD_FOR_RE =
  /^(?:set\s+)?([a-z][a-z0-9 +-]*?)\s+(.+?)\s+for\s+(all(?:\s+circuits)?|circuits?\s+\d+\s+to\s+\d+|circuits?\s+\d+)\s*\.?$/i;

const APPLY_FIELD_IS_RE =
  /^([a-z][a-z0-9 +-]*?)\s+for\s+(all(?:\s+circuits)?|circuits?\s+\d+\s+to\s+\d+|circuits?\s+\d+)\s+is\s+(.+?)\s*\.?$/i;

/**
 * Parse a raw transcript into a structured voice command. Returns null
 * when the transcript doesn't match any known grammar.
 *
 * Transcripts arrive from Deepgram already lowercased-ish but with
 * punctuation intact. We trim + drop trailing full-stops / question
 * marks before matching.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  if (!transcript) return null;
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;

  // iOS-canon on-device intents — DeepgramRecordingViewModel.swift:1755
  // (CalculateImpedanceIntent) and :1772 (ApplyFieldIntent). Everything
  // else returns null so the transcript flows to Sonnet and the server's
  // voice_command_response wins.

  // Calculate impedance — "calculate Zs / R1+R2 [for] [circuit N |
  // circuits N to M | all]". Same scope shapes, same kind tokens.
  const calculateCmd = parseCalculate(trimmed);
  if (calculateCmd) return calculateCmd;

  // Apply field (batch) — "<field> <value> for all circuits" /
  // "<field> for circuits N to M is <value>".
  const applyCmd = parseApplyField(trimmed);
  if (applyCmd) return applyCmd;

  return null;
}

/** Strip trailing "amps"/"amp"/"A"/"ohms"/"ohm" units from numeric values
 *  so a field like `ocpd_rating_a` receives `"32"` not `"32A"` — matches
 *  the circuit defaults schema which stores raw numbers.
 *
 *  PLAN-C (feedback id 129) — this mangler is field-UNAWARE by
 *  construction, and on the six closed-enum fields it is actively
 *  destructive: the unit strippers eat a trailing "A" (so `rcd_type` "A"
 *  → `""` and `wiring_type` "SWA" → `"SW"`), the volts stripper eats a
 *  trailing "V", and the `[.,!?]` peel turns "N/A." into "N/A" only by
 *  luck of ordering. Every one of those produces a value the closed-enum
 *  guard would then correctly REJECT — an audible re-ask for a reading
 *  the inspector actually dictated correctly (Audio-First §2).
 *
 *  So callers now resolve the FIELD first and pass its canonical name:
 *  guarded fields take the guard's own edge-only cleaner, which
 *  preserves internal `/ - + &` (N/A, A-S, B+, T&E) and never strips a
 *  unit-shaped letter. Unguarded fields are byte-identical to before. */
function cleanValue(raw: string, canonicalField?: string): string {
  // PLAN-CC — `ocpd_bs_en` is named explicitly alongside the guarded set
  // because it LEFT that set and must keep the edge-only cleaner. The
  // unit-stripping fallback below ends `.replace(/\s*(?:amps?|amperes?|a)$/i,
  // '')`, which turns a dictated `N/A` into `N/`: a value the certificate
  // would then print as a mangled fragment. The field's cleaning requirement
  // never depended on it being membership-validated.
  if (canonicalField && isValueCheckedCircuitField(canonicalField)) {
    return cleanClosedEnumResidue(raw);
  }
  const noTrailingPunct = raw.replace(/[.,!?]+$/, '').trim();
  // Strip common electrical units inspectors dictate alongside numbers.
  const unitStripped = noTrailingPunct
    .replace(/\s*(?:amps?|amperes?|a)$/i, '')
    .replace(/\s*(?:ohms?|Ω)$/i, '')
    .replace(/\s*(?:volts?|v)$/i, '')
    .replace(/\s*milliseconds?$/i, '')
    .replace(/\s*ms$/i, '')
    .trim();
  // Normalise spoken "pass" / "fail" so polarity_confirmed gets "✓" /
  // "✗" via the update branch.
  const lower = unitStripped.toLowerCase();
  if (lower === 'pass' || lower === 'passed' || lower === 'okay' || lower === 'ok') return 'PASS';
  if (lower === 'fail' || lower === 'failed') return 'FAIL';
  return unitStripped;
}

// ─────────────────────────────────────────────────────────────────────────
// Calculate-impedance + apply-field parsers. Mirror iOS
// CalculateImpedanceIntent / ApplyFieldIntent (VoiceCommandExecutor.swift:
// 578–890+). The shapes the regexes above capture are routed here for
// scope resolution.
// ─────────────────────────────────────────────────────────────────────────

const ZS_PREFIXES = ['zs', 'z s', 'zed s', 'impedance'] as const;
const R1R2_PREFIXES = [
  'r1 plus r2',
  'r 1 plus r 2',
  'r1+r2',
  'r1 + r2',
  'r1 r2',
  'r 1 r 2',
] as const;

function stripPrefix(text: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length);
  }
  return null;
}

/**
 * A01P — remainder-aware sibling of `parseScopeText`, used ONLY by the
 * Calculate caller (`parseScopeText` and its `apply_field` caller are
 * untouched). Same recognised shapes; additionally tolerates terminal
 * `.`, `,`, `!` or `?` (Deepgram finals carry them) and reports the text
 * left after the scope so the caller can forward board-qualified trailing
 * text ("… on the garage board") instead of executing locally.
 */
export function parseScopeTextWithRemainder(
  text: string
): { scope: VoiceCommandScope; remainder: string } | null {
  let rest = text
    .trim()
    .replace(/[.,!?]+$/, '')
    .trim();
  if (rest.startsWith('for ')) rest = rest.slice(4).trim();
  if (rest === 'all' || rest === 'all circuits') return { scope: { kind: 'all' }, remainder: '' };
  const allMatch = /^all(?:\s+circuits)?\b\s*(.*)$/.exec(rest);
  if (allMatch) return { scope: { kind: 'all' }, remainder: allMatch[1].trim() };
  const rangeMatch = /^(?:circuits?)\s+(\d+)\s+to\s+(\d+)\b\s*(.*)$/.exec(rest);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { scope: { kind: 'range', from, to }, remainder: rangeMatch[3].trim() };
    }
  }
  const singleMatch = /^(?:circuits?)\s+(\d+)\b\s*(.*)$/.exec(rest);
  if (singleMatch) {
    const ref = Number(singleMatch[1]);
    if (Number.isFinite(ref) && ref >= 1) {
      return { scope: { kind: 'single', circuit: ref }, remainder: singleMatch[2].trim() };
    }
  }
  return null;
}

/** A01P — the additive optional `client_command` transcript-frame marker a
 *  client stamps when it RECOGNISED a Calculate but declined to run it
 *  locally (multi-board job). Names the server calculator the model selects. */
export type ClientCommandMarker = 'calculate_zs' | 'calculate_r1_plus_r2';

export function clientCommandForCalculate(
  command: Extract<VoiceCommand, { type: 'calculate_impedance' }>
): ClientCommandMarker {
  return command.kind === 'r1_r2' ? 'calculate_r1_plus_r2' : 'calculate_zs';
}

/**
 * A01P — Calculate-only parse entry for the ConversationAdmissionV1 probe.
 * Identical grammar to `parseVoiceCommand`'s Calculate branch (this IS that
 * branch); the probe asks for a complete Calculate with NO unconsumed
 * remainder, which `command.remainder === ''` answers.
 */
export function parseCalculateCommand(
  transcript: string
): Extract<VoiceCommand, { type: 'calculate_impedance' }> | null {
  if (!transcript) return null;
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;
  const cmd = parseCalculate(trimmed);
  return cmd && cmd.type === 'calculate_impedance' ? cmd : null;
}

function parseScopeText(text: string): VoiceCommandScope | null {
  let rest = text.trim();
  if (rest.startsWith('for ')) rest = rest.slice(4).trim();
  if (rest === 'all' || rest === 'all circuits') return { kind: 'all' };
  // "circuits N to M" (range) — plural before singular.
  const rangeMatch = /^(?:circuits?)\s+(\d+)\s+to\s+(\d+)/.exec(rest);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { kind: 'range', from, to };
    }
  }
  // "circuit N" (single) — accept plural form too as iOS does.
  const singleMatch = /^(?:circuits?)\s+(\d+)/.exec(rest);
  if (singleMatch) {
    const ref = Number(singleMatch[1]);
    if (Number.isFinite(ref) && ref >= 1) return { kind: 'single', circuit: ref };
  }
  return null;
}

function parseCalculate(transcript: string): VoiceCommand | null {
  const m = CALCULATE_RE.exec(transcript);
  if (!m) return null;
  const restRaw = (m[1] ?? '').toLowerCase();
  // Identify the kind. Try longest first so "r1 plus r2" doesn't get
  // prefix-eaten by a shorter "r1" candidate.
  let kind: 'zs' | 'r1_r2' | null = null;
  let rest = '';
  const r1r2Stripped = stripPrefix(restRaw, R1R2_PREFIXES);
  if (r1r2Stripped !== null) {
    kind = 'r1_r2';
    rest = r1r2Stripped.trim();
  } else {
    const zsStripped = stripPrefix(restRaw, ZS_PREFIXES);
    if (zsStripped !== null) {
      kind = 'zs';
      rest = zsStripped.trim();
    }
  }
  if (!kind) return null;
  // Bare "calculate Zs" with no scope is ambiguous — refuse rather than
  // guess. Mirrors iOS line 666–667. The inspector should re-issue with
  // a scope. The remainder sibling returns null for empty input so we
  // naturally bail. A01P: the sibling also tolerates terminal punctuation
  // (`calculate impedance for all.` now parses) and reports unconsumed
  // trailing text for the caller's forwarding decision.
  const parsed = parseScopeTextWithRemainder(rest);
  if (!parsed) return null;
  return { type: 'calculate_impedance', kind, scope: parsed.scope, remainder: parsed.remainder };
}

/** All known field-alias phrases, sorted longest-first so prefix
 *  matching picks "rcd test button" before falling back to "rcd". */
const APPLY_FIELD_PHRASES = (() => {
  const phrases = [...Object.keys(CIRCUIT_FIELD_ALIASES)];
  // Length-desc; ties resolve by lexical order for determinism.
  phrases.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return phrases;
})();

/** Match the longest known field-alias prefix in `text` (lowercased
 *  + whitespace-collapsed). Returns the phrase + remaining text, or
 *  null if no alias matches. Word-boundary-aware so "rcd" doesn't
 *  swallow "rcd type" wholesale (the alias dictionary has both keys
 *  and the longest-first sort puts "rcd type" ahead). */
function matchFieldPrefix(text: string): { phrase: string; rest: string } | null {
  const lower = text.toLowerCase();
  for (const phrase of APPLY_FIELD_PHRASES) {
    if (lower.startsWith(phrase + ' ') || lower === phrase) {
      const rest = lower.slice(phrase.length).trimStart();
      return { phrase, rest };
    }
  }
  return null;
}

/** Match a scope phrase at the END of `text`. Returns the parsed
 *  scope + the text BEFORE the scope clause, or null if no scope is
 *  found. Handles the canonical iOS-supported scopes — all / single /
 *  range — and tolerates trailing punctuation. */
function matchTrailingScope(text: string): { scope: VoiceCommandScope; before: string } | null {
  const trimmed = text
    .trim()
    .replace(/[.,!?]+$/, '')
    .trimEnd();
  // Try longest scopes first so "for circuits N to M" doesn't get
  // prefix-eaten by "for circuit N".
  const patterns: Array<{ re: RegExp; scope: (m: RegExpExecArray) => VoiceCommandScope }> = [
    {
      re: /^(.*?)\s+for\s+circuits?\s+(\d+)\s+to\s+(\d+)$/i,
      scope: (m) => ({ kind: 'range', from: Number(m[2]), to: Number(m[3]) }),
    },
    {
      re: /^(.*?)\s+for\s+all(?:\s+circuits)?$/i,
      scope: () => ({ kind: 'all' }),
    },
    {
      re: /^(.*?)\s+for\s+circuits?\s+(\d+)$/i,
      scope: (m) => ({ kind: 'single', circuit: Number(m[2]) }),
    },
  ];
  for (const { re, scope: scopeOf } of patterns) {
    const m = re.exec(trimmed);
    if (m) {
      const before = (m[1] ?? '').trim();
      return { scope: scopeOf(m), before };
    }
  }
  return null;
}

/**
 * Parse an apply-field intent. Two grammars, both iOS-canon:
 *   1. "<field> <value> for <scope>" — value comes BEFORE the scope.
 *   2. "<field> for <scope> is <value>" — the Deepgram-garble shape
 *      iOS observed at 14 The Farm Close Road
 *      (VoiceCommandExecutor.swift:749).
 *
 * Field detection uses longest-prefix-match against the alias
 * dictionary — that's the only reliable way to disambiguate
 * "RCD test button" from "RCD" without hardcoding a regex per phrase.
 * Field-write-only commands (the supply/installation aliases) are
 * rejected here so the inspector hears a clear error rather than a
 * silent no-op; supply fields take a different command shape.
 */
/** Core apply-field shape matcher (both grammars), operating on already
 *  spare-modifier-stripped text. Extracted so the sparePolicy/contradiction
 *  wrapper below can share it — the contradiction path only fires when
 *  the CLEANED text still parses as a genuine apply-field command (avoids
 *  misfiring on unrelated sentences that happen to mention both spare
 *  directions). */
function parseApplyFieldShape(
  stripped: string
): Extract<VoiceCommand, { type: 'apply_field' }> | null {
  // Shape 2: "<field> for <scope> is <value>".
  // Search for " for ... is ..." inside the input, then split at " is ".
  const isPattern =
    /^(.+?)\s+for\s+((?:all(?:\s+circuits)?|circuits?\s+\d+(?:\s+to\s+\d+)?))\s+is\s+(.+?)\s*\.?$/i;
  const isMatch = isPattern.exec(stripped);
  if (isMatch) {
    const fieldPhrase = (isMatch[1] ?? '').trim();
    const scopeText = (isMatch[2] ?? '').trim();
    const fieldHit = matchFieldPrefix(fieldPhrase);
    // PLAN-C — resolve the FIELD before cleaning the value; `cleanValue`
    // mangles closed-enum values when it doesn't know the field.
    const value = cleanValue(
      (isMatch[3] ?? '').trim(),
      fieldHit ? CIRCUIT_FIELD_ALIASES[fieldHit.phrase] : undefined
    );
    const scope = parseScopeText(scopeText);
    if (fieldHit && fieldHit.rest === '' && value && scope) {
      return { type: 'apply_field', field: fieldHit.phrase, value, scope };
    }
  }

  // Shape 1: "<field> <value> for <scope>".
  // Step 1: peel off the trailing scope. Step 2: longest-alias-match
  // on the prefix; whatever's left between the alias and the scope
  // clause is the value.
  const trail = matchTrailingScope(stripped);
  if (trail) {
    const fieldHit = matchFieldPrefix(trail.before);
    if (fieldHit && fieldHit.rest.length > 0) {
      const value = cleanValue(fieldHit.rest, CIRCUIT_FIELD_ALIASES[fieldHit.phrase]);
      if (value) {
        return {
          type: 'apply_field',
          field: fieldHit.phrase,
          value,
          scope: trail.scope,
        };
      }
    }
  }
  return null;
}

function parseApplyField(transcript: string): VoiceCommand | null {
  const lower = transcript.trim().toLowerCase();
  // Strip an optional leading "set " — iOS-style "set polarity correct
  // for all circuits" should land here, not in UPDATE_FIELD_RE.
  const stripped = lower.startsWith('set ') ? lower.slice(4) : lower;

  // PLAN-F item 1 (2026-08-12, feedback id 115) — strip a spoken spare
  // modifier BEFORE shape-matching so "including spares"/"excluding
  // spares" doesn't get swallowed into the value or field phrase. Parse
  // the CLEANED text through the normal shapes first; only THEN decide
  // whether to attach sparePolicy or emit the contradiction command —
  // this way a coincidental "including"/"excluding" near "spares" in an
  // utterance that doesn't otherwise parse as apply-field never misfires.
  const spareInfo = extractSparePolicy(stripped);
  const base = parseApplyFieldShape(spareInfo.cleaned);
  if (!base) return null;
  if (spareInfo.contradictory) {
    return { type: 'apply_field_contradiction' };
  }
  if (spareInfo.policy) {
    return { ...base, sparePolicy: spareInfo.policy };
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────
// PLAN-F item 1 (2026-08-12, feedback id 115) — spare-inclusion classifier
// + predicate. DEVICE_ATTRIBUTE_FIELDS is the UNION of field_schema.json's
// OCPD and RCD field_groups (8 fields) — MUST stay in sync with backend
// device-attribute-fields.js and iOS's DeviceAttributeFields.swift (each
// carries its own generated/pinned drift assertion against the schema).
// ─────────────────────────────────────────────────────────────────────────

// Codex diff-review r1 (wire-contract lens) — exported so a test can assert
// this set directly against config/field_schema.json's live OCPD+RCD union,
// the same drift-assertion contract backend's device-attribute-fields.js
// carries. Without this export only the backend classifier was checked
// against the live schema; the web copy could drift silently.
export const DEVICE_ATTRIBUTE_FIELDS = new Set<string>([
  'ocpd_bs_en',
  'ocpd_type',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ocpd_max_zs_ohm',
  'rcd_bs_en',
  'rcd_type',
  'rcd_operating_current_ma',
]);

/** Spare-detection predicate, aligned to the backend's semantics: regex
 *  `(?<!-)\bspare\b` on the designation, plus empty-designation = spare
 *  by convention (blank-row circuits in the schedule). No `is_spare`
 *  flag needed — the web CircuitRow always carries `circuit_designation`.
 *  Sync-is-social: mirrors backend stage6-dispatchers-circuit.js's spare
 *  regex and iOS's exact-designation predicate. */
const SPARE_DESIGNATION_RE = /(?<!-)\bspare\b/i;
function isSpareCircuit(row: VoiceCommandCircuit): boolean {
  const designation = String(row.circuit_designation ?? '').trim();
  return designation === '' || SPARE_DESIGNATION_RE.test(designation);
}

type ResolvedSparePolicy = 'include' | 'exclude';

/** Resolution rule — mirrors the backend's resolveSparePolicy exactly:
 *  an explicit include/exclude always wins; otherwise the family-aware
 *  automatic default (device-attribute → include, else → exclude). Web
 *  has no scope:'all' vs scope:'non_spare' distinction (the PWA's
 *  VoiceCommandScope has no such selector), so there is no passthrough
 *  carve-out to preserve here — every 'all'-scope apply/calculate goes
 *  through this one resolution path. */
function resolveSparePolicy(
  sparePolicyInput: 'automatic' | 'include' | 'exclude' | undefined,
  fieldName: string | undefined
): ResolvedSparePolicy {
  if (sparePolicyInput === 'include') return 'include';
  if (sparePolicyInput === 'exclude') return 'exclude';
  if (fieldName && DEVICE_ATTRIBUTE_FIELDS.has(fieldName)) return 'include';
  return 'exclude';
}

// Contradiction detection + modifier stripping for the apply-field parser.
// Codex diff-review r1 (silent-path lens) — "not including spares" matched
// BOTH regexes independently (the exclude alternation's "not\s+including"
// AND the include regex's bare "including spares" substring), so a single
// exclude-shaped instruction was misclassified as a self-contradiction and
// silently refused. The negative lookbehind makes the two patterns
// mutually exclusive on this phrase.
const SPARE_INCLUDE_RE = /(?<!not\s)\b(?:including|include|with)\s+(?:the\s+)?spares?\b/i;
const SPARE_EXCLUDE_RE =
  /\b(?:excluding|exclude|except|not\s+including|without)\s+(?:the\s+)?spares?(?:\s+ways?)?\b/i;

function extractSparePolicy(text: string): {
  policy: 'include' | 'exclude' | null;
  contradictory: boolean;
  cleaned: string;
} {
  const hasInclude = SPARE_INCLUDE_RE.test(text);
  const hasExclude = SPARE_EXCLUDE_RE.test(text);
  // Strip a leftover connective ("...including spares BUT excluding
  // spares...") between the two removed phrases — otherwise the stray
  // "but"/"and" breaks the trailing-scope regex match on the cleaned text.
  //
  // Codex diff-review cycle 2 (PLAN-F2 finding 2, 2026-08-14) — a stray
  // COMMA is the same class of problem: the plan's own canonical phrasing
  // is "circuits 3 to 5, excluding spares" (comma before the modifier).
  // Removing only the modifier phrase left "circuits 3 to 5," — the
  // trailing comma then broke parseApplyFieldShape's anchored `\s*\.?$`
  // regex (it tolerates an optional trailing PERIOD, never a comma), so
  // the range+modifier utterance silently fell through to Sonnet instead
  // of composing deterministically — the exact feature Decision 1
  // describes was unreachable for its own worked example. This grammar is
  // a narrow, constrained apply-field mini-language (field + value + scope
  // + optional spare modifier) where a comma never legitimately appears
  // for any other reason, so a global strip is safe.
  const cleaned = text
    .replace(SPARE_INCLUDE_RE, '')
    .replace(SPARE_EXCLUDE_RE, '')
    .replace(/\s+\b(?:but|and)\b\s+/gi, ' ')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (hasInclude && hasExclude) return { policy: null, contradictory: true, cleaned };
  if (hasInclude) return { policy: 'include', contradictory: false, cleaned };
  if (hasExclude) return { policy: 'exclude', contradictory: false, cleaned };
  return { policy: null, contradictory: false, cleaned: text };
}

// ─────────────────────────────────────────────────────────────────────────
// Applier — takes a parsed command + current job, produces a patch.
// Pure; never mutates the input.
// ─────────────────────────────────────────────────────────────────────────

/** Human-readable field phrase → canonical form for response strings. */
function labelForField(field: string): string {
  const map: Record<string, string> = {
    measured_zs_ohm: 'Zs',
    r1_r2_ohm: 'R1 plus R2',
    r2_ohm: 'R2',
    ir_live_earth_mohm: 'insulation resistance live-earth',
    ir_live_live_mohm: 'insulation resistance live-live',
    ir_test_voltage_v: 'insulation test voltage',
    rcd_time_ms: 'RCD trip time',
    rcd_rating_a: 'RCD rating',
    rcd_type: 'RCD type',
    rcd_operating_current_ma: 'RCD operating current',
    rcd_button_confirmed: 'RCD test button',
    afdd_button_confirmed: 'AFDD test button',
    ocpd_rating_a: 'OCPD rating',
    ocpd_type: 'OCPD type',
    ocpd_bs_en: 'OCPD BS EN',
    ocpd_breaking_capacity_ka: 'OCPD breaking capacity',
    ocpd_max_zs_ohm: 'OCPD maximum Zs',
    rcd_bs_en: 'RCD BS EN',
    polarity_confirmed: 'polarity',
    live_csa_mm2: 'cable size',
    cpc_csa_mm2: 'CPC size',
    circuit_designation: 'designation',
    wiring_type: 'wiring type',
    ref_method: 'reference method',
    max_disconnect_time_s: 'maximum disconnect time',
    number_of_points: 'number of points',
    ze: 'Ze',
    pfc: 'PFC',
    earthing_arrangement: 'earthing arrangement',
    bonding_water: 'water bonding',
    bonding_gas: 'gas bonding',
    bonding_oil: 'oil bonding',
    bonding_structural_steel: 'structural steel bonding',
    bonding_lightning: 'lightning protection bonding',
    main_bonding_continuity: 'main bonding continuity',
  };
  return map[field] ?? field.replace(/_/g, ' ');
}

function respondUnknown(reason: string): VoiceCommandOutcome {
  return { response: reason, actionOutcome: 'unsupported', actionReason: reason };
}

/**
 * PLAN-C (feedback id 129) — validate-or-ask on the six closed-enum
 * circuit fields, run ONCE per command at the write boundary.
 *
 * Placement matters and is deliberate: this runs BEFORE scope resolution
 * and before any per-circuit iteration, never inside the row writer. A
 * per-row guard on a 20-circuit `apply_field` would either speak twenty
 * identical re-asks or write nineteen bad rows before noticing; the value
 * is a property of the COMMAND, so it is judged once and the command
 * either proceeds whole or mutates nothing at all.
 *
 * Backend Stage-6 has enforced exactly this for a long time
 * (`src/extraction/stage6-dispatch-validation.js:99` / `:198`). The two
 * CLIENT mirrors — this one and iOS `VoiceCommandExecutor` — wrote
 * whatever they were handed, so a Flux garble ("for" heard as a wiring
 * type, "MCB" as an OCPD standard) landed silently in a legally
 * significant certificate. `unknown_field` cannot occur below (the
 * `isGuardedClosedEnumField` gate has already passed) but is still
 * routed to a rejection rather than a write: fail closed.
 */
function guardOcpdStandardWrite(rawValue: unknown, target: GuardedTarget): ClosedEnumGuardResult {
  const raw = typeof rawValue === 'string' ? rawValue : '';
  const cleaned = cleanClosedEnumResidue(raw);
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
    return {
      kind: 'rejected',
      outcome: {
        response: renderClosedEnumReask('ocpd_bs_en', 'missing_value', '', target),
        invalidClosedEnum: true,
      },
    };
  }
  const canonical = canonicaliseOcpdStandard(rawValue);
  if (canonical == null) {
    const reason: ClosedEnumReaskReason =
      cleaned === '' && typeof rawValue === 'string' ? 'missing_value' : 'invalid_value';
    return {
      kind: 'rejected',
      outcome: {
        response: renderClosedEnumReask('ocpd_bs_en', reason, cleaned, target),
        invalidClosedEnum: true,
      },
    };
  }
  if (target.kind === 'unknown') {
    return {
      kind: 'rejected',
      outcome: {
        response: renderClosedEnumReask('ocpd_bs_en', 'missing_target', canonical, target),
        invalidClosedEnum: true,
      },
    };
  }
  return {
    kind: 'accepted',
    value: canonical,
    canonicalised: !(typeof rawValue === 'string' && rawValue === canonical),
  };
}

type ClosedEnumGuardResult =
  | { kind: 'not_guarded' }
  | { kind: 'accepted'; value: string; canonicalised: boolean }
  | { kind: 'rejected'; outcome: VoiceCommandOutcome };

function guardClosedEnumWrite(
  canonicalField: string,
  rawValue: unknown,
  target: GuardedTarget
): ClosedEnumGuardResult {
  // PLAN-CC — `ocpd_bs_en` sits BESIDE the closed-enum branch rather than
  // inside it. The field accepts any grammar-valid standard, so there is no
  // option set to test membership against; what can still fail is the
  // canonicaliser, and a MISS is judged exactly like an invalid enum value:
  // once per command, nothing written, one spoken re-ask through the SAME
  // renderer so the sentence is byte-identical to the one this field has
  // always spoken. The missing-target, zero-applied, stored-value-speech and
  // failure flags below are shared verbatim.
  if (canonicalField === 'ocpd_bs_en') {
    return guardOcpdStandardWrite(rawValue, target);
  }
  if (!isGuardedClosedEnumField(canonicalField)) return { kind: 'not_guarded' };
  const guarded = canonicalField as GuardedClosedEnumField;
  const outcome = canonicaliseClosedEnumValue(guarded, rawValue);

  const reask = reaskForClosedEnumOutcome(outcome, target);
  if (reask) {
    return { kind: 'rejected', outcome: { response: reask, invalidClosedEnum: true } };
  }
  if (outcome.kind !== 'valid') {
    return {
      kind: 'rejected',
      outcome: {
        response: renderClosedEnumReask(guarded, 'missing_value', '', target),
        invalidClosedEnum: true,
      },
    };
  }

  // Structurally complete VALUE, structurally absent TARGET. Audio-First
  // §2 asks only for structural gaps — this is one, and writing "wiring
  // type A" to nothing at all while speaking a success line would be the
  // silent-drop failure inverted.
  if (target.kind === 'unknown') {
    return {
      kind: 'rejected',
      outcome: {
        response: renderClosedEnumReask(guarded, 'missing_target', outcome.value, target),
        invalidClosedEnum: true,
      },
    };
  }

  return {
    kind: 'accepted',
    value: outcome.value,
    // The inspector must hear what was STORED, not what they said, on any
    // turn where the two differ ("60898" → "BS EN 60898").
    canonicalised: !(typeof rawValue === 'string' && rawValue === outcome.value),
  };
}

export function applyVoiceCommand(
  command: VoiceCommand,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  let outcome: VoiceCommandOutcome;
  switch (command.type) {
    case 'update_field':
      outcome = applyUpdateField(command, job);
      break;
    case 'reorder_circuits':
      outcome = applyReorderCircuits(command, job);
      break;
    case 'query_field':
      outcome = applyQueryField(command, job);
      break;
    case 'calculate_impedance':
      outcome = applyCalculateImpedance(command, job);
      break;
    case 'apply_field':
      outcome = applyApplyField(command, job);
      break;
    case 'add_circuit':
      outcome = applyAddCircuit(command, job);
      break;
    case 'apply_field_contradiction':
      // PLAN-F item 1, Decision 3 — consumed locally: speak a deterministic
      // refusal, no patch (nothing mutates), never forwarded to the server.
      outcome = {
        response:
          'I heard contradictory spare instructions — please say either including or excluding spares, not both.',
        actionOutcome: 'failed',
      };
      break;
    default: {
      // Exhaustiveness — TypeScript will flag a missing branch at compile
      // time; the runtime guard is belt-and-braces for hand-edited JSON.
      const never: never = command;
      void never;
      outcome = respondUnknown("I didn't understand that command.");
      break;
    }
  }
  if (command.type === 'query_field' || outcome.actionOutcome) return outcome;
  return {
    ...outcome,
    actionOutcome: outcome.patch ? 'applied' : 'unapplied',
  };
}

function applyUpdateField(
  command: Extract<VoiceCommand, { type: 'update_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const hasCircuit = command.circuit != null;
  const resolved = resolveField(command.field, hasCircuit);
  if (!resolved) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }

  // PLAN-C — validate the closed-enum value ONCE, before the circuit is
  // even looked up. A positive integer circuit reference is the only
  // structurally complete single-circuit target; anything else (absent,
  // zero, negative, non-finite) is a missing target, NOT a reason to
  // silently route the write into the supply branch.
  let guardedValue: string | null = null;
  let guardedCanonicalised = false;
  if (resolved.circuitField && isValueCheckedCircuitField(resolved.circuitField)) {
    const circuitRef = command.circuit;
    const target: GuardedTarget =
      // `Number.isInteger` (Codex cycle 1) — the comment above always said
      // "positive INTEGER"; the code only checked finiteness, so a wire
      // `circuit: 3.5` built a `single` target, missed every row, and
      // reached the not-found branch. A fractional circuit reference is a
      // structurally absent target, not a target that happens to be empty.
      typeof circuitRef === 'number' && Number.isInteger(circuitRef) && circuitRef >= 1
        ? { kind: 'single', circuit: circuitRef }
        : { kind: 'unknown' };
    const guard = guardClosedEnumWrite(resolved.circuitField, command.value, target);
    if (guard.kind === 'rejected') return guard.outcome;
    if (guard.kind === 'accepted') {
      guardedValue = guard.value;
      guardedCanonicalised = guard.canonicalised;
    }
  }

  // Per-circuit update
  if (hasCircuit && resolved.circuitField) {
    const ref = String(command.circuit);
    const circuits = job.circuits ?? [];
    const idx = circuits.findIndex(
      (c) => c.circuit_ref === ref || c.number === ref || c.id === ref
    );
    if (idx === -1) {
      const missing = respondUnknown(`Circuit ${command.circuit} doesn't exist.`);
      // PLAN-C (Codex cycle 1) — flag it so the speak seam prefers this
      // truthful line over the server's success text. Only for the guarded
      // columns: this plan owns those six, and widening the flag to every
      // circuit field would change the spoken outcome of ~20 fields no plan
      // has reviewed.
      return guardedValue != null ? { ...missing, guardedWriteFailed: true } : missing;
    }
    // Normalise polarity_confirmed — inspectors dictate "pass"/"fail";
    // iOS converts to the ✓/✗ sigils used everywhere else in the app.
    let value: string = command.value;
    if (resolved.circuitField === 'polarity_confirmed') {
      if (value === 'PASS') value = '✓';
      else if (value === 'FAIL') value = '✗';
    }
    // PLAN-B2 — designation hygiene, canonicalised ONCE at command entry.
    // Repair semantics (never reject/blank: banned-token-only stays as
    // dictated — empty designation = spare). The canonical value is
    // threaded to the mutation and spoken response below: cleaned
    // storage + raw speech would leave the hands-free inspector hearing
    // a value the certificate doesn't carry.
    if (resolved.circuitField === 'circuit_designation') {
      value = repairCircuitDesignation(command.value) as string;
    }
    // PLAN-C — the canonical option is what gets STORED, so it is also
    // what gets SPOKEN. Same storage-and-speech-from-one-value discipline
    // PLAN-B2 established for designations directly above.
    if (guardedValue != null) {
      value = guardedValue;
    }
    // PLAN-CC (write path 7 / M3) — the ONE manual-boundary commit route. The
    // bare `{ ...row, [field]: value }` spread this replaces recomputed
    // nothing, so a dictated standard, type, rating or disconnect-time change
    // left the PREVIOUS device's max Zs on the certificate; and a dictated max
    // Zs kept whatever source the row already had, so the next tuple change
    // could recompute the inspector's own correction away.
    const next: VoiceCommandCircuit[] = circuits.map((row, i) =>
      i === idx
        ? (applyOcpdAwarePatch(
            row as Record<string, unknown>,
            { [resolved.circuitField as string]: value },
            canonicaliseOcpdStandardForImport
          ) as VoiceCommandCircuit)
        : row
    );
    const label = labelForField(resolved.circuitField);
    return {
      patch: { circuits: next },
      response: `Set ${label} to ${value} on circuit ${command.circuit}.`,
      appliedResults: [{ circuit: command.circuit as number, field: resolved.circuitField, value }],
      changedKeys: [resolved.circuitField as string],
      ...(guardedCanonicalised ? { canonicalSuccess: true } : {}),
    };
  }

  // Supply / installation update
  if (resolved.supplyRoute) {
    const { section, field } = resolved.supplyRoute;
    const existing = (job[section] as Record<string, unknown> | undefined) ?? {};
    const patch: Record<string, unknown> = {
      [section]: { ...existing, [field]: command.value },
    };
    const label = labelForField(field);
    return {
      patch,
      response: `Set ${label} to ${command.value}.`,
      appliedResults: [{ circuit: 0, field, value: command.value }],
      changedKeys: [field],
    };
  }

  return respondUnknown(`I don't know where "${command.field}" belongs.`);
}

function applyReorderCircuits(
  command: Extract<VoiceCommand, { type: 'reorder_circuits' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const circuits = [...(job.circuits ?? [])];
  const fromRef = String(command.from);
  const fromIdx = circuits.findIndex((c) => c.circuit_ref === fromRef || c.number === fromRef);
  if (fromIdx === -1) {
    return respondUnknown(`Circuit ${command.from} doesn't exist.`);
  }
  const target = Math.min(Math.max(command.to - 1, 0), circuits.length - 1);
  if (target === fromIdx) {
    return { response: `Circuit ${command.from} is already at position ${command.to}.` };
  }
  const [moved] = circuits.splice(fromIdx, 1);
  circuits.splice(target, 0, moved);
  // Renumber sequentially — mirrors iOS `renumberCircuitRefs`.
  const renumbered: VoiceCommandCircuit[] = circuits.map((row, i) => ({
    ...row,
    circuit_ref: String(i + 1),
    number: String(i + 1),
  }));
  return {
    patch: { circuits: renumbered },
    // iOS canon: "Moved to circuit N" (AlertManager.swift:581) — the
    // shorter phrasing reads more naturally over TTS than the verbose
    // "Moved circuit X to position Y." Pre-fix the PWA used the
    // verbose form; aligned here so both clients speak the same line.
    response: `Circuit ${command.from} moved to circuit ${command.to}.`,
    appliedResults: [{ circuit: command.from, field: 'circuit_ref', value: String(command.to) }],
    changedKeys: ['circuits'],
  };
}

function applyQueryField(
  command: Extract<VoiceCommand, { type: 'query_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const hasCircuit = command.circuit != null;
  const resolved = resolveField(command.field, hasCircuit);
  if (!resolved) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }
  if (hasCircuit && resolved.circuitField) {
    const ref = String(command.circuit);
    const row = (job.circuits ?? []).find((c) => c.circuit_ref === ref || c.number === ref);
    if (!row) {
      return respondUnknown(`Circuit ${command.circuit} doesn't exist.`);
    }
    const value = row[resolved.circuitField as string];
    const label = labelForField(resolved.circuitField);
    if (value == null || value === '') {
      return { response: `${label} on circuit ${command.circuit} is not set.` };
    }
    return { response: `${label} on circuit ${command.circuit} is ${String(value)}.` };
  }
  if (resolved.supplyRoute) {
    const { section, field } = resolved.supplyRoute;
    const value = (job[section] as Record<string, unknown> | undefined)?.[field];
    const label = labelForField(field);
    if (value == null || value === '') return { response: `${label} is not set.` };
    return { response: `${label} is ${String(value)}.` };
  }
  return respondUnknown(`I couldn't find ${command.field}.`);
}

// ─────────────────────────────────────────────────────────────────────────
// Calculate impedance + apply-field (batch). Mirrors iOS
// VoiceCommandExecutor.executeCalculateImpedance / executeApplyField
// (lines 314 + 399). Both use resolveCircuitScope semantics: read Ze
// from supply, fan a single (field, value) across the resolved set,
// report the count via the spoken response.
// ─────────────────────────────────────────────────────────────────────────

/** PLAN-F item 1 (2026-08-12, feedback id 115) — `spareFilter` is threaded
 *  from the caller's field identity so the 'all' branch can resolve the
 *  family-aware spare default. `applyCalculateImpedance` passes NO
 *  `fieldName` (always resolves to 'exclude' — calculate_zs/r1_r2 are
 *  reading fields with no ambiguity, unaffected by this plan). This is
 *  NEW exclusion logic for 'all' scope that did not exist before — web
 *  previously included every circuit at this layer and relied on
 *  downstream numeric checks (spares have no R1+R2/Zs, so a spare row
 *  silently no-opped further down); now the exclusion is explicit, which
 *  is what makes the audible-skip count meaningful. */
function indicesForScope(
  scope: VoiceCommandScope,
  circuits: VoiceCommandCircuit[],
  spareFilter?: { fieldName?: string; sparePolicy?: 'automatic' | 'include' | 'exclude' }
): { indices: number[]; spareSkippedCount: number } {
  if (circuits.length === 0) return { indices: [], spareSkippedCount: 0 };
  if (scope.kind === 'all') {
    const effectivePolicy = resolveSparePolicy(spareFilter?.sparePolicy, spareFilter?.fieldName);
    const indices: number[] = [];
    let spareSkippedCount = 0;
    circuits.forEach((row, i) => {
      if (effectivePolicy === 'exclude' && isSpareCircuit(row)) {
        spareSkippedCount += 1;
        return;
      }
      indices.push(i);
    });
    return { indices, spareSkippedCount };
  }
  // single/range — an explicitly-named circuit is never spare-filtered
  // BY DEFAULT, matching the backend (the spare filter only applies to the
  // bulk 'all' candidate set UNLESS the inspector spoke a modifier).
  //
  // PLAN-F2 finding 2 (2026-08-14, Derek decision 1) — a SPOKEN spare
  // modifier now COMPOSES with single/range scope too: "circuits 3 to 5,
  // excluding spares" filters the spare out of the explicit range AND the
  // caller discloses the skip (skipClause, already scope-agnostic — see
  // applyApplyField below). Modifier ABSENT keeps today's behaviour
  // (explicitly-named circuits are never spare-filtered). Modifier PRESENT
  // as 'include' is a no-op here — single/range never filters unless the
  // policy is 'exclude', so there's nothing to disclose either way.
  const excludeSpares = spareFilter?.sparePolicy === 'exclude';
  if (scope.kind === 'single') {
    const ref = String(scope.circuit);
    const idx = circuits.findIndex((c) => c.circuit_ref === ref || c.number === ref);
    if (idx < 0) return { indices: [], spareSkippedCount: 0 };
    if (excludeSpares && isSpareCircuit(circuits[idx])) {
      return { indices: [], spareSkippedCount: 1 };
    }
    return { indices: [idx], spareSkippedCount: 0 };
  }
  // range
  const fromRef = String(scope.from);
  const toRef = String(scope.to);
  const fromIdx = circuits.findIndex((c) => c.circuit_ref === fromRef || c.number === fromRef);
  const toIdx = circuits.findIndex((c) => c.circuit_ref === toRef || c.number === toRef);
  if (fromIdx < 0 || toIdx < 0) return { indices: [], spareSkippedCount: 0 };
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  const out: number[] = [];
  let spareSkippedCount = 0;
  for (let i = lo; i <= hi; i++) {
    if (excludeSpares && isSpareCircuit(circuits[i])) {
      spareSkippedCount += 1;
      continue;
    }
    out.push(i);
  }
  return { indices: out, spareSkippedCount };
}

/**
 * Format an impedance value (ohms) the same way iOS's
 * `formatImpedance` does in VoiceCommandExecutor — 2 decimal places,
 * no trailing-zero stripping (Sonnet's CCU pipeline reads raw strings).
 */
function formatImpedance(value: number): string {
  return value.toFixed(2);
}

/** A01P — why the local calculator left a selected row alone. Mirrors the
 *  backend calculators' skip taxonomy (stage6-dispatchers-circuit.js). */
export type CalculateSkipReason = 'already_set' | 'no_r1_r2' | 'no_zs' | 'zs_below_ze';

function circuitScope(refs: Array<number | string>): string {
  return refs.length === 1
    ? `circuit ${refs[0]}`
    : `circuits ${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
}

/** Spoken reason for ONE skip reason. */
function missingInputPhrase(reason: CalculateSkipReason): string {
  switch (reason) {
    case 'no_r1_r2':
      return 'no R1 plus R2';
    case 'no_zs':
      return 'no Zs';
    case 'zs_below_ze':
      return 'a Zs below Ze';
    default:
      return 'no usable values';
  }
}

/**
 * Codex EP cycle-3 — the unusable rows are GROUPED BY REASON so a mixed
 * R1+R2 command never collapses "no Zs" and "a Zs below Ze" into one clause
 * (a row with a Zs below Ze DOES have a Zs). Reason order is the taxonomy
 * order; circuits keep their command order within each group.
 */
function unusableClauses(
  unusable: Array<{ circuit: number | string; reason: CalculateSkipReason }>
): string {
  const order: CalculateSkipReason[] = ['no_r1_r2', 'no_zs', 'zs_below_ze'];
  const clauses: string[] = [];
  for (const reason of order) {
    const refs = unusable.filter((s) => s.reason === reason).map((s) => s.circuit);
    if (refs.length === 0) continue;
    clauses.push(
      `${circuitScope(refs)} ${refs.length === 1 ? 'has' : 'have'} ${missingInputPhrase(reason)} to calculate from`
    );
  }
  return clauses.join(', and ');
}

/** Genuinely absent Ze — every ladder tier blank (existing no-Ze wording). */
export const NO_ZE_RESPONSE = "I can't calculate that — no zed E value has been set yet.";
/** DictatedReadbackPolicyV1 `strings.ze_unreadable` (config/dictated-readback-policy-v1.json). */
const ZE_UNREADABLE_RESPONSE = 'I couldn’t apply that calculation.';

function applyCalculateImpedance(
  command: Extract<VoiceCommand, { type: 'calculate_impedance' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const circuits = [...(job.circuits ?? [])];
  // No fieldName passed — calculate_zs/r1_r2 are reading fields, always
  // spare-excluded (unaffected by this plan; see indicesForScope's doc).
  const { indices } = indicesForScope(command.scope, circuits);
  if (indices.length === 0) {
    return respondUnknown('No circuits found in the specified range.');
  }
  // A01P — resolve Ze exactly once for the JOB through the real job keys
  // (`boards[]` / `board_info` / `supply_characteristics`), never through a
  // circuit anchor and never through the unpopulated singular `supply` bag
  // that caused the original bug. Three states, parse-once, no fall-through
  // from an occupied-but-invalid tier (mirrors iOS `findZe`).
  const ze = resolveJobZe(job as JobZeLike);
  if (ze.state === 'multi_board') {
    // The caller forwards multi-board Calculates before reaching here; this
    // is the truthful terminal if it ever does not.
    return {
      response: ZE_UNREADABLE_RESPONSE,
      actionOutcome: 'unsupported',
      actionReason: 'multi_board',
    };
  }
  if (ze.state === 'absent') {
    return respondUnknown(NO_ZE_RESPONSE);
  }
  if (ze.state === 'unreadable') {
    // DictatedReadbackPolicyV1 `strings.ze_unreadable` — spoken exactly once
    // by the caller's FIFO; a recorded LIM / N/A is never narrated as "no Ze".
    return {
      response: ZE_UNREADABLE_RESPONSE,
      actionOutcome: 'unsupported',
      actionReason: 'ze_unreadable',
    };
  }
  const zeNum = ze.value;
  const appliedResults: Array<{ circuit: number | string; field: string; value: string }> = [];
  // Codex cycle-1 BLOCKER — a meter reading always wins. Mirrors the backend
  // calculators' `already_set` skip (stage6-dispatchers-circuit.js): a row
  // whose DESTINATION field is already occupied (a number, LIM, N/A — any
  // non-blank value) is never overwritten by a derived value, in single,
  // range and all scopes alike; the empty rows in the same command still
  // fill. The read-back names only what was actually written.
  const skipped: Array<{ circuit: number | string; reason: CalculateSkipReason }> = [];
  const refOf = (row: VoiceCommandCircuit, idx: number): string =>
    String(row.circuit_ref ?? row.number ?? idx + 1);
  const destination = command.kind === 'zs' ? 'measured_zs_ohm' : 'r1_r2_ohm';
  const next = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    if (String(row[destination] ?? '').trim() !== '') {
      skipped.push({ circuit: refOf(row, idx), reason: 'already_set' });
      return row;
    }
    if (command.kind === 'zs') {
      // Zs = Ze + R1+R2
      const r1r2Str = row.r1_r2_ohm;
      const r1r2 = Number(r1r2Str);
      if (String(r1r2Str ?? '').trim() === '' || !Number.isFinite(r1r2)) {
        skipped.push({ circuit: refOf(row, idx), reason: 'no_r1_r2' });
        return row;
      }
      const zs = zeNum + (r1r2 as number);
      const value = formatImpedance(zs);
      appliedResults.push({
        circuit: String(row.circuit_ref ?? row.number ?? idx + 1),
        field: 'measured_zs_ohm',
        value,
      });
      return { ...row, measured_zs_ohm: value };
    }
    // r1_r2 = Zs - Ze
    const zsStr = row.measured_zs_ohm;
    const zs = Number(zsStr);
    if (String(zsStr ?? '').trim() === '' || !Number.isFinite(zs)) {
      skipped.push({ circuit: refOf(row, idx), reason: 'no_zs' });
      return row;
    }
    const r1r2 = (zs as number) - zeNum;
    if (r1r2 < 0) {
      skipped.push({ circuit: refOf(row, idx), reason: 'zs_below_ze' });
      return row;
    }
    const value = formatImpedance(r1r2);
    appliedResults.push({
      circuit: String(row.circuit_ref ?? row.number ?? idx + 1),
      field: 'r1_r2_ohm',
      value,
    });
    return { ...row, r1_r2_ohm: value };
  });
  const label = command.kind === 'zs' ? 'Zs' : 'R1 plus R2';
  if (appliedResults.length === 0) {
    const occupied = skipped.filter((s) => s.reason === 'already_set').map((s) => s.circuit);
    const unusable = skipped.filter((s) => s.reason !== 'already_set');
    if (occupied.length > 0 && unusable.length === 0) {
      // EVERY selected row already carries a measured value — the honest
      // outcome is the backend's own "already recorded" line (the backend
      // emits it only when every skip reason is already_set), never a
      // fabricated success and never silence (A04P truthful outcomes).
      return {
        response: `${label} for ${circuitScope(occupied)} is already recorded — ${
          occupied.length === 1
            ? 'say a new reading to replace it.'
            : 'say new readings to replace them.'
        }`,
        actionOutcome: 'unapplied',
        actionReason: 'already_set',
        skippedResults: skipped,
      };
    }
    if (occupied.length > 0) {
      // Codex EP cycle-2 — a zero-write command with MIXED reasons names
      // both: the occupied rows AND the rows that could not be calculated.
      // Silencing either half would misreport what happened.
      return {
        response:
          `${label} for ${circuitScope(occupied)} is already recorded, and ` +
          `${unusableClauses(unusable)}.`,
        actionOutcome: 'unapplied',
        actionReason: 'mixed_skips',
        skippedResults: skipped,
      };
    }
    return {
      response: `No circuits had the values needed to calculate ${label}.`,
      ...(skipped.length > 0 ? { skippedResults: skipped } : {}),
    };
  }
  const groups = new Map<string, Array<number | string>>();
  for (const item of appliedResults) {
    const refs = groups.get(item.value) ?? [];
    refs.push(item.circuit);
    groups.set(item.value, refs);
  }
  const response = [...groups.entries()]
    .map(([value, refs]) => {
      const scope =
        refs.length === 1
          ? `Circuit ${refs[0]}`
          : `Circuits ${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
      return `${scope}, ${label} calculated as ${value} ohms`;
    })
    .join('. ');
  return {
    patch: { circuits: next },
    response,
    actionOutcome: 'applied',
    appliedResults,
    ...(skipped.length > 0 ? { skippedResults: skipped } : {}),
    changedKeys: command.kind === 'zs' ? ['measured_zs_ohm'] : ['r1_r2_ohm'],
  };
}

function applyApplyField(
  command: Extract<VoiceCommand, { type: 'apply_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  // Apply-field always targets per-circuit fields (iOS's executeApplyField
  // never writes supply/installation — those have a different command
  // shape). Reject supply-only fields up front so the inspector hears a
  // clear error rather than a silent no-op.
  const resolved = resolveField(command.field, /* hasCircuit */ true);
  if (!resolved || !resolved.circuitField) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }
  // PLAN-C — validate ONCE, BEFORE scope resolution. A bulk apply of a
  // garbled enum must mutate NOTHING and re-ask once, not write N bad
  // rows or speak N identical re-asks. The re-ask echoes the command's
  // ACTUAL target (including the spare policy) so the inspector can
  // restate the whole instruction in one breath.
  let guardedValue: string | null = null;
  let guardedCanonicalised = false;
  if (isValueCheckedCircuitField(resolved.circuitField)) {
    const guard = guardClosedEnumWrite(
      resolved.circuitField,
      command.value,
      guardedTargetForScope(command.scope, command.sparePolicy)
    );
    if (guard.kind === 'rejected') return guard.outcome;
    if (guard.kind === 'accepted') {
      guardedValue = guard.value;
      guardedCanonicalised = guard.canonicalised;
    }
  }
  const circuits = [...(job.circuits ?? [])];
  const { indices, spareSkippedCount } = indicesForScope(command.scope, circuits, {
    fieldName: resolved.circuitField,
    sparePolicy: command.sparePolicy,
  });
  // PLAN-F item 1, Decision 4 — count-aware audible skip. Zero applied
  // WITH spares skipped is the "all targets were spares under an exclude
  // policy" case (there is no success confirmation to append to); zero
  // applied with NO spares skipped is the pre-existing "range/circuit not
  // found" case. Distinct branches — the wording must not collide.
  // PLAN-C (Codex cycle 1) — on a guarded field BOTH zero-applied branches
  // must take the speak seam, for the same reason the value-rejection branch
  // does: nothing was written, so the server's "Set wiring type to A for 6
  // circuits." is a read-back of a certificate state that does not exist. A
  // 0/negative/fractional circuit target from the wire lands here too.
  const guardedZeroFlag = guardedValue != null ? { guardedWriteFailed: true as const } : {};
  if (indices.length === 0) {
    if (spareSkippedCount > 0) {
      return {
        response: `No non-spare circuits were updated; ${skipClause(spareSkippedCount, 'standalone')}.`,
        ...guardedZeroFlag,
      };
    }
    return { ...respondUnknown('No circuits found in the specified range.'), ...guardedZeroFlag };
  }
  // Polarity normalisation — same sigil mapping as applyUpdateField.
  let value: string = command.value;
  if (resolved.circuitField === 'polarity_confirmed') {
    if (value === 'PASS') value = '✓';
    else if (value === 'FAIL') value = '✗';
  }
  // PLAN-B2 — designation hygiene at command entry (see applyUpdateField;
  // apply_field can carry circuit_designation across a bulk scope). Same
  // canonical value for the mutation and the spoken response.
  let spokenValue: string = command.value;
  if (resolved.circuitField === 'circuit_designation') {
    value = repairCircuitDesignation(command.value) as string;
    spokenValue = value;
  }
  // PLAN-C — store and speak the SAME canonical option (see applyUpdateField).
  if (guardedValue != null) {
    value = guardedValue;
    spokenValue = guardedValue;
  }
  let updated = 0;
  const appliedResults: Array<{ circuit: number | string; field: string; value: string }> = [];
  const next: VoiceCommandCircuit[] = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    updated += 1;
    const appliedValue =
      resolved.circuitField === 'polarity_confirmed'
        ? value === 'PASS'
          ? '✓'
          : value === 'FAIL'
            ? '✗'
            : value
        : value;
    appliedResults.push({
      circuit: String(row.circuit_ref ?? row.number ?? idx + 1),
      field: resolved.circuitField as string,
      value: appliedValue,
    });
    // PLAN-CC (write path 7 / M3) — per row, the same commit route as the
    // single-circuit branch above. A bulk standard change has to recompute the
    // derived rows and leave the manual ones exactly as the inspector entered
    // them, which a plain spread cannot do.
    return applyOcpdAwarePatch(
      row as Record<string, unknown>,
      { [resolved.circuitField as string]: appliedValue },
      canonicaliseOcpdStandardForImport
    ) as VoiceCommandCircuit;
  });
  const label = labelForField(resolved.circuitField);
  if (updated === 0) {
    return { response: `No circuits found in the specified range.`, ...guardedZeroFlag };
  }
  // iOS phrasing — VoiceCommandExecutor.swift around line 472. "Set X
  // for N circuits" / "for 1 circuit". Same direct-mutation semantics
  // (overrides any pre-existing value because the inspector explicitly
  // asked for it). PLAN-F item 1, Decision 4 — a count-aware skip clause
  // is appended when the bulk write also skipped spares under an exclude
  // policy (Decision 4's exact wording, shared with backend/iOS — no
  // client-invented variants).
  const skipSuffix = spareSkippedCount > 0 ? `, ${skipClause(spareSkippedCount, 'append')}` : '';
  const actualSpokenValue = appliedResults[0]?.value ?? spokenValue;
  const response =
    updated === 1
      ? `Set ${label} to ${actualSpokenValue} for 1 circuit${skipSuffix}.`
      : `Set ${label} to ${actualSpokenValue} for ${updated} circuits${skipSuffix}.`;
  return {
    patch: { circuits: next },
    response,
    appliedResults,
    changedKeys: [resolved.circuitField as string],
    ...(guardedCanonicalised ? { canonicalSuccess: true } : {}),
  };
}

/** PLAN-C — the apply-field scope, in the shape the re-ask renderer echoes.
 *  `sparePolicy` rides along because a restatement that drops "excluding
 *  spares" would not reproduce the command the inspector actually gave. */
function guardedTargetForScope(
  scope: VoiceCommandScope,
  sparePolicy: ClosedEnumSparePolicy | undefined
): GuardedTarget {
  // Codex cycle 2 — a single scope counts as RESOLVED only when it names a
  // positive integer, which is exactly iOS's test (`guardedApplyTarget`,
  // `VoiceCommandExecutor.swift:749`). `asNumber` in the action mapper only
  // screens for finiteness, so `circuit: 0` and `circuit: 2.5` reached here
  // as resolved single targets: web then fell through to the zero-applied
  // branch and said "No circuits found in the specified range." for a
  // command that named no valid circuit at all, where iOS asks "…but not
  // which circuit". Both refuse the write, so nothing lands wrongly either
  // way — but the shared fixture is a contract about what the two clients
  // SAY, and iOS is canon. Narrowed here rather than in `scopeFromParams`
  // deliberately: that resolver serves every field, and dropping a
  // 0/fractional scope to null there would change unguarded behaviour this
  // plan has no business touching.
  if (scope.kind === 'single') {
    return Number.isInteger(scope.circuit) && scope.circuit >= 1
      ? { kind: 'single', circuit: scope.circuit }
      : { kind: 'unknown' };
  }
  if (scope.kind === 'range') {
    return { kind: 'range', from: scope.from, to: scope.to, sparePolicy };
  }
  return { kind: 'all', sparePolicy };
}

/**
 * PLAN-B2 — apply the legacy `add_circuit` action locally. Mirrors iOS
 * `VoiceCommandExecutor.executeAddCircuit` (:105-115) semantics as they
 * stand TODAY:
 *   - GLOBAL next-ref: max numeric `circuit_ref` across ALL circuits
 *     (every board) + 1;
 *   - board attribution: `boards.first?.id` (undefined when the job has
 *     no boards yet — same as iOS's optional boardId);
 *   - designation canonicalised ONCE (repair semantics) and the SAME
 *     value used for storage and the spoken response;
 *   - rows kept sorted by numeric ref (iOS `sortByCircuitRef`).
 * Deliberately NOT board-scoped allocation — the round-14 revert pinned
 * today's identically-imperfect multi-board behaviour on both clients;
 * which-board correctness is the "multi-board voice-routing" follow-up
 * plan, not this one.
 */
function applyAddCircuit(
  command: Extract<VoiceCommand, { type: 'add_circuit' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const circuits = [...(job.circuits ?? [])];
  // Strict whole-string integer parse mirroring Swift `Int(...)` (Codex
  // r1: `parseInt("7A")` is 7 so web allocated 8 where iOS allocates 1).
  // Invalid refs map to 0 exactly like iOS's `Int($0.circuitRef) ?? 0`,
  // the max may be negative, and the ?? 0 fallback applies only to an
  // EMPTY list — byte-parity with executeAddCircuit.
  const strictRef = (raw: unknown): number => {
    const str = String(raw ?? '');
    return /^[+-]?\d+$/.test(str) ? parseInt(str, 10) : 0;
  };
  const refValues = circuits.map((row) => strictRef(row.circuit_ref ?? row.number));
  const maxRef = refValues.length > 0 ? Math.max(...refValues) : 0;
  const nextRef = String(maxRef + 1);
  const boards = job.boards as Array<{ id?: string }> | undefined;
  const boardId = boards?.[0]?.id;
  const canonical = repairCircuitDesignation(command.description) as string;
  const row: VoiceCommandCircuit = {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `c-${nextRef}-${Math.random().toString(36).slice(2, 10)}`,
    circuit_ref: nextRef,
    number: nextRef,
    circuit_designation: canonical,
  };
  if (boardId) row.board_id = boardId;
  // Mini-review c1 — sorting uses iOS `sortByCircuitRef` semantics, NOT
  // the allocation parser: group by board, compare leading integer
  // portions, natural-compare remainders/non-numeric refs (Swift sorts
  // "7A" after 7 by its LEADING int even though allocation treats it as
  // 0).
  const leadingInt = (raw: unknown): { num: number | null; rem: string } => {
    const str = String(raw ?? '');
    const m = /^([+-]?\d+)(.*)$/.exec(str);
    return m ? { num: parseInt(m[1], 10), rem: m[2] } : { num: null, rem: str };
  };
  const next = [...circuits, row].sort((a, b) => {
    const boardA = String(a.board_id ?? '');
    const boardB = String(b.board_id ?? '');
    if (boardA !== boardB) return boardA < boardB ? -1 : 1;
    const ra = leadingInt(a.circuit_ref ?? a.number);
    const rb = leadingInt(b.circuit_ref ?? b.number);
    if (ra.num != null && rb.num != null) {
      if (ra.num !== rb.num) return ra.num - rb.num;
      return ra.rem.localeCompare(rb.rem, undefined, { numeric: true });
    }
    if (ra.num != null) return -1;
    if (rb.num != null) return 1;
    return String(a.circuit_ref ?? a.number ?? '').localeCompare(
      String(b.circuit_ref ?? b.number ?? ''),
      undefined,
      { numeric: true }
    );
  });
  // Spoken template — the SAME canonical value as storage. This exact
  // wording is the cross-client contract for the add action (the iOS
  // spoken-override half pins the identical string).
  const response = canonical.trim()
    ? `Added circuit ${nextRef}, ${canonical}.`
    : `Added circuit ${nextRef}.`;
  return {
    patch: { circuits: next },
    response,
    appliedResults: [{ circuit: nextRef, field: 'circuit_designation', value: canonical }],
    changedKeys: ['circuits'],
  };
}

/**
 * PLAN-B2 — TRUE when a mapped voice command writes/speaks a circuit
 * designation. The recording context uses this to decide the spoken
 * response must be the LOCALLY constructed canonical text (the server's
 * raw `spoken_response` may carry the banned word verbatim).
 */
export function voiceCommandTargetsDesignation(command: VoiceCommand): boolean {
  if (command.type === 'add_circuit') return true;
  if (command.type === 'update_field' || command.type === 'apply_field') {
    const resolved = resolveField(command.field, /* hasCircuit */ true);
    return resolved?.circuitField === 'circuit_designation';
  }
  return false;
}

/** Decision 4's exact count-aware skip clause, shared verbatim across all
 *  three implementations. 'append' (present continuous, joined onto a
 *  success response): "skipping 1 spare way" / "skipping N spare ways".
 *  'standalone' (past tense, the zero-applied sentence — plan line 85):
 *  "skipped 1 spare way" / "skipped N spare ways". No client-invented
 *  variants. */
function skipClause(spareSkippedCount: number, mode: 'append' | 'standalone'): string {
  const verb = mode === 'append' ? 'skipping' : 'skipped';
  return spareSkippedCount === 1
    ? `${verb} 1 spare way`
    : `${verb} ${spareSkippedCount} spare ways`;
}
