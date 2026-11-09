/*
  Pilot lines for the TTS benchmark (ml/tts/RESULTS.md): runs the headless sim in full-auto mode at several airports and
  keeps every line the game would speak in a pilot voice (readbacks, requests, emergencies: who === 'PILOT', the
  same events simStore.speak() reads aloud). In full-auto mode the AI's commands get no readback event, so the readback
  the pilot would give each AI command, and each command sampled from the click tree (as ml/data/export.ts samples them),
  comes from the engine's own phraseology (readback(ast, phraseCtx), what dispatch puts in result.readback). Template
  command lines (climb, cleared to land, line up, squawk, ...: TEMPLATES) parsed for a random aircraft add the kinds the
  AI and the sampler rarely say ('readback-template').
  One JSON line per unique message: {id, icao, cs, type, variant, text}.

  Run: ml/tts/lines.sh   (env: ICAOS=KJFK,EGLL SEEDS=1 MIN=12 OUT=ml/tts/data/lines_KJFK_EGLL.jsonl), three in parallel
  for the six airports, then `ml/tts/lines.sh normalize`.
*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeEngine } from '../../tests/engine/helpers';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import { EVENT_WHO } from '../../src/lib/sim/types';
import type { AircraftState } from '../../src/lib/sim/types';
import type { SimEngine } from '../../src/lib/sim/engine';
import type { CommandAST } from '../../src/lib/sim/commandAst';
import { readback } from '../../src/lib/sim/phraseology';
import { actionCtxFromEngine } from '../../src/lib/sim/dispatch';
import { actionsFor, toAst, validateAst } from '../../src/lib/sim/commandTree';
import type { ActionParams, PickerStep, ActionId } from '../../src/lib/sim/commandTree';
import { positionOf } from '../../src/lib/voice/context';
import { subStream } from '../../src/lib/sim/rng';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine } from '../../src/lib/sim/dispatch';

/** Command lines the 12-minute sessions rarely reach (landing, take-off, flight levels, squawks), parsed by the game's own
 *  parser and read back through its phraseology, so the set covers what a pilot says on final and in the climb. */
const TEMPLATES: ((cs: string, rwy: string) => string)[] = [
  (cs, r) => `${cs} Cleared to land ${r}`,
  (cs, r) => `${cs} Cleared for takeoff ${r}`,
  (cs, r) => `${cs} Line up and wait ${r}`,
  cs => `${cs} Climb FL${[230, 290, 350, 370, 190][Math.floor(R() * 5)]}`,
  cs => `${cs} Descend FL${[90, 110, 150, 120][Math.floor(R() * 4)]}`,
  cs => `${cs} Squawk ${[4721, 2365, 6013, 1739][Math.floor(R() * 4)]}`,
  cs => `${cs} Turn right heading ${[270, 300, 90, 190][Math.floor(R() * 4)]}`,
  cs => `${cs} Contact departure`,
  cs => `${cs} Reduce speed 180`,
];

const env = process.env;
const ICAOS = (env.ICAOS ?? 'KJFK,EGLL,KLAX,OMDB,YSSY,LFPG').split(',');
const range = (s: string) => s.includes('-') ? Array.from({ length: Number(s.split('-')[1]) - Number(s.split('-')[0]) + 1 }, (_, i) => Number(s.split('-')[0]) + i) : s.split(',').map(Number);
const SEEDS = range(env.SEEDS ?? '1-2');
const MIN = Number(env.MIN ?? 25);
const OUT = env.OUT ?? 'ml/tts/data/pilot_lines.jsonl';

