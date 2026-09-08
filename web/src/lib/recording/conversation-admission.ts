/**
 * ConversationAdmissionV1 classifies the RAW Deepgram final before any
 * normalisation or local mutation.  It is deliberately client-only: the
 * backend remains model-owned and list-free.
 */

import { parseCalculateCommand } from '@certmate/shared-utils';
import { normalise } from './number-normaliser';

export type ConversationAdmissionClass =
  | 'QUERY_TRIGGER'
  | 'REFERENCE_TRIGGER'
  | 'QUESTION_SHAPED'
  | 'MIXED'
  | 'ORDINARY';

/** UTF-16 code-unit offsets, matching String.slice and RegExp indices. */
export interface ProtectedOrdinalSpan {
  start: number;
  end: number;
}

export interface ConversationAdmissionDecision {
  classification: ConversationAdmissionClass;
  bypassMutation: boolean;
  admits: boolean;
  protectedOrdinalSpans: readonly ProtectedOrdinalSpan[];
}

const ORDINAL = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth';
const REFERENCE_WORD = `${ORDINAL}|last|next|that|this`;

// Mirrors the marker-bearing replacements in both NumberNormaliser tables.
// These patterns recognise raw speech without rewriting it.
const SPOKEN_MARKER =
  '(?:zed\\s+s(?:s|ess)?|zed\\s+e|zed(?:dy|d?e(?:e)?)|zedi|p\\s+f\\s+c|m\\s+c\\s+b|r\\s+c\\s+b\\s+o|r\\s+c\\s+d|a\\s+f\\s+d\\s+d|our\\s+c\\s*d|c\\s+p\\s+c|r\\s+one|r\\s+two)';

const MARKER =
  `(?:zs|ze|pfc|psc|ipfc|r1|r2|mcb|rcd|rcbo|spd|polarity|continuity|insulation|fcu|cpc|afdd|` +
  `earthing|tncs|tn-c-s|tns|tn-s|tnc|tn-c|tt|pme|customer|client|landlord|tenant|occupier|address|postcode|circuit|circuits|board|boards|field|designation|reading|readings|value|maximum|${SPOKEN_MARKER})`;
const MARKER_RE = new RegExp(`\\b${MARKER}\\b`, 'i');

const EARTHING_CODE = /^(?:tncs|tn-c-s|tns|tn-s|tnc|tn-c|tt|pme)$/i;
const AUXILIARY =
  "(?:am|is|was|are|were|do|does|did|have|has|had|can|could|would|should|will|shall|may|might|must|isn't|isn’t|wasn't|wasn’t|aren't|aren’t|weren't|weren’t|don't|don’t|doesn't|doesn’t|didn't|didn’t|haven't|haven’t|hasn't|hasn’t|hadn't|hadn’t|can't|can’t|couldn't|couldn’t|wouldn't|wouldn’t|shouldn't|shouldn’t|won't|won’t|shan't|shan’t|mayn't|mayn’t|mightn't|mightn’t|mustn't|mustn’t)";
const SIMPLE_SUBJECT =
  '(?:i|you|we|they|it|he|she|that|this|there|one|the|a|an|my|your|our|these|those|each|every|any)';

const CLAUSE_BOUNDARY = '(?:^|[.!?]\\s*|\\.\\.\\.\\s*|\\b(?:and|but|then)\\s+)';
const WH_CLAUSE_RE = new RegExp(
  `${CLAUSE_BOUNDARY}(?:what|where|when|why|who|whom|whose|which|how)\\b`,
  'i'
);
const AUX_CLAUSE_RE = new RegExp(
  `${CLAUSE_BOUNDARY}(${AUXILIARY})\\s+(${SIMPLE_SUBJECT}|${MARKER})\\b`,
  'i'
);
const AUX_SECOND_CIRCUIT_RE = new RegExp(
  `${CLAUSE_BOUNDARY}${AUXILIARY}\\s+second\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\b`,
  'i'
);

const WHOLE_BOARD_IMPERATIVE_RE = new RegExp(
  `^(?:(?:(?:can|could)\\s+you|please)\\s+)+(?:working\\s+on|work\\s+on|switching\\s+to|switch\\s+to|now\\s+on)\\s+\\S(?:.*\\S)?[.!?]?$`,
  'i'
);
const FOLLOWING_QUERY_OR_REFERENCE_RE = new RegExp(
  `\\b(?:and|but|then)\\s+(?:(?:what|where|when|why|who|which|how)\\b|${AUXILIARY}\\b|(?:start\\s+with|go\\s+with|use)\\s+(?:(?:the\\s+)?(?:${REFERENCE_WORD})\\b))`,
  'i'
);

