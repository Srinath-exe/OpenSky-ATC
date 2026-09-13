/*
  LLM I/O — the agent loop (docs/spec/07-LLM-IO.md §5).

  For every position the model works, on a cadence (sooner when a pilot request or an alert appears): build the
  observation, ask the model, parse its command lines and either execute them on that position (control) or post them
  as suggestions (advise). One call in flight at a time; every call is recorded (observation, reply, outcomes) in the
  I/O log that the settings modal can export as JSONL for fine-tuning.
*/
import type { PlayerPosition } from '../sim/types';
import type { SimStore } from '../../components/atc/simStore';
import { buildObservation, type ActionOutcome } from './observe';
import { parseReply, systemPrompt } from './prompt';
import { chatComplete, type LlmConfig } from './client';

export interface LlmStatus {
  running: boolean; inFlight: PlayerPosition | null; calls: number; errors: number; lastMs: number | null; lastAt: number | null;
  lastError: string | null; lastReply: string | null; lastPosition: PlayerPosition | null; model: string | null;
  tokens: { prompt: number; completion: number };
}

export interface IoRecord {
  t: number; wall: number; icao: string; position: PlayerPosition; source: 'model' | 'player';
  observation: string; reply: string | null; actions: ActionOutcome[]; ms: number | null; model: string | null;
}

const LOG_MAX = 4000;
const POSITIONS: PlayerPosition[] = ['ground', 'tower', 'approach'];

export class LlmAgent {
  status: LlmStatus = { running: false, inFlight: null, calls: 0, errors: 0, lastMs: null, lastAt: null, lastError: null, lastReply: null, lastPosition: null, model: null, tokens: { prompt: 0, completion: 0 } };
  log: IoRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextAt: Record<PlayerPosition, number> = { ground: 0, tower: 0, approach: 0 };
  private sig: Record<PlayerPosition, string> = { ground: '', tower: '', approach: '' };
  private lastActions: Record<PlayerPosition, ActionOutcome[]> = { ground: [], tower: [], approach: [] };
  private vocabSent: Record<PlayerPosition, boolean> = { ground: false, tower: false, approach: false };
  private abort: AbortController | null = null;

  constructor(private sim: SimStore, private cfg: () => LlmConfig, private onChange: () => void) {}

  /** Start / stop the wall-clock loop according to the config (idempotent). */
  sync(): void {
    const c = this.cfg();
    const want = c.mode !== 'off' && c.positions.length > 0;
    if (want && !this.timer) { this.timer = setInterval(() => void this.tick(), 1000); this.status.running = true; this.onChange(); }
    if (!want && this.timer) { clearInterval(this.timer); this.timer = null; this.status.running = false; this.abort?.abort(); this.onChange(); }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.status.running = false; this.abort?.abort(); }

  /** One scheduler pass (also callable from the test API): runs at most one position that is due. */
  async tick(force?: PlayerPosition): Promise<void> {
    const c = this.cfg(); const e = this.sim.engine;
    if (!e || c.mode === 'off' || this.status.inFlight) return;
    if (this.sim.paused && !force) return;
    const now = Date.now();
    for (const p of POSITIONS) {
      if (!c.positions.includes(p)) continue;
      if (force && force !== p) continue;
      // due: the cadence elapsed, or something new to react to (a request / alert set changed)
      const sig = this.signature(p);
      const changed = sig !== this.sig[p];
      if (!force && now < this.nextAt[p] && !changed) continue;
      if (!force && changed && now < this.nextAt[p] - c.intervalS * 1000 + 2500) continue;   // at least 2.5 s between calls even when things change
      this.sig[p] = sig;
      this.nextAt[p] = now + c.intervalS * 1000;
      await this.call(p);
      return;
    }
  }

  private signature(p: PlayerPosition): string {
    const e = this.sim.engine; if (!e) return '';
    const reqs = e.aircraft.filter(a => a.onFrequency === p && a.requests.some(r => r.answeredAt == null)).map(a => `${a.callsign}:${a.requests.filter(r => r.answeredAt == null).map(r => r.kind).join('/')}`);
    const alerts = e.activeAlerts().map(a => a.id);
    return `${reqs.join(',')}|${alerts.join(',')}`;
  }

