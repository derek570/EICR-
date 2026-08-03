> **REFERENCE COPY — NOT EXECUTABLE.** Execute only the canonical handoff final recorded in `provenance.json`; every tracked copy has an adjacent fail-closed EP policy.

# Plan 00B — production-composed trusted semantic oracle

Status: **DONE — RP converged / EXECUTION-READY**
Dependencies: Plan 00A delivered; current recorded field-replay gate green
Execution after RP convergence only: `[REFERENCE COPY — Plan 00B execution uses its canonical handoff final only]`

Execution guard: exact explicit path only; `--no-chain` is mandatory. The adjacent machine policy must verify 00A's genuine merged/deployed success record and `plan00_tracked_bundle_provenance` before claim.

## Outcome and boundary

Replace the existing reduced/provider-agreement A/B with a real-server, trusted semantic oracle that independently judges Haiku and Luna. Use production WebSocket lifecycle composition without extracting or reimplementing the `sonnet-stream.js` connection closure. This plan builds and verifies the harness, capture seams, immutable expectations and reports; the three-day vendor sampling and release gate belong to Plan 00C.

It does not alter live model/tier choices, the two-round loop, end-of-turn policy, client wire/TTS behaviour, Deepgram, ElevenLabs, Loaded Barrel or later latency experiments. With evaluation mode absent, evaluation capture allocates/serializes nothing and preserves existing wire bytes. The one-time board-mutation chokepoint extraction in B2 is a separately proven behaviour-preserving production refactor.

## Revalidate before editing

Create a fresh current-`origin/main` worktree. Reference facts from `af530a7a`:

- `scripts/model-ab` hand-builds a reduced session and treats provider agreement as correctness.
- The committed corpus has nine fixtures. `frc_4687948efcd06a3cd9dce203a3aa4ffe` contains “Downstairs Socket, circuit 3, IR L to L 100”, but frozen recorded rounds cannot prove Luna itself emits the operation.
- The exported `initSonnetStream` already supports real-server/WebSocket tests, including resume, disconnect cleanup and ask routing. Use that production-composed route instead of extracting `handleTranscript` or recreating message sequencing.
- `recordReadingWrite()` / `recordBoardReadingWrite()` in `stage6-per-turn-writes.js` are staging/journal helpers, not certificate-mutation commit boundaries: address-mirror source-ledger stamping can call them without mutating certificate state, while dialogue and derivations can mutate through snapshot atoms without calling them. `stage6-snapshot-mutators.js` owns the authoritative mutation atoms. Revalidate this distinction before editing.

## B1 — real-server lifecycle lane