function trimTerminalPunctuation(text: string): string {
  return text
    .trim()
    .replace(/[.!?]+\s*$/, '')
    .trim();
}

function stripPoliteWrapper(text: string): string {
  let value = trimTerminalPunctuation(text);
  // Multiple wrappers are intentional: "Could you please ... please".
  for (;;) {
    const next = value.replace(/^(?:(?:can|could|would)\s+you|please)\s+/i, '');
    if (next === value) break;
    value = next;
  }
  value = value.replace(/\s+please$/i, '').trim();
  return value;
}

function isAnchoredQuery(text: string): boolean {
  const core = stripPoliteWrapper(text);
  const match =
    /^(repeat(?:\s+(?:that|it))?(?:\s+again)?|say\s+(?:that|it)(?:\s+again)?|help(?:\s+me)?|review\s+the\s+readings|what\s+did\s+you\s+(?:hear|get|write)|what(?:\s+is|'s|’s)\s+(?:still\s+)?missing|what(?:\s+is|'s|’s)\s+the\s+next\s+(?:test|reading))(.*)$/i.exec(
      core
    );
  if (!match) return false;
  const tail = match[2].trim();
  if (!tail) return true;
  // Scoped continuations are bounded to electrical/certificate markers.
  return /^(?:for|on|about)\b/i.test(tail) && MARKER_RE.test(tail);
}

function isWholeReference(text: string): boolean {
  const core = trimTerminalPunctuation(text);
  const simple = new RegExp(`^(?:the\\s+)?(?:${REFERENCE_WORD})(?:\\s+(?:one|circuit))?$`, 'i');
  if (simple.test(core)) return true;

  const governed = new RegExp(
    `^(?:start\\s+with|go\\s+with|use)\\s+(?:(?:the\\s+)?(?:${REFERENCE_WORD})(?:\\s+(?:one|circuit))?|that|this)(?:\\s+for\\s+circuits?\\b.*)?$`,
    'i'
  );
  if (governed.test(core)) return true;

  // A definite ordinal reference retains reference meaning with a reading
  // continuation.  The bare "Second one is ..." remains the Flux repair.
  return new RegExp(`^the\\s+(?:${ORDINAL}|last|next)\\s+one\\b\\s+.+$`, 'i').test(core);
}