  private radioFor(p: PlayerPosition) {
    return this.sim.radio.filter(l => !l.position || l.position === p).map(l => ({ who: l.who, callsign: l.callsign, text: l.text, at: l.at }));
  }

  private async call(p: PlayerPosition): Promise<void> {
    const c = this.cfg(); const e = this.sim.engine; if (!e) return;
    const obs = buildObservation(e, { position: p, radio: this.radioFor(p), lastActions: this.lastActions[p], vocabulary: !this.vocabSent[p] });
    this.vocabSent[p] = true;
    this.status.inFlight = p; this.onChange();
    this.abort = new AbortController();
    const messages = [{ role: 'system' as const, content: systemPrompt(p) }, { role: 'user' as const, content: obs.text }];
    let reply: string | null = null; let ms: number | null = null; let model: string | null = null;
    const actions: ActionOutcome[] = [];
    try {
      const r = await chatComplete(c, messages, this.abort.signal);
      reply = r.text; ms = r.ms; model = r.model;
      this.status.calls++; this.status.lastMs = ms; this.status.lastAt = Date.now(); this.status.lastError = null; this.status.lastReply = reply; this.status.lastPosition = p; this.status.model = model ?? (c.model || null);
      if (r.usage) { this.status.tokens.prompt += r.usage.prompt; this.status.tokens.completion += r.usage.completion; }
      const lines = parseReply(reply);
      if (c.mode === 'control') {
        for (const line of lines) {
          const res = this.sim.command(line, { position: p, who: 'LLM' });
          actions.push({ line, ok: res.ok, note: res.ok ? (res.readback || res.code) : (res.reason ?? res.code) });
        }
      } else {
        for (const line of lines) { this.sim.llmSuggest(line, p); actions.push({ line, ok: true, note: 'suggested' }); }
        if (!lines.length) actions.push({ line: 'NOOP', ok: true, note: 'nothing to do' });
      }
      if (c.mode === 'control' && !lines.length) actions.push({ line: 'NOOP', ok: true, note: '' });
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) { this.status.errors++; this.status.lastError = err instanceof Error ? err.message : String(err); this.status.lastAt = Date.now(); }
    } finally {
      this.status.inFlight = null; this.abort = null;
      this.lastActions[p] = actions.slice(-6);
      if (c.record || reply != null) this.record({ t: e.time, wall: Date.now(), icao: e.air.icao, position: p, source: 'model', observation: obs.text, reply, actions, ms, model });
      this.onChange();
    }
  }

  /** Player commands are recorded too (with the observation the model would have seen) when recording is on. */
  recordPlayer(position: PlayerPosition, line: string, ok: boolean, note: string): void {
    const e = this.sim.engine; if (!e || !this.cfg().record) return;
    const obs = buildObservation(e, { position, radio: this.radioFor(position) });
    this.record({ t: e.time, wall: Date.now(), icao: e.air.icao, position, source: 'player', observation: obs.text, reply: line, actions: [{ line, ok, note }], ms: null, model: null });
  }

  private record(r: IoRecord): void {
    if (!this.cfg().record && r.source === 'player') return;
    this.log.push(r);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  /** JSONL export: one {messages:[system,user,assistant]} chat sample per record (the common fine-tuning shape) + meta. */
  exportJsonl(): string {
    return this.log.map(r => JSON.stringify({
      meta: { t: r.t, wall: r.wall, icao: r.icao, position: r.position, source: r.source, ms: r.ms, model: r.model, outcomes: r.actions },
      messages: [
        { role: 'system', content: systemPrompt(r.position) },
        { role: 'user', content: r.observation },
        { role: 'assistant', content: r.reply ?? 'NOOP' },
      ],
    })).join('\n') + (this.log.length ? '\n' : '');
  }
  clearLog(): void { this.log = []; this.onChange(); }
}
