import { makeEngine } from '../engine/helpers';
import { executeText } from '../../src/lib/sim/dispatch';
import { CHAPTERS, setRunner } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => { const r: any = executeText(eng as any, line); console.log('  run', line, '->', r?.ok, r?.code, r?.reason ?? ''); return r; });
for (const id of (process.env.CH || 'g-giveway').split(',')) {
  const ch = CHAPTERS.find((c) => c.id === id)!;
  const ctx = ch.setup(e);
  const a = e.find(ctx.cs);
  console.log(id, a?.phase, a?.pushback.stage, Math.round(a?.speed ?? 0), 'others', ctx.others.map((o) => !!e.find(o)));
}
