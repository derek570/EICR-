/**
 * PLAN-C Phase 4 — the client chime-silence watchdog's fallback line, as a
 * backend-exported constant.
 *
 * The watchdog (iOS + PWA) speaks this ONE line, natively, when a processing
 * chime fired but no epoch-correlated TTS played within
 * CHIME_SILENCE_WATCHDOG_MS. It is a CLIENT string — the backend never emits
 * it — but it lives here, exported, for a SINGLE reason: the client field-nil
 * confirmation channel dedupes on a 30 s TEXT-KEYED TTL, so the watchdog line
 * MUST be full-string-distinct from every backend spoken-line family that
 * rides the same channel (marker-② CATCHALL, marker-① NOOP, the F7
 * ask-audibility apology, the pending-value apology, and the F/U-2/3 rotating
 * voice notices). A collision would let one line silently swallow the other.
 *
 * The distinctness is PROVEN by a backend Jest test
 * (client-watchdog-fallback.test.js) against every exported family + a
 * representative render sweep of the templated notice families. Each client
 * (web / iOS) hardcodes this SAME literal and pins it with a mirror/drift test
 * against this constant, so the three copies cannot drift.
 *
 * Construction note: the "didn't come back to you" stem is deliberately unused
 * by every other family (NOOP: didn't catch / quite get / come through /
 * missed / get; F7: couldn't action; CATCHALL: didn't give me anything /
 * nothing came of that / produce / came out / make anything; pending-value:
 * couldn't place that reading; notices: is unchanged / nothing changed / is
 * already recorded / there's already). It reads as "I never got back to you",
 * which is exactly the watchdog's meaning — a chime with no spoken follow-up.
 */
export const CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT =
  "Sorry, I didn't come back to you on that — could you say it again?";

/**
 * PLAN-C Phase 4 — the `session_ack` capability advert. The backend stamps
 * `speech_epochs: <this>` on every SESSION-ESTABLISHING ack (started /
 * reconnected / resumed / a rehydrate spread-ack whose status is 'resumed').
 * It signals "this backend stamps a stable utterance epoch on every speech
 * frame", which the clients require before ARMING the watchdog: against an
 * old / rolled-back / not-yet-deployed backend the field is absent, the
 * client latch clears, and the watchdog never arms (so it can never false-
 * fire against a backend whose frames it cannot epoch-correlate).
 *
 * A NUMBER (not a boolean) so the capability can version forward if the epoch
 * contract ever changes shape; clients accept the capability only for the
 * strict value `1`. NOT stamped on non-establishing acks (paused /
 * compact_skipped / stopped) or a rehydrate 'new'/'rejected' — those do not
 * (re)establish a session the client can arm against.
 */
export const SPEECH_EPOCHS_CAPABILITY = 1;

/**
 * Plan D (2026-07-25, feedback id 100(b)) — the `session_ack` advert for
 * SERVER-AUTHORITATIVE impedance clamping. It means, precisely:
 *
 *   "the impedance value you are about to receive has ALREADY been clamped
 *    server-side, and the confirmation you are about to hear names the value
 *    that was actually stored — so do NOT clamp it again."
 *
 * A client that sees it must disable its own `clampImpedance` for the Ze family;
 * a client that does not see it keeps clamping, which is why an old / rolled-back
 * backend has no regression window. Both halves matter: double-clamping would
 * divide a corrected `1.6` to `0.16`, and neither side clamping would let the raw
 * `16` that this whole plan exists to catch reach the certificate.
 *
 * MODE-GATED, unlike `speech_epochs`. The claim is only TRUE when the Stage-6
 * dispatchers ran: `off` / `shadow` sessions take the legacy result path
 * (`stage6-shadow-harness.js`), whose snapshot writer stores the RAW dictated
 * value, so none of the plan's clamp seams are on it. Emitters therefore gate on
 * the same `session.toolCallsMode ?? 'off'` read the harness dispatches on — see
 * `impedanceClampCapabilityFields` in `sonnet-stream.js`. This is what makes the
 * documented `STAGE6_TOOL_CALLS_MODE` rollback safe: a post-rollback session
 * simply stops advertising, and the client clamp takes over again.
 *
 * A NUMBER for the same forward-versioning reason as `SPEECH_EPOCHS_CAPABILITY`;
 * clients accept it only for the strict value `1`.
 */
export const SERVER_IMPEDANCE_CLAMP_CAPABILITY = 1;
