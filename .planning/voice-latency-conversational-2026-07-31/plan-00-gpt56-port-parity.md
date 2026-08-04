# Plan 00 — GPT-5.6 provider-parity evidence bundle

Status: **RUNTIME STATUS EXTERNAL — run the committed Plan 00 status command below**

The RP-converged Plan 00 work is split into three dependency-locked plans. The files tracked in this repository are immutable reference copies only: their adjacent `.ep-policy.json` files disable execution. EP always uses the canonical handoff final recorded in [provenance.json](plan-00-gpt56-port-parity/provenance.json).

## Reviewed reference bundle

1. [Plan 00 umbrella](plan-00-gpt56-port-parity/PLAN-00-final.md)
2. [Plan 00A — provider, tool-result and cost parity](plan-00-gpt56-port-parity/PLAN-00A-final.md)
3. [Plan 00B — trusted production-composed semantic oracle](plan-00-gpt56-port-parity/PLAN-00B-final.md)
4. [Plan 00C — durable three-day field-evidence gate](plan-00-gpt56-port-parity/PLAN-00C-final.md)

Execution order is strictly `00A → 00B → 00C`. Each canonical child final requires an explicit `--no-chain` EP run. Plan 00B is machine-gated on 00A's merged, deployed success and tracked provenance artifact; Plan 00C is similarly gated on 00B's shipped semantic-oracle artifact.

## Current shipped baseline

- Provider resolution, session-owned clients and the whole-loop provider fence shipped in `a45996a6`.
- Core explicit GPT-5.6 prompt caching shipped in PR #150 (`94f56eea`); the 24-hour retention evaluation and any proposed 25-minute Terra re-warm remain deferred Plan 01 supplement work.
- Terra observation routing shipped in PR #147 (`60fd0f9d`) and is live as GPT-5.6 Terra Standard with low reasoning. Ordinary readings remain GPT-5.6 Luna Fast.
- Plan 00 does not shorten the two-round loop, change Deepgram or ElevenLabs, re-enable Loaded Barrel, enable eager endpointing or add cache keep-warm policy.

## Committed Plan 00 status command

Run the source-integrity check, then inspect the read-only live ECS selection:

```bash
npm run verify:plan00-provenance
aws ecs describe-task-definition \
  --task-definition "$(aws ecs describe-services --cluster eicr-cluster-production --services eicr-backend --region eu-west-2 --query 'services[0].taskDefinition' --output text)" \
  --region eu-west-2 \
  --query "{Revision:taskDefinition.revision,Image:taskDefinition.containerDefinitions[0].image,Environment:taskDefinition.containerDefinitions[0].environment[?name=='SONNET_EXTRACT_MODEL' || name=='OPENAI_EXTRACT_SERVICE_TIER' || name=='OBSERVATION_EXTRACT_MODEL' || name=='OBSERVATION_TIER_ROUTING' || name=='VOICE_LATENCY_ROUND1_MODEL']}" \
  --output json
```

Do not copy a runtime HOLD/DONE value into this tracked entry point. Runtime truth lives in EP outcome/success artifacts, the merged commit and the deployed ECS task definition.
