/*
  Main-thread client for the S1 voice model worker (public/voice/s1-worker.js). Lazy: nothing downloads until the
  first push-to-talk. prefill() is called on PTT down with the current game state (the expensive part, done while the
  player is talking); complete() on release with the transcript.
*/
import type { Signals } from './s1';

export const S1_MODEL_URL = '/models/s1/2m-free-v1';   // free wording (ml/data/plain.py, docs/spec/16-COMMAND-MODEL-FREE.md); 2m-grpo-v1 kept for rollback.
// previous model 2m-grpo-v1: GRPO-tuned (ml/rl, +4 pts on recogniser transcripts); 2m-swap-v1 kept for rollback. Versioned: /models/* is cached for a year

/** `signals` (per-token evidence for the verifier) is null from a worker built before it existed; `model` names the
 *  weights that answered, so the verifier uses the gate fitted for them. */
export interface L1Result { line: string; confidence: number; ms: number; sayAgain: boolean; signals: Signals | null; model: string }

export class L1Client {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private ready: Promise<void> | null = null;

  private call<T>(msg: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
    const id = this.seq++;
    // a call never hangs push-to-talk: no answer in time (worker stuck or gone) rejects, and the rules' result stands
    return new Promise<T>((ok, err) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) err(new Error('voice model did not answer')); }, timeoutMs);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, err: (e) => { clearTimeout(timer); err(e); } });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  /** The worker failed to load or crashed: fail every waiting call and start afresh on the next one. */
  private reset(why: string) {
    for (const p of this.pending.values()) p.err(new Error(why));
    this.pending.clear(); this.ready = null;
    try { this.worker?.terminate(); } catch { /* gone */ }
    this.worker = null;
  }

  load(): Promise<void> {
    if (this.ready) return this.ready;
    if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Workers are not available'));
    this.worker = new Worker('/voice/s1-worker.js', { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.type === 'error') p.err(new Error(m.message)); else p.ok(m);
    };
    this.worker.onerror = (e) => { e.preventDefault?.(); this.reset(`voice model worker failed: ${e.message || 'could not start'}`); };
    this.worker.onmessageerror = () => this.reset('voice model worker sent an unreadable message');
    // a failed load (network blip) is not cached: the next push-to-talk tries again
    const ready = this.call<void>({ type: 'load', url: S1_MODEL_URL }, 60000).then(() => undefined);
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.reset('voice model could not load'); });
    return ready;
  }

  /** Stop the worker (the model files stay in the browser's cache). */
  dispose(): void { this.reset('disposed'); }

  /** Game state while the player talks. Fire and forget; errors surface on complete(). */
  prefill(ctx: string): void { void this.load().then(() => this.call({ type: 'prefill', ctx })).catch(() => undefined); }

  async complete(said: string, callsigns: string[], ctx?: string): Promise<L1Result> {
    await this.load();
    const r = await this.call<L1Result>({ type: 'complete', said, callsigns, ctx });
    return { line: r.line, confidence: r.confidence, ms: r.ms, sayAgain: r.sayAgain, signals: r.signals ?? null, model: S1_MODEL_URL };
  }
}
