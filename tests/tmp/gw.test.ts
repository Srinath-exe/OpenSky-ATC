import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => { const r = text(eng as any, line); if (/ASA/.test(line)) console.log('   run', line, r.ok, r.code); return r; });
for (const ch of CHAPTERS.filter((c) => c.tab === 'ground' && !c.ui && c.id !== 'g-cross' && c.id !== 'g-handoff')) {
  const ctx = ch.resume?.(e) ?? ch.setup(e); const L: Live = { e, ctx, events: [], t0: e.time, selectedId: null }; ch.cues?.(L);
  if (ch.id === 'g-giveway') { const a = e.find('DLH455')!, b = e.find('ASA331'); console.log('giveway start: ours d', Math.round(a.distAlong), 'asa', b ? `${b.phase} ${Math.round(Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y))}m path ${b.path?.total}` : 'none'); }
  for (const g of ch.goals) {
    if (g.optional) continue; let said = '';
    let t = 0; while (g.when && !g.when(L) && t < 600) { e.step(30); t++; }
    t = 0; while (!g.done(L) && t < 400) { const l = g.say?.(L); if (l && l !== said) { said = l; text(e, l); } e.step(30); t++;
      if (ch.id === 'g-giveway' && t % 15 === 0) { const a = e.find('DLH455')!, b = e.find('ASA331'); console.log('  ', g.id, t, Math.round(a.speed), Math.round(a.distAlong), a.trafficHold, (e as any).sc(a).holdReason, b ? `${b.phase} ${Math.round(b.speed)}kt ${Math.round(Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y))}m ${(e as any).sc(b).holdReason}` : '-', 'min', L.ctx.data.asaMin); } }
    console.log(ch.id, g.id, g.done(L) ? 'DONE' : 'STUCK');
  }
}
