// ============================================================
//  SimEngine — owns aircraft, runs the fixed-timestep loop, spawns traffic,
//  builds drivable paths, enforces ground traffic rules + separation,
//  and tracks ILS approach / departure handoff logic.
// ============================================================
import {
  LocalProjection, XY, dist, headingTo, advance, chaikin,
  dedupeBacktracks, arcLengths, resample, distToSegment, NM_TO_M, FT_TO_M,
} from './projection';
import { OsmAirport, findPath, taxiwaysForPath } from '../osmAirport';
import { getPerformance, randomCommercialType, randomCommercialTypeOf, wakeSeparationNM, WeightClass } from './aircraftDB';
import { AircraftState, DrivePath, SimEvent, SimEventType, FlightKind, PendingCmd, newAircraftFields } from './types';
import { stepAircraft, setPhase, isAirborne } from './aircraft';
import {
  ILSRunway, canCaptureLoc, locTargetHdg, gsAltFt, gsDistM,
  distAlongFwd, distFromThrM, aboveGlideslope,
} from './ils';

const FIXED = 1 / 30, MAX_SUBSTEPS = 6;
const VERT_SEP_FT = 1000, HORIZ_SEP_NM = 3;
const PILOT_DELAY_S = 3;
const FT_PER_M = 1 / FT_TO_M;

const AIRLINES = [
  { icao: 'BAW', iata: 'BA', name: 'British Airways' }, { icao: 'UAL', iata: 'UA', name: 'United' },
  { icao: 'AAL', iata: 'AA', name: 'American' }, { icao: 'DAL', iata: 'DL', name: 'Delta' },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa' }, { icao: 'AFR', iata: 'AF', name: 'Air France' },
  { icao: 'KLM', iata: 'KL', name: 'KLM' }, { icao: 'UAE', iata: 'EK', name: 'Emirates' },
  { icao: 'QTR', iata: 'QR', name: 'Qatar' }, { icao: 'SIA', iata: 'SQ', name: 'Singapore' },
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific' }, { icao: 'QFA', iata: 'QF', name: 'Qantas' },
  { icao: 'SWR', iata: 'LX', name: 'Swiss' }, { icao: 'EIN', iata: 'EI', name: 'Aer Lingus' },
];
const CITIES = ['MUC', 'FRA', 'CDG', 'AMS', 'MAD', 'DXB', 'SIN', 'HKG', 'JFK', 'LAX', 'ORD', 'DEL', 'SYD', 'NRT', 'GVA', 'VIE', 'LIS', 'DUB', 'ZRH', 'IST'];
const rnd = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const ri = (n: number) => Math.floor(Math.random() * n);

export interface AirspaceConfig {
  radiusM: number;
  ilsRunways: ILSRunway[];
  beacons: Array<{ id: string; x: number; y: number }>;
}

export class SimEngine {
  readonly air: OsmAirport;
  readonly proj: LocalProjection;
  aircraft: AircraftState[] = [];
  time = 0;
  autoTower = true;
  score = 0;
  skill = 3;

  private airspaceRadiusM = 30 * NM_TO_M;
  private ilsRunways: ILSRunway[] = [];
  private beacons: Array<{ id: string; x: number; y: number }> = [];
  private activeEnds: Set<string> | null = null; // null = all runway ends active
  private runwayWeights: Map<string, Set<WeightClass>> | null = null; // end name → allowed weight classes
  private acc = 0;
  private idc = 0;
  private pendingEvents: SimEvent[] = [];
  private conflictPairs = new Set<string>();
  private xyCache = new Map<string, XY>();

  constructor(air: OsmAirport) {
    this.air = air;
    this.proj = new LocalProjection(air.center.lat, air.center.lng);
  }

  setAirspaceConfig(cfg: AirspaceConfig) {
    this.airspaceRadiusM = cfg.radiusM;
    this.ilsRunways = cfg.ilsRunways;
    this.beacons = cfg.beacons;
  }

  // Restrict spawning to a chosen subset of runway ends (active-runway config
  // picked on the home page). Pass null/empty to allow every end.
  setActiveRunwayEnds(ends: string[] | null) {
    this.activeEnds = ends && ends.length ? new Set(ends.map(e => e.toUpperCase())) : null;
  }
  private endActive(name: string): boolean { return !this.activeEnds || this.activeEnds.has(name.toUpperCase()); }

  // Per-runway-end allowed weight classes (e.g. a short strip disallowing
  // Heavy/Super). Pass null to allow every class everywhere.
  setRunwayWeightAllow(map: Record<string, WeightClass[]> | null) {
    if (!map) { this.runwayWeights = null; return; }
    this.runwayWeights = new Map(Object.entries(map).map(([k, v]) => [k.toUpperCase(), new Set(v)]));
  }
  private weightsFor(endName: string): Set<WeightClass> | null {
    return this.runwayWeights?.get(endName.toUpperCase()) ?? null;
  }

  // ── geometry ───────────────────────────────────────────────────────────────
  nodeXY(nodeId: string): XY | null {
    const c = this.xyCache.get(nodeId);
    if (c) return c;
    const n = this.air.nodes.get(nodeId);
    if (!n) return null;
    const xy = this.proj.toXY(n.lat, n.lng);
    this.xyCache.set(nodeId, xy);
    return xy;
  }
  endXY(e: { lat: number; lng: number }): XY { return this.proj.toXY(e.lat, e.lng); }

