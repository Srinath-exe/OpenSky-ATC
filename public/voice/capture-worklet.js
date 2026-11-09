// Microphone capture for on-device / server speech recognition: forwards mono Float32 frames (the AudioContext runs at
// 16 kHz, the rate speech models expect) to the main thread while `recording` is on. Loaded with audioWorklet.addModule().
// Pre-roll: while the microphone is open but not recording, the last `preroll` seconds (default 0.3 s) are kept in a
// ring buffer and sent first when recording starts, so a word begun just before push-to-talk is not cut.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const pre = (options && options.processorOptions && options.processorOptions.preroll) ?? 0.3;
    this.recording = false;
    this.ring = new Float32Array(Math.max(128, Math.round(sampleRate * pre)));
    this.fill = 0;   // samples in the ring
    this.pos = 0;    // next write position
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.recording !== 'boolean') return;
      if (d.recording && !this.recording && this.fill) {
        const n = this.fill, out = new Float32Array(n), start = (this.pos - n + this.ring.length) % this.ring.length;
        for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.ring.length];
        this.port.postMessage(out);
      }
      if (d.recording) { this.fill = 0; this.pos = 0; }
      this.recording = d.recording;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    if (this.recording) this.port.postMessage(ch.slice(0));
    else {
      for (let i = 0; i < ch.length; i++) { this.ring[this.pos] = ch[i]; this.pos = (this.pos + 1) % this.ring.length; }
      this.fill = Math.min(this.ring.length, this.fill + ch.length);
    }
    return true;
  }
}
registerProcessor('atc-capture', CaptureProcessor);
