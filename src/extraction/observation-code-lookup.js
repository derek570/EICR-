// observation-code-lookup.js
//
// Refines an observation in three dimensions using `gpt-5-search-api`:
//   1. BPG4 Issue 7.1 classification code (C1/C2/C3/FI)
//   2. BS 7671 regulation citation (number + wording)
//   3. Schedule of Inspection section (`schedule_item`, e.g. "5.4" for bonding)
//   4. Professional rewrite of the observation text in BS 7671 language
//
// The app's USP is that the electrician dictates "observation: <defect>" in
// natural speech and the certificate ends up with a properly-coded,
// regulation-cited, schedule-linked, professionally-worded observation
// without manual cleanup. Sonnet does the immediate first-pass extraction
// (so the inspector sees the row in the UI within ~200ms), then this
// refinement runs in the background and patches the row in place via an
// `observation_update` WS message ~2s later.
//
// 2026-05-01 — restored Stage C (`schedule_item`) and added Stage D
// (`professional_text` rewrite) following the legacy `extract_chunk.js`
// pipeline that was lost during the Stage 6 tool-schema migration. iOS
// already has the consumer plumbing (`ObservationScheduleLinker.swift` +
// the `observation_update` handler patches text/code/regulation in place).
//
// Refinement now ALWAYS runs (no `needsRefinement` gate) — the text rewrite
// is the new value-add and short-circuiting on a "good enough" first pass
// would skip it. The cost (~$0.02-0.05/observation in gpt-5-search-api +
// web search) is acceptable at the £3/cert margin; Derek explicitly opted
// in to the always-rewrite design.
//
// Called from src/extraction/sonnet-stream.js.

import logger from '../logger.js';

export const VALID_CODES = new Set(['C1', 'C2', 'C3', 'FI']);

/**
 * Always-true gate kept as a function for symmetry with the legacy API
 * (callers test `if (needsRefinement(obs))` before invoking refinement).
 * Returning false on missing/empty text avoids spending tokens on a row
 * that has nothing to refine — that's still a real save, not a heuristic.
 *
 * @param {object} obs
 * @returns {boolean}
 */
export function needsRefinement(obs) {
  if (!obs || typeof obs !== 'object') return false;
  const text = obs.observation_text || obs.description || '';
  if (!text || text.length < 8) return false;
  return true;
}

/**
 * Call gpt-5-search-api to refine an observation's code and regulation.
 *
 * @param {object} openai           OpenAI client (already constructed by caller)
 * @param {object} obs              Observation object from Sonnet
 * @param {object} [context]        Optional context (installation type, etc.)
 * @returns {Promise<object|null>}  { code, regulation, rationale, source } or null on failure
 */
