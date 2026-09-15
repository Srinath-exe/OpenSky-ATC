import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleFleet, DEFAULT_FLEET, FULL_FLEET, VEHICLE_CONST, defaultStations, type VehicleStepCtx } from '../../src/lib/sim/vehicles';
import { setSeed } from '../../src/lib/sim/rng';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { arcLengths, dist } from '../../src/lib/sim/projection';
import type { AircraftState, DrivePath, RunwayState } from '../../src/lib/sim/types';
import { loadAirport, mkAircraft, mkRunway, projectionFor } from './helpers';
import type { OsmAirport } from '../../src/lib/osmAirport';

function runwaysFor(icao: string, over: Partial<RunwayState> = {}): RunwayState[] {
  const out: RunwayState[] = [];
  for (const p of RUNWAY_MANIFEST[icao]) {
    out.push(mkRunway(p.ends[0].name, p.ends[1].name, p.ref, p.ends[0].hdg, over));
    out.push(mkRunway(p.ends[1].name, p.ends[0].name, p.ref, p.ends[1].hdg, over));
  }
  return out;
}

function ctxFor(fleet: VehicleFleet, air: OsmAirport, runways: RunwayState[], time: number, opts: { autoCross?: boolean; safe?: boolean; aircraft?: AircraftState[] } = {}): VehicleStepCtx {
  return {
    time, air, nodeXY: (id) => fleet.nodeXY(id), nearestNodeId: () => null, pathFromNodes: () => null,
    runways, aircraft: opts.aircraft ?? [], crossingSafe: () => opts.safe ?? true, autoCross: opts.autoCross ?? true,
  };
}

function runUntil(fleet: VehicleFleet, air: OsmAirport, runways: RunwayState[], t0: number, maxS: number, pred: () => boolean, opts: Parameters<typeof ctxFor>[4] = {}, dt = 0.5): { t: number; events: string[] } {
  let t = t0;
  const events: string[] = [];
  while (t - t0 < maxS && !pred()) {
    const r = fleet.step(dt, ctxFor(fleet, air, runways, t, opts));
    for (const e of r.events) events.push(e.message);
    t += dt;
  }
  return { t, events };
}

function centrelineDist(air: OsmAirport, ref: string, p: { x: number; y: number }): number {
  const proj = projectionFor(air);
  const rw = air.runways.find(r => r.ref === ref)!;
  const a = proj.toXY(rw.ends[0].lat, rw.ends[0].lng), b = proj.toXY(rw.ends[1].lat, rw.ends[1].lng);
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  let tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2; tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(p.x - (a.x + dx * tt), p.y - (a.y + dy * tt));
}

test('init: DEFAULT_FLEET parked at stations, standby, JSON-serialisable', () => {
  const air = loadAirport('EGLL');
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  const list = fleet.list();
  assert.equal(list.length, DEFAULT_FLEET.length);
  assert.ok(list.every(v => v.state === 'standby' && v.speed === 0 && v.stationNodeId));
  assert.deepEqual(list.filter(v => v.type === 'arff').map(v => v.callsign), ['Fire 1', 'Fire 2', 'Fire 3']);
  assert.equal(fleet.available('arff').length, 3);
  const round = JSON.parse(JSON.stringify(list));
  assert.deepEqual(round, list);
  assert.deepEqual(fleet.stationFor('arff'), defaultStations({ x: 0, y: 0 }).fire);
  assert.ok(Math.abs(list[0].maxSpeedKt.taxiway - 43.2) < 0.1, 'km/h converted to kt');
});

