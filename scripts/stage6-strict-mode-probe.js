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
 *   0 — valid-enum call succeeded with the expected tool_use + parsed input.
 *   1 — hard failure (API error on valid call, missing tool_use, etc.).
 *   2 — ANTHROPIC_API_KEY not set.
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
  console.log('\n[stage6-probe] Running INVALID-enum call (diagnostic)...');
  const invalidOutcome = await runInvalidCall(client, tool);

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
        console.log(
          `[stage6-probe] INVALID call: model self-corrected to a valid enum "${reason}" (strict:true likely enforced client-side by API).`,
        );
      } else {
        console.warn(
          `[stage6-probe] INVALID call: reason="${reason}" escaped the enum. Strict mode may NOT be enforced for this model/SDK.`,
        );
      }
    }
  } else {
    printDelimited(
      'INVALID CALL API ERROR (expected under strict enforcement)',
      invalidOutcome.error,
    );
    console.log(
      '[stage6-probe] INVALID call rejected by API — strict:true is enforced at the API level. This is the expected outcome per REQUIREMENTS.md STS-08.',
    );
  }

  console.log('\n[stage6-probe] Probe complete.');
  console.log(`[stage6-probe] Probe commit SHA: ${probeSha}`);
  console.log(
    '[stage6-probe] Paste the VALID CALL RESPONSE block and the Probe commit SHA line into\n' +
      '              .planning-stage6-agentic/phases/01-foundation/OPEN_QUESTIONS.md Q#4.',
  );
}

main().catch((err) => {
  console.error('[stage6-probe] Unhandled error:', err);
  process.exit(1);
});
