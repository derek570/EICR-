// PCM capture AudioWorklet — runs on the audio rendering thread.
//
// Captures each 128-sample block from the mic, copies it into a fresh
// Float32Array, and posts it to the main thread using a transferable
// buffer (zero-copy). The RecordingContext in the main thread computes
// RMS for the VU meter and forwards samples to the Deepgram WebSocket
// (Phase 4c) + SleepDetector (Phase 4e).
//
// Kept deliberately minimal — any downstream processing (resample to
// 16kHz, PCM16 conversion, ring buffer) happens on the main thread so
// this file stays small, auditable, and cacheable.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      // Copy so the underlying ArrayBuffer is transferable (the caller's
      // Float32Array view would otherwise be aliased to a worklet-owned
      // buffer that Chrome reuses across process() calls).
      const samples = new Float32Array(input[0]);
      this.port.postMessage({ samples }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
