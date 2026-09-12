// Headless data-layer tests (node:test). Run with scripts/test-sim.sh tests/data
// Asserts, for all six shipped airports, that the OSM graph + airspace file
// produce a playable airport: oriented runway ends, holds at every entry, stands
// with headings, an ARFF station, and routable gate -> runway paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildOsmAirport, findPath, holdsOnPath, holdForRunwayEntry, runwayEndByName, taxiwaysForPath, routeVia,
  bearingDeg, meters, nearestOsmNode, isHoldNodeForRunway, angDiff, type OsmAirport,
} from '../../src/lib/osmAirport';
import { parseEndlessAirport, reciprocalName, sidsForRunway, starsForRunway } from '../../src/lib/airspace/eairport';
import { buildAirportData, runwaySeeds, crossCheckRunways } from '../../src/lib/airportData';
import { RUNWAY_MANIFEST, manifestEnd } from '../../src/lib/runwayManifest';

// The harness compiles into .tmp/sim and runs from the repo root; fall back to walking up from __dirname.
const ROOT = (() => {
  for (const start of [process.cwd(), __dirname]) {
    let d = start;
    for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(d, 'public', 'maps', 'osm'))) return d; d = path.dirname(d); }
  }
  return process.cwd();
})();
const AIRPORTS = ['EGLL', 'KLAX', 'KJFK', 'KSFO', 'KBOS', 'VIDP'];

const cache = new Map<string, ReturnType<typeof buildAirportData>>();
function load(icao: string) {
  let d = cache.get(icao);
  if (!d) {
    const fc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'maps', 'osm', `${icao}.geojson`), 'utf8'));
    const txtPath = path.join(ROOT, 'public', 'airspace', `${icao}.txt`);
    const txt = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : null;
    d = buildAirportData(icao, fc, txt, { quiet: true });
    cache.set(icao, d);
  }
  return d;
}
const designatorHdg = (name: string) => parseInt(name.replace(/[^\d]/g, ''), 10) * 10;

