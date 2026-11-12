import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
const ch = CHAPTERS.find((c) => c.id === 'g-push')!;
const ctx = ch.setup(e);
const a = e.find(ctx.cs)!;
console.log('say', JSON.stringify(text(e, `${ctx.cs} pushback approved`)));
let wall = 0;
for (let i = 0; i < 60 * 90; i++) {
  e.update(Number(process.env.DT || 0.192)); wall += Number(process.env.DT || 0.192) / 12;
  if (i % 60 === 0) console.log(wall.toFixed(0), a.phase, a.pushback.stage, Math.round(a.distAlong), a.path ? Math.round(a.path.total) : '-', a.speed.toFixed(2));
  if (a.phase === 'startup' || a.phase === 'taxi') { console.log('DONE at wall', wall.toFixed(1), a.phase); break; }
}
