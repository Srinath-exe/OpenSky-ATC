import test from 'node:test';
import { makeEngine } from '../engine/helpers';
test('wind', () => {
  for (const seed of [3, 4]) {
    const e = makeEngine('KJFK', { seed, ends: ['13L', '13R'], wind: { dir: 130, kts: 11 } } as any);
    (e as any).setWind?.(130, 11);
    const out: string[] = [];
    for (let m = 0; m <= 40; m += 5) { const w = e.wx(); out.push(`${m}m ${Math.round(w.windDirTrue)}/${Math.round(w.windKt)}`); for (let i = 0; i < 20; i++) e.step(15); }
    console.log('seed', seed, out.join(' '));
  }
});
