import test from 'node:test';
import { makeEngine, evs } from '../engine/helpers';
import { profileOf } from '../../src/lib/sim/airlines';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import type { AircraftState } from '../../src/lib/sim/types';

const WINDS: Record<string, [number, number]> = { EGLL: [240, 10], KJFK: [280, 11], KLAX: [250, 9], KSFO: [280, 12], KBOS: [270, 10], VIDP: [300, 6], LFPG: [240, 10], OMDB: [310, 9], WSSS: [30, 7], VHHH: [70, 10], RJTT: [340, 10], YSSY: [160, 10] };
const ICAO = process.env.ICAO ?? 'EGLL', SEED = Number(process.env.SEED ?? 3), MIN = Number(process.env.MIN ?? 30);
function desc(a: AircraftState | undefined) {
  if (!a) return '?';
  return `${a.callsign} ${a.perf.icaoCode}/${a.wakeCategory} ${a.plan.kind} ${a.phase} alt ${Math.round(a.altitude)}->${a.targetAltitude} hdg ${Math.round(a.heading)}->${Math.round(a.targetHeading)} spd ${Math.round(a.speed)} nav ${a.navMode} ils ${a.ilsArmed ? (a.ilsCaptured ? 'CAP' : 'armed') : '-'} ${a.assignedRunway ?? ''} freq ${a.onFrequency} rwy ${a.plan.runway} hs ${a.holdShortRunway ?? '-'} route ${a.plan.taxiRoute?.slice(0, 5).join(' ') ?? '-'} holds ${a.path?.holds?.map(h => h.runway + '@' + Math.round(h.at)).join(',') ?? '-'} along ${Math.round(a.distAlong)}/${Math.round(a.path?.total ?? 0)}`;
}
test('soak', () => {
  const ends = process.env.ENDS ? process.env.ENDS.split(',') : process.env.ALLENDS ? null : preferredEnds(RUNWAY_MANIFEST[ICAO].flatMap(r => r.ends), WINDS[ICAO][0], WINDS[ICAO][1]);
  const e = makeEngine(ICAO, { seed: SEED, pilotDelay: null, emergencies: 'off', ends } as any);
  console.log('ends', ends?.join(' ') ?? 'all');
  if (process.env.DEP && process.env.ARR) { e.setActiveRunways(process.env.DEP.split(','), process.env.ARR.split(',')); console.log('split dep', process.env.DEP, 'arr', process.env.ARR); }
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  const busy = profileOf(ICAO).busy * Number(process.env.BUSY ?? 1);
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100) / busy;
  const t0 = e.time; const log: string[] = []; const snap = new Map<string, string>(); const tx = new Map<string, string[]>();
  let lastEv = 0;
  while (e.time - t0 < MIN * 60) {
    if (e.time >= next) { if (e.aircraft.length < Number(process.env.CAP ?? 14)) { const dep = chance(0.55); const ok = dep ? e.spawnDeparture() : e.spawnArrival(); if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); } } next = e.time + rf(50, 100) / busy; }
    const out = e.step(15);
    for (const a of e.aircraft) snap.set(a.callsign, desc(a));
    for (const ev of out) {
      if (ev.type === 'transmission' && /^AI /.test(ev.message)) { const cs = ev.message.match(/^AI \w+: (\S+)/)?.[1] ?? ''; const l = tx.get(cs) ?? []; l.push(`${Math.round(ev.at)} ${ev.message}`); if (l.length > 6) l.shift(); tx.set(cs, l); }
      if (['separation_loss', 'ground_conflict', 'diversion', 'go_around', 'runway_incursion'].includes(ev.type)) {
        const m = ev.message.match(/: (\S+) \/ (\S+)/) ?? ev.message.match(/: (\S+) [\d.]+ NM behind (\S+)/) ?? ev.message.match(/: (\S+) on/); const a = snap.get(m?.[1] ?? ''), b = snap.get(m?.[2] ?? '');
        log.push(`\n[${Math.round(ev.at)}] ${ev.type}: ${ev.message}\n   A: ${a}\n   B: ${b}\n   A tx: ${(tx.get(m?.[1] ?? '') ?? []).join(' | ')}\n   B tx: ${(tx.get(m?.[2] ?? '') ?? []).join(' | ')}`);
        if (ev.type === 'go_around' || ev.type === 'diversion') { const cs = ev.message.split(' ')[0]; log.push(`   ${snap.get(cs)}\n   tx: ${(tx.get(cs) ?? []).join(' | ')}`); }
      }
      lastEv = ev.at;
    }
  }
  void lastEv;

  console.log(`${ICAO} seed ${SEED} ${MIN} min: score ${e.score} arr ${e.stats.arrivals} dep ${e.stats.departures} n ${e.aircraft.length}`);
  console.log(log.join('\n'));
  for (const a of e.aircraft) for (const r of a.requests) if (r.answeredAt == null && e.time - r.at > 120 && r.kind === 'taxi_in') { const E = e as any; console.log('taxi_in', a.callsign, a.phase, 'gate', a.plan.gateRef, 'freq', a.onFrequency, 'plan', JSON.stringify(E.planTaxi(a, { kind: 'stand', ref: a.plan.gateRef }, [])).slice(0, 200), 'occ', E.standOccupant(a.plan.gateRef), 'path', a.path?.total, 'pos', JSON.stringify(a.pos), 'nearest', E.nearestNodeId(a.pos, 1500)); }
  for (const a of e.aircraft) if (a.plan.kind === 'arrival' && a.altitude > 0) { const sc = (e as any).sc(a); console.log('ARR', a.callsign, a.phase, 'alt', Math.round(a.altitude), '->', a.targetAltitude, 'spd', Math.round(a.speed), 'freq', a.onFrequency, 'ils', a.ilsArmed, 'mode', sc.aiMode, 'base', sc.aiBase?.toFixed(1), 'rank', sc.aiRank, 'lvl', sc.aiLevel, 'spawned', Math.round(e.time - a.spawnedAt), 's ago', 'tx', (tx.get(a.callsign) ?? []).slice(-3).join(' | ')); }
  for (const a of e.aircraft) if ((a.plan.kind === 'departure' || a.requests.some(r => r.answeredAt == null)) && !['parked','arrived'].includes(a.phase) && a.altitude === 0) { console.log('DEP', a.callsign, a.phase, 'freq', a.onFrequency, 'hs', a.holdShortRunway, 'rwyAhead', a.holdShortRunway && a.plan.runway ? Math.round((e as any).runwayAheadM(a, e.runwayState(a.plan.runway!))) : '-', 'need', Math.round((e as any).takeoffRunNeededM(a)), 'req', a.requests.filter(r => r.answeredAt == null).map(r => r.kind).join(','), a.holdShortRunway ? `safe ${e.crossingSafe(a.holdShortRunway, 80, true)} allowed ${(e as any).aiCrossAllowed(a)} released ${a.holdReleased} h0 ${JSON.stringify(a.path?.holds?.[0])} h1 ${JSON.stringify(a.path?.holds?.[1])} h1safe ${a.path?.holds?.[1]?.runway ? e.crossingSafe(a.path.holds[1].runway, 110, true) : '-'} h1occ ${a.path?.holds?.[1]?.runway ? JSON.stringify(e.runwayState(a.path.holds[1].runway)?.occupiedBy) : '-'} near ${e.aircraft.filter(b => b !== a && b.altitude === 0 && !['parked','arrived'].includes(b.phase) && Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) < 700).map(b => b.callsign + ':' + b.phase + ':' + Math.round(b.speed) + ':' + Math.round(Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y))).join(',')} stopped ${(e as any).sc(a).stoppedSince} reason ${JSON.stringify((e as any).holdReasonOf?.(a.id))}` : '', 'tx', (tx.get(a.callsign) ?? []).slice(-2).join(' | ')); }
  console.log('unanswered:', e.aircraft.flatMap(a => a.requests.filter(r => r.answeredAt == null && e.time - r.at > 120).map(r => a.callsign + ':' + r.kind)).join(','));
  void evs;
});