- Boot the actual server through exported `initSonnetStream`, using the same production WebSocket handler as the existing sonnet-stream integration suites.
- Drive real ordered frames and controlled clocks for session start, accepted transcript, `ask_user_answered`, pause/resume, token resume, disconnect/reconnect, timer retry and teardown. Never call private closure fragments or hand-reimplement dispatcher sequencing.
- Under a test/evaluation-only server option, attach an evaluation context to each `activeSessions` entry at creation before start/rehydration. Every message handler, address-mirror outbox replay/retry, dialogue path and send helper already resolves the active entry; use that session context rather than threading a new parameter through the 4,900-line closure.
- Preserve evaluation context until explicit teardown/quiescence. Each message/outbox/timer invocation contributes an immutable sub-record. Controlled schedulers must execute the same production retry callback.
- Ship one behaviour-preserving production lifecycle chokepoint before computing the semantic digest. A dormant `src/extraction/plan00-lifecycle-hooks.js` exposes per-entry evidence-observer registration, successful-frame/confirmation callbacks, the 00A cost count/revision and extraction/queued-transcript/outbox/refinement/confirmation in-flight counts plus monotonic revisions. With no observer registered it allocates/serializes nothing and preserves byte/timing/branch parity.
- One per-entry teardown arbiter is used by explicit stop, disconnect-timeout expiry, `session_start` and `session_resume`. The first teardown caller synchronously marks the entry stopping and installs one promise owning utterance-buffer flush, `session.stop`, evidence freeze and the existing acknowledgement/delete ordering; duplicate callers await it and never run teardown independently. A reconnect message seeing `isStopping` or the promise applies no mode change, clears no timer, rebinds no socket and touches no stale entry: it awaits, re-reads `activeSessions`, then follows the existing entry-missing/fresh-session response path.
- When an evidence observer is registered, the arbiter freezes an eligible completion only after existing flush/reject points and only when every inspector/non-inspector billable, extraction, queued-transcript, successful-frame, outbox, refinement and confirmation count is zero and every corresponding revision remains unchanged across the synchronous freeze. Otherwise it immediately freezes the sole candidate as evidence-ineligible with `non_quiescent_at_stop`, without reusing either the unrelated eight-second audio-ACK finalizer or the extraction watchdog and without delaying/changing normal `session.stop`/`session_ack` behaviour. At each start/completion boundary the hook invokes the registered pure candidate builder synchronously once with an immutable allowlisted lifecycle/ledger snapshot, then latches its returned timestamp, canonical bytes, content hash/key and checksum plus one publish promise; retries reuse them. The later 00C consumer owns the manifest schema, while this 00B seam owns when and exactly once it is frozen.
- Add message-type/lifecycle coverage and byte-for-byte production-versus-evaluation frame parity tests. Evaluation mode may observe but must not change timing, branch order, retries, model calls, state or wire output.
- Add controlled stop races for active extraction, cache keepalive, orphan review, frame send, outbox/refinement and confirmation updates; each eligible freeze has zero counts/stable revisions and no later ledger mutation, otherwise it is explicitly ineligible. Race explicit stop and disconnect timeout against both reconnect message types and prove one teardown, no stale rebind and one deterministic response. Prove the no-observer path is byte/timing identical.

## B2 — authoritative semantic capture

Judge at authoritative boundaries:

- canonical certificate/session state before the scenario and after all expected work reaches quiescence;
- an ordered immutable commit stream for operation kinds where order matters;
- ordered emitted WebSocket and frame-ledger events;
- pending-ask/address-outbox state;
- central model tool calls/results and round boundaries.

Capture every actual certificate mutation solely at declared atoms in `stage6-snapshot-mutators.js`, never from a staging/journal entry. Attach the evaluation observer non-enumerably to the evaluated session/snapshot. Each reading, board-reading, clear, circuit, board-operation and observation atom emits exactly one immutable commit receipt only after a real state change, preserving exact effective slot identity. Route `add_board`, select-board, distribution, postcode-derived and any other semantic direct write through those atoms; input hydration remains separately classified. If an existing semantic mutation cannot be routed state-identically, add a narrowly named canonical atom rather than treating a journal helper as authority.

Treat `recordReadingWrite()` / `recordBoardReadingWrite()` only as an evaluation-owned ordering/provenance overlay. Mark the real per-turn accumulator non-enumerably, join its `WRITE_SEQUENCE` and source metadata to an already-existing commit receipt, and never create a commit from a journal entry. An unmatched receipt or overlay makes capture `INVALID/HOLD`; address-mirror source-ledger cloning must emit zero mutation commits.

Add a committed production-source parity manifest/scan following the field-replay active-entry classification pattern:

- `semantic_mutation`: active after evaluation-context creation and required to use the declared commit atoms;
- `input_state_seed`: constructor hydration and client `job_state_update`, allowed only as scenario input and captured in canonical pre/post state;
- `forbidden_direct_mutation`: every other covered write.

Extracting `add_board`'s board append/current-board flip, select-board, inline distribution-circuit side effect and other semantic direct writes into canonical atoms is a deliberate behaviour-preserving **production** refactor, not evaluation-only capture. Prove before/after snapshot and `boardOps` identity with the existing board-dispatcher regression suite independently of production-vs-evaluation parity. Do not refactor input seed/hydration merely to satisfy grep. Add a test for every manifest class plus an unclassified direct-write RED fixture.