for (const icao of AIRPORTS) {
  test(`${icao}: runway ends are oriented by geometry (designator vs bearing within 25 deg, magnetic)`, () => {
    const { osm } = load(icao);
    assert.ok(osm.runways.length >= 2, 'at least two runways');
    for (const rw of osm.runways) {
      assert.equal(rw.ends.length, 2);
      assert.equal(rw.orientation, 'geometry', `${rw.ref} orientation should be unambiguous`);
      const [a, b] = rw.ends;
      const brgAB = bearingDeg(a.lng, a.lat, b.lng, b.lat);
      assert.ok(angDiff(brgAB, a.trueHdg) < 0.01, `${rw.ref}: trueHdg of ${a.name} is the bearing toward ${b.name}`);
      assert.ok(angDiff((brgAB + 180) % 360, b.trueHdg) < 0.01);
      for (const e of rw.ends) {
        const mag = (e.trueHdg - osm.magVar + 360) % 360;
        assert.ok(angDiff(designatorHdg(e.name), mag) <= 25, `${icao} ${e.name}: designator ${designatorHdg(e.name)} vs magnetic bearing ${mag.toFixed(1)}`);
        assert.ok(osm.nodes.has(e.nodeId), `${e.name} end is a graph node`);
        assert.ok(rw.nodeIds.includes(e.nodeId), `${e.name} end is on the centreline chain`);
      }
      assert.ok(rw.lengthM > 700 && rw.lengthM < 5000, `${rw.ref} length ${rw.lengthM.toFixed(0)} m plausible`);
      // duplicate / split ways were merged: one runway per ref
      assert.equal(osm.runways.filter(r => r.ref === rw.ref).length, 1, `${rw.ref} appears once`);
    }
  });

  test(`${icao}: every runway end has at least one holding position (entry hold) and holdsOnPath finds it`, () => {
    const { osm } = load(icao);
    for (const rw of osm.runways) for (const end of rw.ends) {
      assert.ok(end.holdNodeIds.length >= 1, `${icao} ${end.name} has an entry hold`);
      for (const id of end.holdNodeIds) {
        const h = osm.holdByNode.get(id);
        assert.ok(h, 'hold node registered');
        assert.equal(h!.entryEnd, end.name);
        assert.ok(h!.runwayRefs.includes(rw.ref));
        assert.ok(h!.distToRunwayM >= 35 && h!.distToRunwayM <= 150, `${end.name} hold ${h!.distToRunwayM.toFixed(0)} m from the centreline`);
        assert.ok(isHoldNodeForRunway(osm, id, end.name));
        assert.ok(isHoldNodeForRunway(osm, id, rw.ref));
      }
    }
    // no hold sits on a runway centreline node
    for (const h of osm.holdingPositions) {
      const n = osm.nodes.get(h.nodeId)!;
      assert.ok(!n.edges.some(e => e.type === 'runway' && e.runway), `hold ${h.id} is not on a runway`);
    }
  });

  test(`${icao}: stands have headings, lead-ins, sizes, and gates[] mirrors stands[]`, () => {
    const { osm } = load(icao);
    assert.ok(osm.stands.length >= 60, `${icao} has ${osm.stands.length} stands`);
    assert.equal(osm.gates.length, osm.stands.length);
    const refs = new Set<string>();
    for (const s of osm.stands) {
      assert.ok(Number.isFinite(s.headingIn) && s.headingIn >= 0 && s.headingIn < 360, `${s.ref} headingIn`);
      assert.ok(angDiff(s.pushbackHeading, (s.headingIn + 180) % 360) < 1e-6);
      assert.ok(/^[A-F]$/.test(s.size));
      assert.ok(['gate', 'stand', 'remote'].includes(s.type));
      assert.ok(osm.nodes.has(s.nodeId) && osm.nodes.has(s.entryNodeId));
      assert.ok(s.leadInPts.length >= 2);
      assert.ok(!refs.has(s.ref), `duplicate stand ref ${s.ref}`); refs.add(s.ref);
      // the stand node is reachable from the taxiway network (routable)
      const n = osm.nodes.get(s.nodeId)!;
      assert.ok(n.edges.length >= 1, `${s.ref} stand node is linked`);
    }
    const withLead = osm.stands.filter(s => s.hasLeadIn).length;
    if (icao !== 'VIDP') assert.ok(withLead > osm.stands.length * 0.5, 'most stands have OSM lead-in lines');
    for (const g of osm.gates) { const s = osm.stands.find(x => x.ref === g.ref)!; assert.equal(g.nodeId, s.nodeId); }
  });

  test(`${icao}: service stations exist (ARFF real or inferred, standby points, de-ice pads)`, () => {
    const { osm } = load(icao);
    const S = osm.stations;
    for (const st of [S.arff, S.ambulance, S.tugDepot, S.followMeBase, S.ops, S.fuelFarm, ...S.deice]) {
      assert.ok(Number.isFinite(st.lat) && Number.isFinite(st.lng));
      assert.ok(st.nodeId && osm.nodes.has(st.nodeId), `${st.name} snaps to a graph node`);
      assert.ok(meters(st.lng, st.lat, osm.center.lng, osm.center.lat) < 8000, `${st.name} is on the airport`);
    }
    assert.ok(S.arffAll.length >= 1);
    if (icao !== 'KJFK') assert.equal(S.arff.source, 'osm', `${icao} ARFF station from OSM`);
    assert.equal(S.deice.length, 2);
    assert.equal(S.arffStandby.length, osm.runways.length * 2);
    for (const sb of S.arffStandby) assert.ok(sb.touchdownNodeId && sb.midpointNodeId);
  });

  test(`${icao}: findPath from a gate to every runway end succeeds and carries a departure-entry hold`, () => {
    const { osm } = load(icao);
    const picks = [osm.stands[0], osm.stands[Math.floor(osm.stands.length / 2)], osm.stands[osm.stands.length - 1]];
    for (const gate of picks) for (const rw of osm.runways) for (const end of rw.ends) {
      const ids = findPath(osm, gate.nodeId, end.nodeId);
      assert.ok(ids && ids.length >= 2, `${icao} ${gate.ref} -> ${end.name} routable`);
      assert.equal(ids![0], gate.nodeId); assert.equal(ids![ids!.length - 1], end.nodeId);
      // consecutive nodes are linked
      for (let i = 0; i < ids!.length - 1; i++) assert.ok(osm.nodes.get(ids![i])!.edges.some(e => e.to === ids![i + 1]), 'path uses graph edges');
      const holds = holdsOnPath(osm, ids!);
      const dep = holds.filter(h => h.isDepartureEntry);
      assert.equal(dep.length, 1, `${icao} ${gate.ref} -> ${end.name}: exactly one departure-entry hold (${JSON.stringify(holds)})`);
      assert.ok(rw.ends.some(e => e.name === dep[0].runway), 'departure hold names an end of the runway');
      assert.ok(dep[0].at >= 0 && dep[0].at <= holds.reduce((m, h) => Math.max(m, h.at), 0) + 1e-6);
      for (let i = 1; i < holds.length; i++) assert.ok(holds[i].at >= holds[i - 1].at, 'holds in path order');
      const entry = holdForRunwayEntry(osm, end.name, gate.nodeId);
      assert.ok(entry && entry.entryEnd === end.name, `holdForRunwayEntry(${end.name})`);
      // VIDP's OSM taxiways are mostly unnamed (77 % of edges have no ref) — via-lists can be empty there
      if (icao !== 'VIDP') assert.ok(taxiwaysForPath(osm, ids!).length >= 1, 'route has named taxiways');
    }
    // unreachable / unknown nodes return null cleanly
    assert.equal(findPath(osm, 'nope', picks[0].nodeId), null);
    assert.equal(findPath(osm, picks[0].nodeId, 'nope'), null);
  });

  test(`${icao}: findPath options — avoid a runway, prefer taxiways, routeVia`, () => {
    const { osm } = load(icao);
    const gate = osm.stands[Math.floor(osm.stands.length / 3)];
    const rw = osm.runways[0];
    const base = findPath(osm, gate.nodeId, rw.ends[1].nodeId)!;
    assert.ok(base);
    // avoiding the target runway itself: entering it is impossible unless the end node is reached by taxiway only
    const crossed = osm.runways.filter(r => r !== rw && base.some(id => osm.nodes.get(id)!.edges.some(e => e.runway === r.ref)));
    for (const r of crossed) {
      const p = findPath(osm, gate.nodeId, rw.ends[1].nodeId, { avoidRunways: [r.ref] });
      if (p) assert.ok(!p.some(id => osm.nodes.get(id)!.edges.some(e => e.type === 'runway' && e.runway === r.ref) && osm.nodes.get(id)!.edges.every(e => e.type === 'runway' || e.runway === r.ref)), `${r.ref} avoided`);
    }
    const tw = taxiwaysForPath(osm, base);
    if (tw.length) {
      const pref = findPath(osm, gate.nodeId, rw.ends[1].nodeId, { prefer: [tw[0]] });
      assert.ok(pref && pref.length >= 2);
      const via = routeVia(osm, gate.nodeId, [tw[0]], rw.ends[1].nodeId);
      assert.ok(via && via[via.length - 1] === rw.ends[1].nodeId, 'routeVia reaches the goal');
      assert.equal(routeVia(osm, gate.nodeId, ['ZZZ9'], rw.ends[1].nodeId), null, 'unknown taxiway -> null');
    }
    const n = nearestOsmNode(osm, gate.lng, gate.lat, 50);
    assert.ok(n && meters(n.lng, n.lat, gate.lng, gate.lat) < 1);
  });

  test(`${icao}: runway manifest agrees with the runtime graph (names, headings, thresholds)`, () => {
    const { osm } = load(icao);
    const man = RUNWAY_MANIFEST[icao];
    assert.ok(man && man.length >= 2);
    for (const pair of man) {
      const rw = osm.runways.find(r => r.ref === pair.ref);
      assert.ok(rw, `${pair.ref} in graph`);
      for (const me of pair.ends) {
        const oe = rw!.ends.find(e => e.name === me.name);
        assert.ok(oe, `${me.name} present in graph runway ${pair.ref}`);
        assert.ok(angDiff(me.hdg, oe!.trueHdg) <= 0.2, `${me.name} heading ${me.hdg} vs ${oe!.trueHdg.toFixed(1)}`);
        assert.ok(meters(me.thr.lng, me.thr.lat, oe!.lng, oe!.lat) <= 5, `${me.name} threshold matches`);
        assert.ok(Math.abs(me.lengthFt - rw!.lengthM / 0.3048) < 5);
        const found = manifestEnd(icao, me.name.toLowerCase());
        assert.ok(found && found.end.name === me.name && found.other.name !== me.name);
      }
    }
  });

  test(`${icao}: airspace file — every runway end has an ILS row that matches the OSM end; SIDs/STARs typed`, () => {
    const data = load(icao);
    assert.ok(data.airspace, 'airspace file parsed');
    const ap = data.airspace!;
    const seeds = runwaySeeds(data);
    assert.equal(seeds.length, data.osm.runways.length * 2);
    for (const s of seeds) {
      if (!s.usable) continue;
      assert.ok(s.hasIls, `${icao} ${s.name} has an ILS row`);
      assert.ok(!s.ilsEstimated, `${icao} ${s.name} ILS row is explicit`);
      assert.ok(s.holdNodes.length >= 1);
      assert.ok(Number.isFinite(s.thrElevFt));
      assert.ok(sidsForRunway(ap, s.name).length >= 1, `${icao} ${s.name} has SIDs`);
      assert.ok(starsForRunway(ap, s.name).length >= 1, `${icao} ${s.name} has STARs`);
    }
    for (const c of crossCheckRunways(data)) assert.ok(c.ok, `${icao} ILS ${c.name}: ${c.distM.toFixed(0)} m / ${c.hdgDiff.toFixed(1)} deg from the OSM end`);
    for (const r of ap.sids.concat(ap.stars)) {
      assert.ok(r.name && r.waypoints.length >= 2 && r.runways.length >= 1, `route ${r.name} typed`);
      for (const w of r.waypoints) assert.ok(Math.abs(w.lat - ap.airspace.center.lat) < 2 && Math.abs(w.lng - ap.airspace.center.lng) < 3, `${r.name} waypoint near the TMA`);
    }
    assert.ok(ap.entryPoints.length >= 4);
    assert.ok(ap.airspace.beacons.length >= 4);
    assert.ok(Number.isFinite(ap.airspace.magVar));
  });
}

