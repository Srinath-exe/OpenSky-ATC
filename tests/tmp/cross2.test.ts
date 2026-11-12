import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
for (const ch of CHAPTERS.filter((c) => c.tab === 'ground' && !c.ui)) {
  const ctx = ch.resume?.(e) ?? ch.setup(e); const L: Live = { e, ctx, events: [], t0: e.time, selectedId: null }; ch.cues?.(L);
  const step = () => { L.events.push(...e.step(30)); ch.tick?.(L); };
  for (const g of ch.goals) {
    if (g.optional) continue;
    let t = 0; while (g.when && !g.when(L) && t < 600) { step(); t++; }
    let said = ''; const sn = () => { const l = g.say?.(L); if (l && l !== said) { said = l; text(e, l); } }; sn();
    t = 0; while (!g.done(L) && t < 300) { step(); t++; sn(); if (ch.id === 'g-giveway' && t % 15 === 0) { const a = e.find('DLH455')!; const b = e.find('ASA331'); console.log('  ', g.id, t, a.phase, Math.round(a.speed), Math.round(a.distAlong), a.trafficHold, (e as any).sc(a).holdReason, b ? `${b.phase} ${Math.round(b.speed)}kt ${Math.round(Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y))}m th ${b.trafficHold} ${(e as any).sc(b).holdReason}` : '-', 'gw', a.giveWayTo, 'min', Math.round((L.ctx.data.asaMin as number) ?? -1)); } }
    const a = e.find('DLH455'); console.log(ch.id, g.id, g.done(L) ? 'DONE' : 'STUCK', t, a?.phase, Math.round(a?.distAlong ?? 0));
    if (!g.done(L)) break;
  }
}
