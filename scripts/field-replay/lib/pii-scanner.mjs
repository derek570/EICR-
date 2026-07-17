/**
 * pii-scanner.mjs — the SCHEMA-AWARE privacy scanner for committed
 * field-replay artifacts (plan Item 1 "PII policy" + Item 5 two-tier docs
 * rule). NOT a literal key-name ban: canonical fixture fields legitimately
 * include address/client fields, and fixture-owned SYMBOLIC ids are
 * by-design present — a naive key ban would reject every valid sanitized
 * fixture, while a loose value-only scan misses sensitive material in YAML
 * comments, keys, anchors, and filenames. So:
 *
 *   - scanning operates on the RAW BYTES of every committed YAML/attestation/
 *     evidence file BEFORE parsing, plus every relative filename;
 *   - canonical schema field names and documented symbolic-ID formats are
 *     ALLOWLISTED;
 *   - sanitized PII-bearing fields use a RESERVED SYNTHETIC GRAMMAR —
 *     persons `fixture_person_<N>`, addresses `<N> Example Street, Testtown`,
 *     postcodes from the non-real `ZZ99` range — the ONLY content accepted in
 *     canonical PII fields;
 *   - the scanner rejects raw identifier VALUES, UUIDs outside symbolic
 *     slots, address-like values outside the grammar, forbidden arbitrary
 *     keys/comments, and manifest-listed fragments (acceptance-time only).
 *
 * Two-tier documentation scanning (Item 5): tier 1 = FULL raw-byte scanning
 * for new/modified corpus artifacts and NEWLY CREATED docs; tier 2 = legacy
 * tracked docs are scanned on ADDED lines only (zero-context diff) — legacy
 * historical identifiers pass untouched, newly introduced ones reject.
 */

/** Reserved synthetic grammar — the ONLY admissible content of canonical
 *  PII fields. Anything else that parses as a name/address/postcode rejects
 *  (closes the "is this sanitized or real?" judgment gap). */
export const SYNTHETIC_GRAMMAR = Object.freeze({
  person: /^fixture_person_\d+$/,
  address: /^\d+ Example Street, Testtown(?:, ZZ99 9[A-Z]{2})?$/,
  postcode: /^ZZ99\s?9[A-Z]{2}$/,
});

/** Canonical PII-bearing fixture/job-state field names (allowlisted keys
 *  whose VALUES must match the synthetic grammar). */
export const CANONICAL_PII_FIELDS = Object.freeze({
  person: ['client_name', 'inspector_name', 'contractor_name', 'authorising_person'],
  address: ['address', 'client_address', 'installation_address', 'install_address'],
  postcode: ['postcode', 'client_postcode', 'installation_postcode'],
});

/** Documented symbolic-ID formats (allowlisted VALUE shapes). `sym_*` is the
 *  fixture-local symbolic-id namespace (tool calls, boards, observations,
 *  chain ids); the rest are the deterministic/opaque classes. */
export const SYMBOLIC_ID_RE =
  /^(?:sym_[a-z0-9_]+|frc_[0-9a-f]{32}|fix_[0-9a-f]{32}|frsess_[0-9a-f]{32}|frgen_[0-9a-f]{32}|frutt_[0-9a-f]{32}|frturn_[0-9a-f]{32}|prov_[a-z0-9_]+|op_[a-z0-9_]+|out_[a-z0-9_]+)$/;

const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
// Raw production identifier values.
const RAW_ID_VALUE_RE = /\b(?:sess_[a-z0-9_]{4,}|job_\d{6,}|user_\d{4,}|harness_\d{8,}[a-z0-9_]*)\b/g;
// UK postcode shape (broad), later filtered by the ZZ99 allowance.
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
// Address-like free text outside the grammar.
const ADDRESS_LIKE_RE =
  /\b\d+\s+[A-Z][a-zA-Z]*\s+(?:Street|Road|Avenue|Lane|Drive|Close|Way|Court|Crescent|Terrace|Gardens?)\b/g;
// Private machine paths and handoff locations.
const PRIVATE_PATH_RE = /(?:\/Users\/[a-z]+\/|~\/\.claude\/|\.claude\/handoffs|\.field-replay-archive)/g;
// Timestamp-bearing capture filenames (dr_2026-07-16T..., session_full.jsonl, debug_log.jsonl).
const CAPTURE_FILENAME_RE = /\b(?:dr_20\d{2}-\d{2}-\d{2}T[\dZ.:-]+\.json|session_full\.jsonl|debug_log\.jsonl)\b/g;

