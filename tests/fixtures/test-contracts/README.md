# Cross-client wire-contract fixtures

Each file here is a **snapshot of a frame as it leaves the backend**, produced by
running the REAL production egress chain (`runShadowHarness` →
`validateAndCorrectFields` → the wire projection) and pinned. Read it as the
record of the frame's SHAPE and VALUES, not of its byte encoding: the producer
test asserts STRUCTURAL equality (`toEqual`) against the parsed fixture, so key
ORDER and JSON whitespace are not pinned — a producer change that only reorders
keys will not fail, one that adds, drops, renames or re-values a key will.

Their purpose is to be the ONE artefact both sides of a cross-client contract
assert against:

- the **backend** test regenerates the frame from the production chain and
  deep-equals it against the fixture, so a producer-side change that alters the
  wire is a loud failure rather than a silent drift;
- the **web** test imports the same fixture as its decoder input, so the client
  half is exercised against what the backend actually emits, not against a
  hand-written approximation that can quietly diverge.

**iOS is the known exception.** CertMateUnified is a separate git repo with no
build-time link to this one, so its contract tests embed a hand-mirrored copy of
the payload as a Swift literal. That copy CAN drift from the fixture with nothing
detecting it. This is an owned gap, not a solved one — the fix is to generate the
Swift literal from the fixture or hash-compare the two in CI. Until then, a change
to a fixture consumed by an iOS test MUST be mirrored into that test by hand in
the same wave.

**Regeneration is a documented procedure, not a script.** There is no
`npm run regen-contract-fixtures`; each fixture's producing test names the chain
that built it, and you regenerate by running that chain and copying the result.

**Do not hand-edit a fixture to make a test pass.** If the wire genuinely
changed, regenerate it from the production chain, review the diff as a wire
change (it is one), and update every consumer — including the iOS literal — in
the same wave.

| File | Contract | Introduced |
|------|----------|------------|
| `replaces-cleared-circuit.json` | A2 `replaces_cleared` — the omit-when-false marker stamped on a write that superseded a same-turn `clear_reading` the P5 collapse dropped from the wire | 2026-07-28 |
