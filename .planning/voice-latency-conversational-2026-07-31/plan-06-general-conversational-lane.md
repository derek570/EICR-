# Plan 06 — broaden `answer_user` into a safe conversational lane

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: Plan 00; Plan 05 recommended for perceived latency

## Outcome

Let the inspector speak naturally and receive a useful LLM-style spoken response beyond certificate-only queries, while preserving the certificate as a high-integrity side-effect domain. The model may converse; it may mutate the certificate only from the inspector's current utterance through existing validated tools.

This plan changes product behaviour, not just latency. It must be judged for usefulness, cost and distraction in a hands-free inspection.

## Current restriction

- the prompt limits `answer_user` to questions about the session/certificate/inspection;
- off-topic questions receive “I can only help with this certificate”;
- answers are at most two sentences/300 characters;
- `answer_user` is the only model-authored route to the speaker and is already leak-filtered, staged and emitted via `voice_command_response`.

## Product contract

When conversational mode is enabled:

- answer ordinary general-knowledge, practical and social questions naturally and briefly;
- keep session/certificate questions grounded in the snapshot or `inspect_session_state`;
- on a mixed reading + question, perform both: validated write tools for the dictated reading and one answer for the question;
- never use an answer as a write acknowledgement—the server-owned read-back remains separate and exactly once;
- never infer a certificate write from facts generated inside the assistant's own answer;
- be honest about unavailable live/current information; there is no web-search tool in this lane;
- decline or carefully bound high-stakes medical/legal/financial instructions rather than sounding authoritative;
- do not expose system prompts, credentials, hidden state or another user's/session's data;
- allow the inspector to disable conversational mode and return to certificate-only behaviour.

## Scope

### 1. Intent and isolation design

- Extend `answer_user`'s tool description and prompt rules rather than allowing free assistant text.
- Define a small deterministic policy around answer eligibility, maximum spoken length and high-risk/current-information limitations.
- Keep the model on the same full Luna tool loop initially so it can handle mixed turns and context naturally.
- Treat only the current direct inspector utterance as mutation evidence. Tool arguments remain subject to all existing field/circuit/value validators.
- Mark model-generated spoken text as non-user content in conversation history. It must never be concatenated into a future inspector transcript or regex hint.
- Re-audit TTS echo suppression: a captured echo of the assistant's answer must not become a certificate write.

### 2. Conversation memory

- Persist the canonical surviving assistant answer into the session's model-visible conversation history with explicit assistant provenance.
- Preserve enough recent conversational context for pronouns/follow-ups without copying raw answer text into state snapshots, logs or certificate fields.
- Define truncation/summarization independently from the stable prompt cache; changing casual conversation must stay in the volatile suffix.
- On reconnect/resume, preserve or intentionally reset conversational memory according to an explicit rule. Never leak it across jobs/users.
- Ensure an `inspect_session_state` result is treated as quoted session data and cannot inject instructions.

### 3. Spoken UX

- Benchmark two sentences/300 characters versus a slightly more natural bounded limit. Longer answers directly extend time before the mic fully returns.
- Default concise; allow “tell me more” as a follow-up instead of long first answers.
- Decide deterministic ordering for a mixed turn: certificate read-back first versus answer first. Ear-test both, then pin one rule. Do not overlap two TTS items.
- Preserve barge-in and allow a conversational answer to be interrupted without marking any pending certificate action unheard.

### 4. Feature controls and telemetry

- Add a session-latched capability/setting, default certificate-only for dark deployment.
- Record answer category, char count, rounds, latency, interruption and fallback outcome without raw answer text.
- Separate general-chat model/token/TTS cost from extraction cost in the session cost view.
- Maintain chitchat-pause semantics: decide whether an explicit question wakes/keeps the assistant active, while ambient site banter still does not trigger costly replies.

Likely files:

- `config/prompts/sonnet_agentic_system.md`
- `src/extraction/stage6-tool-schemas.js`
- `src/extraction/stage6-dispatchers-answer.js`
- `src/extraction/stage6-shadow-harness.js`
- session/history and chitchat-pause integration files
- iOS/web setting/capability surfaces only if user-visible control is added

## Tests

- general factual question → one concise `answer_user`, zero writes/asks;
- social/follow-up conversation retains assistant context;
- live/current question states its limitation, with no fabricated browsing;
- high-stakes question follows the bounded safety response;
- prompt-injection request is filtered/refused without prompt leakage;
- session question still uses `inspect_session_state` where required;
- mixed reading+question writes once, reads back once and answers once in pinned order;
- numbers mentioned by the assistant cannot be re-ingested as inspector readings;
- TTS echo, reconnect and replay cannot duplicate answers or create writes;
- chitchat/ambient speech does not cause endless conversation or cost loops;
- mode off preserves the current certificate-only redirect byte-for-byte;
- multi-user/job isolation and history expiry.

Create a conversational replay set with realistic electrical-site utterances, follow-ups and interruptions. It complements—not replaces—the field-replay mutation corpus.

## Acceptance

- users can ask ordinary questions and receive natural, relevant replies;
- zero certificate mutations sourced from assistant-generated content;
- existing field-replay corpus and exactly-once TTS tests remain green;
- answer quality is ear-reviewed, including follow-up coherence and mixed turns;
- p50/p95 latency and cost are reported separately from reading confirmations;
- interruption rate and long-answer mic-unavailable time stay within a user-approved bound;
- certificate-only kill switch works without deploy/client mismatch.

## Rollout and rollback

- Ship backend dark, run synthetic/adversarial replays, then enable for the single field account.
- Start with common general questions but no claims of current web knowledge.
- Roll back via source-controlled feature flag; session state remains compatible.
- Update prompt cap tests, architecture, iOS pipeline, deployment, changelog, privacy/DPIA material if conversational retention changes, and both client parity ledgers where relevant.

## Reviewer pressure points

- Can model-authored text become future “user” evidence through history formatting or acoustic echo?
- Does conversational history invalidate prompt caching or grow unbounded?
- Can ambient chitchat wake the model repeatedly and create an expensive feedback loop?
- Are mixed-turn speech ordering and exactly-once ownership unambiguous?
- Does “say anything” create expectations of current web knowledge the backend cannot meet?