test('EGLL: all four ends have explicit ILS, Northolt stays out of the merged runway list, entry beacons resolve', () => {
  const data = load('EGLL');
  const ap = data.airspace!;
  assert.deepEqual(ap.airports.map(a => `${a.code}:${a.coLocated}`), ['EGLW:true', 'WU:false', 'EGLW:true']);
  assert.deepEqual(ap.runways.map(r => r.name).sort(), ['09L', '09R', '27L', '27R']);
  assert.ok(ap.runways.every(r => !r.derived));
  const r27r = ap.runways.find(r => r.name === '27R')!;
  assert.equal(r27r.displacedThrOppFt, 1013.78);
  assert.equal(r27r.thrElevFt, 77);
  assert.equal(r27r.towerFreq, 118.705);
  assert.equal(r27r.reciprocal, '09L');
  for (const e of ap.entryPoints) assert.ok(!e.beacon || ap.airspace.beacons.some(b => b.id === e.beacon), `entry beacon ${e.beacon}`);
  assert.ok(sidsForRunway(ap, '09R').some(s => s.name === 'BPK1J'));
  assert.ok(sidsForRunway(ap, '27L').some(s => s.name === 'BPK7G' && s.weight === 2), 'duplicate route rows collapse into weight');
  assert.equal(sidsForRunway(ap, '25').length, 0, 'Northolt SIDs are not attached');
  assert.equal(starsForRunway(ap, '27L', 'BIG').length, 1);
  // engine-facing runway ends
  const seeds = runwaySeeds(data);
  assert.deepEqual(seeds.map(s => s.name).sort(), ['09L', '09R', '27L', '27R']);
  const s27l = seeds.find(s => s.name === '27L')!;
  assert.ok(angDiff(s27l.headingTrue, 269.7) < 0.2 && s27l.reciprocal === '09R' && s27l.hasIls && !s27l.ilsEstimated);
});