Each committed operation receives an evaluation-owned operation id and contains kind, canonical field, board/circuit identity, normalized value, ordering and semantic origin (`model_direct`, `ask_auto_resolve`, `calculator`, `silent_deterministic`, `dialogue_script_direct`, `dialogue_script_derived`). Every deterministic/dialogue-derived operation carries its real `parent_operation_id`, `derivation_kind` and exact source field/board/circuit slot supplied through evaluation context at the producer boundary—never inferred from stack inspection or `auto_resolved`. Resume-drained/auto-assigned writes parent to the matching current-turn create/rename; script-entry mirrors/sets parent to the exact triggering model-direct reading. Missing/wrong parent or source is semantic FAIL. Restore valid-parent, wrong-trigger, wrong-source and missing-parent RED cases. Deterministic derived operations are otherwise explicit trusted expectations or a narrow exact allowlist; undeclared/extra/wrong-target mutations fail.

Capture is behaviour-isolated but verdict-fatal. Any evaluation copy, normalization, provenance, lifecycle or quiescence error marks the sample `INVALID/HOLD`; partial capture is never compared or accepted. No evaluation context means no observer work in production.

Required RED cases include expected write plus extra write; wrong board/circuit; write→clear ordering despite production pruning; standalone clear/delete; circuit create/rename/delete; observation create/delete; wrong deterministic mirror; address-mirror transcript/answer/outbox recovery; session start/token resume/reconnect/timer retry; dialogue-only `applyWrite`; resume-drained derivation/bulk propagation; and forced capture failure at each atom/lifecycle class. Prove address-mirror source-ledger cloning emits zero commits, while dialogue writes, derivations and bulk propagation emit their real commit receipts with parent provenance.

## B3 — complete ask and audible lifecycle

Use one evaluation-only ask ledger on the active session across turns:

- `produced`: full semantic key captured after server normalization/chain assignment and before lossy projection;
- `emitted`: same runtime id marked only after successful send;
- `answered|terminal`: matching resolution from the real ingress/lifecycle.

The exact normalized `liveAskKey` contains origin, purpose, reason, context field, board, scalar or sorted plural circuits, expected answer shape, observation clarification kind, normalized pending-write identity and semantic chain role without generated ids. Require one unmatched declaration/runtime match, then bind the runtime id; fail zero/multiple/unclaimed matches.

Compose—not overwrite—the existing `ASK_STARTED_OBSERVER`. Dialogue full-key data comes from the pre-wire session capture; the post-send observer supplies runtime-id emission evidence. Instrument direct/recovered address-mirror `type:"question"` send helpers at pre-wire and successful-send seams because they bypass `ask_user_started`.

For `srv-*`, drive the real paired answer frame and transcript in production order. `answered` requires the frame id to equal the outstanding emitted id and the paired transcript to reach engine resolution; a logged prefix is not proof. Keep address-mirror asks across reconnect/outbox replay. RED cases cover closed/throwing send, wrong id, answer without transcript, transcript without answer, reverse/interleaved arrival, recovery/reissue, near-identical wrong answer and observer restoration.

Capture server confirmation delivery exactly, without treating delivery as playback. Define the durable logical identity at the operation/source-write boundary as original `extractionTurnId` + canonical effective slot identity + operation ordinal/digest, never from a result envelope. Persist it in every audibility-mandatory source-write/outbox row and restore it unchanged through pending extraction, address-mirror database recovery and every retry/replay. `confirmation_ref`, `result.turn_id`, address-mirror resolution tokens and client dedupe tokens are transport aliases only. The dormant observer callback records an immutable operation-bound `delivery_attempt` for every successful result-frame send/replay, dialogue-engine `safeSend` confirmation and `voice_command_response.spoken_response`; multiple deliveries are never discarded or presented as proof that the client suppressed playback.

Fast-TTS is the pre-operation exception and must converge onto that same identity. Record a provisional fast delivery only after proving `activeSessions.get(sessionId)?.userId === req.user.id`, with its correlation id and normalized candidate field/value/effective board/circuit; client `turnId` is never identity. Transcript ingress binds echoed `regex_fast_correlation_id` to the server-minted original `extractionTurnId`. When the matching authoritative mutation receipt is created, resolve the provisional delivery to exactly one operation by that server turn plus canonical effective slot and normalized value, then persist the operation ordinal/digest binding. Zero, multiple, wrong-value, wrong-slot, wrong-user or unconsumed provisional matches make capture/session evidence INVALID; they are never dropped or counted independently. Plan 00C keeps the resolved fast delivery beside every canonical/replayed delivery under the operation identity.

