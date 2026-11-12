// Scratch probe for the voice-model plan: every AI-controller command in a full-auto session is rendered to the spoken
// transmission the engine would say (phraseology.transmission), then fed back through the typed-command parser.
// Measures how much of "clean spoken ATC" the rule parser already understands, per command kind, plus simple
// player-style perturbations (flight-number-only callsign, dropped filler words).
import test from 'node:test';
import { makeEngine } from '../engine/helpers';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import { transmission } from '../../src/lib/sim/phraseology';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine } from '../../src/lib/sim/dispatch';
import type { CommandAST } from '../../src/lib/sim/commandAst';

const ICAO = process.env.ICAO ?? 'KJFK', SEED = Number(process.env.SEED ?? 1), MIN = Number(process.env.MIN ?? 30);
let MV = 0;   // headings are compared in the magnetic frame they were spoken in (true -> spoken magnetic -> true is +-1 deg)
const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (k === 'hdg' ? 'H' : Math.round(v)) : v));
const hdgs = (x: unknown) => { const h: number[] = []; JSON.stringify(x, (k, v) => { if (k === 'hdg' && typeof v === 'number') h.push(v); return v; }); return h; };
const same = (a: unknown, b: unknown) => norm(a) === norm(b) && hdgs(a).every((v, i) => Math.abs(((v - hdgs(b)[i] + 540) % 360) - 180) <= 1.5);
const ONES: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, five: 5, fife: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Grouped spoken numbers -> digit strings: "eight sixty-five" -> 865, "seventy-six" -> 76, "one twenty" -> 120. */
export function numNorm(s: string): string {
  const w = s.replace(/(\w)-(\w)/g, '$1 $2').split(/\s+/); const out: string[] = []; let run = '';
  const flush = () => { if (run) { out.push(run); run = ''; } };
  for (let i = 0; i < w.length; i++) {
    const m = w[i].match(/^([A-Za-z]+)([,.]?)$/); const k = m ? m[1].toLowerCase() : ''; const p = m ? m[2] : '';
    if (k in TENS) { const nx = (w[i + 1] ?? '').replace(/[,.]$/, '').toLowerCase(); if (nx in ONES && ONES[nx] > 0) { run += String(TENS[k] + ONES[nx]); i++; const p2 = (w[i].match(/[,.]$/) ?? [''])[0]; if (p2) { run += p2; flush(); } } else run += String(TENS[k]); if (p) { run += p; flush(); } continue; }
    if (k in TEENS) { run += String(TEENS[k]); if (p) { run += p; flush(); } continue; }
    if (k in ONES) { run += String(ONES[k]); if (p) { run += p; flush(); } continue; }
    flush(); out.push(w[i]);
  }
  flush(); return out.join(' ');
}
const variants: Record<string, (s: string, cs: string, flightNo: string) => string> = {
  clean: s => s,
  lower_nopunct: s => s.toLowerCase().replace(/[,.]/g, ''),
  numnorm: s => numNorm(s),
  spoken_raw: s => s,
  numnorm_lower: s => numNorm(s).toLowerCase().replace(/[,.]/g, ''),
  numnorm_flightno: (s, cs, fno) => numNorm(s).replace(/^[A-Za-z ]+?(\d+)/, '$1'),
  drop_fillers: s => s.replace(/\b(and maintain|runway|degrees|knots|feet)\b/gi, '').replace(/\s+/g, ' '),
};
test('roundtrip', () => {
  const ends = preferredEnds(RUNWAY_MANIFEST[ICAO].flatMap(r => r.ends), 280, 10);
  const e = makeEngine(ICAO, { seed: SEED, pilotDelay: null, emergencies: 'off', ends } as any);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  MV = e.magVar ?? 0;
  let next = e.time + rf(50, 100); const t0 = e.time;
  const stats = new Map<string, Record<string, { n: number; ok: number; same: number }>>();
  const fails: string[] = [];
  while (e.time - t0 < MIN * 60) {
    if (e.time >= next) { if (e.aircraft.length < 14) { if (!(chance(0.55) ? e.spawnDeparture() : e.spawnArrival())) e.spawnDeparture(); } next = e.time + rf(50, 100); }
    for (const ev of e.step(15)) {
      const ast = (ev.data as any)?.ast as CommandAST | undefined;
      if (ev.type !== 'transmission' || ev.who !== 'AI' || !ast) continue;
      const a = e.find(ev.callsign); if (!a) continue;
      let spoken = ''; try { spoken = transmission(ast, e.phraseCtx(a)); } catch { continue; }
      if (!spoken) continue;
      const ctx = fromEngine(e as any);
      const kind = ast.kind;
      for (const [vn, fn] of Object.entries(variants)) {
        const s = fn(spoken, a.callsign, a.flightNo);
        const r = parseCommand(s, ctx as any);
        const row = (stats.get(kind) ?? {}); const c = row[vn] ?? { n: 0, ok: 0, same: 0 }; c.n++;
        if (r.ok && r.ast) { c.ok++; if (same(r.ast, ast)) c.same++; else if (vn === 'numnorm' && fails.length < 40) fails.push(`DIFF ${kind}: "${s}"\n   gold ${norm(ast).slice(0, 220)}\n   got  ${norm(r.ast).slice(0, 220)}`); }
        else if (vn === 'numnorm' && fails.length < 40) fails.push(`FAIL ${kind} [${a.callsign}/${a.flightNo}/${a.airline}]: "${s}" -> ${r.errors.map(x => (x as any).message ?? JSON.stringify(x)).join('; ').slice(0, 160)}`);
        row[vn] = c; stats.set(kind, row);
      }
    }
  }
  const tot: Record<string, { n: number; ok: number; same: number }> = {};
  for (const [kind, row] of [...stats].sort((x, y) => (y[1].clean?.n ?? 0) - (x[1].clean?.n ?? 0))) {
    console.log(kind.padEnd(16), Object.entries(row).map(([vn, c]) => { const t = tot[vn] ??= { n: 0, ok: 0, same: 0 }; t.n += c.n; t.ok += c.ok; t.same += c.same; return `${vn} ${c.same}/${c.ok}/${c.n}`; }).join('  '));
  }
  console.log('TOTAL (exact/parsed/n)', Object.entries(tot).map(([vn, c]) => `${vn} ${c.same}/${c.ok}/${c.n} = ${(100 * c.same / c.n).toFixed(1)}% exact, ${(100 * c.ok / c.n).toFixed(1)}% parsed`).join(' | '));
  console.log('RESULT ' + JSON.stringify({ icao: ICAO, seed: SEED, min: MIN, n: tot.clean?.n ?? 0, clean: tot.clean?.same ?? 0, clean_parsed: tot.clean?.ok ?? 0, drop: tot.drop_fillers?.same ?? 0, lower: tot.lower_nopunct?.same ?? 0, kinds: Object.fromEntries([...stats].map(([k, r]) => [k, [r.clean?.same ?? 0, r.clean?.n ?? 0]])) }));
  for (const f of fails) console.log(f);
});