/** Bounded finding codes. */
export const PII_FINDING_CODES = Object.freeze({
  UUID: 'uuid_outside_symbolic_slot',
  RAW_ID: 'raw_identifier_value',
  POSTCODE: 'postcode_outside_zz99',
  ADDRESS: 'address_like_outside_grammar',
  PRIVATE_PATH: 'private_path',
  CAPTURE_FILENAME: 'timestamped_capture_filename',
  MANIFEST_FRAGMENT: 'manifest_listed_fragment',
  PII_FIELD_GRAMMAR: 'canonical_pii_field_outside_grammar',
  FILENAME: 'filename_violation',
});

function findAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/**
 * Tier-1 RAW-BYTE scan of one committed artifact (fixture YAML, attestation,
 * evidence JSON, or a NEWLY CREATED doc). `relPath` participates in the
 * filename checks. `opts.manifestFragments` is acceptance-time only.
 * Returns { ok, findings: [{code, match, context}] }.
 */
export function scanRawContent(content, relPath = '', opts = {}) {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  const findings = [];
  const push = (code, match) => findings.push({ code, match, file: relPath });

  for (const m of findAll(UUID_RE, text)) push(PII_FINDING_CODES.UUID, m);
  for (const m of findAll(RAW_ID_VALUE_RE, text)) push(PII_FINDING_CODES.RAW_ID, m);
  for (const m of findAll(UK_POSTCODE_RE, text)) {
    if (!/^ZZ99/.test(m.replace(/\s+/g, ' ').trim())) push(PII_FINDING_CODES.POSTCODE, m);
  }
  for (const m of findAll(ADDRESS_LIKE_RE, text)) {
    if (!/Example Street/.test(m)) push(PII_FINDING_CODES.ADDRESS, m);
  }
  for (const m of findAll(PRIVATE_PATH_RE, text)) push(PII_FINDING_CODES.PRIVATE_PATH, m);
  for (const m of findAll(CAPTURE_FILENAME_RE, text)) push(PII_FINDING_CODES.CAPTURE_FILENAME, m);
  for (const frag of opts.manifestFragments ?? []) {
    if (frag && text.includes(frag)) push(PII_FINDING_CODES.MANIFEST_FRAGMENT, frag.slice(0, 24) + '…');
  }
  // Filename checks: dates, raw prefixes, capture names in the file name.
  const base = relPath.split('/').pop() ?? '';
  if (/20\d{2}-?\d{2}-?\d{2}/.test(base) || /(?:sess|job|user)_/i.test(base)) {
    push(PII_FINDING_CODES.FILENAME, base);
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Parsed-layer scan of a fixture document: canonical PII fields must match
 * the synthetic grammar EXACTLY; unknown keys carrying PII-suspect values
 * are caught by the raw scan (comments/keys/anchors included).
 * Walks the whole document (job_state, turns, everywhere).
 */
export function scanParsedFixture(doc, relPath = '') {
  const findings = [];
  const classOf = (key) => {
    for (const [cls, keys] of Object.entries(CANONICAL_PII_FIELDS)) {
      if (keys.includes(key)) return cls;
    }
    return null;
  };
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}/${i}`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const cls = classOf(k);
      if (cls && typeof v === 'string' && v.trim() !== '') {
        if (!SYNTHETIC_GRAMMAR[cls].test(v.trim())) {
          findings.push({
            code: PII_FINDING_CODES.PII_FIELD_GRAMMAR,
            match: `${k}: ${v.slice(0, 60)}`,
            file: relPath,
            path: `${path}/${k}`,
          });
        }
      }
      walk(v, `${path}/${k}`);
    }
  };
  walk(doc, '');
  return { ok: findings.length === 0, findings };
}

/**
 * Tier-2 scan for LEGACY tracked docs: only ADDED lines are scanned (the
 * caller supplies them from a zero-context merge-base/index diff). Pre-
 * existing historical identifiers pass untouched; every NEWLY INTRODUCED raw
 * identifier still rejects. The filename check is skipped (the legacy file
 * already exists under its name).
 */
export function scanAddedLines(addedLines, relPath = '', opts = {}) {
  const findings = [];
  for (const [i, line] of addedLines.entries()) {
    const r = scanRawContent(line, '', opts);
    for (const f of r.findings) {
      if (f.code === PII_FINDING_CODES.FILENAME) continue;
      findings.push({ ...f, file: relPath, line: i + 1 });
    }
  }
  return { ok: findings.length === 0, findings };
}
