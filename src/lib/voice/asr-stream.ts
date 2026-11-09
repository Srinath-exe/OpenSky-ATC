/*
  Streaming push-to-talk to /api/voice/stt/stream (server side: src/app/api/voice/stt/stream.ts).

  The transmission is sent while it is spoken, ~0.3 s at a time, one request in flight (the server needs the chunks in
  order; whatever piles up behind a slow request goes in the next one). The server transcribes each phrase as soon as
  it ends, so at release only the last phrase is left. `onPartial` gets the phrases finished so far.
*/
import { toPcm16 } from './asr-capture';
import type { SttReply } from './asr-server';

export const STREAM_URL = '/api/voice/stt/stream';
const CHUNK = 4800;   // 0.3 s at 16 kHz

export interface StreamReply extends SttReply {
  /** phrases decoded; model time of the last phrase (after release); server time of the last request; wait for the
   *  request still in flight at release; the last request's round trip */
  segments: number; tailModelMs: number; serverMs: number; drainMs: number; finalRttMs: number;
  /** phrases the server could not decode */
  failed: number;
}

export interface SttStreamClient {
  push(pcm: Float32Array): void;
  /** Send what is left and wait for the joined text. Rejects when nothing was streamed or the server cannot stream. */
  end(): Promise<StreamReply>;
  /** Stop sending (a cancelled transmission). */
  abort(): void;
  readonly samples: number;
}

export function openSttStream(names: string[], onPartial?: (text: string) => void): SttStreamClient {
  const sid = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');
  let seq = 0, pending: Float32Array[] = [], pendingN = 0, total = 0;
  let inflight: Promise<void> | null = null, failed: Error | null = null, ended = false, aborted = false;

  const take = () => { const out = new Float32Array(pendingN); let o = 0; for (const p of pending) { out.set(p, o); o += p.length; } pending = []; pendingN = 0; return out; };
  async function send(pcm: Float32Array, end: boolean) {
    const headers: Record<string, string> = { 'content-type': 'audio/l16', 'x-stt-sid': sid, 'x-stt-seq': String(seq++) };
    if (end) headers['x-stt-end'] = '1';
    if (headers['x-stt-seq'] === '0') headers['x-stt-names'] = encodeURIComponent(JSON.stringify(names.slice(0, 40)));
    const res = await fetch(STREAM_URL, { method: 'POST', body: toPcm16(pcm), headers, signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    if (typeof j.partial === 'string' && j.partial) onPartial?.(j.partial);
    return j;
  }
  function pump() {
    if (inflight || failed || ended || aborted || pendingN < CHUNK) return;
    const chunk = take();
    inflight = send(chunk, false).then(() => undefined, (e) => { failed = e instanceof Error ? e : new Error(String(e)); })
      .finally(() => { inflight = null; pump(); });
  }

  return {
    get samples() { return total; },
    push(pcm) {
      if (ended || aborted || failed) return;
      pending.push(pcm.slice()); pendingN += pcm.length; total += pcm.length;
      pump();
    },
    async end() {
      ended = true;
      const t0 = performance.now();
      while (inflight) await inflight;
      const drainMs = performance.now() - t0;
      if (failed) throw failed;
      if (!total) throw new Error('nothing streamed');
      const t1 = performance.now();
      const j = await send(take(), true);
      const text = String(j.text ?? '');
      return { text, alternatives: Array.isArray(j.alternatives) ? j.alternatives : text ? [text] : [], ms: j.tailModelMs ?? null, model: j.model ?? null,
        segments: j.segments ?? 0, tailModelMs: j.tailModelMs ?? 0, serverMs: j.serverMs ?? 0, drainMs, finalRttMs: performance.now() - t1, failed: j.failed ?? 0 };
    },
    abort() { aborted = true; pending = []; pendingN = 0; },
  };
}
