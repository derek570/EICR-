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
    };

export interface VoiceCommandOutcome {
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
  // Designation
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

/** Resolve a spoken field phrase against both vocabularies, preferring
 *  the circuit field when the command has an explicit circuit number.
 *  Returns the canonical field + routing section, or null if unknown. */
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
 *  the circuit defaults schema which stores raw numbers. */
function cleanValue(raw: string): string {
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
  // a scope. parseScopeText returns null for empty input so we naturally
  // bail.
  const scope = parseScopeText(rest);
  if (!scope) return null;
  return { type: 'calculate_impedance', kind, scope };
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
    const value = cleanValue((isMatch[3] ?? '').trim());
    const fieldHit = matchFieldPrefix(fieldPhrase);
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
      const value = cleanValue(fieldHit.rest);
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
  return { response: reason };
}

export function applyVoiceCommand(
  command: VoiceCommand,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  switch (command.type) {
    case 'update_field':
      return applyUpdateField(command, job);
    case 'reorder_circuits':
      return applyReorderCircuits(command, job);
    case 'query_field':
      return applyQueryField(command, job);
    case 'calculate_impedance':
      return applyCalculateImpedance(command, job);
    case 'apply_field':
      return applyApplyField(command, job);
    case 'apply_field_contradiction':
      // PLAN-F item 1, Decision 3 — consumed locally: speak a deterministic
      // refusal, no patch (nothing mutates), never forwarded to the server.
      return {
        response:
          'I heard contradictory spare instructions — please say either including or excluding spares, not both.',
      };
    default: {
      // Exhaustiveness — TypeScript will flag a missing branch at compile
      // time; the runtime guard is belt-and-braces for hand-edited JSON.
      const never: never = command;
      void never;
      return respondUnknown("I didn't understand that command.");
    }
  }
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

  // Per-circuit update
  if (hasCircuit && resolved.circuitField) {
    const ref = String(command.circuit);
    const circuits = job.circuits ?? [];
    const idx = circuits.findIndex(
      (c) => c.circuit_ref === ref || c.number === ref || c.id === ref
    );
    if (idx === -1) {
      return respondUnknown(`Circuit ${command.circuit} doesn't exist.`);
    }
    // Normalise polarity_confirmed — inspectors dictate "pass"/"fail";
    // iOS converts to the ✓/✗ sigils used everywhere else in the app.
    let value: string = command.value;
    if (resolved.circuitField === 'polarity_confirmed') {
      if (value === 'PASS') value = '✓';
      else if (value === 'FAIL') value = '✗';
    }
    const next: VoiceCommandCircuit[] = circuits.map((row, i) =>
      i === idx ? { ...row, [resolved.circuitField as string]: value } : row
    );
    const label = labelForField(resolved.circuitField);
    return {
      patch: { circuits: next },
      response: `Set ${label} to ${command.value} on circuit ${command.circuit}.`,
      changedKeys: [resolved.circuitField as string],
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
    response: `Moved to circuit ${command.to}.`,
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
  // Read Ze from supply.ze. iOS also tries the active board's Ze
  // first — the PWA doesn't yet carry a board-level Ze override, so
  // supply Ze is the only source. If that's absent, refuse cleanly.
  // Note `Number('')` returns 0 (finite) — so an empty/whitespace
  // string must short-circuit BEFORE the numeric coercion.
  const supply = (job.supply ?? {}) as Record<string, unknown>;
  const zeRaw = supply.ze;
  const zeStr = typeof zeRaw === 'number' ? String(zeRaw) : String(zeRaw ?? '');
  if (zeStr.trim() === '') {
    return respondUnknown("I can't calculate that — no zed E value has been set yet.");
  }
  const zeNum = Number(zeStr);
  if (!Number.isFinite(zeNum)) {
    return respondUnknown("I can't calculate that — no zed E value has been set yet.");
  }
  let updated = 0;
  const next = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    if (command.kind === 'zs') {
      // Zs = Ze + R1+R2
      const r1r2Str = row.r1_r2_ohm;
      const r1r2 = typeof r1r2Str === 'string' ? Number(r1r2Str) : Number(r1r2Str);
      if (!Number.isFinite(r1r2)) return row;
      const zs = zeNum + (r1r2 as number);
      updated += 1;
      return { ...row, measured_zs_ohm: formatImpedance(zs) };
    }
    // r1_r2 = Zs - Ze
    const zsStr = row.measured_zs_ohm;
    const zs = typeof zsStr === 'string' ? Number(zsStr) : Number(zsStr);
    if (!Number.isFinite(zs)) return row;
    const r1r2 = (zs as number) - zeNum;
    if (r1r2 < 0) return row;
    updated += 1;
    return { ...row, r1_r2_ohm: formatImpedance(r1r2) };
  });
  const label = command.kind === 'zs' ? 'Zs' : 'R1 plus R2';
  if (updated === 0) {
    return {
      response: `No circuits had the values needed to calculate ${label}.`,
    };
  }
  // iOS phrasing — verbatim from VoiceCommandExecutor.swift:374–376.
  const response =
    updated === 1
      ? `Done. Calculated ${label} for 1 circuit.`
      : `Done. Calculated ${label} for ${updated} circuits.`;
  return {
    patch: { circuits: next },
    response,
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
  if (indices.length === 0) {
    if (spareSkippedCount > 0) {
      return {
        response: `No non-spare circuits were updated; ${skipClause(spareSkippedCount, 'standalone')}.`,
      };
    }
    return respondUnknown('No circuits found in the specified range.');
  }
  // Polarity normalisation — same sigil mapping as applyUpdateField.
  let value: string = command.value;
  if (resolved.circuitField === 'polarity_confirmed') {
    if (value === 'PASS') value = '✓';
    else if (value === 'FAIL') value = '✗';
  }
  let updated = 0;
  const next: VoiceCommandCircuit[] = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    updated += 1;
    return { ...row, [resolved.circuitField as string]: value };
  });
  const label = labelForField(resolved.circuitField);
  if (updated === 0) {
    return { response: `No circuits found in the specified range.` };
  }
  // iOS phrasing — VoiceCommandExecutor.swift around line 472. "Set X
  // for N circuits" / "for 1 circuit". Same direct-mutation semantics
  // (overrides any pre-existing value because the inspector explicitly
  // asked for it). PLAN-F item 1, Decision 4 — a count-aware skip clause
  // is appended when the bulk write also skipped spares under an exclude
  // policy (Decision 4's exact wording, shared with backend/iOS — no
  // client-invented variants).
  const skipSuffix = spareSkippedCount > 0 ? `, ${skipClause(spareSkippedCount, 'append')}` : '';
  const response =
    updated === 1
      ? `Set ${label} to ${command.value} for 1 circuit${skipSuffix}.`
      : `Set ${label} to ${command.value} for ${updated} circuits${skipSuffix}.`;
  return {
    patch: { circuits: next },
    response,
    changedKeys: [resolved.circuitField as string],
  };
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