test('eairport: derived reciprocal when a file lists only one end; xy coordinates; secondary airport filtered', () => {
  const txt = [
    '[airspace]', 'radius = 20', 'center = N51.5, W0.5', 'magneticvar = 1', 'beacons =', '\tABC, N51.6, W0.6, 0, abc', '',
    '[airport1]', 'name = Test', 'code = TEST', 'runways =', '\tr27, 27, N51.5, W0.5, 270, 9843, 0, 656, 100, 3, 270, 0, 0, 0, 0, 0, 118.1', '',
    'entrypoints =', '\t90, ABC, 8000', '',
    '[airport2]', 'name = Far', 'code = FARR', 'runways =', '\tf1, 18, N52.5, W0.5, 180, 5000, 0, 0, 50, 3, 180', '',
    '[departure1]', 'runway = r27', 'route1 =', '\tABC1A, abc one alpha', '\tN51.5, W0.55, 5000', '\t3, 4', '',
    '[departure2]', 'runway = f1', 'route2 =', '\tXYZ1A, xyz', '\tN52.4, W0.5', '',
  ].join('\n');
  const ap = parseEndlessAirport(txt);
  assert.deepEqual(ap.runways.map(r => r.name), ['27', '09']);
  const r09 = ap.runways[1];
  assert.ok(r09.derived && r09.reciprocal === '27' && Math.abs(r09.trueHeading - 90) < 1e-9);
  assert.equal(r09.displacedThrFt, 656);
  assert.ok(r09.coord.kind === 'll' && r09.coord.lng < -0.5 && Math.abs(r09.coord.lat - 51.5) < 0.001, 'far end lies 3 km west');
  assert.ok(r09.thrCoord.kind === 'll' && r09.thrCoord.lng > (r09.coord as { lng: number }).lng, 'displaced threshold moved east');
  assert.equal(ap.airports.length, 2);
  assert.equal(ap.airports[1].coLocated, false);
  assert.equal(ap.sids.length, 1);
  assert.deepEqual(ap.sids[0].runways, ['27']);
  assert.equal(ap.sids[0].waypoints.length, 2);
  const w = ap.sids[0].waypoints[1];
  assert.ok(w.lat > 51.5 && w.lng > -0.5, 'x,y NM waypoint converted around the centre');
  assert.equal(reciprocalName('18C'), '36C');
  assert.equal(reciprocalName('04L'), '22R');
});

