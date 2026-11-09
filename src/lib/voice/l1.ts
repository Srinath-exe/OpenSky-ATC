/*
  Main-thread client for the S1 voice model worker (public/voice/s1-worker.js). Lazy: nothing downloads until the
  first push-to-talk. prefill() is called on PTT down with the current game state (the expensive part, done while the
  player is talking); complete() on release with the transcript.
*/
import type { Signals } from './s1';

export const S1_MODEL_URL = '/models/s1/2m-grpo-v1';   // GRPO-tuned (ml/rl, +4 pts on recogniser transcripts); 2m-swap-v1 kept for rollback. Versioned: /models/* is cached for a year

/** `signals` (per-token evidence for the verifier) is null from a worker built before it existed; `model` names the
 *  weights that answered, so the verifier uses the gate fitted for them. */
export interface L1Result { line: string; confidence: number; ms: number; sayAgain: boolean; signals: Signals | null; model: string }

export class L1Client {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private ready: Promise<void> | null = null;

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((ok, err) => { this.pending.set(id, { ok, err }); this.worker!.postMessage({ ...msg, id }); });
  }

  load(): Promise<void> {
    if (this.ready) return this.ready;
    if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Workers are not available'));
    this.worker = new Worker('/voice/s1-worker.js', { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.type === 'error') p.err(new Error(m.message)); else p.ok(m);
    };
    this.ready = this.call<void>({ type: 'load', url: S1_MODEL_URL }).then(() => undefined);
    return this.ready;
  }

  /** Game state while the player talks. Fire and forget; errors surface on complete(). */
  prefill(ctx: string): void { void this.load().then(() => this.call({ type: 'prefill', ctx })).catch(() => undefined); }

  async complete(said: string, callsigns: string[], ctx?: string): Promise<L1Result> {
    await this.load();
    const r = await this.call<L1Result>({ type: 'complete', said, callsigns, ctx });
    return { line: r.line, confidence: r.confidence, ms: r.ms, sayAgain: r.sayAgain, signals: r.signals ?? null, model: S1_MODEL_URL };
  }
}
