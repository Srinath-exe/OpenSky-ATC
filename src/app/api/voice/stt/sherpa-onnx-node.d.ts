// The part of sherpa-onnx-node (2.0.1, no bundled types) that engine.ts uses: an offline recogniser with per-stream hotwords.
declare module 'sherpa-onnx-node' {
  export interface OfflineStream { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }
  export class OfflineRecognizer {
    static createAsync(config: Record<string, unknown>): Promise<OfflineRecognizer>;
    /** hotwords: phrases separated by '/' (modified_beam_search with modelingUnit + bpeVocab set). */
    createStream(hotwords?: string): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }
}
