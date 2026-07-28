# Cross-client wire-contract fixtures

Each file here is a **verbatim snapshot of a frame as it leaves the backend** — the
exact bytes a client decoder receives — produced by running the REAL production
egress chain (`runShadowHarness` → `validateAndCorrectFields` → the wire
projection → `JSON.stringify`) and pinned.

Their purpose is to be the ONE artefact both sides of a cross-client contract
assert against:

- the **backend** test regenerates the frame from the production chain and
  deep-equals it against the fixture, so a producer-side change that alters the
  wire is a loud failure rather than a silent drift;
- the **web** test imports the same fixture as its decoder input, so the client
  half is exercised against bytes the backend actually emits, not against a
  hand-written approximation that can quietly diverge.

**Do not hand-edit a fixture to make a test pass.** If the wire genuinely
changed, regenerate it from the production chain, review the diff as a wire
change (it is one), and update both consumers in the same commit.

| File | Contract | Introduced |
|------|----------|------------|
| `replaces-cleared-circuit.json` | A2 `replaces_cleared` — the omit-when-false marker stamped on a write that superseded a same-turn `clear_reading` the P5 collapse dropped from the wire | 2026-07-28 |
