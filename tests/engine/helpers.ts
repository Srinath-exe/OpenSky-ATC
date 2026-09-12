// Headless engine fixtures: real OSM graph + Endless-ATC airspace, seeded RNG.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildOsmAirport } from '../../src/lib/osmAirport';
import { parseEndlessAirport, coordToXY, EAirport } from '../../src/lib/airspace/eairport';
import { SimEngine, AirspaceConfig, FIXED } from '../../src/lib/sim/engine';
import { setSeed } from '../../src/lib/sim/rng';
import { advance, NM_TO_M } from '../../src/lib/sim/projection';
import type { AircraftState, SimEvent } from '../../src/lib/sim/types';
import type { CommandAST, EngineOutcome } from '../../src/lib/sim/commandAst';
import { applyToEngine } from '../../src/lib/sim/dispatch';

const ROOT = process.cwd();
const cache = new Map<string, { fc: unknown; ap: EAirport | null }>();

export function loadData(icao: string) {
  let d = cache.get(icao);
  if (!d) {
    const fc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'maps', 'osm', `${icao}.geojson`), 'utf8'));
    let ap: EAirport | null = null;
    try { ap = parseEndlessAirport(fs.readFileSync(path.join(ROOT, 'public', 'airspace', `${icao}.txt`), 'utf8')); } catch { ap = null; }
    d = { fc, ap }; cache.set(icao, d);
  }
  return d;
}

export interface EngineOpts { seed?: number; ends?: string[] | null; pilotDelay?: number | null; autoHandoff?: boolean; emergencies?: 'off' | 'normal' | 'training' }

/** Build an engine exactly the way the store does: OSM graph + airspace config projected into engine XY. */
export function makeEngine(icao: string, opts: EngineOpts = {}): SimEngine {
  setSeed(opts.seed ?? 42);
  const { fc, ap } = loadData(icao);
  const air = buildOsmAirport(icao, fc, { magVarDeg: ap?.airspace.magVar, quiet: true });
  const e = new SimEngine(air);
  e.setActiveRunwayEnds(opts.ends === undefined ? null : opts.ends);
  if (ap) {
    const proj = e.proj;
    const centerXY = coordToXY({ kind: 'll', lat: ap.airspace.center.lat, lng: ap.airspace.center.lng }, proj);
    const radiusM = ap.airspace.radiusNM * NM_TO_M;
    const cfg: AirspaceConfig = {
      radiusM,
      centerXY,
      ilsRunways: ap.runways.map(r => ({ name: r.name, thrXY: coordToXY(r.thrCoord ?? r.coord, proj), rwdHdg: r.trueHeading, locCourse: r.localizerCourse, gsDeg: r.glideslopeDeg, thrElevFt: 0, estimated: r.derived })),
      beacons: ap.airspace.beacons.map(b => { const p = coordToXY(b.coord, proj); return { id: b.id, x: p.x, y: p.y }; }),
      entries: ap.entryPoints.map(ep => { const p = advance(centerXY, (ep.heading + 180) % 360, radiusM); return { x: p.x, y: p.y, heading: ep.heading, altFt: ep.altitudeFt, beacon: ep.beacon, weight: ep.weight }; }),
      magVar: ap.airspace.magVar, transitionAltFt: ap.airspace.transitionAltFt, airportName: ap.name,
    };
    e.setAirspaceConfig(cfg);
  }
  e.settings.pilotDelayOverride = opts.pilotDelay === undefined ? 2 : opts.pilotDelay;
  e.settings.autoHandoff = opts.autoHandoff ?? true;
  e.settings.emergencyRate = opts.emergencies ?? 'off';
  e.settings.pilotErrorRate = 0;
  return e;
}

/** Advance the sim by `s` seconds in fixed substeps; collects events. */
export function run(e: SimEngine, s: number): SimEvent[] {
  const n = Math.round(s / FIXED);
  return e.step(n);
}
/** Advance until `pred` is true or `maxS` elapsed. Returns elapsed seconds and events. */
export function runUntil(e: SimEngine, pred: () => boolean, maxS: number, chunkS = 1): { ok: boolean; elapsed: number; events: SimEvent[] } {
  const events: SimEvent[] = [];
  let t = 0;
  while (t < maxS) {
    if (pred()) return { ok: true, elapsed: t, events };
    events.push(...run(e, chunkS));
    t += chunkS;
  }
  return { ok: pred(), elapsed: t, events };
}
/** Dispatch an AST straight to the engine (bypasses W1-COMMANDS' dispatch). */
export function cmd(e: SimEngine, ast: CommandAST): EngineOutcome {
  const a = 'callsign' in ast ? e.find(ast.callsign) ?? null : null;
  const out = applyToEngine(e, ast, a);
  e.onTransmission(ast, { ok: out.ok, code: out.code, transmission: '', readback: '', reason: out.reason, applyAt: out.applyAt }, a);
  return out;
}
export function byCs(e: SimEngine, cs: string): AircraftState { const a = e.find(cs); if (!a) throw new Error(`no aircraft ${cs}`); return a; }
export const has = (evs: SimEvent[], type: SimEvent['type'], cs?: string) => evs.some(ev => ev.type === type && (!cs || ev.callsign === cs));
