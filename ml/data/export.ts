/*
  Dataset exporter (ml/README.md module 1, docs/spec/11-VOICE-MODEL.md §3).

  Runs the headless sim in full-auto mode and writes one JSON line per controller command:
    src      'ai'      a command the rule-based AI issued (realistic timing and choice: the teacher)
             'sample'  a command drawn from an aircraft's currently valid actions in the click tree, with random
                       valid parameters (covers what the AI never says: holds, directs, go-arounds, odd headings, ...)
    ctx      the compact game state the model reads (src/lib/voice/context.ts)
    line     the canonical command line the model must output (parses back to `ast`, checked here)
    say      what a controller says for it: ICAO and FAA phraseology from the engine
    ast      the structured command
  Sampled commands are NOT applied, so they never change the sim; only the AI's commands drive it.

  Run: ml/data/export.sh   (env: ICAOS=KJFK,EGLL SEEDS=1-4 MIN=40 OUT=ml/data/out/train.jsonl SAMPLE_EVERY=20)
*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeEngine } from '../../tests/engine/helpers';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance, subStream } from '../../src/lib/sim/rng';
import { transmission } from '../../src/lib/sim/phraseology';
import type { PhraseVariant } from '../../src/lib/sim/phraseology';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine, actionCtxFromEngine } from '../../src/lib/sim/dispatch';
import { actionsFor, toAst, validateAst } from '../../src/lib/sim/commandTree';
import type { ActionParams, PickerStep, ActionId } from '../../src/lib/sim/commandTree';
import type { CommandAST } from '../../src/lib/sim/commandAst';
import type { AircraftState, PlayerPosition } from '../../src/lib/sim/types';
import type { SimEngine } from '../../src/lib/sim/engine';
import { voiceContext, canonicalLine, positionOf, spokenName } from '../../src/lib/voice/context';

const env = process.env;
const ICAOS = (env.ICAOS ?? 'KJFK').split(',');
const range = (s: string) => s.includes('-') ? Array.from({ length: Number(s.split('-')[1]) - Number(s.split('-')[0]) + 1 }, (_, i) => Number(s.split('-')[0]) + i) : s.split(',').map(Number);
const SEEDS = range(env.SEEDS ?? '1');
const MIN = Number(env.MIN ?? 30);
const SAMPLE_EVERY = Number(env.SAMPLE_EVERY ?? 20);
const OUT = env.OUT ?? 'ml/data/out/train.jsonl';
const SKIP_ACTIONS = new Set<ActionId>(['action-report', 'action-say-again', 'action-correction'] as ActionId[]);

// AST equality for label hygiene: headings within 1.5 deg (true -> magnetic -> true rounds)
const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (k === 'hdg' || k === 'thenHdg' || k === 'inbound' || k === 'afterDepHdg' ? 'H' : Math.round(v)) : v));
const hdgs = (x: unknown) => { const h: number[] = []; JSON.stringify(x, (k, v) => { if ((k === 'hdg' || k === 'thenHdg' || k === 'inbound' || k === 'afterDepHdg') && typeof v === 'number') h.push(v); return v; }); return h; };
const same = (a: unknown, b: unknown) => norm(a) === norm(b) && hdgs(a).every((v, i) => Math.abs(((v - hdgs(b)[i] + 540) % 360) - 180) <= 1.5);
// the sampler draws from its own stream so sampling never changes the sim's trajectory
const R = subStream('voice-export');
const rint = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const rch = (p: number) => R() < p;
const rfl = (lo: number, hi: number) => lo + R() * (hi - lo);
const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(R() * xs.length)] : undefined);
const REJECTS: string[] = [];

/** Fill an action's picker steps with random valid choices (what a player could click). */
function fillParams(steps: PickerStep[], a: AircraftState): ActionParams | null {
  const p: ActionParams = {};
  for (const s of steps) {
    switch (s.type) {
      case 'runway': { const c = s.candidates.filter(x => x.enabled); const r = s.locked ? s.default : rch(0.7) && s.default ? s.default : pick(c)?.name ?? s.default; if (!r) return null; p.runway = r; break; }
      case 'taxiway-route': {
        if (rch(0.5) || !s.taxiways.length) p.route = { via: [], auto: true };
        else { const n = rint(1, Math.min(3, s.taxiways.length)); const start = rint(0, s.taxiways.length - n); p.route = { via: s.taxiways.slice(start, start + n), auto: false }; }
        if (s.allowHoldShort && s.holdShortSuggestions.length && rch(0.4)) p.route.holdShortOf = { kind: 'runway', runway: pick(s.holdShortSuggestions)! };
        break;
      }
      case 'heading': { const m = rint(1, 72) * 5; p.heading = ((m + s.magVar) % 360 + 360) % 360; if (s.allowDir && rch(0.4)) p.dir = rch(0.5) ? 'L' : 'R'; break; }
      case 'altitude': { const r = s.rungs.filter(x => x.band === 'ok'); const v = pick(r)?.ft ?? s.default; if (v == null) return null; p.altitude = v; if (s.expediteToggle && rch(0.1)) p.expedite = true; break; }
      case 'speed': { const v = rch(0.5) && s.chips.length ? pick(s.chips)! : Math.round(rfl(s.min, s.max) / 10) * 10; p.speed = v; break; }
      case 'fix': { const f = pick(s.candidates)?.name ?? s.default; if (!f) return null; p.fix = f; break; }
      case 'hold': { const f = s.defaultFix ?? pick(s.candidates)?.name; if (!f) return null; p.hold = { fix: f, dir: s.defaultDir }; break; }
      case 'direction': { const d = pick(s.enabledOptions) ?? s.default; if (d) p.direction = d as never; break; }
      case 'taxiway': { const e = s.exits.filter(x => x.enabled); const t = e.length && s.mode === 'exit' ? pick(e)!.taxiway : pick(s.candidates) ?? s.default; if (!t) return null; p.taxiway = t; if (s.mode === 'exit') p.exit = { kind: 'taxiway', taxiway: t }; break; }
      case 'gate': { const g = pick(s.candidates.filter(x => x.enabled))?.ref ?? s.default; if (!g) return null; p.stand = g; break; }
      case 'aircraft': { const c = pick(s.candidates)?.callsign; if (!c) return null; p.aircraft = c; break; }
      case 'position': { const c = s.default ?? pick(s.candidates.filter(x => x.enabled))?.position; if (!c) return null; p.position = c; p.when = s.when; break; }
      case 'text': { if (s.default.length) p.chips = s.default; break; }
      case 'vehicle': return null;
      case 'confirm': break;
    }
  }
  void a; return p;
}

