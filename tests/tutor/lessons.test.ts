// Every tutorial chapter, played headlessly the way the coach suggests: set up, then for each goal wait until it applies,
// say the example call, and run the sim until the goal is met. Fails on a goal that never completes.
import test from 'node:test';
import assert from 'node:assert';
import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
import { spokenCall, callKey } from '../../src/game/Tutorial/spoken';
import fs from 'fs';
const CALLS: Record<string, string> = {};
process.on('exit', () => { if (process.env.CALLS_OUT) fs.writeFileSync(process.env.CALLS_OUT, JSON.stringify(CALLS, null, 1)); });
import type { SimEvent } from '../../src/lib/sim/types';

const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => { const r = text(eng as any, line); if (!r.ok) console.log('   setup call failed:', line, r.code, r.reason ?? ''); return r; });
const only = process.env.CH;
for (const ch of CHAPTERS) {
  if (only && ch.id !== only) continue;
  test(ch.id, () => {
    if (ch.ui) return;
    const resumed = process.env.FRESH ? null : ch.resume?.(e) ?? null;
    const ctx = resumed ?? ch.setup(e);
    console.log(`${ch.id}: ${resumed ? 'CONTINUED' : 'fresh'}`);
    const L: Live = { e, ctx, events: [], t0: e.time, selectedId: null };
    ch.cues?.(L);   // the coach's map cues (the taxi lesson works out its route there)
    const step = (s: number) => { for (let i = 0; i < s; i++) { const evs: SimEvent[] = e.step(30); L.events.push(...evs); ch.tick?.(L); } };   // s sim seconds
    const log: string[] = []; const met = new Set<string>(); const done = (g: { id: string; done: (L: Live) => boolean }) => met.has(g.id) || (g.done(L) && !!met.add(g.id));
    for (const g of ch.goals) {
      if (g.optional) continue;
      let t = 0; while (g.when && !g.when(L) && t < 600) { step(1); t++; }
      // the suggested call, once it has one (some goals only suggest a call when it is needed, e.g. "continue taxi")
      let said = '';
      const sayNow = () => { const line = g.say?.(L); if (!line || line === said || done(g)) return; said = line; const sp = spokenCall(e, line); if (sp) CALLS[callKey(sp)] = sp; log.push(`   say: ${sp}`); const r = text(e, line); log.push(`${g.id}: "${line}" -> ${r.ok ? 'ok' : r.code} ${r.reason ?? ''}`); };
      sayNow();
      t = 0; while (!done(g) && t < 600) { step(1); t++; sayNow(); }
      const a = e.find(ctx.cs);
      log.push(`  ${done(g) ? 'DONE' : 'STUCK'} ${g.id} after ${t}s  [${a ? `${a.phase} ${Math.round(a.altitude)}ft ${Math.round(a.speed)}kt freq ${a.onFrequency} hs ${a.holdShortRunway ?? '-'}` : 'gone'}]`);
      if (!done(g)) break;
    }
    const kinds = L.events.filter(ev => ev.type === 'readback' && ev.data?.type === 'readback').map(ev => `${ev.callsign}:${(ev.data as any).ast?.kind}`);
    const bad = L.events.filter(ev => ['ground_conflict', 'separation_loss', 'go_around'].includes(ev.type) || (ev.type === 'alert' && (ev.data as any)?.alert?.kind === 'runway_incursion'));
    console.log(`${ch.id} (${ctx.cs})\n ${log.join('\n ')}\n readbacks ${kinds.join(' ')}\n trouble ${bad.map(b => b.type + ':' + b.message).join(' | ') || '-'}`);
    for (const g of ch.goals) if (!g.optional) assert.ok(met.has(g.id), `${ch.id}: goal ${g.id} not met`);
  });
}
