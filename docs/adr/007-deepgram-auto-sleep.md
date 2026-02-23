# ADR-007: Deepgram Auto-Sleep Power Management

**Date:** 2026-02-19
**Status:** Accepted

## Context

Electrical inspectors using CertMate frequently pause during recording sessions. Between rooms, while writing notes, talking to customers, taking breaks, or moving between locations, the inspector stops dictating but the recording session remains open. In the field, a single EICR session can span 30-60 minutes of wall-clock time with only 10-15 minutes of actual dictation.

Without power management, the Deepgram WebSocket continues streaming silence at $0.0077/min, the iPhone's network radio stays active draining battery, and "forgotten recording" sessions can run for hours. A 60-minute session with 15 minutes of actual speech would waste ~$0.35 on silent audio and drain significant battery.

### Alternatives considered

1. **Manual pause/resume button.** Inspector taps to pause when they stop talking. Rejected because inspectors' hands are occupied holding tools, torches, and test equipment. Requiring manual interaction breaks the hands-free workflow that is the app's core value proposition.
2. **Simple silence timeout.** Disconnect Deepgram after N seconds of silence, reconnect when audio resumes. Rejected because reconnecting a WebSocket takes 300-1000ms, during which speech would be lost. Also, a simple audio-level threshold would false-trigger constantly in noisy worksite environments.
3. **Three-tier state machine with VAD (chosen).** Gradually reduce power consumption through three states (Active, Dozing, Sleeping) using Deepgram's KeepAlive mechanism and Silero VAD for intelligent wake detection.

## Decision

Implement a **three-tier power management state machine** in `SleepManager.swift` with the following states:

### State Definitions

| State | Deepgram WebSocket | Audio Streaming | KeepAlive | Silero VAD | Ring Buffer | Resume Latency |
|-------|-------------------|-----------------|-----------|------------|-------------|----------------|
| **Active** | Connected | Streaming PCM | No (audio acts as keepalive) | Off | Off | N/A |
| **Dozing** | Connected | Stopped | Every 5 seconds | On (~100ms intervals) | Recording | ~0ms (instant) |
| **Sleeping** | Disconnected | Stopped | No | On (~100ms intervals) | Recording | 300-1000ms |

### State Transitions

- **Active to Dozing:** 60 seconds with no Deepgram final transcript received. Audio streaming stops, KeepAlive frames maintain the connection at zero audio cost, Silero VAD activates as wake detector.
- **Dozing to Active:** Silero VAD detects speech (3 consecutive frames above 0.5 probability). Audio streaming resumes immediately on the existing WebSocket. Ring buffer replayed as safety net.
- **Dozing to Sleeping:** 5 minutes in Dozing state (or Deepgram connection closes due to its hard timeout). WebSocket disconnected entirely.
- **Sleeping to Active:** Silero VAD detects speech. New Deepgram WebSocket opened, ring buffer (3 seconds of captured audio) replayed after connection, then live streaming resumes. If replay produces no transcript within 5 seconds, TTS prompts "Sorry, could you repeat that?"
- **Any state to Active:** Manual wake via tapping the transcript bar (fallback).

### Key Components

- **Silero VAD (`SileroVAD.swift`):** Lightweight ONNX neural network model (~2MB) running on-device via Core ML. Used only during Dozing/Sleeping as a wake detector. Not used during Active state (Deepgram handles VAD server-side during active recording). Distinguishes human speech from worksite noise (power tools, radios, hammering) -- a simple audio-level RMS threshold would false-wake constantly.
- **Audio Ring Buffer (`AudioRingBuffer.swift`):** Circular buffer holding 3 seconds of 16kHz Int16 PCM audio (~96KB memory). Records continuously during Dozing and Sleeping states. On wake, the buffer is flushed to Deepgram before live audio, ensuring no speech is lost during the wake detection and reconnection window.
- **KeepAlive frames:** During Dozing, `DeepgramService.swift` sends Deepgram's KeepAlive message every 5 seconds to maintain the WebSocket connection without streaming audio. This costs $0/min (no audio = no billing) while keeping the connection warm for instant resume.

### Backend Support

- **Prompt cache TTL extended to 1 hour** (from Anthropic's default 5 minutes). This ensures the Sonnet system prompt cache survives silence gaps, saving ~$0.09/session by avoiding cache rebuilds when the inspector resumes.
- **Session timeout extended to 5 minutes.** The Sonnet extraction session in `eicr-extraction-session.js` preserves conversation history for 5 minutes of inactivity, aligned with the Dozing timeout.
- **`session_compact` message.** When entering Dozing, the iOS app sends a compact signal to the backend, triggering proactive conversation compaction while the inspector is not speaking.

### UI Indicators

Subtle text changes in `TranscriptBarView`:
- **Active:** Normal transcript display
- **Dozing:** Small grey text -- "Saving power..."
- **Sleeping:** Grey text -- "Paused -- speak to resume"
- **Reconnecting:** "Reconnecting..."

The same architecture is replicated in the PWA frontend (`frontend/src/lib/recording/sleep-manager.ts`) using `AnalyserNode` RMS monitoring as a wake detector instead of Silero VAD (Web Audio API does not support ONNX model inference efficiently).

## Consequences

### Positive

- **Significant cost savings.** A 60-minute session with 15 minutes of speech pays for 15 minutes of Deepgram audio (~$0.12) instead of 60 minutes (~$0.46). The KeepAlive mechanism during Dozing costs nothing.
- **Battery preservation.** Stopping audio streaming during Dozing/Sleeping reduces network radio usage and CPU load. Silero VAD at ~100ms intervals is lightweight compared to continuous 16kHz PCM streaming.
- **Zero word loss from Dozing.** Resuming from Dozing is instant because the WebSocket is still connected. The ring buffer provides a safety net but is rarely needed.
- **Minimal word loss from Sleeping.** The 3-second ring buffer captures speech spoken during the 300-1000ms reconnection window. Combined with the TTS "repeat that" fallback, no data is lost even in the worst case.
- **Automatic operation.** No inspector interaction required. The system transitions silently between states based on speech activity. The inspector only sees a subtle text change in the transcript bar.
- **Noise-robust wake detection.** Silero VAD is a neural network trained to distinguish speech from noise. It works reliably on noisy construction sites where a simple volume threshold would false-wake on every power tool or radio.

### Negative

- **Silero model size.** The `silero_vad.onnx` model adds ~2MB to the iOS app bundle. Acceptable for the power savings it enables.
- **Wake latency from Sleeping.** Reconnecting from the Sleeping state takes 300-1000ms. Speech during this window is captured by the ring buffer, but there is a perceptible delay before transcripts appear. From Dozing, resume is instant.
- **Complexity.** The three-tier state machine with VAD, ring buffer, KeepAlive frames, and backend session coordination is significantly more complex than a simple start/stop recording model. Bugs in state transitions could cause missed speech or stuck states.
- **PWA uses simpler wake detection.** The browser version uses RMS volume threshold instead of Silero VAD, which is less accurate in noisy environments. This is a known trade-off -- Web Audio API does not efficiently support ONNX model inference, and the browser is a secondary platform.
- **Backend session timeout coupling.** The 5-minute session timeout in the backend must stay aligned with the Dozing-to-Sleeping transition. If either timeout changes independently, conversation history could be lost or sessions could leak.