Playback is a separate operation-bound ledger. A `playback_start` exists only when an authenticated ACK resolves uniquely to one authoritative logical operation and that operation has at least one compatible `delivery_attempt`; the existing wire cannot and must not invent a unique delivery-instance assignment. De-duplicate only byte-identical ACK retransmissions by canonical full-body hash; distinct accepted ACK bodies for the same operation are distinct playback starts. A successful server send never synthesizes playback.

Persist each audibility operation's existing outbox delivery-claim token/process lineage beside its authoritative source identity. Recovery under a prior/different claim lineage whose successful-send observation is absent from the current process observer sets `delivery_history_ambiguous:true`; it never reconstructs a missing pre-crash delivery or playback. Same-process retry remains unambiguous only while the observer retains every attempt. Plan 00C may never use an ambiguous operation for manual exactly-once PASS.

For fast-TTS, after the active-session owner check, stage any early ACK by correlation beside the provisional delivery and atomically promote both only when transcript correlation plus the authoritative mutation resolves exactly one operation. Zero/multiple/mismatched/expired bindings make session evidence invalid; process loss before binding is never reconstructed. Tests use the real ACK schema: one ACK after two compatible same-operation deliveries is one start; a second distinct ACK is two starts; an identical duplicate POST remains one; an ACK matching multiple operations is INVALID/HOLD; and a pre-operation fast ACK promotes after authoritative binding. Also cover normal fast delivery plus client-suppressed canonical delivery, suppressed/audible replay, missing/ambiguous ACKs, absent/ambiguous/wrong-value/wrong-slot provisional matches and cross-user requests. Keep server delivery, client playback started and manually heard/completed as distinct facts; Plan 00B proves server/wire identity and ACK binding, while Plan 00C owns manual hearing. Zero client-wire change is required.

## B4 — immutable independently approved expectations

- Extend each frozen field-corpus fixture with a separate expectation projection: canonical operations/order, asks/answers and audible outputs only—no recorded model rounds, tool ids or output from a model under test.
- The 00B authoring step may create `UNREVIEWED-DRAFT` candidates from existing human fixture data. Neither runner nor collector may derive, accept, rewrite or “repair” expectations from live Haiku/Luna output.
- Provide a read-only command that renders the exact projection and computes its SHA-256 anchor. Plan 00B stores no attestation record. Derek's attestation act and the authoritative `expectations_attested` event are owned solely by Plan 00C after its event store is deployed and before cohort initialisation/vendor sampling. Any missing, changed or unattested projection is `INVALID/HOLD`.
- Include both frozen projection hashes in the combined anchor that Plan 00C later attests and binds into corpus/oracle/cohort fingerprints. A changed projection requires a new comparable cohort.
- Frozen `model_rounds`, recorded tool ids, schema/dispatcher expectations remain recorded-lane-only. Live matching uses semantic operations/asks/audio and runtime-id-independent keys.

## B5 — model lanes and pinned IR oracle

- Keep the recorded lane unchanged as deterministic backend/wire protection.
- Add a real Luna lane for the pinned transcript/seeded state. Require semantic `{kind: reading, field: ir_live_live_mohm, circuit: 3, value: "100"}` with board wildcard for the single-board job. Plain overwrite or clear→write are both valid if final semantics/order expectations allow; recorded responses can never satisfy this live lane.
- Judge Haiku and Luna independently against the attested `vendor_live_expectations`. Agreement is secondary.
- Base-model lanes use production composition but isolate the model under test: Loaded Barrel off, observation tier escalation disabled or set to the lane model, round-one override empty. Keep real Terra routing only in Plan 00C production-field evidence.
- Evaluation-only SDK clients disable automatic retries. Pace inspector turns/samples with `--inter-turn-ms=10000`; never pause between rounds of one conversational turn. Provider-proven throttling is excluded/retried after reset and reported separately.
- Emit PII-safe sample id, corpus/expectation hash, provider/model, requested/served tier, round count, cache buckets, status class, semantic verdict and phase timings. Report pass rate, mismatch class, p50/p95, all/unthrottled distributions, cache ratios and actual/no-cache cost.

