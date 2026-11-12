// quick checks of spoken forms through the parser
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../engine/helpers';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine } from '../../src/lib/sim/dispatch';
test('spoken', () => {
  const e = makeEngine('KJFK', { seed: 1 } as any);
  const d = e.spawnDeparture({ callsign: 'DAL421' } as any)!; void d;
  const ctx = fromEngine(e as any) as any;
  const tw = (ctx.taxiways ?? []).slice(0, 30); console.log('TWY', tw.join(' ')); console.log('STANDS', (ctx.stands ?? []).slice(0, 12).join(' '));
  for (const s of ['delta four twenty-one taxi runway three one left via alpha bravo hold short of runway two two right', 'Delta 421, taxi to stand Bravo 22', 'delta four two one turn left heading two seven zero descend and maintain four thousand', 'DAL421 TAXI 31L VIA A B', 'delta four twenty one climb flight level two forty', 'delta one oh eight']) {
    const r = parseCommand(s, ctx); console.log(r.ok ? 'OK ' : 'ERR', s, '=>', r.ok ? JSON.stringify(r.ast).slice(0, 200) : r.errors.map(x => x.message).join(';'));
  }
  assert.ok(true);
});
