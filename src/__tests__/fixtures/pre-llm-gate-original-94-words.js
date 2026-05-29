/**
 * The original 94-word trigger list from pre-llm-gate.js as of
 * 2026-05-26 (the panic-ask field-session fix).
 *
 * Pinned here as a vocabulary preservation invariant. The 2026-05-29
 * PLAN_v4 split moved each of these words into STRONG, WEAK, or the
 * OBSERVATION_PATTERN regex. The invariant test in
 * `pre-llm-gate.test.js` walks this set and verifies every entry is
 * placed somewhere — no original word may be dropped silently.
 *
 * When intentionally adding/removing original words, update this
 * file in the same commit + update the relevant set/regex.
 */
export const ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26 = new Set([
  // Circuit and board nouns
  'circuit',
  'circuits',
  'board',
  'boards',
  'ring',
  'socket',
  'sockets',
  'lights',
  'light',
  // Appliance designations
  'shower',
  'cooker',
  'oven',
  'hob',
  // Room names
  'kitchen',
  'lounge',
  'living',
  'bedroom',
  'bedrooms',
  'bathroom',
  'hallway',
  'garage',
  'utility',
  'loft',
  'attic',
  'landing',
  // Appliance + protection device terms
  'heater',
  'immersion',
  'smoke',
  'alarm',
  'spur',
  'fcu',
  'radial',
  'main',
  'sub-main',
  'submain',
  'spd',
  'rcd',
  'rcbo',
  'mcb',
  'fuse',
  // Observation language
  'observation',
  'observe',
  'defect',
  'issue',
  'crack',
  'cracked',
  'burn',
  'burnt',
  'damage',
  'damaged',
  'missing',
  'exposed',
  'loose',
  'corroded',
  // Action verbs
  'note',
  'record',
  'fill',
  'add',
  'delete',
  'remove',
  'move',
  'next',
  'previous',
  'done',
  'finish',
  'skip',
  // Test-reading field shorthand
  'zs',
  'ze',
  'pfc',
  'psc',
  'ipfc',
  'r1',
  'r2',
  'continuity',
  'insulation',
  'polarity',
  'earth',
  'bond',
  'bonding',
  // Wiring / device language
  'trip',
  'breaker',
  'live',
  'neutral',
  'protective',
  'conductor',
  'cable',
  'wiring',
  'colour',
  'color',
  // Confirmation verbs
  'confirm',
  'correct',
  // Inspection vocabulary
  'overall',
  'summary',
  'inspection',
]);
