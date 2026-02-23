class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const samples = new Float32Array(input[0]);
      this.port.postMessage({ samples }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