  private runwayByEnd(endName: string) {
    for (const rw of this.air.runways) {
      const e = rw.ends.find(x => x.name === endName);
      if (e) return { rw, end: e, other: rw.ends.find(x => x !== e)! };
    }
    return null;
  }
  runwayHeading(endName: string): number {
    const r = this.runwayByEnd(endName);
    if (!r) return 0;
    return headingTo(this.endXY(r.end), this.endXY(r.other));
  }

  private buildPath(raw: XY[], kind: DrivePath['kind'], holdAtEnd = false): DrivePath {
    const clean = dedupeBacktracks(raw, 3);
    const uniform = resample(clean, kind === 'taxi' ? 8 : 30);
    const pts = kind === 'taxi' ? chaikin(uniform, 4) : chaikin(uniform, 3);
    const { cum, total } = arcLengths(pts);
    return { pts, cum, total, kind, holdAt: holdAtEnd ? total : undefined };
  }
  private pathFromNodes(ids: string[], holdAtEnd = false): DrivePath | null {
    const raw: XY[] = [];
    for (const id of ids) { const xy = this.nodeXY(id); if (xy) raw.push(xy); }
    if (raw.length < 2) return null;
    return this.buildPath(raw, 'taxi', holdAtEnd);
  }

  // ── events / lookup ────────────────────────────────────────────────────────
  private emit(type: SimEventType, ac: AircraftState | null, message: string) {
    this.pendingEvents.push({ type, id: ac?.id ?? -1, callsign: ac?.callsign ?? 'SYSTEM', message, at: this.time });
  }
  private evt() { return { push: (m: string, t: any = 'info') => this.pendingEvents.push({ type: t as SimEventType, id: -1, callsign: '', message: m, at: this.time }) }; }
  find(cs: string): AircraftState | undefined { const u = cs.toUpperCase(); return this.aircraft.find(a => a.callsign === u || a.flightNo === u); }
  byId(id: number): AircraftState | undefined { return this.aircraft.find(a => a.id === id); }

  // ── identity / base ────────────────────────────────────────────────────────
  private newIdentity(type?: string, allowedWeights?: Set<WeightClass> | null) {
    const al = rnd(AIRLINES); const fno = 1 + ri(998);
    return { callsign: `${al.icao}${fno}`, flightNo: `${al.iata}${fno}`, airline: al.name, perf: getPerformance(type ?? randomCommercialTypeOf(allowedWeights)) };
  }
  private base(ident: ReturnType<SimEngine['newIdentity']>, kind: FlightKind, pos: XY, heading: number): AircraftState {
    return {
      id: ++this.idc, callsign: ident.callsign, flightNo: ident.flightNo, airline: ident.airline, perf: ident.perf,
      phase: 'parked', plan: { kind }, pos: { ...pos }, heading, speed: 0, altitude: 0,
      targetHeading: heading, targetSpeed: 0, targetAltitude: 0,
      path: null, distAlong: 0, holdReleased: false, trafficHold: false, thresholdDist: 0, takeoffCleared: false,
      navMode: 'heading',
      ilsArmed: false, ilsCaptured: false, gsCaptured: false, assignedRunway: null,
      directTargetXY: null, directTargetName: null, turnDir: null,
      holdFix: null, holdFixName: null, holdInboundHdg: 0, holdTurnDir: 'R',
      holdPhase: 'to_fix', holdTimer: 0,
      cmdAltitude: null, cmdIas: null, expedite: false,
      pendingCmds: [], underControl: false, attention: false,
      route: [], routeIndex: 0, holdingShort: false,
      trail: [{ ...pos }], spawnedAt: this.time,
      // Wave-0 contract fields (types.ts newAircraftFields is the single source of defaults)
      ...newAircraftFields(ident.perf.weightClass, this.time),
    };
  }

  // ── spawning ───────────────────────────────────────────────────────────────
  private freeGate() {
    for (let tries = 0; tries < 12; tries++) {
      const g = rnd(this.air.gates);
      const xy = this.nodeXY(g.nodeId); if (!xy) continue;
      if (!this.aircraft.some(a => dist(a.pos, xy) < 55)) return g;
    }
    return null;
  }

  spawnDeparture(): AircraftState | null {
    if (!this.air.gates.length || !this.air.runways.length) return null;
    const gate = this.freeGate(); if (!gate) return null;
    const activeEnds = this.air.runways.flatMap(rw => rw.ends.filter(e => this.endActive(e.name)).map(e => ({ rw, end: e })));
    const fallbackRw = rnd(this.air.runways);
    const pick = activeEnds.length ? rnd(activeEnds) : { rw: fallbackRw, end: rnd(fallbackRw.ends) };
    const rw = pick.rw; const end = pick.end;
    const ids = findPath(this.air, gate.nodeId, end.nodeId);
    if (!ids || ids.length < 2) return null;
    const path = this.pathFromNodes(ids, true);
    if (!path) return null;
    const start = path.pts[0];
    const ac = this.base(this.newIdentity(undefined, this.weightsFor(end.name)), 'departure', start, path.pts.length > 1 ? headingTo(start, path.pts[1]) : 0);
    ac.plan.gateRef = gate.ref; ac.plan.runway = end.name;
    // Use a real beacon as departure fix if airspace is loaded, so SID routing works
    ac.plan.fix = this.beacons.length > 0 ? rnd(this.beacons).id : rnd(CITIES);
    ac.plan.cruiseAlt = 13000;
    ac.plan.taxiRoute = taxiwaysForPath(this.air, ids);
    ac.path = path; ac.holdReleased = false; ac.phase = 'taxi';
    this.aircraft.push(ac);
    const via = ac.plan.taxiRoute.length ? ` via ${ac.plan.taxiRoute.join(' ')}` : '';
    this.emit('spawn', ac, `${ac.callsign} (${ac.perf.icaoCode}) → ${ac.plan.fix}, taxi to ${end.name}${via}`);
    return ac;
  }