for (const icao of ['EGLL', 'KSFO']) {
  test(`ARFF dispatch reaches every runway end at ${icao} within 180 s of rolling (real OSM graph)`, () => {
    const air = loadAirport(icao);
    const runways = runwaysFor(icao);
    for (const rw of air.runways) {
      for (const end of rw.ends) {
        setSeed(1);
        const fleet = new VehicleFleet();
        fleet.init(air, defaultStations({ x: 0, y: 0 }));
        fleet.step(1 / 30, ctxFor(fleet, air, runways, 0));
        const r = fleet.dispatch('arff', { kind: 'runway', runway: end.name }, [], 2);
        assert.ok(r.ok, `${icao} ${end.name}: ${r.reason}`);
        assert.equal(r.vehicles.length, 2);
        assert.ok(r.etaAt != null && r.etaAt > 0);
        const v = r.vehicles[0];
        assert.equal(v.state, 'enroute');
        assert.ok(v.path && v.path.total > 100);
        let rollAt: number | null = null;
        let t = 0;
        const res = runUntil(fleet, air, runways, 0, 400, () => { if (rollAt == null && v.speed > 0.5) rollAt = t; t += 0.5; return v.state === 'onscene'; });
        assert.equal(v.state, 'onscene', `${icao} ${end.name} did not arrive: ${res.events.slice(-5).join(' | ')}`);
        assert.ok(rollAt != null && rollAt >= VEHICLE_CONST.arffRolloutDelayS[0] - 1 && rollAt <= VEHICLE_CONST.arffRolloutDelayS[1] + 1, `roll-out ${rollAt}`);
        const drive = res.t - rollAt!;
        assert.ok(drive <= VEHICLE_CONST.arffResponseLimitS, `${icao} ${end.name}: drive time ${drive} s`);
        assert.ok(res.t <= 240, `${icao} ${end.name}: total ${res.t} s`);
        // parked beside the runway, not on it, near the touchdown zone
        assert.equal(v.onRunway, null, 'parked clear of the runway');
        const d = centrelineDist(air, rw.ref, v.pos);
        assert.ok(d >= 40 && d <= 120, `${icao} ${end.name}: ${Math.round(d)} m from the centreline`);
        const proj = projectionFor(air);
        const thr = proj.toXY(end.lat, end.lng);
        assert.ok(dist(thr, v.pos) < 700, `${icao} ${end.name}: ${Math.round(dist(thr, v.pos))} m from the threshold`);
        assert.ok(res.events.some(m => /on scene/.test(m)), 'on-scene event');
        assert.ok(Math.abs((r.etaAt ?? 0) - res.t) < 60, `ETA ${r.etaAt} vs actual ${res.t}`);
      }
    }
  });
}

test('holds short of an active runway, requests the crossing, crosses on op(cross), reports enter/vacate; skips inactive runways', () => {
  const air = loadAirport('KSFO');
  const runways = runwaysFor('KSFO');
  setSeed(2);
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  fleet.step(1 / 30, ctxFor(fleet, air, runways, 0, { autoCross: false, safe: false }));
  // Ops car (no roll-out delay) to 19L: the route crosses several runways
  const r = fleet.dispatch('ops', { kind: 'point', xy: (() => { const p = projectionFor(air); const e = air.runways.find(x => x.ref === '01R/19L')!.ends.find(x => x.name === '19L')!; return p.toXY(e.lat, e.lng); })() }, ['OPS1'], 1);
  assert.ok(r.ok, r.reason);
  const v = r.vehicles[0];
  const holds = v.path!.holds!;
  assert.ok(holds.length >= 1, 'route has runway crossings');
  // drive until stopped at the first hold
  const first = holds[0];
  const res1 = runUntil(fleet, air, runways, 0, 300, () => v.speed === 0 && v.distAlong > 5 && Math.abs(v.distAlong - first.at) < 3, { autoCross: false, safe: false });
  assert.ok(Math.abs(v.distAlong - first.at) < 3, `stopped at the hold (${v.distAlong} vs ${first.at})`);
  assert.equal(v.holdShortRunway, first.runway);
  assert.equal(v.onRunway, null, 'holding short is off the runway');
  assert.ok(res1.events.some(m => /request cross/.test(m)), 'crossing request voiced');
  const step = fleet.step(0.5, ctxFor(fleet, air, runways, res1.t, { autoCross: false, safe: false }));
  assert.deepEqual(step.crossingRequests, [{ vehicleId: 'OPS1', runway: first.runway }]);
  // remains stopped while not cleared even though crossingSafe becomes true (autoCross off, not responding)
  runUntil(fleet, air, runways, res1.t, 20, () => false, { autoCross: false, safe: true });
  assert.equal(v.speed, 0);
  // clear it
  assert.equal(fleet.op('OPS1', 'cross', first.runway), true);
  assert.equal(v.holdReleased, true);
  let entered: string[] = [], vacated: string[] = [];
  let t = res1.t + 20;
  for (let i = 0; i < 400 && (vacated.length === 0); i++) {
    const s = fleet.step(0.5, ctxFor(fleet, air, runways, t, { autoCross: false, safe: false }));
    entered.push(...s.enteredRunway.map(e => `${e.runway}:${e.cleared}`));
    vacated.push(...s.vacatedRunway.map(e => e.runway));
    t += 0.5;
  }
  assert.ok(entered.some(e => e.startsWith(first.runway) && e.endsWith('true')), `entered with clearance: ${entered}`);
  assert.equal(vacated[0], first.runway);
  assert.equal(v.holdReleased, false, 'clearance consumed after vacating');
  assert.equal(v.holdShortRunway, null);
  // inactive runways need no clearance: rerun with every runway inactive and autoCross off -> no stop, arrives
  setSeed(2);
  const fleet2 = new VehicleFleet();
  fleet2.init(air, defaultStations({ x: 0, y: 0 }));
  const inactive = runwaysFor('KSFO', { activeDep: false, activeArr: false });
  fleet2.step(1 / 30, ctxFor(fleet2, air, inactive, 0, { autoCross: false, safe: false }));
  const r2 = fleet2.dispatch('ops', { kind: 'point', xy: (() => { const p = projectionFor(air); const e = air.runways.find(x => x.ref === '01R/19L')!.ends.find(x => x.name === '19L')!; return p.toXY(e.lat, e.lng); })() }, ['OPS1'], 1);
  const v2 = r2.vehicles[0];
  const res2 = runUntil(fleet2, air, inactive, 0, 400, () => v2.state === 'onscene', { autoCross: false, safe: false });
  assert.equal(v2.state, 'onscene', 'arrived without clearances');
  assert.ok(res2.events.some(m => /inactive/.test(m)), 'announces crossing an inactive runway');
  assert.ok(!res2.events.some(m => /request cross/.test(m)));
});

