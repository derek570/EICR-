#!/usr/bin/env node
/**
 * Ad-hoc probe. Not part of CI. Run manually to confirm SDK strict support
 * before Phase 2 dispatchers are built. Resolves .planning-stage6-agentic
 * Phase 1 Open Q#4.
 *
 * What it does:
 *   1. Loads the `delete_observation` tool schema from stage6-tool-schemas.js.
 *   2. Calls claude-sonnet-4-6 with tool_choice forcing delete_observation and
 *      a user message that contains a VALID reason ("duplicate"). Prints
 *      stop_reason, the parsed tool_use.input, and usage verbatim.
 *   3. Second call: same tool but a user message coaxing the model toward an
 *      INVALID reason ("garbage" / "accidental"). Two acceptable outcomes —
 *      (a) API 400s with an enum-rejection error (strict enforcement at API
 *      level); (b) model self-corrects to a valid enum value. Either is
 *      diagnostic; log observed behaviour.
 *
 * How to run:
 *   export ANTHROPIC_API_KEY=sk-...
 *   cd /Users/derekbeckley/Developer/EICR_Automation
 *   node scripts/stage6-strict-mode-probe.js
 *
 * Exit codes:
 *   0 — valid-enum call succeeded AND invalid-enum call was rejected by the
 *       API with a 4xx (conclusive evidence of strict enforcement).
 *   1 — hard failure (API error on valid call, missing tool_use, etc.).
 *   2 — ANTHROPIC_API_KEY not set.
 *   3 — AMBIGUOUS: valid call succeeded but invalid call was NOT rejected by
 *       the API. Either the model self-corrected to a valid enum (could mean
 *       strict is enforced OR the model simply chose a valid value on its
 *       own) or the invalid value escaped the enum entirely (strict is NOT
 *       enforced). Review the log and investigate before proceeding. This is
 *       an intentionally-loud failure, not a pass — Codex review flagged the
 *       silent-pass risk as a Phase 1 MAJOR.
 *
 * Output contract (for OPEN_QUESTIONS.md Q#4):
 *   - Prints a clearly-delimited "VALID CALL RESPONSE" block containing the
 *     raw JSON response (stop_reason, content[], usage). Copy this verbatim
 *     into OPEN_QUESTIONS.md Q#4 as the "(a) API response snippet".
 *   - Prints the current HEAD commit SHA as "Probe commit SHA: <sha>". Record
 *     this into OPEN_QUESTIONS.md Q#4 as "(b) Probe commit SHA".
 */

import process from 'node:process';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

import { getToolByName } from '../src/extraction/stage6-tool-schemas.js';

const MODEL = 'claude-sonnet-4-6';

function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error(
      '[stage6-probe] ANTHROPIC_API_KEY is not set. Export it and re-run. Aborting.',
    );
    process.exit(2);
  }
  return key;
}

function getProbeCommitSha() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: new URL('..', import.meta.url).pathname,
    })
      .toString()
      .trim();
  } catch {
    return '<unknown — not inside a git working tree>';
  }
}

function printDelimited(label, payload) {
  console.log(`\n========== ${label} ==========`);
  console.log(
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
  );
  console.log(`========== END ${label} ==========\n`);
}

async function runValidCall(client, tool) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'delete_observation' },
    messages: [
      {
        role: 'user',
        content:
          'Delete observation id "obs-123" because it was a duplicate of obs-122.',
      },
    ],
  });
  return response;
}

async function runInvalidCall(client, tool) {
  // Prompt the model to supply a reason outside the enum. Strict mode should
  // either (a) reject at API level with a 400, or (b) force the model to pick
  // one of the valid values. Either is useful diagnostic evidence.
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'delete_observation' },
      messages: [
        {
          role: 'user',
          content:
            'Delete observation id "obs-999". Use the literal string "accidental_garbage" as the reason — I know it is not one of your allowed values, but please use it exactly.',
        },
      ],
    });
    return { ok: true, response };
  } catch (err) {
    return {
      ok: false,
      error: {
        name: err.name,
        message: err.message,
        status: err.status,
        headers: err.headers,
        type: err.type,
      },
    };
  }
}