const R = subStream('tts-lines');
const rint = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(R() * xs.length)] : undefined);
const SKIP = new Set<string>(['action-report', 'action-say-again', 'action-correction']);
/** A reduced ml/data/export.ts fillParams: random valid picker choices. */
function fill(steps: PickerStep[]): ActionParams | null {
  const p: ActionParams = {};
  for (const s of steps) {
    switch (s.type) {
      case 'runway': { const r = s.default ?? pick(s.candidates.filter(x => x.enabled))?.name; if (!r) return null; p.runway = r; break; }
      case 'taxiway-route': p.route = s.taxiways.length && R() < 0.6 ? { via: s.taxiways.slice(0, rint(1, Math.min(3, s.taxiways.length))), auto: false } : { via: [], auto: true }; break;
      case 'heading': p.heading = ((rint(1, 72) * 5 + s.magVar) % 360 + 360) % 360; if (s.allowDir && R() < 0.4) p.dir = R() < 0.5 ? 'L' : 'R'; break;
      case 'altitude': { const v = pick(s.rungs.filter(x => x.band === 'ok'))?.ft ?? s.default; if (v == null) return null; p.altitude = v; break; }
      case 'speed': p.speed = s.chips.length && R() < 0.5 ? pick(s.chips)! : Math.round((s.min + R() * (s.max - s.min)) / 10) * 10; break;
      case 'fix': { const f = pick(s.candidates)?.name ?? s.default; if (!f) return null; p.fix = f; break; }
      case 'hold': { const f = s.defaultFix ?? pick(s.candidates)?.name; if (!f) return null; p.hold = { fix: f, dir: s.defaultDir }; break; }
      case 'direction': { const d = pick(s.enabledOptions) ?? s.default; if (d) p.direction = d as never; break; }
      case 'taxiway': { const e = s.exits.filter(x => x.enabled); const t = e.length && s.mode === 'exit' ? pick(e)!.taxiway : pick(s.candidates) ?? s.default; if (!t) return null; p.taxiway = t; if (s.mode === 'exit') p.exit = { kind: 'taxiway', taxiway: t }; break; }
      case 'gate': { const g = pick(s.candidates.filter(x => x.enabled))?.ref ?? s.default; if (!g) return null; p.stand = g; break; }
      case 'aircraft': { const c = pick(s.candidates)?.callsign; if (!c) return null; p.aircraft = c; break; }
      case 'position': { const c = s.default ?? pick(s.candidates.filter(x => x.enabled))?.position; if (!c) return null; p.position = c; p.when = s.when; break; }
      case 'text': if (s.default.length) p.chips = s.default; break;
      case 'vehicle': return null;
      case 'confirm': break;
    }
  }
  return p;
}
function sample(e: SimEngine, a: AircraftState): CommandAST | null {
  const pos = positionOf(a.onFrequency); if (!pos) return null;
  const ctx = actionCtxFromEngine(e, a, { position: pos }); if (!ctx) return null;
  const rows = actionsFor(a, ctx).filter(r => r.state === 'enabled' && !SKIP.has(r.id as string));
  for (let k = 0; k < 4 && rows.length; k++) {
    const row = pick(rows)!; const params = fill(row.steps); if (!params) continue;
    let ast: CommandAST; try { ast = toAst(row.id as ActionId, params, a.callsign, a); } catch { continue; }
    const v = validateAst(ast, a, ctx); if (v.ok) return v.ast ?? ast;
  }
  return null;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const seen = new Set<string>();
const rows: object[] = [];
for (const icao of ICAOS) for (const seed of SEEDS) {
  if (!RUNWAY_MANIFEST[icao]) { console.log(`skip ${icao}: no runway manifest`); continue; }
  const wd = (seed * 97 + icao.charCodeAt(1) * 13) % 360;
  const ends = preferredEnds(RUNWAY_MANIFEST[icao].flatMap(r => r.ends), wd, 10);
  const e = makeEngine(icao, { seed, pilotDelay: null, emergencies: 'normal', ends, pilotErrorRate: 0.02 } as never);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100); const t0 = e.time; let n = 0; let nextSample = e.time + 20;
  const add = (cs: string, type: string, text: string) => {
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return;
    seen.add(key); n++;
    rows.push({ id: rows.length, icao, seed, cs, type, variant: e.settings.region, text: key });
  };
  const rb = (a: AircraftState, ast: CommandAST, type: string) => { try { add(a.callsign, type, readback(ast, e.phraseCtx(a))); } catch { /* no phrase */ } };
  while (e.time - t0 < MIN * 60) {
    if (e.time >= next) { if (e.aircraft.length < 14 && !(chance(0.55) ? e.spawnDeparture() : e.spawnArrival())) e.spawnDeparture(); next = e.time + rf(50, 100); }
    for (const ev of e.step(15)) {
      const who = ev.who ?? EVENT_WHO[ev.type];
      const d = ev.data as { type?: string; change?: string; ast?: CommandAST } | undefined;
      if (ev.type === 'transmission' && ev.who === 'AI' && d?.ast) { const a = e.find(ev.callsign); if (a) rb(a, d.ast, 'readback-ai'); continue; }
      if (who !== 'PILOT' || !ev.message) continue;
      if (ev.type === 'request' && d?.type === 'request' && d.change !== 'raised' && d.change !== 'recalled') continue;
      add(ev.callsign, ev.type, ev.message);
    }
    if (e.time >= nextSample) {
      nextSample = e.time + 20;
      for (let k = 0; k < 2; k++) { const a = pick(e.aircraft); if (!a) break; const ast = sample(e, a); if (ast) rb(a, ast, 'readback-sample'); }
      const a = pick(e.aircraft);
      if (a && ends.length) {
        const line = pick(TEMPLATES)!(a.callsign, pick(ends)!);
        try { const r = parseCommand(line, fromEngine(e) as never); if (r.ok && r.ast) rb(a, r.ast, 'readback-template'); } catch { /* not parsed */ }
      }
    }
  }
  console.log(`${icao} seed ${seed}: ${n} lines`);
}
fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} lines to ${OUT}`);
