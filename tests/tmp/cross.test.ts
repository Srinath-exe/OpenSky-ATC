import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
const run = (id: string, calls: string[], secs: number) => {
  const ch = CHAPTERS.find((c) => c.id === id)!; const ctx = ch.resume?.(e) ?? ch.setup(e);
  const L: Live = { e, ctx, events: [], t0: e.time, selectedId: null }; ch.cues?.(L);
  for (const c of calls) text(e, c);
  for (let t = 0; t < secs; t++) { L.events.push(...e.step(30)); ch.tick?.(L); }
  const a = e.find('DLH455')!; const b = e.find('ASA331');
  console.log(id, a.phase, Math.round(a.speed), 'd', Math.round(a.distAlong), '/', a.path ? Math.round(a.path.total) : '-', 'th', a.trafficHold, (e as any).sc(a).holdReason, 'gw', a.giveWayTo, 'asa', b ? `${b.phase} ${Math.round(b.speed)} ${Math.round(Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y))}m` : '-');
};
run('g-push', ['DLH455 pushback approved'], 200);
run('g-taxi', ['DLH455 taxi to runway 01R via M5 M1 A2 A1'], 80);
run('g-stop', ['DLH455 hold position'], 10); run('g-stop', ['DLH455 continue taxi'], 15);
run('g-giveway', ['DLH455 give way to ASA331'], 5);
for (let i = 0; i < 6; i++) run('g-cross', [], 40);