function hasAuxiliaryQuestionClause(text: string): boolean {
  const match = AUX_CLAUSE_RE.exec(text);
  if (!match) return AUX_SECOND_CIRCUIT_RE.test(text);
  const subject = match[2].replace(/[’']/g, "'");
  if (new RegExp(`^${SIMPLE_SUBJECT}$`, 'i').test(subject)) return true;
  if (EARTHING_CODE.test(subject)) return false;
  return MARKER_RE.test(subject);
}

function hasQuestionShape(text: string): boolean {
  if (WH_CLAUSE_RE.test(text) || hasAuxiliaryQuestionClause(text)) return true;
  // Punctuation creates a bypass boundary, but never admission by itself.
  return /\?\s*$/.test(text.trim());
}

function hasEmbeddedQuery(text: string): boolean {
  return /\b(?:repeat(?:\s+(?:that|it))?|say\s+(?:that|it)|help(?:\s+me)?|review\s+the\s+readings|what\s+did\s+you\s+(?:hear|get|write)|what(?:\s+is|'s|’s)\s+(?:still\s+)?missing|what(?:\s+is|'s|’s)\s+the\s+next\s+(?:test|reading))\b/i.test(
    text
  );
}

function findProtectedOrdinalSpans(
  raw: string,
  classification: ConversationAdmissionClass
): ProtectedOrdinalSpan[] {
  if (classification === 'ORDINARY') return [];
  const spans: ProtectedOrdinalSpan[] = [];
  const complete = new RegExp(
    `\\b(?:the\\s+)?(?:${ORDINAL}|last|next|that|this)\\s+(?:one|circuit)\\b`,
    'gi'
  );
  for (const match of raw.matchAll(complete)) {
    if (match.index != null) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // A whole one-word reference ("Second", "next") is also protected.
  if (classification === 'REFERENCE_TRIGGER' && spans.length === 0) {
    const oneWord = new RegExp(`^(?:the\\s+)?(?:${REFERENCE_WORD})$`, 'i').exec(
      trimTerminalPunctuation(raw)
    );
    if (oneWord) {
      const start = raw.toLowerCase().indexOf(oneWord[0].toLowerCase());
      if (start >= 0) spans.push({ start, end: start + oneWord[0].length });
    }
  }
  return spans;
}

/**
 * A01P (2026-09-08) — stage 2 of the whole-Calculate carve-out. Deepgram
 * finals carry terminal punctuation, and a trailing `?` makes stage 1
 * classify a complete spoken Calculate ("Calculate Zs for circuit one?")
 * QUESTION_SHAPED with `bypassMutation`, which suppresses the local parse on
 * both clients. This is NOT a second grammar: the probe applies the existing
 * NumberNormaliser WITH stage 1's protected ordinal spans (so a protected
 * `second one` is never rewritten into a circuit), strips terminal
 * punctuation, and asks the client's OWN Calculate parser through its
 * remainder-aware variant whether the result is a complete Calculate with
 * NO unconsumed remainder. Only then does the raw final stay ORDINARY. The
 * base parser ignores trailing text, so a base-parser probe would wrongly
 * admit "calculate Zs for circuit one, what did I say?".
 *
 * Web has no QUERY_TRIGGER override (`calculate` is not an auxiliary); the
 * probe runs ONLY for QUESTION_SHAPED — never REFERENCE_TRIGGER, MIXED, or
 * ORDINARY (whose ordinary parse already runs with `bypassMutation: false`).
 */
function isWholeCalculateCommand(
  rawFinal: string,
  protectedOrdinalSpans: readonly ProtectedOrdinalSpan[]
): boolean {
  const probe = normalise(rawFinal, protectedOrdinalSpans)
    .trim()
    .replace(/[.,!?]+\s*$/, '')
    .trim();
  const command = parseCalculateCommand(probe);
  return command != null && command.remainder === '';
}

export function classifyConversationAdmission(rawFinal: string): ConversationAdmissionDecision {
  const raw = rawFinal.trim();
  let classification: ConversationAdmissionClass = 'ORDINARY';

  if (!raw) {
    return { classification, bypassMutation: false, admits: false, protectedOrdinalSpans: [] };
  }

  // Preserve WorkOnBoardIntent's whole-command grammar, including terminal ?.
  if (WHOLE_BOARD_IMPERATIVE_RE.test(raw) && !FOLLOWING_QUERY_OR_REFERENCE_RE.test(raw)) {
    return { classification, bypassMutation: false, admits: false, protectedOrdinalSpans: [] };
  }

  if (isAnchoredQuery(raw)) {
    classification = 'QUERY_TRIGGER';
  } else if (isWholeReference(raw)) {
    classification = 'REFERENCE_TRIGGER';
  } else {
    const questionShaped = hasQuestionShape(raw);
    const embeddedQuery = hasEmbeddedQuery(raw);
    const embeddedReference = new RegExp(
      `\\b(?:start\\s+with|go\\s+with|use)\\s+(?:(?:the\\s+)?(?:${REFERENCE_WORD})\\b|that\\b|this\\b)`,
      'i'
    ).test(raw);

    if ((embeddedQuery || embeddedReference) && !questionShaped) {
      classification = 'MIXED';
    } else if (questionShaped) {
      // A grammatical question containing a marker is explicitly admitted.
      // Subjectless question punctuation remains QUESTION_SHAPED.
      const subjectless = !WH_CLAUSE_RE.test(raw) && !hasAuxiliaryQuestionClause(raw);
      if (embeddedQuery || embeddedReference) classification = 'MIXED';
      else if (!subjectless && MARKER_RE.test(raw)) classification = 'QUERY_TRIGGER';
      else classification = 'QUESTION_SHAPED';
    }
  }

  // A01P — two-stage whole-Calculate carve-out (beside WorkOnBoardIntent's
  // WHOLE_BOARD_IMPERATIVE_RE above). Stage 1's raw evidence is preserved:
  // the provisional protected spans feed the probe and ride the decision.
  if (classification === 'QUESTION_SHAPED') {
    const provisionalSpans = findProtectedOrdinalSpans(rawFinal, classification);
    if (isWholeCalculateCommand(rawFinal, provisionalSpans)) {
      return {
        classification: 'ORDINARY',
        bypassMutation: false,
        admits: false,
        protectedOrdinalSpans: provisionalSpans,
      };
    }
  }

  const bypassMutation = classification !== 'ORDINARY';
  const admits = classification === 'QUERY_TRIGGER' || classification === 'REFERENCE_TRIGGER';
  return {
    classification,
    bypassMutation,
    admits,
    protectedOrdinalSpans: findProtectedOrdinalSpans(rawFinal, classification),
  };
}