test('osmAirport: hold classification rejects holds on the runway strip and holdsOnPath handles crossings', () => {
  const { osm } = load('KSFO');
  // a path from a stand south of the 1s to 28R crosses 01L/19R and 01R/19L: crossing holds precede the departure entry
  const gate = osm.stands.find(s => s.ref === '50-6') ?? osm.stands[0];
  const end = runwayEndByName(osm, '28R')!;
  const ids = findPath(osm, gate.nodeId, end.end.nodeId)!;
  const holds = holdsOnPath(osm, ids);
  const crossings = holds.filter(h => !h.isDepartureEntry);
  for (const c of crossings) {
    const h = osm.holdByNode.get(c.nodeId);
    assert.ok(h, 'crossing hold is a registered holding position');
    assert.ok(h!.runwayEnds.includes(c.runway));
  }
  assert.equal(holds.filter(h => h.isDepartureEntry).length, 1);
  // a path that starts on the runway (rollout) yields no hold for that runway
  const rollout = holdsOnPath(osm, end.rw.nodeIds.slice(0, 5));
  assert.equal(rollout.length, 0);
});

test('osmAirport: buildings and OsmAirport shape are stable', () => {
  for (const icao of AIRPORTS) {
    const { osm } = load(icao);
    assert.ok(osm.buildings.some(b => b.kind === 'terminal'), `${icao} terminals`);
    for (const b of osm.buildings) { assert.ok(b.polygon.length >= 3 && b.areaM2 > 0); assert.ok(['terminal', 'hangar', 'apron'].includes(b.kind)); }
    assert.ok(osm.taxiwayNames.length >= 10 && osm.taxiwayNodes.size === osm.taxiwayNames.length);
    assert.ok(osm.warnings.every(w => typeof w === 'string'));
    const sample: OsmAirport = osm; void sample;
  }
});