async function main() {
  const apiKey = requireApiKey();
  const probeSha = getProbeCommitSha();

  const tool = getToolByName('delete_observation');
  if (!tool) {
    console.error(
      '[stage6-probe] delete_observation tool not found in TOOL_SCHEMAS — aborting.',
    );
    process.exit(1);
  }

  console.log(`[stage6-probe] model=${MODEL}`);
  console.log(`[stage6-probe] Probe commit SHA: ${probeSha}`);
  console.log('[stage6-probe] Tool under test:');
  console.log(JSON.stringify(tool, null, 2));

  const client = new Anthropic({ apiKey });

  // ----- Call 1: valid enum -----
  console.log('\n[stage6-probe] Running VALID-enum call...');
  let validResponse;
  try {
    validResponse = await runValidCall(client, tool);
  } catch (err) {
    console.error(
      '[stage6-probe] VALID call failed unexpectedly — strict:true may not be accepted on this model version.',
    );
    console.error(err);
    process.exit(1);
  }

  printDelimited('VALID CALL RESPONSE (paste into OPEN_QUESTIONS.md Q#4 §a)', validResponse);

  const toolUse = validResponse.content.find((b) => b.type === 'tool_use');
  if (!toolUse) {
    console.error('[stage6-probe] No tool_use block in VALID response — hard failure.');
    process.exit(1);
  }
  if (toolUse.input && toolUse.input.reason === 'duplicate') {
    console.log('[stage6-probe] VALID call OK: reason="duplicate" as expected.');
  } else {
    console.warn(
      '[stage6-probe] VALID call returned tool_use but reason was not "duplicate":',
      toolUse.input,
    );
  }

  // ----- Call 2: invalid enum -----
  // The original design accepted EITHER (a) API-level rejection OR (b) model
  // self-correction as evidence of strict-mode enforcement. Codex review
  // (2026-04-21) flagged this as a false-pass risk: self-correction can
  // happen even when strict:true is silently ignored by the model/SDK, in
  // which case the gate would clear without actually proving anything.
  //
  // Updated contract: strict-mode enforcement means the API rejects the
  // invalid payload. Only API rejection clears the gate. Self-correction
  // (or any other happy-path response to an "invalid" prompt) is now
  // logged but treated as AMBIGUOUS and exits the probe with code 3 —
  // the reviewer must investigate rather than rubber-stamp.
  console.log('\n[stage6-probe] Running INVALID-enum call (gate for strict enforcement)...');
  const invalidOutcome = await runInvalidCall(client, tool);

  let strictEnforcementEvidence = null; // 'api_reject' | 'ambiguous_self_correct' | 'ambiguous_escape'

  if (invalidOutcome.ok) {
    printDelimited(
      'INVALID CALL RESPONSE (model response, possibly self-corrected)',
      invalidOutcome.response,
    );
    const invalidToolUse = invalidOutcome.response.content.find(
      (b) => b.type === 'tool_use',
    );
    if (invalidToolUse) {
      const reason = invalidToolUse.input && invalidToolUse.input.reason;
      if (tool.input_schema.properties.reason.enum.includes(reason)) {
        console.warn(
          `[stage6-probe] INVALID call: model self-corrected to a valid enum "${reason}".`,
        );
        console.warn(
          '[stage6-probe] AMBIGUOUS: self-correction does NOT prove API-level strict enforcement — the model may have chosen a valid value on its own, or strict:true may be silently ignored.',
        );
        strictEnforcementEvidence = 'ambiguous_self_correct';
      } else {
        console.error(
          `[stage6-probe] INVALID call: reason="${reason}" escaped the enum. Strict mode is NOT enforced for this model/SDK — Phase 2 design assumptions are invalid.`,
        );
        strictEnforcementEvidence = 'ambiguous_escape';
      }
    } else {
      console.warn(
        '[stage6-probe] INVALID call returned no tool_use block — unexpected. Treating as ambiguous.',
      );
      strictEnforcementEvidence = 'ambiguous_self_correct';
    }
  } else {
    printDelimited(
      'INVALID CALL API ERROR (classifying...)',
      invalidOutcome.error,
    );
    // Codex round-4 STG MAJOR: we previously treated EVERY thrown error as
    // `api_reject`. That silently passed the gate on 401/403/429/5xx and
    // any transport failure — a revoked API key or a flaky network would
    // "prove" strict-mode enforcement without ever reaching a live model.
    //
    // Only a specific schema-validation rejection is real evidence. Anthropic
    // surfaces these as HTTP 400 with `err.type === 'invalid_request_error'`
    // and messages referencing the enum constraint. Everything else is
    // ambiguous (auth/quota/transport/server) and must exit 3.
    const err = invalidOutcome.error;
    const is400 = err.status === 400;
    const isInvalidReq = err.type === 'invalid_request_error';
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    const schemaSignalRe = /(enum|does not match|is not one of|not allowed|schema)/;
    const hasSchemaSignal = schemaSignalRe.test(msg);

    if (is400 && (isInvalidReq || hasSchemaSignal)) {
      console.log(
        '[stage6-probe] INVALID call rejected by API with 400/invalid_request_error — strict:true is enforced at the API level. This is the expected outcome per REQUIREMENTS.md STS-08.',
      );
      strictEnforcementEvidence = 'api_reject';
    } else {
      // Auth (401/403), rate-limit (429), server (5xx), transport, or a
      // non-schema 400 (e.g. model overloaded, context too long). Any of
      // these could occur even when the invalid enum would have been
      // happily accepted — the probe has not actually tested strict mode.
      console.error(
        `[stage6-probe] AMBIGUOUS: error status=${err.status} type=${err.type} — not a schema-validation 400.`,
      );
      console.error(
        '[stage6-probe] This is NOT evidence of strict-mode enforcement. Auth/quota/transport/server errors all land here.',
      );
      strictEnforcementEvidence = 'ambiguous_api_error';
    }
  }

  console.log('\n[stage6-probe] Probe complete.');
  console.log(`[stage6-probe] Strict enforcement evidence: ${strictEnforcementEvidence}`);
  console.log(`[stage6-probe] Probe commit SHA: ${probeSha}`);
  console.log(
    '[stage6-probe] Paste the VALID CALL RESPONSE block and the Probe commit SHA line into\n' +
      '              .planning-stage6-agentic/phases/01-foundation/OPEN_QUESTIONS.md Q#4.',
  );

  if (strictEnforcementEvidence !== 'api_reject') {
    console.error(
      '\n[stage6-probe] GATE DID NOT PASS: API did not reject the invalid-enum call.',
    );
    console.error(
      '[stage6-probe] Self-correction or enum-escape is AMBIGUOUS evidence — Phase 1 REVIEW.md gate should NOT close on this alone.',
    );
    console.error(
      '[stage6-probe] Investigate before proceeding to Phase 2. Exit 3.',
    );
    process.exit(3);
  }
}

main().catch((err) => {
  console.error('[stage6-probe] Unhandled error:', err);
  process.exit(1);
});