test('recall drives back to the station and returns to standby; op hold/continue', () => {
  const air = loadAirport('EGLL');
  const runways = runwaysFor('EGLL');
  setSeed(3);
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  fleet.step(1 / 30, ctxFor(fleet, air, runways, 0));
  const r = fleet.dispatch('followme', { kind: 'runway', runway: '27L' }, [], 1);
  assert.ok(r.ok);
  const v = r.vehicles[0];
  runUntil(fleet, air, runways, 0, 30, () => v.distAlong > 100);
  assert.ok(v.distAlong > 100);
  assert.equal(fleet.op('FOLLOW1', 'hold', null), true);
  runUntil(fleet, air, runways, 30, 10, () => false);
  assert.equal(v.speed, 0, 'hold position stops the vehicle');
  const d0 = v.distAlong;
  assert.equal(fleet.op('FOLLOW1', 'continue', null), true);
  runUntil(fleet, air, runways, 40, 10, () => false);
  assert.ok(v.distAlong > d0 + 20, 'continue resumes');
  assert.equal(fleet.recall('FOLLOW1'), true);
  assert.equal(v.state, 'returning');
  assert.equal(fleet.recall('FOLLOW1'), true, 'recall while returning re-plans');
  const res = runUntil(fleet, air, runways, 50, 400, () => v.state === 'standby');
  assert.equal(v.state, 'standby');
  assert.ok(dist(v.pos, v.station) < 1, 'back at the station');
  assert.equal(v.path, null);
  assert.equal(fleet.recall('FOLLOW1'), false, 'already standby');
  assert.ok(res.events.some(m => /at station/.test(m)));
});

test('tug follows a.pushback.tugId: drives to the aircraft, rides the nose while pushing, returns on disconnect', () => {
  const air = loadAirport('EGLL');
  const runways = runwaysFor('EGLL');
  setSeed(4);
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  const gate = air.gates[10];
  const gxy = projectionFor(air).toXY(gate.lat, gate.lng);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'parked', pos: gxy, heading: 90, speed: 0, altitude: 0, plan: { kind: 'departure', runway: '27R', gateRef: gate.ref } });
  a.pushback = { ...a.pushback, stage: 'tug_enroute', tugId: 'TUG1' };
  const tug = fleet.byId('TUG1')!;
  const res = runUntil(fleet, air, runways, 0, 600, () => tug.state === 'onscene', { aircraft: [a] });
  assert.equal(tug.state, 'onscene', `tug arrived: ${res.events.slice(-3).join(' | ')}`);
  assert.ok(dist(tug.pos, gxy) < 60, `tug near the aircraft (${Math.round(dist(tug.pos, gxy))} m)`);
  a.pushback.stage = 'pushing';
  a.speed = 3;
  fleet.step(0.5, ctxFor(fleet, air, runways, res.t, { aircraft: [a] }));
  const nose = { x: gxy.x + Math.sin(Math.PI / 2) * 5.5, y: gxy.y };   // the aircraft position is its nose wheel; the tug sits under the nose
  assert.ok(dist(tug.pos, nose) < 1, 'tug on the nose');
  assert.equal(tug.heading, 90);
  assert.equal(tug.speed, 3);
  a.pushback.stage = 'complete';
  fleet.step(0.5, ctxFor(fleet, air, runways, res.t + 1, { aircraft: [a] }));
  assert.equal(tug.state, 'returning');
  assert.equal(fleet.dispatch('tug', { kind: 'aircraft', id: a.id, callsign: a.callsign }, ['TUG1']).ok, true, 'a free tug can be re-tasked');
});