  // Spawn arrival at the boundary entry point (approach-radar style).
  spawnArrivalAtEntry(pos: XY, heading: number, altFt: number, beacon?: string): AircraftState | null {
    if (!this.air.gates.length) return null;
    const gate = this.freeGate();
    const ac = this.base(this.newIdentity(), 'arrival', pos, heading);
    ac.altitude = altFt; ac.targetAltitude = altFt;
    ac.speed = Math.min(250, ac.perf.maxAirspeedTMA);
    ac.targetSpeed = ac.speed;
    ac.phase = 'approach';
    ac.plan.gateRef = gate?.ref ?? rnd(this.air.gates).ref;
    ac.plan.fix = beacon ?? rnd(CITIES);
    ac.navMode = 'heading';
    ac.attention = true;
    ac.cmdAltitude = altFt;
    this.aircraft.push(ac);
    const hdgStr = String(Math.round(heading)).padStart(3, '0');
    this.emit('spawn', ac, `${ac.callsign} (${ac.perf.icaoCode}) via ${ac.plan.fix}, ${Math.round(altFt)} ft, hdg ${hdgStr}`);
    return ac;
  }

  // Fallback: spawn arrival on short final (when no Endless ATC airspace loaded).
  spawnArrival(): AircraftState | null {
    if (!this.air.gates.length || !this.air.runways.length) return null;
    const activeEnds = this.air.runways.flatMap(rw => rw.ends.filter(e => this.endActive(e.name) && !this.runwayOccupied(e.name)).map(e => ({ rw, end: e })));
    const fallbackFree = this.air.runways.filter(rw => !rw.ends.some(e => this.runwayOccupied(e.name)));
    const fallbackRw = fallbackFree.length ? rnd(fallbackFree) : rnd(this.air.runways);
    const pick = activeEnds.length ? rnd(activeEnds) : { rw: fallbackRw, end: rnd(fallbackRw.ends) };
    const rw = pick.rw; const end = pick.end;
    const hdg = this.runwayHeading(end.name);
    const thr = this.endXY(end); const far = this.endXY(this.runwayByEnd(end.name)!.other);
    const start = advance(thr, (hdg + 180) % 360, 11000);
    const path = this.buildPath([start, thr, far], 'approach');
    const ac = this.base(this.newIdentity(undefined, this.weightsFor(end.name)), 'arrival', start, hdg);
    ac.plan.runway = end.name; ac.plan.fix = rnd(CITIES); ac.plan.gateRef = rnd(this.air.gates).ref;
    ac.path = path;
    // Glideslope altitude in ft: dist_m × tan(3°) × ft/m
    ac.thresholdDist = dist(start, thr);
    ac.altitude = ac.thresholdDist * Math.tan(3 * Math.PI / 180) * FT_PER_M;
    ac.speed = ac.perf.approachSpeed; ac.targetSpeed = ac.perf.approachSpeed; ac.heading = hdg;
    ac.phase = 'landing'; ac.holdReleased = true;
    this.aircraft.push(ac);
    this.emit('spawn', ac, `${ac.callsign} (${ac.perf.icaoCode}) from ${ac.plan.fix}, ${(ac.thresholdDist / NM_TO_M).toFixed(0)}nm final ${end.name}`);
    return ac;
  }

  // ── ATC commands ───────────────────────────────────────────────────────────
  cmdPushback(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (a.phase !== 'parked') return `${a.callsign}: already moving`;
    a.distAlong = 0; setPhase(a, 'pushback', this.evt());
    return `${a.callsign}, pushback approved`;
  }

  private routeVia(startId: string, viaNames: string[], goalId: string): string[] | null {
    let cur = startId; const full = [startId];
    for (const raw of viaNames) {
      const name = raw.toUpperCase();
      const onTw = this.air.taxiwayNodes.get(name);
      if (!onTw || !onTw.length) return null;
      const curXY = this.nodeXY(cur)!;
      let target: string | null = null, best = Infinity;
      for (const id of onTw) { const xy = this.nodeXY(id); if (!xy) continue; const d = (xy.x - curXY.x) ** 2 + (xy.y - curXY.y) ** 2; if (d < best) { best = d; target = id; } }
      if (!target) return null;
      const seg = findPath(this.air, cur, target); if (!seg) return null;
      full.push(...seg.slice(1)); cur = target;
    }
    const last = findPath(this.air, cur, goalId); if (!last) return null;
    full.push(...last.slice(1));
    return full;
  }