export async function refineObservation(openai, obs, context = {}) {
  if (!openai) {
    logger.warn('Observation refinement skipped — no openai client');
    return null;
  }
  const description = obs.observation_text || obs.description || '';
  if (!description) return null;

  const currentCode = obs.code ? String(obs.code).toUpperCase() : null;
  const currentReg = obs.regulation || null;
  const currentSchedule = obs.schedule_item || null;

  const prompt = [
    'You are an expert UK electrical inspector classifying EICR observations.',
    '',
    'INSPECTOR DICTATION (raw, conversational):',
    JSON.stringify(description),
    '',
    context.installationType ? `Installation type: ${context.installationType}` : '',
    context.location ? `Location: ${context.location}` : '',
    currentCode ? `Current candidate code: ${currentCode}` : '',
    currentReg ? `Current candidate regulation: ${currentReg}` : '',
    currentSchedule ? `Current candidate schedule item: ${currentSchedule}` : '',
    '',
    'Using Electrical Safety First Best Practice Guide 4 (BPG4) Issue 7.1 and BS 7671:2018+A2:2022,',
    'do four things:',
    "  (1) PROFESSIONAL_TEXT — rewrite the inspector's dictation as a single concise",
    '      sentence in formal BS 7671 inspector language. Describe the defect (NOT',
    '      the remedy). Strip filler words ("um", "yeah", "I can see"). Keep all',
    "      facts the inspector stated; never invent facts they didn't. This text",
    '      will appear verbatim on the EICR certificate.',
    '  (2) CODE — pick EXACTLY ONE classification:',
    '      - C1: Danger present. Someone can be hurt right now.',
    '      - C2: Potentially dangerous. Would become dangerous under a reasonably',
    '        foreseeable event.',
    '      - C3: Improvement recommended. Non-compliance, not dangerous.',
    '      - FI: Further investigation required to determine condition.',
    '  (3) REGULATION — the specific BS 7671 regulation breached (number + wording),',
    '      e.g. "Reg 411.3.3 — Additional protection: socket-outlets up to 32A".',
    '  (4) SCHEDULE_ITEM — the BS 7671 Schedule of Inspection section number this',
    '      defect maps to. Common mappings: 3.6 bonding-conductor sizing, 4.1',
    '      poor workmanship, 4.3 cable entries / IP rating, 4.4 fire-rated CU,',
    '      4.5 damaged enclosure / scorching, 4.9 circuit labelling, 5.4 main',
    '      bonding, 5.12.1 RCD additional protection on sockets. Return null if',
    '      no section cleanly applies.',
    '',
    'Rules:',
    '- Do NOT over-code. Older installations compliant with an earlier edition are usually C3 or lower.',
    '- Do NOT invent hazards not stated in the description.',
    '- If the description is ambiguous, prefer the LESS severe code and note ambiguity in rationale.',
    '- Regulation must be a specific BS 7671 number plus the regulation wording.',
    "- professional_text must NEVER add facts the inspector didn't state. Faithful rewrite only.",
    '',
    'Return ONLY a JSON object (no prose) shaped exactly like:',
    '{"professional_text":"...","code":"C2","regulation":"Reg 411.3.3 — Additional protection: socket-outlets...","schedule_item":"5.12.1","rationale":"Short reason","source":"BPG4 Issue 7.1 table reference or URL"}',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const started = Date.now();
    const searchResponse = await openai.chat.completions.create({
      model: 'gpt-5-search-api',
      web_search_options: {},
      messages: [{ role: 'user', content: prompt }],
    });
    const elapsedMs = Date.now() - started;
    const content = searchResponse.choices?.[0]?.message?.content || '';
    const tokens = searchResponse.usage?.completion_tokens || 0;

    // Pull out the JSON object. The search model often wraps JSON in prose.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn('Observation refinement returned no JSON', {
        preview: content.slice(0, 200),
      });
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      logger.warn('Observation refinement JSON parse failed', {
        error: err.message,
        preview: match[0].slice(0, 200),
      });
      return null;
    }

    const code = String(parsed.code || '')
      .toUpperCase()
      .trim();
    if (!VALID_CODES.has(code)) {
      logger.warn('Observation refinement returned invalid code', { code });
      return null;
    }

    const regulation = String(parsed.regulation || '').trim();
    if (!regulation || !/\d{3}/.test(regulation)) {
      logger.warn('Observation refinement returned weak regulation', { regulation });
      // Still return the code — a refined code without regulation beats nothing.
    }

    // Schedule item: keep null if the model returned null (legitimate — some
    // defects don't map cleanly to a Schedule of Inspection section). Reject
    // shapes that are obviously wrong (e.g. a sentence instead of a section
    // number) so we don't pollute the iOS schedule auto-tick logic.
    let scheduleItem = null;
    if (parsed.schedule_item != null && parsed.schedule_item !== '') {
      const candidate = String(parsed.schedule_item).trim();
      if (/^\d+(\.\d+)*[a-z]?$/i.test(candidate) && candidate.length <= 12) {
        scheduleItem = candidate;
      } else {
        logger.warn('Observation refinement returned malformed schedule_item', {
          schedule_item: candidate.slice(0, 40),
        });
      }
    }

    // Professional rewrite: must be non-empty and reasonably short (the
    // certificate column is sized for ~1-3 sentences). If the model returns
    // empty / suspiciously short text, fall back to the inspector's original
    // dictation rather than blanking the row.
    const rawRewrite = String(parsed.professional_text || '').trim();
    let professionalText = null;
    if (rawRewrite && rawRewrite.length >= 8 && rawRewrite.length <= 500) {
      professionalText = rawRewrite;
    } else if (rawRewrite) {
      logger.warn('Observation refinement returned out-of-bounds professional_text', {
        length: rawRewrite.length,
      });
    }

    logger.info('Observation refined via web search', {
      elapsedMs,
      tokens,
      before: {
        code: currentCode,
        reg: currentReg ? currentReg.slice(0, 40) : null,
        schedule: currentSchedule,
      },
      after: {
        code,
        reg: regulation.slice(0, 40),
        schedule: scheduleItem,
        rewrote_text: professionalText !== null,
      },
    });

    return {
      code,
      regulation,
      schedule_item: scheduleItem,
      professional_text: professionalText,
      rationale: String(parsed.rationale || '').slice(0, 400),
      source: String(parsed.source || '').slice(0, 200),
    };
  } catch (err) {
    logger.error('Observation refinement failed', {
      error: err.message,
      description: description.slice(0, 80),
    });
    return null;
  }
}