test('follow-me leads 60 m ahead of the escorted aircraft along its own path and peels off at the end', () => {
  const air = loadAirport('EGLL');
  const runways = runwaysFor('EGLL');
  setSeed(5);
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  // straight 800 m aircraft path along +x from the ops station
  const st = defaultStations({ x: 0, y: 0 }).ops;
  const pts = Array.from({ length: 81 }, (_, i) => ({ x: st.x + i * 10, y: st.y + 30 }));
  const { cum, total } = arcLengths(pts);
  const path: DrivePath = { pts, cum, total, kind: 'taxi', holds: [{ nodeId: 'n', runway: '27L', at: 500, isDepartureEntry: false }] };
  const a = mkAircraft({ callsign: 'BAW117', phase: 'taxi', pos: pts[0], heading: 90, speed: 12, altitude: 0, path, distAlong: 0 });
  fleet.step(1 / 30, ctxFor(fleet, air, runways, 0, { aircraft: [a] }));
  const r = fleet.dispatch('followme', { kind: 'aircraft', id: a.id, callsign: a.callsign }, [], 1);
  assert.ok(r.ok, r.reason);
  const v = r.vehicles[0];
  const res = runUntil(fleet, air, runways, 0, 300, () => v.state === 'onscene', { aircraft: [a] });
  assert.equal(v.state, 'onscene');
  a.followVehicleId = v.id;
  // aircraft taxis: the car sits 60 m ahead along the path at <= 15 kt
  a.distAlong = 200; a.speed = 12;
  fleet.step(0.5, ctxFor(fleet, air, runways, res.t, { aircraft: [a] }));
  assert.ok(Math.abs(v.pos.x - (pts[0].x + 260)) < 1 && Math.abs(v.pos.y - pts[0].y) < 1, `leads 60 m ahead (${v.pos.x - pts[0].x})`);
  assert.equal(v.speed, 12);
  // capped before the aircraft's next hold line while it is not released
  a.distAlong = 470;
  fleet.step(0.5, ctxFor(fleet, air, runways, res.t + 1, { aircraft: [a] }));
  assert.ok(v.pos.x - pts[0].x <= 490.5, `stays short of the hold (${v.pos.x - pts[0].x})`);
  a.holdReleased = true; a.distAlong = 799.5;
  fleet.step(0.5, ctxFor(fleet, air, runways, res.t + 2, { aircraft: [a] }));
  assert.equal(v.state, 'returning', 'peels off at the stand');
});

