/**
 * Plan 00B-4 §C1d — the model/tier identity of each live lane, in ONE place.
 *
 * A terminal DECLARES the model and tier it was produced under, and `fold.mjs`
 * enforces that declaration (pinned_ir must be a Luna-family model on a FAST
 * tier; a `vendor_corpus` terminal's model must match its `model_lane`). But the
 * declaration is just a payload field — nothing downstream can see what the
 * vendor call ACTUALLY used. The dispatched model comes from
 * `SONNET_EXTRACT_MODEL` (read by `EICRExtractionSession` at construction AND at
 * call time) and the dispatched tier from `OPENAI_EXTRACT_SERVICE_TIER` (read by
 * the Responses adapter). Nothing joins those two facts up.
 *
 * So a coordinator that sets the env in one place and passes model/tier to
 * `runReservedAttempt` from another can produce a perfectly fold-legal terminal
 * claiming `gpt-5.6-luna`/`fast` for a call that actually ran on the
 * `claude-sonnet-4-6` default at standard tier. That evidence is not merely
 * wrong, it is UNFALSIFIABLE after the fact — the provider ids and the report
 * would all agree with each other and with a lie.
 *
 * This module removes the second place. `pinLaneModelEnv` sets the environment
 * FROM the same frozen descriptor the caller then declares, so the declared
 * identity and the dispatched identity are the same object by construction.
 *
 * The values mirror `ecs/task-def-backend.json` — the live lane's whole claim is
 * "the deployed stack still behaves", which is only true if it dispatches the
 * deployed configuration. `OBSERVATION_EXTRACT_MODEL` is deliberately NOT
 * mirrored: `pinLiveLaneEnv` pins `OBSERVATION_TIER_ROUTING='false'`, so every
 * lane turn takes the default-model branch and a lane is a single-model probe by
 * design. Introducing a second model mid-run would make `model`/`tier` on the
 * terminal a half-truth.
 */

/**
 * `env` is the FULL set of model-selecting variables each lane pins — including
 * the ones it wants OFF. A coordinator process may run the luna lane and then
 * the haiku lane; omitting `OPENAI_EXTRACT_SERVICE_TIER` from the haiku
 * descriptor would leave `fast` set from the previous lane, which is dormant
 * today (haiku dispatches to Anthropic) and a live mis-declaration the moment
 * anything routes an OpenAI call. Every lane states every variable.
 */
export const LANE_MODELS = Object.freeze({
  luna: Object.freeze({
    model_lane: 'luna',
    model: 'gpt-5.6-luna',
    tier: 'fast',
    provider: 'openai',
    env: Object.freeze({
      SONNET_EXTRACT_MODEL: 'gpt-5.6-luna',
      OPENAI_EXTRACT_SERVICE_TIER: 'fast',
      OPENAI_EXTRACT_PROMPT_CACHE: 'explicit',
    }),
  }),
  haiku: Object.freeze({
    model_lane: 'haiku',
    model: 'claude-haiku-4-5-20251001',
    tier: 'standard',
    provider: 'anthropic',
    env: Object.freeze({
      SONNET_EXTRACT_MODEL: 'claude-haiku-4-5-20251001',
      // Dormant on this lane (Anthropic has no service tier), pinned anyway so
      // a preceding luna run in the same process cannot leak `fast` forward.
      OPENAI_EXTRACT_SERVICE_TIER: 'standard',
      OPENAI_EXTRACT_PROMPT_CACHE: 'explicit',
    }),
  }),
});

/**
 * The pinned IR probe runs the LIVE lane — the one the deployment is actually
 * serving — because its question is "does the deployed stack still behave",
 * not "does some model behave". `fold.mjs` independently requires a Luna-family
 * model on a FAST tier for `pinned_ir`, so this constant and that rule must
 * agree; a test pins the agreement rather than trusting the comment.
 */
export const PINNED_IR_MODEL_LANE = 'luna';

/** Look up a lane descriptor. Unknown lanes throw — never a silent default. */
export function resolveLaneModel(modelLane) {
  const descriptor = Object.prototype.hasOwnProperty.call(LANE_MODELS, modelLane)
    ? LANE_MODELS[modelLane]
    : null;
  if (!descriptor) {
    throw new Error(
      `resolveLaneModel: unknown model lane ${JSON.stringify(modelLane)}; ` +
        `known lanes: ${Object.keys(LANE_MODELS).join(', ')}`
    );
  }
  return descriptor;
}

/**
 * Pin the lane's model-selecting environment and return the descriptor the
 * caller must ALSO declare on the terminal. Call BEFORE `bootLiveLaneDriver`:
 * the SDK clients and the session both read these variables, and the session
 * snapshots `SONNET_EXTRACT_MODEL` into `defaultExtractionModel` at
 * construction.
 */
export function pinLaneModelEnv(modelLane, env = process.env) {
  const descriptor = resolveLaneModel(modelLane);
  for (const [name, value] of Object.entries(descriptor.env)) {
    env[name] = value;
  }
  return descriptor;
}
