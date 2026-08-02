# Voice latency and conversational-mode plan batch

Status: **DRAFT — not RP-reviewed and not approved for execution; Plan 01 core is live, retention supplement remains draft**
Prepared: 2026-07-31
Canonical backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Canonical iOS repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`

This directory is a set of separate RP inputs. It deliberately does not combine the experiments into one implementation wave: each lever needs its own evidence, rollback and reviewer decision. No plan reintroduces the removed round-one fast exit. Luna remains authoritative through the complete tool loop, including its opportunity to self-correct, ask, and answer naturally. The currently live, parked-audio form of Loaded Barrel is assessed separately rather than confused with that deleted fast exit.

## Port audit conclusion

The GPT-5.6 Luna migration is operationally live and its main mechanics are correct:

- source and live ECS both select `SONNET_EXTRACT_MODEL=gpt-5.6-luna`;
- source and live ECS both select `OPENAI_EXTRACT_SERVICE_TIER=fast`;
- the Responses adapter retains encrypted reasoning items across rounds, streams tool calls to Loaded Barrel, maps usage, and records the provider-reported model/tier;
- focused adapter/tool-loop/routing tests pass;
- the recorded nine-utterance A/B scored 8/9 for both Haiku and Luna, although they did not miss the same case.

It is not yet parity-complete. Plan 00 owns three findings:

1. `flattenSystem()` concatenates Anthropic prompt blocks with no delimiter, so the stable snapshot and volatile tail can merge tokens on Luna.
2. provider choice is latched from the default model, while observation-tier and round-one overrides change only the model string. The currently dark observation flag or a future cross-provider round-one override could therefore send a Claude model name to the OpenAI adapter.
3. Luna missed the captured `IR L to L 100` case that Haiku extracted. The corpus is too small to call this a general quality regression, but the miss needs a pinned regression and paced rerun before parity is signed off.

The first two defects are latent or prompt-shape defects, not evidence that the current production session used Haiku. Current production flags keep both dormant cross-provider routes off.

## Plans and order

| Order | Plan | Purpose | Dependencies |
|---|---|---|---|
| 00 | [GPT-5.6 port parity](plan-00-gpt56-port-parity.md) | Correct prompt/provider parity and close the known IR miss | None; prerequisite for Plan 01 and any tier routing |
| 01 | [Explicit prompt caching](plan-01-gpt56-explicit-prompt-cache.md) | Core explicit cache is live; refine 24-hour retention before considering any 25-minute Terra re-warm | Plan 00 |
| 02 | [iOS incremental TTS playback](plan-02-ios-incremental-tts-streaming.md) | Play ElevenLabs PCM as chunks arrive instead of awaiting the whole response | Plan 00; enables the full benefit of Plan 03 |
| 03 | [Persistent ElevenLabs session and tuning](plan-03-elevenlabs-persistent-session.md) | Reuse the multi-context socket and test safe synthesis settings | Plan 00; production rollout after Plan 02 |
| 04 | [Deepgram Flux Eager EOT](plan-04-deepgram-flux-eager-eot.md) | Measure and cautiously speculate before authoritative EndOfTurn | Plan 00; independent of Plans 01–03 |
| 05 | [Safe `answer_user` pre-synthesis](plan-05-answer-user-presynthesis-full-loop.md) | Overlap answer TTS with the remaining Luna loop without early playback | Plans 00 and 02; Plan 03 recommended |
| 06 | [General conversational lane](plan-06-general-conversational-lane.md) | Permit natural general conversation while isolating certificate mutation | Plan 00; Plan 05 recommended for latency |
| 07 | [Loaded Barrel value audit](plan-07-loaded-barrel-value-audit.md) | Playback evidence chain shipped; measure the live parked-audio saving and retain, narrow or retire it | Phase 1 complete; Plan 00 for remaining code changes; measure before Plans 02–03 alter TTS |

Recommended execution sequence is `00 → 07 → 01 → 02 → 03 → 04 → 05 → 06`. Plan 07 should capture its baseline before Plans 02–03 change the TTS waterfall. Plan 04 can be refined in parallel with Plans 01–03, but its mutation-capable phase must wait for its own shadow-data gate.

## Future RP commands

Run from the canonical backend repository after usage credit is available.

Refine the complete batch without handing it to EP:

```bash
/rp --batch /Users/derekbeckley/Developer/EICR_Automation/.planning/voice-latency-conversational-2026-07-31/plan-*.md --no-ship
```

Refine one plan at a time (recommended for the cross-repo iOS plans):

```bash
/rp /Users/derekbeckley/Developer/EICR_Automation/.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity.md --no-ship
```

After every plan is converged and the chosen dependencies have shipped, omit `--no-ship` only for the specific plan intended to continue into EP. Do not batch-execute all levers; preserve separate measurements and rollback attribution.

## Shared success metric

The target is mouth-stop to first audible confirmation/answer. Continue reporting the existing authoritative Flux EndOfTurn metric, but add a device-local speech-stop estimate so turn-detection savings are not hidden. Report p50, p75, p95 and sample count, split by:

- reading confirmation versus question/answer;
- single-round versus multi-round Luna turns;
- Wi-Fi versus cellular;
- warm versus cold prompt/TTS connection;
- legacy versus experiment cohort.

No plan may trade away these audio-first invariants: every applied dictated reading is spoken exactly once; cancelled/speculative work is never spoken or written; barge-in remains safe; and the complete Luna loop remains authoritative.
