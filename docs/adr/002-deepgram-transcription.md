# ADR-002: Deepgram Nova-3 for Live Transcription

**Date:** 2026-02-05
**Status:** Accepted

## Context

EICR-oMatic 3000 requires real-time speech-to-text transcription so that electrical inspectors can dictate test readings and observations while their hands are occupied. The transcription must work in noisy worksite environments (power tools, radios, customer conversations) and handle British English electrical terminology (Ze, Zs, RCD, RCBO, ring final, etc.).

The iOS app (`CertMateUnified`) captures 16kHz mono PCM audio from the device microphone via `AudioEngine.swift`. This audio needs to be transcribed with low latency (under 500ms) so the inspector can see their words appear in real time and the extraction pipeline can process them immediately.

Three architectural options were considered for connecting the iOS app to the transcription service:

1. **Server-proxied:** iOS sends audio to the backend over WebSocket, backend forwards to Deepgram, backend returns transcripts to iOS.
2. **Direct iOS-to-Deepgram:** iOS connects directly to `wss://api.deepgram.com/v1/listen` and streams audio. Backend is not involved in transcription.
3. **On-device transcription:** Use Apple Speech framework or a local model (Whisper) on the iPhone.

## Decision

Use **direct iOS-to-Deepgram WebSocket** connections with Deepgram Nova-3. The iOS app fetches a short-lived Deepgram API key from the authenticated backend endpoint `GET /api/keys`, then opens a WebSocket directly to `wss://api.deepgram.com/v1/listen` with the following configuration:

- **Model:** `nova-3` (Deepgram's latest, best accuracy for accented English)
- **Language:** `en-GB` (British English for electrical terminology)
- **Features:** `smart_format`, `punctuate`, `interim_results`
- **Endpointing:** 300ms (fast turn detection for short readings like "0.27")
- **Utterance end:** 1300ms (longer pause before treating utterance as complete)
- **Keyword boosting:** Dynamic boosts generated from board photo data and remote config (`KeywordBoostGenerator.swift` + `default_config.json`) for terms like circuit names, manufacturers, and electrical units.

The backend serves API keys but never touches audio data. Transcripts are displayed locally in `TranscriptBarView` and forwarded to the backend only for Sonnet extraction (as text, not audio).

The same architecture is replicated in the PWA frontend (`frontend/src/lib/recording/deepgram-service.ts`) using the Web Audio API (`getUserMedia` + `AudioWorkletNode`) for browser-based recording.

## Consequences

### Positive

- **Lowest possible latency.** Audio goes directly from device to Deepgram with no intermediate hop. Transcripts arrive in under 300ms, enabling real-time display and instant regex extraction (~40ms after transcript).
- **No backend audio processing load.** The backend (2048MB / 512 CPU on ECS Fargate) does not need to handle audio streaming, freeing resources for Sonnet extraction and job processing.
- **Reduced bandwidth costs.** 16kHz PCM audio at ~32KB/s goes directly to Deepgram's infrastructure instead of routing through the AWS backend. For a 10-minute session, this saves ~19MB of backend ingress/egress.
- **Simpler backend.** No WebSocket audio relay code, no audio buffering, no transcription error handling on the server. The backend only deals with text (transcripts from the iOS app).
- **Deepgram handles all audio complexity.** VAD (during active recording), endpointing, noise suppression, and model inference happen on Deepgram's infrastructure.
- **KeepAlive support.** Deepgram's WebSocket KeepAlive mechanism enables the auto-sleep feature (ADR-007) at zero audio cost during silence.

### Negative

- **API key exposure on client.** The Deepgram API key must be sent to the iOS app and PWA browser. Mitigated by serving keys from an authenticated backend endpoint (`GET /api/keys` requires JWT) and using Deepgram's key scoping to limit permissions.
- **Two WebSocket connections per session.** The iOS app maintains both a Deepgram WebSocket (for transcription) and a backend WebSocket (`/api/sonnet-stream` for extraction). This adds connection management complexity in `DeepgramRecordingViewModel.swift`.
- **On-device rejected:** Apple Speech framework was rejected due to poor accuracy with electrical terminology and no keyword boosting. On-device Whisper was rejected due to iPhone thermal throttling during sustained transcription and lack of real-time streaming support.
- **Server-proxy rejected:** Adding a server hop would add 50-100ms latency per transcript, double the WebSocket connection management, and require the backend to handle raw audio streaming -- all for no accuracy benefit since the server would just forward audio unchanged.
