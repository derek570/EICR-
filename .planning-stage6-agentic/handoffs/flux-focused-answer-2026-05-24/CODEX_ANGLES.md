# Codex CLI brainstorm — 12 divergent angles

> Run 2026-05-24, methodology=divergent, reasoningEffort=high. F = feasibility,
> I = impact, N = novelty (each 1-5).

### Idea 1: Speculative Interim Dispatch — F:5 I:5 N:3
When in an `ask_user` window, dispatch stable interim text like "eight"
after ~300-500ms of silence, before Flux final EOT. Better than tuning
because normal Flux behaviour stays untouched; cost is low iOS work, no
runtime cost, with risk of sending corrected interim text too early.
Validate by replaying 50 short-answer clips and measuring interim
stability vs final transcript.

### Idea 2: Local VAD Turn Endpoint — F:5 I:5 N:3
Treat focused answers as audio-turns ended by local silence detection,
not semantic EOT. Better because "done speaking" is acoustic, not
semantic; likely 1-2 days iOS work, no runtime cost, risk is clipping
hesitant answers. Validate with a local WebRTC VAD prototype on
recorded inspector answers.

### Idea 3: Focused Answer Audio Gate — F:5 I:4 N:3
After TTS completes, open a 3-second "answer capture" gate where first
speech burst plus 300ms silence forces dispatch of current transcript.
Better than threshold tuning because it is scoped to the UX moment, not
STT semantics; low cost, risk is multi-word answers getting cut.
Validate with scripted answers: "eight", "circuit eight", "I think
it's eight".

### Idea 4: Local Digit / Short-Answer Recognizer — F:4 I:5 N:4
Run a tiny on-device grammar recognizer for digits, yes/no, common
circuit labels, and send its result immediately while Flux continues
for display / correction. Better because the common bad case bypasses
semantic EOT entirely; medium iOS work, zero cloud cost, accuracy risk
on accents / noise. Validate with Apple Speech or a small keyword
model against 100 real short clips.

### Idea 5: Dual Path Fast Commit — F:3 I:4 N:4
In focused mode, feed audio both to Flux and a cheap fast endpoint /
config; commit whichever produces a confident short answer first.
Better because it separates latency from transcript quality;
engineering cost medium, runtime cost slightly higher but only during
ask_user. Validate with a replay harness comparing latency / cost for
focused-answer clips.

### Idea 6: Client-Side Semantic Completeness — F:4 I:4 N:4
iOS maintains expected answer types from the visible question, then
considers "eight" complete for "Which circuit…" without waiting for
Flux final. Better because completeness is question-aware but
STT-agnostic; medium iOS logic cost, no runtime cost, risk is brittle
question parsing. Validate by classifying the last 100 `ask_user`
prompts into expected answer schemas.

### Idea 7: Ask-User Metadata Side Channel — F:4 I:4 N:3
Without backend changes, infer answer type from the TTS text before
playback and set a local answer policy: digit, yes/no, free text,
selection, location. Better than STT tuning because each question gets
a latency policy; low-medium cost, no runtime cost, risk is
misclassification. Validate with logged ask_user questions and a
simple rules / LLM-offline classifier.

### Idea 8: Push-to-Confirm Micro Interaction — F:4 I:3 N:3
In focused mode, show the interim "eight" as tappable / auto-selected
and let inspector confirm by continuing silence, tap, or hardware
button. Better because the UI can resolve uncertainty faster than STT
EOT; low-medium cost, no runtime cost, risk is adding friction.
Validate with a clickable prototype during mock inspection flow.

### Idea 9: Audio Chunk Finalization Timeout — F:3 I:4 N:4
If focused-mode audio contains speech shorter than ~700ms followed by
300ms silence, close / reopen the Flux socket or audio segment to
force finalization. Better because it uses transport boundaries
instead of model thresholds; medium cost, no extra runtime cost, risk
is reconnect latency or lost context. Validate by manually replaying
"eight" clips through forced close timing.

### Idea 10: Question-Specific Deepgram Reconnect — F:4 I:4 N:2
Reconnect Flux only for constrained answer prompts with aggressive
timeout / eager settings, then restore normal dictation config
immediately after one answer. Better than generic focused tuning
because only high-confidence question types get the fast config;
medium engineering cost, negligible runtime cost, risk is WS churn.
Validate by measuring reconnect time plus finalization latency on
device.

### Idea 11: Local Silence Sends "Commit Current Interim" — F:5 I:5 N:3
Keep Flux unchanged, but after local silence in focused mode send the
latest interim transcript as if final, tagging internally as
speculative only in iOS state. Better because it avoids EOT entirely
and preserves backend immutability if the payload shape is identical;
low cost, no runtime cost, risk is backend receiving a transcript Flux
might later revise. Validate by comparing interim-at-silence text to
final text across short answers.

### Idea 12: Interruptible TTS-to-STT Handoff Buffer — F:4 I:3 N:4
Start buffering microphone audio during the tail of TTS playback, then
begin focused detection immediately at TTS end so early answers are
not delayed by mode switching. Better because it attacks perceived
latency around the handoff, not Flux finalization alone; medium iOS /
audio-session cost, no runtime cost, risk is echo leakage. Validate by
instrumenting timestamps from TTS end, speech start, interim arrival,
dispatch.

---

## Synthesis notes (Claude, post-brainstorm)

The brainstorm clustered around three structural approaches:

1. **Tune Flux** (Ideas 9, 10) — covered natively by Deepgram's
   `Configure` mid-stream message (see RESEARCH_APIS §6); no need to
   reconnect as Idea 10 proposed.
2. **Bypass Flux EOT** (Ideas 1, 2, 3, 11, 12) — iOS-side local
   silence detection or interim commit. High feasibility but
   structurally less clean than using Flux's own eager event.
3. **Pre-classify the question** (Ideas 4, 6, 7, 8) — derive expected
   answer shape from the ask_user text, route latency policy per
   shape. High novelty, medium feasibility, would compound nicely
   with Flux tuning but is a larger refactor.

Idea 12 (TTS-to-STT handoff buffer) is the most-overlooked. Today the
audio stream resumes only after AlertManager finishes TTS — if the
inspector starts answering during the last 200ms of TTS, that audio is
lost. Worth a follow-up phase but not the headline fix.

The recommended path in `PLAN.md` adopts a layered version of
**Ideas 9-10 + 1-11 + 12**: Flux `Configure` swap (primary), eager
event handling for speculative dispatch (secondary), iOS VAD-silence
fallback (tertiary), TTS-tail audio buffer (phase 2 if needed).
