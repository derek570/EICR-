# CertMate Web (ground-up rebuild)

Next.js 16 + React 19 + Tailwind 4 web client for the CertMate EICR / EIC
platform. Shares the existing Node.js backend at
`../src/` (no changes required) and aims for **full visual and behavioural
parity with the iOS app** at `../CertMateUnified/`.

The previous web client lives at `../_archive/web-legacy/` for reference
while this rebuild proceeds.

## Development

```bash
npm install
npm run dev       # turbopack dev server on :3000
npm run verify    # spin up dev + screenshot every route (Playwright)
npm run typecheck
npm run lint
```

Environment: set `NEXT_PUBLIC_API_URL` to the backend base URL
(default `http://localhost:3000` for local, `https://api.certmate.uk`
for production).

## Phase plan

| # | Scope | Status |
|---|-------|--------|
| 0 | Foundation, design tokens, Playwright verify harness | ✅ |
| 1 | Login + dashboard | pending |
| 2 | Job-detail shell (10 tabs) | pending |
| 3 | Data-entry tabs (Installation, Supply, Board, Circuits, Observations, Inspection, Inspector, PDF) | pending |
| 4 | Recording overlay + transcript bar (AudioWorklet → Deepgram Nova-3 direct, RMS VAD, ring buffer, sliding-window Sonnet) | pending |
| 5 | Capture flows (CCU, document, observation + photo, live-fill) | pending |
| 6 | Admin + settings parity | pending |
| 7 | PWA, a11y, iOS home-screen polish | pending |
| 8 | Staged deploy + promote to `web/` on approval | pending |

## Visual verification loop

1. User pastes iOS reference shots into `_reference/ios-screenshots/` (PNGs,
   kebab-case names matching web routes).
2. `npm run verify` starts a dev server on a free port, drives Chromium
   through every configured route at mobile (390×844) + desktop (1440×900),
   writes PNGs to `_screenshots/phase-N-<timestamp>/`.
3. Claude reads the PNGs back, diffs against iOS references, iterates on
   the code until the web build visually matches.

## Key design patterns ported from iOS

- `CertMateDesign` tokens → CSS custom properties (see `src/app/globals.css`
  `@theme { … }` block and mirror in `src/lib/design-tokens.ts`).
- Dark mode is **forced** (`color-scheme: dark`, `.dark` on `<html>`).
- SF Pro Rounded font stack (`ui-rounded`) with system fallbacks.
- 4pt spacing grid (`--spacing-xs … --spacing-3xl`).
- Surface elevation L0–L4 for background layering.
- Recording-state colour map (`--color-rec-*`) matches iOS `VADStateMachine`.

## Recording pipeline (Phase 4) — guardrails

Lessons from `../transcript-standalone/` (the working browser voice
extractor) and the legacy web audit:

- **AudioWorklet** for audio capture, not `MediaRecorder` (sub-100ms
  latency, frame-by-frame Int16 PCM control).
- **Resample every frame to 16 kHz** before sending — the OS-granted rate
  may differ (the legacy web's ring-buffer replay bug was a missing
  resample).
- **Direct Deepgram Nova-3** WebSocket with subprotocol auth; no proxy
  fallback (the proxy silently degraded to Nova-2 before).
- **30 s temp tokens** via `/api/proxy/deepgram-streaming-key`, master key
  cached 5 min in Secrets Manager hit.
- **RMS-based client VAD** for sleep detection; Deepgram server-side VAD
  for speech/utterance end.
- **Ring buffer (5 s @ 16 kHz)** for pre-wake audio replay during doze
  transitions.
- **25 s grace** after wake, **20 s grace** after a Sonnet question.
- **Wake Lock** requested on record, re-acquired on visibility change
  (iOS Safari releases on blur).
- **Sliding-window Sonnet extraction** (6 exchanges / 12 messages) to
  balance context vs token budget.
