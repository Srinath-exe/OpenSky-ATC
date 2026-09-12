// Headless engine fixtures: real OSM graph + Endless-ATC airspace, seeded RNG.
//
// Every test builds its engine through makeEngine() exactly the way the store
// does (buildOsmAirport + airspace config projected into engine XY), drives it
// with engine.step(n) (fixed 1/30 s substeps) and talks to it through the
// EngineCommandApi via applyToEngine (dispatch() is still a W1-COMMANDS stub).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildOsmAirport } from '../../src/lib/osmAirport';
import { parseEndlessAirport, coordToXY, EAirport } from '../../src/lib/airspace/eairport';
import { SimEngine, AirspaceConfig, FIXED } from '../../src/lib/sim/engine';
import { setSeed } from '../../src/lib/sim/rng';
import { advance, dist, headingTo, angleDelta, NM_TO_M, KTS_TO_MPS, XY } from '../../src/lib/sim/projection';
import type { AircraftState, SimEvent, SimEventType, ScoreCode } from '../../src/lib/sim/types';
import type { CommandAST, EngineOutcome, CommandResult } from '../../src/lib/sim/commandAst';
import { applyToEngine, executeText } from '../../src/lib/sim/dispatch';

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

export interface EngineOpts {
  seed?: number;
  /** Active runway ends (null/undefined = every end active). */
  ends?: string[] | null;
  /** Fixed pilot delay in s (null = realistic 2-4 s air / 4-8 s ground). Default 2. */
  pilotDelay?: number | null;
  autoHandoff?: boolean;
  emergencies?: 'off' | 'normal' | 'training';
  /** Wrong-readback probability (default 0 so scripted scenarios are exact). */
  pilotErrorRate?: number;
}

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
  e.settings.pilotErrorRate = opts.pilotErrorRate ?? 0;
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
/** Dispatch an AST straight to the engine (bypasses W1-COMMANDS' dispatch, which is still a stub). */
export function cmd(e: SimEngine, ast: CommandAST): EngineOutcome {
  const a = 'callsign' in ast ? e.find(ast.callsign) ?? null : null;
  const out = applyToEngine(e, ast, a);
  e.onTransmission(ast, { ok: out.ok, code: out.code, transmission: '', readback: '', reason: out.reason, applyAt: out.applyAt }, a);
  return out;
}
/** Typed command line -> parser -> dispatch (W1-COMMANDS' executeText); returns the CommandResult. */
export function text(e: SimEngine, line: string): CommandResult & { parsedOk: boolean } {
  const r = executeText(e, line);
  return { ...r.result, parsedOk: !!r.parse.ok };
}
export function byCs(e: SimEngine, cs: string): AircraftState { const a = e.find(cs); if (!a) throw new Error(`no aircraft ${cs}`); return a; }
export const has = (evs: SimEvent[], type: SimEvent['type'], cs?: string) => evs.some(ev => ev.type === type && (!cs || ev.callsign === cs));
/** Events of a type (optionally for a callsign) from the engine ring buffer. */
export const evs = (e: SimEngine, type: SimEventType, cs?: string): SimEvent[] => e.events.filter(ev => ev.type === type && (!cs || ev.callsign === cs));
/** Score ledger codes in order. */
export const ledger = (e: SimEngine): ScoreCode[] => e.stats.ledger.map(l => l.code);
export const ledgerHas = (e: SimEngine, code: ScoreCode, cs?: string) => e.stats.ledger.some(l => l.code === code && (!cs || l.primary === cs));

// ──────────────────────────────────────────────────────────────────────────────
//  Tick-by-tick tracking: teleport detection (B5) and the hold-short-place invariant (B4)
// ──────────────────────────────────────────────────────────────────────────────
export interface TrackViolation { at: number; callsign: string; kind: 'teleport' | 'hold_place' | 'backwards'; detail: string }
export interface Tracker { violations: TrackViolation[]; maxRatio: number; ticks: number }
export function newTracker(): Tracker { return { violations: [], maxRatio: 0, ticks: 0 }; }

/**
 * Step the sim one substep at a time for `s` seconds, checking every tracked
 * aircraft each tick:
 *  - displacement <= (max(speed_prev, speed_now) + wind) * dt * 1.5 + 5 cm (no teleports),
 *  - on a path the arc-length never decreases (no backward jumps),
 *  - phase hold_short at a runway hold implies the node protects that runway.
 * Returns the events. `until` stops early when true.
 */
