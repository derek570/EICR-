# Stage 0.D — Voice fidelity A/B (Derek listens)

**Bench:** `scripts/voice-latency-bench/voice-ab-samples.mjs`
**Date generated:** 2026-05-23
**Samples:** 40 audio files in `stage0-results/voice-ab-samples/`
**Cost:** ~$1.37 (one-time)

## How to listen

Sample naming: `<model>_<format>_<n>.<ext>`
- `flash` = `eleven_flash_v2_5` (locked default per PLAN_v2 1.4)
- `turbo` = `eleven_turbo_v2_5` (documented as deprecated alias for Flash;
  this A/B confirms whether the audio really is identical)
- `wav` = `pcm_22050` wrapped in WAV header (locked default per
  PLAN_v3 1.14 — sidesteps MP3 frame parsing in Swift)
- `mp3` = `mp3_22050_32` (contingency if PCM sounds worse)

Same `index.tsv` row maps each filename to its text.

Recommended listening order:

1. **PCM vs MP3 within Flash** — same model, same text, different format.
   Listen to e.g. `flash_wav_01.wav` then `flash_mp3_01.mp3`. Note any
   audible difference (artifacts, "fuzziness" on consonants, breathiness
   on long vowels).
2. **Flash vs Turbo within PCM** — same format, same text, different model.
   Listen to `flash_wav_01.wav` then `turbo_wav_01.wav`. The plan
   assumes these are identical; verify.
3. **Cross-check 3–4 more samples** to catch differences only audible on
   longer text (e.g. sample 8, the ask_user question).

## Verdict (Derek to fill in)

| Question | Answer |
|---|---|
| PCM ≈ MP3 within Flash? (acceptably close) | TBD — yes / no / depends-on-text |
| Flash ≈ Turbo within PCM? (truly identical?) | TBD — yes / no / one-better |
| **Locked model for Stage 2+:** | TBD — `eleven_flash_v2_5` (default) or `eleven_turbo_v2_5` |
| **Locked output format for Stage 2+:** | TBD — `pcm_22050` (default) or `mp3_22050_32` |
| If MP3 chosen: do you accept the 2–3 day MP3-parser implementation cost? | TBD — yes / no |
| Notes / artefacts heard | TBD |

If PCM is acceptable AND Flash ≈ Turbo: locked decisions 1.4 + 1.14 stand,
Stage 2 ships with `eleven_flash_v2_5 + pcm_22050`. This is the
recommended outcome.

If PCM is worse than MP3: the plan stays viable, but Stage 2 commit
plan changes — 2.1a (MP3 frame parser via AudioFileStreamOpen) + 2.1b
(integrate parser into StreamingAudioPlayer) get added. ~2-3 day cost.

If Flash and Turbo sound different: surface to Derek before proceeding;
may indicate ElevenLabs has un-aliased them since the docs were written.