  cmdTaxiTo(cs: string, dest: string, via?: string[]): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    const D = dest.toUpperCase();
    let goalId: string | null = null; let toRunway = false;
    const rwy = this.runwayByEnd(D);
    if (rwy) { goalId = rwy.end.nodeId; a.plan.runway = rwy.end.name; toRunway = true; }
    else { const g = this.air.gates.find(x => x.ref.toUpperCase() === D); if (g) { goalId = g.nodeId; a.plan.gateRef = g.ref; } }
    if (!goalId) return `${a.callsign}: unknown destination "${dest}"`;
    const startId = this.nearestNodeId(a.pos); if (!startId) return `${a.callsign}: no route`;
    let ids: string[] | null;
    if (via && via.length) {
      const bad = via.find(v => !this.air.taxiwayNodes.has(v.toUpperCase()));
      if (bad) return `${a.callsign}: no taxiway "${bad}" here`;
      ids = this.routeVia(startId, via, goalId);
      if (!ids) return `${a.callsign}: can't route via ${via.join(' ')}`;
    } else {
      ids = findPath(this.air, startId, goalId);
    }
    if (!ids || ids.length < 2) return `${a.callsign}: no route to ${D}`;
    const path = this.pathFromNodes(ids, toRunway); if (!path) return `${a.callsign}: no route`;
    a.path = path; a.distAlong = 0; a.holdReleased = false; a.takeoffCleared = false;
    a.plan.taxiRoute = taxiwaysForPath(this.air, ids);
    setPhase(a, 'taxi', this.evt());
    const tw = a.plan.taxiRoute.length ? ` via ${a.plan.taxiRoute.join(' ')}` : '';
    return `${a.callsign}, taxi to ${D}${tw}`;
  }

  cmdHoldShort(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    a.holdReleased = false;
    if (a.path) a.path.holdAt = Math.min(a.path.holdAt ?? a.path.total, a.distAlong + Math.max(20, a.speed * 2));
    return `${a.callsign}, hold short`;
  }
  cmdCross(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    a.holdReleased = true; if (a.phase === 'hold_short') setPhase(a, 'taxi', this.evt());
    return `${a.callsign}, continue`;
  }
  cmdLineUp(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!['hold_short', 'taxi'].includes(a.phase) || !a.plan.runway) return `${a.callsign}: unable line up`;
    const r = this.runwayByEnd(a.plan.runway); if (!r) return `${a.callsign}: runway unknown`;
    a.path = this.buildPath([a.pos, this.endXY(r.end)], 'runway'); a.distAlong = 0; a.holdReleased = true;
    a.targetHeading = this.runwayHeading(a.plan.runway);
    setPhase(a, 'lineup', this.evt());
    return `${a.callsign}, line up and wait runway ${a.plan.runway}`;
  }

  private beginRoll(a: AircraftState) {
    const r = this.runwayByEnd(a.plan.runway!)!;
    const rwHdg = this.runwayHeading(a.plan.runway!);
    const far = advance(this.endXY(r.other), rwHdg, 800);
    a.path = this.buildPath([a.pos, this.endXY(r.end), far], 'runway');
    a.distAlong = 0; a.holdReleased = true; a.takeoffCleared = false;
    a.targetHeading = rwHdg;
    setPhase(a, 'takeoff', this.evt());
  }
  cmdTakeoff(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!a.plan.runway) return `${a.callsign}: no runway assigned`;
    if (!this.runwayByEnd(a.plan.runway)) return `${a.callsign}: runway unknown`;
    if (a.phase === 'hold_short' || a.phase === 'lineup') { this.beginRoll(a); return `${a.callsign}, cleared for takeoff runway ${a.plan.runway}`; }
    if (a.phase === 'taxi') { a.takeoffCleared = true; return `${a.callsign}, cleared for takeoff ${a.plan.runway} — continue to the runway`; }
    return `${a.callsign}: unable takeoff`;
  }
  cmdClearedLand(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: not airborne`;
    if (!a.plan.runway && !a.assignedRunway) return `${a.callsign}: no runway assigned`;
    const rwy = a.plan.runway ?? a.assignedRunway ?? '';
    return `${a.callsign}, cleared to land runway ${rwy}`.trim();
  }

  // ── airborne commands (with pilot delay) ──────────────────────────────────
  private enqueuePilotCmd(a: AircraftState, cmd: Omit<PendingCmd, 'applyAt'>, immediate = false): void {
    const applyAt = this.time + (immediate ? 0 : PILOT_DELAY_S);
    // Replace any pending command of the same kind (latest wins)
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== cmd.kind);
    a.pendingCmds.push({ ...cmd, applyAt });
  }

  cmdHeading(cs: string, hdg: number, dir?: 'L' | 'R'): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: on the ground`;
    const h = ((hdg % 360) + 360) % 360;
    a.cmdAltitude = a.cmdAltitude; // unchanged
    a.turnDir = dir ?? null;
    // Cancel ILS/direct if manual heading given
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = 'heading';
    a.directTargetXY = null; a.directTargetName = null;
    a.underControl = true; a.attention = false;
    this.enqueuePilotCmd(a, { kind: 'heading', value: h });
    const dirStr = dir ? ` turn ${dir === 'L' ? 'left' : 'right'}` : '';
    return `${a.callsign},${dirStr} fly heading ${String(h).padStart(3, '0')}`;
  }
  cmdAltitude(cs: string, ft: number, expedite = false): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    const tgt = Math.max(0, ft);
    a.cmdAltitude = tgt; a.expedite = expedite;
    a.underControl = true; a.attention = false;
    this.enqueuePilotCmd(a, { kind: 'altitude', value: tgt });
    const verb = tgt >= a.altitude ? 'climb' : 'descend';
    const xp = expedite ? ', expedite' : '';
    return `${a.callsign}, ${verb} and maintain ${tgt} ft${xp}`;
  }
  cmdSpeed(cs: string, kts: number): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    const tgt = Math.max(0, kts);
    a.cmdIas = tgt;
    a.underControl = true; a.attention = false;
    this.enqueuePilotCmd(a, { kind: 'speed', value: tgt });
    return `${a.callsign}, ${tgt} knots`;
  }
  cmdExpedite(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    a.expedite = !a.expedite;
    return `${a.callsign}, expedite ${a.expedite ? 'on' : 'off'}`;
  }

  // Arm ILS approach for a named runway.
  cmdILS(cs: string, runwayName: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: on the ground`;
    const rwyUp = runwayName.toUpperCase();
    const allowed = this.weightsFor(rwyUp);
    if (allowed && allowed.size && !allowed.has(a.perf.weightClass)) {
      return `${a.callsign}: ${a.perf.weightClass}-category not permitted runway ${rwyUp}`;
    }
    const ils = this.ilsRunways.find(r => r.name === rwyUp);
    if (!ils) {
      // Fall back to OSM runway heading
      const osmR = this.runwayByEnd(rwyUp);
      if (osmR) {
        // Build a temporary ILS runway from OSM data
        const thr = this.endXY(osmR.end);
        const hdg = headingTo(thr, this.endXY(osmR.other));
        this.ilsRunways.push({ name: rwyUp, thrXY: thr, rwdHdg: hdg, locCourse: hdg, gsDeg: 3, thrElevFt: 0 });
      } else {
        return `${a.callsign}: ILS ${runwayName} not available`;
      }
    }
    a.assignedRunway = rwyUp; a.ilsArmed = true; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = 'ils'; a.plan.runway = rwyUp;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'heading'); // cancel stale heading cmds
    a.underControl = true; a.attention = false;
    return `${a.callsign}, cleared ILS approach runway ${rwyUp}`;
  }

  // Direct to a beacon / fix.
  cmdDirect(cs: string, fixName: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: on the ground`;
    const fixUp = fixName.toUpperCase();
    const b = this.beacons.find(x => x.id === fixUp);
    if (!b) return `${a.callsign}: fix "${fixName}" unknown`;
    a.directTargetXY = { x: b.x, y: b.y };
    a.directTargetName = fixUp;
    a.navMode = 'direct';
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'heading'); // cancel stale heading cmds
    a.underControl = true; a.attention = false;
    return `${a.callsign}, direct ${fixUp}`;
  }

  // Hold at a beacon (standard right turns unless 'L' specified).
  cmdHold(cs: string, fixName: string, inboundCourse?: number, turnDir?: 'L' | 'R'): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: on the ground`;
    const fixUp = fixName.toUpperCase();
    const b = this.beacons.find(x => x.id === fixUp);
    if (!b) return `${a.callsign}: fix "${fixUp}" not in database`;
    a.holdFix = { x: b.x, y: b.y };
    a.holdFixName = fixUp;
    a.holdInboundHdg = inboundCourse ?? headingTo(a.pos, { x: b.x, y: b.y });
    a.holdTurnDir = turnDir ?? 'R';
    a.holdPhase = 'to_fix'; a.holdTimer = 0;
    a.navMode = 'hold';
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'heading'); // cancel stale heading cmds
    a.underControl = true; a.attention = false;
    const inbStr = String(Math.round(a.holdInboundHdg)).padStart(3, '0');
    const turns = a.holdTurnDir === 'L' ? 'left turns' : 'right turns';
    return `${a.callsign}, hold at ${fixUp} inbound ${inbStr}, ${turns}, expect further clearance`;
  }

  // Instruct a go-around (or the engine triggers one automatically).
  cmdGoAround(cs: string): string {
    const a = this.find(cs); if (!a) return notFound(cs);
    if (!isAirborne(a)) return `${a.callsign}: not airborne`;
    this.initiateGoAround(a);
    return `${a.callsign}, go around, climb to 3000 ft`;
  }

  private initiateGoAround(a: AircraftState) {
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.assignedRunway = null;
    a.navMode = 'heading'; a.path = null; a.distAlong = 0;
    a.targetAltitude = 3000; a.cmdAltitude = 3000;
    a.targetSpeed = Math.min(a.perf.maxAirspeedTMA, 220);
    a.phase = 'climb';
    this.emit('go_around', a, `${a.callsign} going around`);
  }

  remove(id: number) { this.aircraft = this.aircraft.filter(a => a.id !== id); }
  clear() { this.aircraft = []; this.conflictPairs.clear(); }

  private nearestNodeId(p: XY): string | null {
    let best: string | null = null, bestD = Infinity;
    for (const id of this.air.nodes.keys()) {
      const xy = this.nodeXY(id)!; const d = (xy.x - p.x) ** 2 + (xy.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  private runwayOccupied(endName: string): boolean {
    const r = this.runwayByEnd(endName); if (!r) return false;
    const names = [r.end.name, r.other.name];
    return this.aircraft.some(a => a.plan.runway && names.includes(a.plan.runway) &&
      ['lineup', 'takeoff', 'landing', 'rollout'].includes(a.phase));
  }
  private runwayPhysicallyClear(endName: string, exceptId: number): boolean {
    const r = this.runwayByEnd(endName); if (!r) return false;
    const a = this.endXY(r.end), b = this.endXY(r.other);
    return !this.aircraft.some(ac => ac.id !== exceptId && distToSegment(ac.pos, a, b) < 45);
  }

  // ── main update ────────────────────────────────────────────────────────────
  update(realDt: number): SimEvent[] {
    this.acc += Math.min(realDt, 0.25);
    let steps = 0; const evt = this.evt();
    while (this.acc >= FIXED && steps < MAX_SUBSTEPS) {
      this.applyNavTargets(); // set targetHeading/targetAltitude/targetSpeed from navMode each tick
      this.applyTraffic();
      for (const a of this.aircraft) stepAircraft(a, FIXED, evt, this.time);
      this.handleTransitions(evt);
      this.time += FIXED; this.acc -= FIXED; steps++;
    }
    this.checkSeparation();
    const out = this.pendingEvents; this.pendingEvents = [];
    return out;
  }

  // ── nav targets (runs every sim tick before physics) ─────────────────────
  private applyNavTargets() {
    for (const a of this.aircraft) {
      if (!isAirborne(a)) continue;

      // --- HOLD pattern ---
      if (a.navMode === 'hold' && a.holdFix) {
        const fixDist = dist(a.pos, a.holdFix);
        const hdgToFix = headingTo(a.pos, a.holdFix);
        const outHdg = (a.holdInboundHdg + 180) % 360;
        switch (a.holdPhase) {
          case 'to_fix':
            a.targetHeading = hdgToFix;
            if (fixDist < 700) { a.holdPhase = 'outbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; }
            break;
          case 'outbound_turn': {
            a.targetHeading = outHdg;
            // Switch when within 5° of outbound heading (diff close to 0, not 180)
            const dOut = Math.abs(((a.heading - outHdg + 540) % 360) - 180);
            if (dOut < 5) { a.holdPhase = 'outbound'; a.holdTimer = 0; a.turnDir = null; }
            break;
          }
          case 'outbound':
            a.targetHeading = outHdg;
            a.holdTimer += FIXED;
            if (a.holdTimer >= 60) { a.holdPhase = 'inbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; }
            break;
          case 'inbound_turn': {
            a.targetHeading = a.holdInboundHdg;
            const dIn = Math.abs(((a.heading - a.holdInboundHdg + 540) % 360) - 180);
            if (dIn < 5) { a.holdPhase = 'inbound'; a.turnDir = null; }
            break;
          }
          case 'inbound':
            a.targetHeading = hdgToFix;
            if (fixDist < 700) { a.holdPhase = 'outbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; }
            break;
        }
      }

      // --- DCT (direct-to) ---
      if (a.navMode === 'direct' && a.directTargetXY) {
        a.targetHeading = headingTo(a.pos, a.directTargetXY);
        // Reached the fix?
        if (dist(a.pos, a.directTargetXY) < 1500) {
          a.navMode = 'heading'; // continue on current heading past the fix
          a.directTargetXY = null;
        }
      }

      // --- SID (departure climb mode) — fly toward the departure beacon if known ---
      if (a.navMode === 'sid' && a.plan.fix) {
        const b = this.beacons.find(x => x.id === a.plan.fix);
        if (b) {
          a.targetHeading = headingTo(a.pos, { x: b.x, y: b.y });
          if (dist(a.pos, { x: b.x, y: b.y }) < 2000) {
            a.navMode = 'heading'; // past the fix, maintain current heading
          }
        }
      }

      // --- ILS approach tracking ---
      if ((a.navMode === 'ils' || a.navMode === 'loc') && a.ilsArmed && a.assignedRunway) {
        const r = this.ilsRunways.find(x => x.name === a.assignedRunway);
        if (!r) continue;

        if (!a.ilsCaptured) {
          // Check localizer capture
          if (canCaptureLoc(a.pos, a.heading, r)) {
            // Reject if above glideslope
            if (aboveGlideslope(a.pos, a.altitude, r)) {
              // Too high — let aircraft continue, don't capture
            } else {
              a.ilsCaptured = true;
              // Auto-speed reduction on localizer capture: ≤200 kt
              if ((a.cmdIas ?? a.targetSpeed) > 200) {
                a.targetSpeed = 200; a.cmdIas = 200;
              }
            }
          }
        }

        if (a.ilsCaptured) {
          // Track localizer (set heading target from LOC geometry)
          a.targetHeading = locTargetHdg(a.pos, r);

          const along = distAlongFwd(a.pos, r);
          const gs = gsAltFt(along, r);

          // Check glideslope capture from below
          if (!a.gsCaptured && a.navMode !== 'loc') {
            if (a.altitude <= gs + 50 && along > 500) {
              a.gsCaptured = true;
            }
          }

          // Speed rules on final
          const distNM = along / NM_TO_M;
          if (a.gsCaptured) {
            if (distNM < 4) {
              a.targetSpeed = a.perf.approachSpeed;
            } else if (distNM < 6 && a.targetSpeed > 160) {
              a.targetSpeed = 160;
            }
          }

          // Track glideslope altitude target
          if (a.gsCaptured) {
            a.targetAltitude = Math.max(0, gs);
          }
        }
      }

      // --- Auto speed rules (below FL100 = 250 kt max) already in aircraft.ts ---
      // 15 NM from field: slow to 220 if no explicit speed set
      const fieldDist = dist(a.pos, { x: 0, y: 0 });
      if (fieldDist < 15 * NM_TO_M && a.cmdIas == null && a.targetSpeed > 220 && !a.ilsCaptured) {
        a.targetSpeed = 220;
      }
    }
  }

  // ground stop-and-go: a taxiing aircraft holds if another is close ahead
  private applyTraffic() {
    const ground = this.aircraft.filter(a => ['taxi', 'pushback', 'lineup', 'rollout', 'hold_short'].includes(a.phase));
    const blockedBy = new Map<number, number>();
    for (const a of ground) a.trafficHold = false;
    for (const a of ground) {
      if (a.phase === 'hold_short') continue;
      for (const b of this.aircraft) {
        if (b === a || isAirborne(b)) continue;
        const d = dist(a.pos, b.pos); if (d < 1) continue;
        const gap = a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 14 + a.speed * 0.7;
        if (d < gap) {
          const rel = Math.abs(((headingTo(a.pos, b.pos) - a.heading + 540) % 360) - 180);
          if (rel < 48) { a.trafficHold = true; blockedBy.set(a.id, b.id); }
        }
      }
    }
    for (const a of ground) {
      const bId = blockedBy.get(a.id); if (bId == null) continue;
      if (blockedBy.get(bId) === a.id && a.id < bId) a.trafficHold = false;
    }
    for (let i = 0; i < ground.length; i++) for (let j = i + 1; j < ground.length; j++) {
      const a = ground[i], b = ground[j];
      if (dist(a.pos, b.pos) >= a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 7) continue;
      const aSeesB = Math.abs(((headingTo(a.pos, b.pos) - a.heading + 540) % 360) - 180);
      const bSeesA = Math.abs(((headingTo(b.pos, a.pos) - b.heading + 540) % 360) - 180);
      if (aSeesB < 90 && a.phase !== 'hold_short') a.trafficHold = true;
      if (bSeesA < 90 && b.phase !== 'hold_short') b.trafficHold = true;
    }
    const activeRwys = new Map<string, { a: XY; b: XY }>();
    for (const a of this.aircraft) {
      if (!a.plan.runway || !['lineup', 'takeoff', 'landing', 'rollout'].includes(a.phase)) continue;
      const r = this.runwayByEnd(a.plan.runway); if (!r) continue;
      activeRwys.set(r.rw.ref, { a: this.endXY(r.end), b: this.endXY(r.other) });
    }
    if (activeRwys.size) {
      for (const ac of ground) {
        if (ac.phase === 'takeoff' || ac.phase === 'rollout' || ac.phase === 'lineup') continue;
        const ahead = advance(ac.pos, ac.heading, 28);
        for (const [ref, seg] of activeRwys) {
          if (ac.plan.runway && this.runwayByEnd(ac.plan.runway)?.rw.ref === ref) continue;
          if (distToSegment(ac.pos, seg.a, seg.b) < 75 || distToSegment(ahead, seg.a, seg.b) < 75) { ac.trafficHold = true; break; }
        }
      }
    }
  }

  // phase transitions
  private handleTransitions(evt: { push: (m: string, t?: any) => void }) {
    for (const a of this.aircraft) {
      // ILS: transition to landing when established within 8 NM. Don't require
      // a.phase === 'approach' — it may read 'descent'/'cruise' after altitude commands.
      if (a.gsCaptured && a.ilsCaptured && a.assignedRunway && isAirborne(a) && a.phase !== 'landing') {
        const r = this.ilsRunways.find(x => x.name === a.assignedRunway);
        if (r) {
          const along = distAlongFwd(a.pos, r);
          if (along < 8 * NM_TO_M && along > 100) {
            // Check runway clear — go around if occupied
            if (this.runwayOccupied(a.assignedRunway)) {
              this.initiateGoAround(a);
              evt.push(`${a.callsign} going around — runway occupied`, 'go_around');
            } else {
              // Build landing path from current position through threshold to far end
              const osmRwy = this.runwayByEnd(a.assignedRunway);
              const thrXY = osmRwy ? this.endXY(osmRwy.end) : r.thrXY;
              const farXY = osmRwy
                ? advance(this.endXY(osmRwy.other), r.rwdHdg, 500)
                : advance(r.thrXY, r.rwdHdg, 2500);
              a.path = this.buildPath([a.pos, thrXY, farXY], 'approach');
              // thresholdDist = metres from current position to threshold along glideslope
              a.thresholdDist = gsDistM(a.altitude, r);
              a.distAlong = 0; a.holdReleased = true;
              a.plan.runway = a.assignedRunway;
              setPhase(a, 'landing', evt);
            }
          }
        }
      }

      // Go-around: runway occupied when very close on final (<2 NM)
      if (a.phase === 'landing' && a.plan.runway) {
        const r = this.ilsRunways.find(x => x.name === a.plan.runway);
        if (r) {
          const along = distAlongFwd(a.pos, r);
          if (along < 2 * NM_TO_M && this.runwayOccupied(a.plan.runway) &&
              !this.aircraft.some(b => b.id !== a.id && b.phase === 'rollout' && b.plan.runway === a.plan.runway && dist(b.pos, r.thrXY) < 500)) {
            this.initiateGoAround(a);
            evt.push(`${a.callsign} going around — runway not clear`, 'go_around');
          }
        }
      }

      // Arrival vacates runway → taxi to gate
      if (a.phase === 'rollout' && a.speed < 22 && a.plan.kind === 'arrival' && a.plan.gateRef) {
        const startId = this.nearestNodeId(a.pos);
        const gate = this.air.gates.find(g => g.ref === a.plan.gateRef);
        if (startId && gate) {
          const ids = findPath(this.air, startId, gate.nodeId);
          const path = ids && ids.length > 1 ? this.pathFromNodes(ids, false) : null;
          if (path) {
            a.path = path; a.distAlong = 0; a.holdReleased = true;
            setPhase(a, 'taxi', evt);
            this.emit('info', a, `${a.callsign} vacated, taxi to stand ${gate.ref}`);
            this.score++; this.skill = Math.min(12, this.skill + 0.1);
          } else setPhase(a, 'arrived', evt);
        }
      }

      // Pre-cleared departures roll when runway is clear
      if (a.phase === 'hold_short' && a.takeoffCleared && a.plan.runway &&
          !this.runwayOccupied(a.plan.runway) && this.runwayPhysicallyClear(a.plan.runway, a.id)) {
        this.beginRoll(a); this.emit('info', a, `${a.callsign} rolling, runway ${a.plan.runway}`);
      }
    }

    // Auto-tower: clear one waiting departure per free runway
    if (this.autoTower) {
      for (const rw of this.air.runways) {
        for (const end of rw.ends) {
          if (this.runwayOccupied(end.name)) continue;
          const waiting = this.aircraft.find(a => a.phase === 'hold_short' && a.plan.runway === end.name);
          if (waiting && this.runwayPhysicallyClear(end.name, waiting.id)) {
            this.emit('info', waiting, this.cmdTakeoff(waiting.callsign)); break;
          }
        }
      }
    }

    // Retire finished flights / departures exiting airspace
    this.aircraft = this.aircraft.filter(a => {
      if (a.phase === 'arrived' && this.time - a.spawnedAt > 3) return false;
      if (isAirborne(a) && a.plan.kind === 'departure') {
        const d = dist(a.pos, { x: 0, y: 0 });
        if (d > this.airspaceRadiusM * 0.92) {
          if (a.altitude < 9000) {
            this.emit('diversion', a, `${a.callsign} DIVERSION — left airspace below FL90`);
            this.skill = Math.max(0, this.skill - 0.5);
          } else {
            this.emit('departed', a, `${a.callsign} airborne, contact departure`);
            this.score++; this.skill = Math.min(12, this.skill + 0.05);
          }
          return false;
        }
      }
      // Arrivals that leave the boundary unintentionally (e.g. player forgot them)
      if (isAirborne(a) && a.plan.kind === 'arrival') {
        const d = dist(a.pos, { x: 0, y: 0 });
        if (d > this.airspaceRadiusM * 1.05) {
          this.emit('diversion', a, `${a.callsign} DIVERSION — exited airspace`);
          this.skill = Math.max(0, this.skill - 0.5);
          return false;
        }
      }
      return true;
    });
  }

  private checkSeparation() {
    for (const a of this.aircraft) a.conflict = false;
    const now = new Set<string>(); const list = this.aircraft;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]; const d = dist(a.pos, b.pos);
      const airA = isAirborne(a), airB = isAirborne(b);
      if (!airA && !airB) {
        if (d < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.6) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) this.emit('ground_conflict', a, `GROUND CONFLICT: ${a.callsign} / ${b.callsign}`);
        }
      } else if (airA && airB) {
        const reqNM = Math.max(wakeSeparationNM(a.perf), wakeSeparationNM(b.perf), HORIZ_SEP_NM);
        // Reduced minima: parallel ILS on different runways, or both in landing rollout on different runways
        const reduced =
          (a.ilsCaptured && b.ilsCaptured && a.assignedRunway != null && b.assignedRunway != null && a.assignedRunway !== b.assignedRunway) ||
          (a.phase === 'landing' && b.phase === 'landing' && a.plan.runway != null && b.plan.runway != null && a.plan.runway !== b.plan.runway);
        if (!reduced && d < reqNM * NM_TO_M && Math.abs(a.altitude - b.altitude) < VERT_SEP_FT) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) {
            this.emit('separation_loss', a, `SEPARATION LOSS: ${a.callsign} / ${b.callsign}`);
            this.skill = Math.max(0, this.skill - 0.5);
          }
        }
      }
    }
    this.conflictPairs = now;
  }

  stats() {
    let dep = 0, arr = 0, air = 0, gnd = 0, conf = 0;
    for (const a of this.aircraft) {
      if (a.plan.kind === 'departure') dep++; else arr++;
      if (isAirborne(a)) air++; else gnd++;
      if (a.conflict) conf++;
    }
    return { total: this.aircraft.length, dep, arr, air, gnd, conf };
  }
}

function pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
function notFound(cs: string) { return `No aircraft "${cs.toUpperCase()}" on frequency`; }