export function runTracked(e: SimEngine, tracked: AircraftState[], s: number, tr: Tracker, until?: () => boolean): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(s / FIXED);
  const prev = new Map<number, { pos: XY; speed: number; along: number; pathRef: unknown }>();
  for (const a of tracked) prev.set(a.id, { pos: { ...a.pos }, speed: a.speed, along: a.distAlong, pathRef: a.path });
  for (let i = 0; i < n; i++) {
    out.push(...e.step(1));
    tr.ticks++;
    const windKt = e.wx().windKt + e.wx().gustKt;
    for (const a of tracked) {
      if (!e.byId(a.id)) continue;
      const p = prev.get(a.id)!;
      const moved = dist(p.pos, a.pos);
      const allowed = (Math.max(p.speed, a.speed) + windKt) * KTS_TO_MPS * FIXED * 1.5 + 0.05;
      const ratio = moved / Math.max(allowed, 1e-6);
      if (ratio > tr.maxRatio) tr.maxRatio = ratio;
      if (moved > allowed) tr.violations.push({ at: e.time, callsign: a.callsign, kind: 'teleport', detail: `${a.phase}: moved ${moved.toFixed(2)} m, allowed ${allowed.toFixed(2)} m (speed ${a.speed.toFixed(1)} kt)` });
      if (a.path && a.path === p.pathRef && a.distAlong < p.along - 1e-6) tr.violations.push({ at: e.time, callsign: a.callsign, kind: 'backwards', detail: `${a.phase}: distAlong ${p.along.toFixed(2)} -> ${a.distAlong.toFixed(2)}` });
      if (a.phase === 'hold_short' && a.holdShortRunway) {
        const ok = !!a.holdShortNode && e.isHoldNodeForRunway(a.holdShortNode, a.holdShortRunway);
        if (!ok) tr.violations.push({ at: e.time, callsign: a.callsign, kind: 'hold_place', detail: `hold_short of ${a.holdShortRunway} at node ${a.holdShortNode}` });
      }
      prev.set(a.id, { pos: { ...a.pos }, speed: a.speed, along: a.distAlong, pathRef: a.path });
    }
    if (until && until()) break;
  }
  return out;
}
/** runTracked until `pred` or `maxS`; returns elapsed and whether pred became true. */
export function runTrackedUntil(e: SimEngine, tracked: AircraftState[], pred: () => boolean, maxS: number, tr: Tracker): { ok: boolean; elapsed: number; events: SimEvent[] } {
  const t0 = e.time;
  const events = runTracked(e, tracked, maxS, tr, pred);
  return { ok: pred(), elapsed: e.time - t0, events };
}
export function formatViolations(tr: Tracker, max = 8): string {
  return tr.violations.slice(0, max).map(v => `${v.at.toFixed(2)} ${v.callsign} ${v.kind}: ${v.detail}`).join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
//  Geometry helpers
// ──────────────────────────────────────────────────────────────────────────────
/** Along-track (m, + = past the threshold in the landing direction) and cross-track (m) of a point relative to a runway end. */
export function runwayFrame(e: SimEngine, endName: string, p: XY): { along: number; cross: number } {
  const rs = e.runwayState(endName)!; const thr = e.thresholdXY(endName)!;
  const h = rs.headingTrue * Math.PI / 180;
  const dx = p.x - thr.x, dy = p.y - thr.y;
  return { along: dx * Math.sin(h) + dy * Math.cos(h), cross: dx * Math.cos(h) - dy * Math.sin(h) };
}
/** True when the aircraft nose is aligned (+-tolDeg) with a taxiway-graph edge of some node within `maxM` (i.e. it sits on a lane, facing along it). */
export function facingTaxiway(e: SimEngine, a: AircraftState, tolDeg = 35, maxM = 40): boolean {
  for (const id of e.air.nodes.keys()) {
    const nx = e.nodeXY(id)!;
    if (dist(nx, a.pos) > maxM) continue;
    for (const ed of e.air.nodes.get(id)!.edges) {
      const h = headingTo(nx, e.nodeXY(ed.to)!);
      if (Math.abs(angleDelta(h, a.heading)) < tolDeg) return true;
    }
  }
  return false;
}
/** Spawn an arrival on the extended centreline `nm` out, ILS armed, on tower frequency. */
export function spawnOnFinal(e: SimEngine, callsign: string, runway: string, nm: number, opts: { type?: string; altFt?: number; speedKts?: number; onFrequency?: 'tower' | 'approach'; landingCleared?: boolean } = {}): AircraftState {
  const gsAlt = Math.round(nm * NM_TO_M * Math.tan(3 * Math.PI / 180) * 3.28084 / 100) * 100;
  return e.spawnAt({
    callsign, type: opts.type ?? 'A320', kind: 'arrival', phase: 'approach',
    posRel: { fromRunway: runway, alongNM: -nm, altFt: opts.altFt ?? Math.max(200, gsAlt - 60) },
    speedKts: opts.speedKts ?? 170, ils: runway, onFrequency: opts.onFrequency ?? 'tower', landingCleared: opts.landingCleared,
  });
}
export { FIXED, NM_TO_M, KTS_TO_MPS, dist, headingTo, angleDelta, advance };
export type { XY };
