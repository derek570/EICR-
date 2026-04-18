// observation-code-lookup.js
//
// Refines an observation's BPG4 Issue 7.1 classification code (C1/C2/C3/FI) and
// BS 7671 regulation citation using `gpt-5-search-api`. The app's USP is that the
// electrician dictates "observation: <defect>" and the app picks the code and
// regulation — RULE 3 of the extraction prompt makes this explicit, but Sonnet's
// knowledge of BPG4 specifics varies and it sometimes emits observations with
// medium confidence or an incomplete regulation citation. Refining with a web
// search gives us current NICEIC / Electrical Safety First / IET guidance and
// the exact BS 7671 wording.
//
// This runs AFTER the extraction response has been sent to iOS. On success it
// emits an `observation_update` WebSocket message that the iOS client applies
// by matching on `observation_text`.
//
// Called from src/extraction/sonnet-stream.js.

import logger from '../logger.js';

const VALID_CODES = new Set(['C1', 'C2', 'C3', 'FI']);

/**
 * Decide whether an observation needs refinement. Cheap gate so we don't
 * spend search tokens on observations Sonnet already nailed.
 *
 * @param {object} obs
 * @returns {boolean}
 */
export function needsRefinement(obs) {
  if (!obs || typeof obs !== 'object') return false;
  const text = obs.observation_text || obs.description || '';
  if (!text || text.length < 8) return false;

  // No code at all — always refine.
  if (!obs.code || !VALID_CODES.has(String(obs.code).toUpperCase())) return true;

  // Missing regulation citation (number + wording) — always refine.
  const reg = String(obs.regulation || '').trim();
  if (!reg || !/\d{3}/.test(reg) || reg.length < 12) return true;

  // Sonnet explicitly told us it was unsure.
  const conf = (obs.confidence || '').toString().toLowerCase();
  if (conf && conf !== 'high') return true;

  return false;
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

  const prompt = [
    'You are an expert UK electrical inspector classifying EICR observations.',
    '',
    'DEFECT DESCRIPTION (from the inspector):',
    JSON.stringify(description),
    '',
    context.installationType ? `Installation type: ${context.installationType}` : '',
    context.location ? `Location: ${context.location}` : '',
    currentCode ? `Current candidate code: ${currentCode}` : '',
    currentReg ? `Current candidate regulation: ${currentReg}` : '',
    '',
    'Using Electrical Safety First Best Practice Guide 4 (BPG4) Issue 7.1 and BS 7671:2018+A2:2022,',
    'determine the correct classification code and the most relevant regulation for this defect.',
    '',
    'Codes (pick EXACTLY ONE):',
    '- C1: Danger present. Someone can be hurt right now.',
    '- C2: Potentially dangerous. Would become dangerous under a reasonably foreseeable event.',
    '- C3: Improvement recommended. Non-compliance, not dangerous.',
    '- FI: Further investigation required to determine condition.',
    '',
    'Rules:',
    '- Do NOT over-code. Older installations compliant with an earlier edition are usually C3 or lower.',
    '- Do NOT invent hazards not stated in the description.',
    '- If the description is ambiguous, prefer the LESS severe code and note ambiguity in rationale.',
    '- Regulation must be a specific BS 7671 number plus the regulation wording.',
    '',
    'Return ONLY a JSON object (no prose) shaped exactly like:',
    '{"code":"C2","regulation":"Reg 411.3.3 — Additional protection: socket-outlets...","rationale":"Short reason","source":"BPG4 Issue 7.1 table reference or URL"}',
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

    logger.info('Observation refined via web search', {
      elapsedMs,
      tokens,
      before: { code: currentCode, reg: currentReg ? currentReg.slice(0, 40) : null },
      after: { code, reg: regulation.slice(0, 40) },
    });

    return {
      code,
      regulation,
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
