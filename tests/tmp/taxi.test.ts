import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
const ctx = CHAPTERS.find((c) => c.id === 'g-push')!.setup(e);
const a = e.find(ctx.cs)!;
text(e, `${ctx.cs} pushback approved`);
for (let t = 0; t < 400 && a.phase !== 'startup'; t++) e.step(30);
console.log('after push', a.phase, a.pushback.stage, 'stable', a.startup.enginesStable, 'readyAt', a.startup.readyAt, 'now', Math.round(e.time));
console.log(JSON.stringify(text(e, `${ctx.cs} taxi to runway 01R`)).slice(0, 200));
for (let t = 0; t < 600; t++) { e.step(30); if (t % 20 === 0) console.log(t, a.phase, 'stable', a.startup.enginesStable, Math.round(a.speed), 'kt d', Math.round(a.distAlong), 'hold?', (e as any).manualHold?.has?.(a.id), a.requests?.[0]?.kind ?? ''); }