test('ops inspection: enters only a closed/inspection runway, drives full length and back, reports complete; open runway -> holds and requests', () => {
  const air = loadAirport('EGLL');
  setSeed(6);
  const inspection = runwaysFor('EGLL').map(r => (r.ref === '09R/27L' ? { ...r, status: 'inspection' as const } : r));
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }));
  fleet.step(1 / 30, ctxFor(fleet, air, inspection, 0));
  const r = fleet.dispatch('ops', { kind: 'runway', runway: '27L' }, [], 1);
  assert.ok(r.ok, r.reason);
  const v = r.vehicles[0];
  let entered = false, maxD = 0;
  let t = 0;
  const events: string[] = [];
  while (t < 900 && v.state !== 'returning') {
    const s = fleet.step(0.5, ctxFor(fleet, air, inspection, t));
    if (s.enteredRunway.some(e => e.vehicleId === 'OPS1' && e.cleared)) entered = true;
    events.push(...s.events.map(e => e.message));
    if (v.onRunway) maxD = Math.max(maxD, dist(v.pos, projectionFor(air).toXY(air.runways.find(x => x.ref === '09R/27L')!.ends[0].lat, air.runways.find(x => x.ref === '09R/27L')!.ends[0].lng)));
    t += 0.5;
  }
  assert.ok(entered, 'entered the runway with clearance');
  assert.ok(maxD > 3000, `drove the full length (${Math.round(maxD)} m)`);
  assert.ok(events.some(m => /inspection complete/.test(m)), events.filter(m => /Ops 1|OPS1/.test(m)).join(' | '));
  assert.equal(v.state, 'returning');
  // open runway: holds short and requests entry
  setSeed(6);
  const open = runwaysFor('EGLL');
  const fleet2 = new VehicleFleet();
  fleet2.init(air, defaultStations({ x: 0, y: 0 }));
  fleet2.step(1 / 30, ctxFor(fleet2, air, open, 0, { autoCross: false, safe: false }));
  const r2 = fleet2.dispatch('ops', { kind: 'runway', runway: '27L' }, [], 1);
  const v2 = r2.vehicles[0];
  const res2 = runUntil(fleet2, air, open, 0, 600, () => v2.state === 'onscene' && v2.speed === 0 && v2.holdShortRunway != null, { autoCross: false, safe: false });
  assert.equal(v2.holdShortRunway, '27L');
  assert.equal(v2.onRunway, null);
  assert.ok(res2.events.some(m => /request enter runway for inspection/.test(m)), res2.events.slice(-4).join(' | '));
  const s = fleet2.step(0.5, ctxFor(fleet2, air, open, res2.t, { autoCross: false, safe: false }));
  assert.deepEqual(s.crossingRequests, [{ vehicleId: 'OPS1', runway: '27L' }]);
  // the controller closes the runway (status inspection) -> it enters
  const nowClosed = open.map(x => (x.ref === '09R/27L' ? { ...x, status: 'inspection' as const } : x));
  runUntil(fleet2, air, nowClosed, res2.t, 30, () => v2.onRunway != null, { autoCross: false, safe: false });
  assert.equal(v2.onRunway, '09R/27L');
  // explicit entry clearance on an OPEN runway (op cross): drives the full inspection before reporting complete
  setSeed(6);
  const fleet3 = new VehicleFleet();
  fleet3.init(air, defaultStations({ x: 0, y: 0 }));
  fleet3.step(1 / 30, ctxFor(fleet3, air, open, 0, { autoCross: false, safe: false }));
  const v3 = fleet3.dispatch('ops', { kind: 'runway', runway: '27L' }, [], 1).vehicles[0];
  const res3 = runUntil(fleet3, air, open, 0, 600, () => v3.state === 'onscene' && v3.speed === 0 && v3.holdShortRunway != null, { autoCross: false, safe: false });
  assert.equal(fleet3.op('OPS1', 'cross', '27L'), true);
  let maxD3 = 0;
  const res4 = runUntil(fleet3, air, open, res3.t, 900, () => { if (v3.onRunway) maxD3 = Math.max(maxD3, dist(v3.pos, projectionFor(air).toXY(air.runways.find(x => x.ref === '09R/27L')!.ends[0].lat, air.runways.find(x => x.ref === '09R/27L')!.ends[0].lng))); return v3.state === 'returning'; }, { autoCross: false, safe: false });
  assert.ok(maxD3 > 3000, `cleared entry drives the full length before completing (${Math.round(maxD3)} m)`);
  assert.ok(res4.events.some(m => /Entering 27L, Ops 1/.test(m)) && res4.events.some(m => /inspection complete/.test(m)), res4.events.filter(m => /Ops 1/.test(m)).join(' | '));
});

test('fuel trucks never route over runways; dispatch failures are reported; dispatchEmergency full = 3 ARFF + ambulance', () => {
  const air = loadAirport('EGLL');
  const runways = runwaysFor('EGLL');
  setSeed(7);
  const fleet = new VehicleFleet();
  fleet.init(air, defaultStations({ x: 0, y: 0 }), FULL_FLEET);
  fleet.step(1 / 30, ctxFor(fleet, air, runways, 0));
  assert.equal(fleet.dispatch('fuel', { kind: 'runway', runway: '27L' }).ok, false);
  const stand = air.gates[0];
  const rf = fleet.dispatch('fuel', { kind: 'stand', ref: stand.ref });
  assert.ok(rf.ok, rf.reason);
  assert.equal(rf.vehicles[0].path!.holds!.length, 0, 'no runway crossings on a fuel route');
  assert.equal(fleet.dispatch('arff', { kind: 'stand', ref: 'NOPE' }).ok, false);
  assert.equal(fleet.dispatch('arff', { kind: 'runway', runway: '27L' }, ['FIRE9']).ok, false);
  const em = fleet.dispatchEmergency('full', { kind: 'runway', runway: '27R' });
  assert.ok(em.ok);
  assert.equal(em.vehicles.filter(v => v.type === 'arff').length, 3);
  assert.equal(em.vehicles.filter(v => v.type === 'ambulance').length, 1);
  assert.equal(fleet.available('arff').length, 0);
  assert.equal(fleet.responding().length, 4);
  assert.equal(fleet.dispatch('arff', { kind: 'runway', runway: '27L' }).ok, false, 'none left');
  assert.ok(fleet.etaS('FIRE1')! > 0);
});
