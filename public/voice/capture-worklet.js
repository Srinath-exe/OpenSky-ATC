// Microphone capture for on-device speech recognition: forwards mono Float32 frames (the AudioContext runs at 16 kHz,
// the rate speech models expect) to the main thread while `recording` is on. Loaded with audioWorklet.addModule().
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => { if (e.data && typeof e.data.recording === 'boolean') this.recording = e.data.recording; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.recording && ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('atc-capture', CaptureProcessor);