/** One random valid command for an aircraft, through the same tree the click UI uses. */
function sampleCommand(e: SimEngine, a: AircraftState): { ast: CommandAST; pos: PlayerPosition } | null {
  const pos = positionOf(a.onFrequency); if (!pos) return null;
  const ctx = actionCtxFromEngine(e, a, { position: pos }); if (!ctx) return null;
  const rows = actionsFor(a, ctx).filter(r => r.state === 'enabled' && !SKIP_ACTIONS.has(r.id));
  for (let tries = 0; tries < 4 && rows.length; tries++) {
    const row = pick(rows)!;
    const params = fillParams(row.steps, a); if (!params) continue;
    let ast: CommandAST; try { ast = toAst(row.id, params, a.callsign, a); } catch { continue; }
    const v = validateAst(ast, a, ctx);
    if (v.ok) return { ast: v.ast ?? ast, pos };
  }
  return null;
}

const posOfMessage = (m: string): PlayerPosition | null => (/^AI APP/.test(m) ? 'approach' : /^AI TWR/.test(m) ? 'tower' : /^AI GND/.test(m) ? 'ground' : null);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.openSync(OUT, 'w');
const stats = { ai: 0, sample: 0, rejected: 0, kinds: {} as Record<string, number> };
let id = 0;
for (const icao of ICAOS) for (const seed of SEEDS) {
  const wd = (seed * 97 + icao.charCodeAt(1) * 13) % 360;
  const ends = preferredEnds(RUNWAY_MANIFEST[icao].flatMap(r => r.ends), wd, 10);
  const e = makeEngine(icao, { seed, pilotDelay: null, emergencies: 'off', ends } as never);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  const write = (a: AircraftState, ast: CommandAST, src: 'ai' | 'sample', pos: PlayerPosition) => {
    const line = canonicalLine(ast, e.magVar ?? 0);
    const r = parseCommand(line, fromEngine(e) as never);
    if (!r.ok || !same(r.ast, ast)) { stats.rejected++; if (REJECTS.length < 30) REJECTS.push(`${src} ${line}  ->  ${r.ok ? norm(r.ast).slice(0, 160) + '  GOLD ' + norm(ast).slice(0, 160) : r.errors.map(x => x.message).join('; ')}`); return; }
    const pc = e.phraseCtx(a);
    const say: Record<string, string> = {};
    for (const v of ['ICAO', 'FAA'] as PhraseVariant[]) { try { say[v] = transmission(ast, { ...pc, variant: v }); } catch { /* no phrase for this kind */ } }
    if (!say.ICAO && !say.FAA) { stats.rejected++; return; }
    const k = ast.kind === 'sequence' ? ast.parts.map(x => x.kind).join('+') : ast.kind;
    stats.kinds[k] = (stats.kinds[k] ?? 0) + 1; stats[src]++;
    fs.writeSync(out, JSON.stringify({ id: id++, src, icao, seed, t: Math.round(e.time), pos, cs: a.callsign, name: spokenName(a), ctx: voiceContext(e, pos).text, line, say, kind: k, ast }) + '\n');
  };
  let next = e.time + rf(50, 100); let nextSample = e.time + SAMPLE_EVERY; const t0 = e.time;
  while (e.time - t0 < MIN * 60) {
    if (e.time >= next) { if (e.aircraft.length < 14 && !(chance(0.55) ? e.spawnDeparture() : e.spawnArrival())) e.spawnDeparture(); next = e.time + rf(50, 100); }
    for (const ev of e.step(15)) {
      const ast = (ev.data as { ast?: CommandAST } | undefined)?.ast;
      if (ev.type !== 'transmission' || ev.who !== 'AI' || !ast) continue;
      const a = e.find(ev.callsign); const pos = posOfMessage(ev.message);
      if (a && pos) write(a, ast, 'ai', pos);
    }
    if (e.time >= nextSample) {
      nextSample = e.time + SAMPLE_EVERY;
      for (let k = 0; k < 2; k++) { const a = pick(e.aircraft); if (!a) break; const s = sampleCommand(e, a); if (s) write(a, s.ast, 'sample', s.pos); }
    }
  }
  console.log(`${icao} seed ${seed}: ai ${stats.ai} sample ${stats.sample} rejected ${stats.rejected}`);
}
fs.closeSync(out);
fs.writeFileSync(OUT.replace(/\.jsonl$/, '.stats.json'), JSON.stringify(stats, null, 1));
if (env.SHOW_REJECTS) for (const x of REJECTS) console.log('REJECT', x);
console.log('kinds', Object.keys(stats.kinds).length, JSON.stringify(Object.entries(stats.kinds).sort((x, y) => y[1] - x[1]).slice(0, 40)));
