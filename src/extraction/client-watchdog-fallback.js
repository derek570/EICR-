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
