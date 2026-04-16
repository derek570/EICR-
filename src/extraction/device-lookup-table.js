/**
 * Device Lookup Table (Phase D — Stage 4 gap-fill)
 *
 * Maps (manufacturer, model) → { rcdWaveformType, bsEn, defaults } for UK consumer-unit
 * devices. Stage 3 of the geometric extractor identifies the device on each DIN slot but
 * frequently cannot read the BS EN number or RCD waveform symbol from a photo (tiny print,
 * glare, angle). Stage 4 looks the device up here and gap-fills any nulls left by Stage 3.
 *
 * The VLM is authoritative for fields it DID read — this table only fills blanks. A
 * mis-identified manufacturer/model should never silently overwrite a VLM-confirmed value.
 *
 * See: docs/plans/2026-04-16-ccu-geometric-extraction-design.md §5 (Phase D)
 */

/**
 * @typedef {Object} DeviceSpec
 * @property {'AC'|'A'|'F'|'B'|null} rcdWaveformType — BS EN 61008/61009 waveform class
 * @property {string|null} bsEn — primary BS EN standard number
 * @property {{ ratingAmps?: number, poles?: number }} defaults
 */

// Canonical entries. Keys are lowercase `${manufacturer}|${model}` — model may be a prefix.
// When multiple model prefixes match, the longest wins (most specific).
const TABLE = [
  // Hager — ADA/ADB/ADC curves (Type A RCBOs from ~2018)
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'ada',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'adb',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'adc',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },
  // Hager — CDA MCBs (BS EN 60898)
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'cda',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // Hager — NB/NC MCB ranges
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'nb',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  {
    manufacturerPattern: /^hager$/,
    modelPrefix: 'nc',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },

  // MK Sentry — LN5xxx / LN7xxx MCBs (Type AC older)
  {
    manufacturerPattern: /^mk(\s+sentry)?$/,
    modelPrefix: 'ln5',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  {
    manufacturerPattern: /^mk(\s+sentry)?$/,
    modelPrefix: 'ln7',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // MK Sentry RCBOs — LN8xxx (Type AC pre-2018)
  {
    manufacturerPattern: /^mk(\s+sentry)?$/,
    modelPrefix: 'ln8',
    spec: { rcdWaveformType: 'AC', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },

  // Wylex — NH MCBs
  {
    manufacturerPattern: /^wylex$/,
    modelPrefix: 'nh',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // Wylex — NHXS RCBOs (Type A from 2019)
  {
    manufacturerPattern: /^wylex$/,
    modelPrefix: 'nhxs',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },
  // Wylex — WRS RCDs
  {
    manufacturerPattern: /^wylex$/,
    modelPrefix: 'wrs',
    spec: { rcdWaveformType: 'AC', bsEn: 'BS EN 61008-1', defaults: { poles: 2 } },
  },

  // MEM Memera 2000 — MCBs
  {
    manufacturerPattern: /^mem(\s+memera)?$/,
    modelPrefix: 'memera',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },

  // Crabtree Starbreaker — 61/series MCBs
  {
    manufacturerPattern: /^crabtree(\s+starbreaker)?$/,
    modelPrefix: '61',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },

  // Eaton (incl. MEM/Memshield 3) — MCBs
  {
    manufacturerPattern: /^eaton$/,
    modelPrefix: 'mbh',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // Eaton RCBOs
  {
    manufacturerPattern: /^eaton$/,
    modelPrefix: 'mrb',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },

  // Schneider Electric — Easy9 MCBs
  {
    manufacturerPattern: /^schneider(\s+electric)?$/,
    modelPrefix: 'ez9',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // Schneider Electric — Acti9 iC60 MCBs
  {
    manufacturerPattern: /^schneider(\s+electric)?$/,
    modelPrefix: 'ic60',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },

  // BG — CUM MCBs
  {
    manufacturerPattern: /^bg$/,
    modelPrefix: 'cum',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // BG — CUR RCBOs (Type A)
  {
    manufacturerPattern: /^bg$/,
    modelPrefix: 'cur',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },

  // Fusebox — MT MCBs
  {
    manufacturerPattern: /^fusebox$/,
    modelPrefix: 'mt',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
  // Fusebox — RCBO (Type A)
  {
    manufacturerPattern: /^fusebox$/,
    modelPrefix: 'rcbo',
    spec: { rcdWaveformType: 'A', bsEn: 'BS EN 61009-1', defaults: { poles: 2 } },
  },

  // Contactum — Defender MCBs
  {
    manufacturerPattern: /^contactum$/,
    modelPrefix: 'def',
    spec: { rcdWaveformType: null, bsEn: 'BS EN 60898-1', defaults: { poles: 1 } },
  },
];

function normalise(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[\s\-_./\\]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

/**
 * Look up a device by (manufacturer, model).
 *
 * Returns null on unknown input. Callers should treat null as "no gap-fill available"
 * and leave any VLM-confirmed fields untouched.
 *
 * @param {string|null|undefined} manufacturer
 * @param {string|null|undefined} model
 * @returns {DeviceSpec|null}
 */
export function lookupDevice(manufacturer, model) {
  const mfg = normalise(manufacturer);
  const mdl = normalise(model);
  if (!mfg || !mdl) return null;

  let best = null;
  let bestLen = -1;
  for (const entry of TABLE) {
    if (!entry.manufacturerPattern.test(mfg)) continue;
    const prefix = entry.modelPrefix;
    if (!mdl.startsWith(prefix)) continue;
    if (prefix.length > bestLen) {
      best = entry.spec;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Apply Stage 4 gap-fill to a Stage 3 slot.
 *
 * Only fills nulls — never overwrites a value the VLM already reported. Returns a shallow
 * copy of the slot with `rcdWaveformType`, `bsEn`, and (for RCDs/RCBOs) `ratingAmps` / `poles`
 * defaults filled in if the lookup succeeded and the VLM left them null.
 *
 * The caller is responsible for deciding whether to apply Stage 4 at all (e.g. skip when
 * classification is 'blank' or 'unknown' or confidence is below threshold).
 *
 * @param {object} slot — Stage 3 classified slot
 * @returns {object} new slot with gap-filled fields
 */
export function applyDeviceLookup(slot) {
  if (!slot || typeof slot !== 'object') return slot;
  const spec = lookupDevice(slot.manufacturer, slot.model);
  if (!spec)
    return { ...slot, rcdWaveformType: slot.rcdWaveformType ?? null, bsEn: slot.bsEn ?? null };

  const out = { ...slot };
  if (out.rcdWaveformType == null) out.rcdWaveformType = spec.rcdWaveformType;
  if (out.bsEn == null) out.bsEn = spec.bsEn;
  if (out.ratingAmps == null && spec.defaults && typeof spec.defaults.ratingAmps === 'number') {
    out.ratingAmps = spec.defaults.ratingAmps;
  }
  // Only fill poles if Stage 3 didn't report any (null/undefined). Stage 3 defaults poles
  // to 1 when unknown, so we treat 1 as "reported" and don't override.
  if (out.poles == null && spec.defaults && typeof spec.defaults.poles === 'number') {
    out.poles = spec.defaults.poles;
  }
  return out;
}

// Exported for tests only.
export const __TABLE_SIZE__ = TABLE.length;