## B6 — observation update and corpus reachability

Direct Stage-6 observation create/delete belongs in Haiku/Luna parity. Post-harness `observation_update` uses separate refinement/egress and is tested deterministically outside vendor comparison:

- async neutral update emits one silent update;
- code change emits update then one recode confirmation;
- disconnect after update/before recode resumes without duplicate update and with one recode;
- Rule-6/frame-ledger ordering covers extraction, update, recode, field corrections and VCR with stable dedupe.

At 00B delivery, freeze two disjoint candidate manifests as `UNREVIEWED-DRAFT`:

- `vendor_live_expectations`: only operations executable through the production-composed Haiku/Luna lanes, including direct observation create/delete;
- `deterministic_egress_expectations`: post-harness observation update/recode/resume cases, gated by Plan 00C's Stage-A deployed-oracle fingerprint and never rerun as vendor A/B.

Every fixture belongs to exactly one executable lane; add a partition/completeness test. Include both hashes in the combined anchor that Plan 00C alone attests before sampling. Required strata are corrections, clears, multi-board routing, direct observation create/delete, deterministic observation-update egress, mixed ask+reading, common test types and pinned IR. If real provenance is unavailable for a non-safety stratum, record a named gap for Plan 00C's Derek decision; never fabricate a fixture. Safety-critical clear/write and certificate-mutation strata cannot be waived.

Publish `scripts/model-ab/plan00-expectation-manifest.json` as the deterministic combined manifest: schema/version, both complete fixture inventories and hashes, combined hash, `semantic_oracle_digest` and `UNREVIEWED-DRAFT` status. The semantic digest hashes a committed enumerated repository-relative input manifest covering the canonical mutation atoms, capture/ask/audibility adapters, schemas, expectation runner, `sonnet-stream.js` lifecycle chokepoint and `plan00-lifecycle-hooks.js` whose behaviour the 00B expectations cover—not the later manifest consumer/publisher. Its EP success policy records this file as `plan00_expectation_manifest`; Plan 00C's pre-claim policy verifies that recorded artifact and the live deployed predecessor commit before claim. Plan 00C must recompute this exact enumerated digest before cohort initialisation; any semantic-oracle input change fails closed and requires a fresh 00B successor artifact rather than silently updating the digest.

## Verification and delivery

- Run focused real-server lifecycle suites, capture/parity/source-scan RED tests, recorded field corpus, full backend tests and pre-push corpus gate.
- Run no vendor A/B before expectations are attested. Mock/recorded lanes prove implementation during EP.
- Update `docs/reference/field-replay-corpus.md`, architecture, changelog and the dated oracle report/schema.
- Deliver via the normal PR-only workflow. Zero client/wire change is expected; stop if parity changes.

## Acceptance

- Real-server evaluation executes unmodified session lifecycle paths through `initSonnetStream`.
- Canonical snapshot-mutation atoms, journal overlays and canonical pre/post state make extra/wrong/false mutations verdict-fatal without ad hoc handler enumeration.
- Ask production/emission/resolution and server audibility are exact across reconnect and dialogue paths.
- Every fixture has a frozen independently reviewable expectation in exactly one executable manifest, with both hashes ready for Plan 00C attestation; no vendor sampling is permitted until 00C records it.
- Pinned IR and all frozen corpus strata have executable trusted semantic verdicts; only named, dated, non-safety deferrals remain.
- The enumerated semantic-oracle input manifest is complete, repository-relative and deterministic; it includes every production hook later consumed by 00C. 00C adds only a consumer/publisher through that frozen seam. A merge-blocking source check fails if 00C changes an enumerated path/hash; such work requires a freshly reviewed/delivered 00B successor and an updated 00C dependency first.
