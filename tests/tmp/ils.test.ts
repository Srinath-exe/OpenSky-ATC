import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
const v = CHAPTERS.find((c) => c.id === 'a-vectors')!; v.setup(e);
for (const c of ['UAL1729 turn left heading 270', 'UAL1729 descend and maintain 5000', 'UAL1729 reduce speed 210']) { text(e, c); for (let i = 0; i < 4; i++) e.step(30); }
const ch = CHAPTERS.find((c) => c.id === 'a-ils')!; const ctx = ch.resume!(e); console.log('resume', JSON.stringify(ctx?.data));
const a = e.find('UAL1729')!;
const t = e.thresholdXY('28L')!; const o = e.thresholdXY('10R')!; const dx = o.x - t.x, dy = o.y - t.y, L = Math.hypot(dx, dy);
const log = (w: string) => console.log(w, Math.round(e.time), a.phase, 'hdg', Math.round(a.heading), 'alt', Math.round(a.altitude), 'dist NM', (Math.hypot(a.pos.x - t.x, a.pos.y - t.y) / 1852).toFixed(1), 'off', ((dx * (a.pos.y - t.y) - dy * (a.pos.x - t.x)) / L / 1852).toFixed(2), 'along', (-((a.pos.x - t.x) * dx + (a.pos.y - t.y) * dy) / L / 1852).toFixed(1), 'armed', a.ilsArmed, 'loc', (a as any).locCaptured, 'cap', a.ilsCaptured);
log('start');
if (ctx) { text(e, `UAL1729 turn ${ctx.data.turn} heading ${String(ctx.data.cut).padStart(3, '0')}`); for (let i = 0; i < 8; i++) e.step(30); text(e, 'UAL1729 cleared ILS runway 28L approach'); }
for (let s = 0; s < 400; s += 20) { for (let i = 0; i < 20; i++) e.step(30); log(String(s)); }
