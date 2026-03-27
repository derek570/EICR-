class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._errorCount = 0;
  }

  process(inputs, outputs, parameters) {
    try {
      const input = inputs[0];
      if (input && input.length > 0 && input[0].length > 0) {
        const samples = new Float32Array(input[0]);
        this.port.postMessage({ samples }, [samples.buffer]);
      }
    } catch (err) {
      this._errorCount++;
      // Throttle error reports to avoid flooding the main thread
      if (this._errorCount <= 5 || this._errorCount % 100 === 0) {
        this.port.postMessage({
          error: true,
          message: err instanceof Error ? err.message : String(err),
          count: this._errorCount,
        });
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
