// Self-play arena (docs/spec/13-PILOT-BRAIN.md §6): the game's AI controllers run a whole airport while an adversary
// talks on the same frequencies and makes the mistakes a human controller makes. Every injected mistake is a labelled
// example: what the controller said, what the pilot knew, what the pilot answered, and whether the mistake was caught.
//
// Two uses:
//   1. a scoreboard for the pilots' judgement (catch rate per kind of mistake, and how much they talk when the
//      controller is good), run on every change;
//   2. free training data for the learned pilot model: episodes.jsonl holds the dialogues.
//
//   bash ml/selfplay/run.sh [--airport EGLL] [--minutes 40] [--seeds 6] [--out ml/data/selfplay]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeEngine, FIXED } from '../../tests/engine/helpers';
import { executeText } from '../../src/lib/sim/dispatch';
import { isAirborne } from '../../src/lib/sim/aircraft';
import { magneticHeading } from '../../src/lib/sim/phraseology';
import { mindOf } from '../../src/lib/sim/pilotmind';
import { ledgerOf } from '../../src/lib/sim/ledger';
import { personaOf } from '../../src/lib/sim/persona';
import type { SimEngine } from '../../src/lib/sim/engine';
import type { AircraftState, SimEvent } from '../../src/lib/sim/types';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ICAO = arg('airport', 'EGLL');
const MINUTES = Number(arg('minutes', '40'));
const SEEDS = Number(arg('seeds', '6'));
const OUT = arg('out', 'ml/data/selfplay');
const ENDS: Record<string, string[]> = { EGLL: ['27R', '27L'], KSFO: ['28L', '28R'], KJFK: ['31L', '31R'] };

function mulberry(seed: number) { let t = seed >>> 0; return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

type Verdict = 'caught' | 'missed' | 'void';
interface Shot { kind: string; t: number; callsign: string; crew: string; said: string; reply: string; code: string; verdict: Verdict; knew: string }
interface Step { cs: string; at: number; until: number; kind: string; line: (a: AircraftState) => string | null; expectCatch: boolean; then?: (a: AircraftState, e: SimEngine) => void }

/** A mistake the adversary can make now: the line to say, or two steps (a normal instruction, then its contradiction). */
interface Attack { kind: string; find: (e: SimEngine, rnd: () => number) => { a: AircraftState; setup?: string; line: (a: AircraftState) => string | null; delay?: number } | null }

const pick = <T,>(xs: T[], rnd: () => number): T | null => xs.length ? xs[Math.floor(rnd() * xs.length)] : null;
const k = (ft: number) => Math.round(ft / 1000) * 1000;
const rwOf = (a: AircraftState) => a.plan.runway ?? a.assignedRunway ?? null;
const vectored = (e: SimEngine) => e.aircraft.filter((a) => isAirborne(a) && !a.ilsArmed && !a.ilsCaptured && !a.emergency && a.phase !== 'go_around' && a.phase !== 'landing' && a.phase !== 'takeoff' && a.altitude > 3500 && a.altitude < 12000);
const holding = (e: SimEngine) => e.aircraft.filter((a) => a.phase === 'hold_short' && !!a.holdShortRunway);

const ATTACKS: Attack[] = [
  { kind: 'level reversed', find: (e, r) => { const a = pick(vectored(e), r); return a && { a, setup: `${a.callsign} Altitude ${k(a.altitude + 3000)}`, delay: 14, line: (x) => `${x.callsign} Altitude ${Math.max(2000, k(x.altitude - 2500))}` }; } },
  { kind: 'heading reversed', find: (e, r) => { const a = pick(vectored(e), r); if (!a) return null; const h = magneticHeading(a.heading + 20, e.magVar); return { a, setup: `${a.callsign} Fly heading ${String(h).padStart(3, '0')}`, delay: 14, line: () => `${a.callsign} Fly heading ${String(((h + 179) % 360) + 1).padStart(3, '0')}` }; } },
  { kind: 'line up, traffic on short final', find: (e, r) => { const a = pick(holding(e).filter((x) => x.plan.kind === 'departure' && !!e.arrivalOnFinal(x.holdShortRunway!, 2) && !e.runwayOccupant(x.holdShortRunway!, x.id)), r); return a && { a, line: (x) => `${x.callsign} Line up ${x.holdShortRunway}` }; } },
  { kind: 'cross, traffic on short final', find: (e, r) => { const a = pick(holding(e).filter((x) => !(x.plan.kind === 'departure' && rwOf(x) && e.runwayState(rwOf(x)!)?.ref === e.runwayState(x.holdShortRunway!)?.ref) && !!e.arrivalOnFinal(x.holdShortRunway!, 2)), r); return a && { a, line: (x) => `${x.callsign} Cross ${x.holdShortRunway}` }; } },
  { kind: 'cross, departure rolling', find: (e, r) => { const a = pick(holding(e).filter((x) => !(x.plan.kind === 'departure' && rwOf(x) && e.runwayState(rwOf(x)!)?.ref === e.runwayState(x.holdShortRunway!)?.ref) && !!e.rollingDeparture(x.holdShortRunway!) && !e.arrivalOnFinal(x.holdShortRunway!, 2)), r); return a && { a, line: (x) => `${x.callsign} Cross ${x.holdShortRunway}` }; } },
  { kind: 'cleared to land, runway occupied', find: (e, r) => { const a = pick(e.aircraft.filter((x) => { if (!isAirborne(x) || x.landingCleared || !x.ilsCaptured) return false; const rw = rwOf(x); const rs = rw ? e.runwayState(rw) : undefined; const d = rw ? e.distToThresholdNM(x, rw) : null; return !!rs && d != null && d < 3.4 && d > 2.1 && rs.occupiedBy.some((o) => o.id !== x.id && ['lineup', 'stopped', 'vehicle', 'crossing', 'backtrack', 'inspection'].includes(o.kind)); }), r); return a && { a, line: (x) => `${x.callsign} Cleared to land ${rwOf(x)}` }; } },
  { kind: 'cleared to land, wrong runway', find: (e, r) => { const a = pick(e.aircraft.filter((x) => isAirborne(x) && x.ilsCaptured && !x.landingCleared && !!rwOf(x)), r); if (!a) return null; const mine = e.runwayState(rwOf(a)!); const other = e.runways.find((y) => mine && y.ref !== mine.ref && y.name.slice(0, 2) === mine.name.slice(0, 2)); return other ? { a, line: () => `${a.callsign} Cleared to land ${other.name}` } : null; } },
  { kind: 'takeoff, traffic on short final', find: (e, r) => { const a = pick(e.aircraft.filter((x) => (x.phase === 'lineup' || x.phase === 'hold_short') && x.plan.kind === 'departure' && !!rwOf(x) && !!e.arrivalOnFinal(rwOf(x)!, 2)), r); return a && { a, line: (x) => `${x.callsign} Cleared for takeoff ${rwOf(x)}` }; } },
  { kind: 'instruction for the wrong aircraft', find: (e, r) => { const a = pick(e.aircraft.filter((x) => x.phase !== 'parked' && x.phase !== 'arrived'), r); if (!a) return null; const rw = e.runways[0]?.name ?? ''; const lines = isAirborne(a) ? [`${a.callsign} Pushback approved`, `${a.callsign} Line up ${rw}`, `${a.callsign} Cross ${rw}`] : [`${a.callsign} Altitude 5000`, `${a.callsign} Cleared to land ${rw}`, `${a.callsign} Fly heading 180`]; const line = pick(lines, r)!; return { a, line: () => line }; } },
  { kind: 'descent below a safe level', find: (e, r) => { const a = pick(vectored(e).filter((x) => Math.hypot(x.pos.x - e.centerXY.x, x.pos.y - e.centerXY.y) > 12 * 1852), r); return a && { a, line: (x) => `${x.callsign} Altitude 1000` }; } },
  { kind: 'speed below what the aircraft can fly', find: (e, r) => { const a = pick(vectored(e).filter((x) => x.speed > 200), r); return a && { a, line: (x) => `${x.callsign} Speed 100` }; } },
  { kind: 'sent to the ground frequency in the air', find: (e, r) => { const a = pick(vectored(e), r); return a && { a, line: (x) => `${x.callsign} Contact ground` }; } },
];

function snapshot(e: SimEngine, a: AircraftState): string {
  const rw = rwOf(a);
  const d = rw && isAirborne(a) ? e.distToThresholdNM(a, rw) : null;
  const bits = [a.phase, isAirborne(a) ? `${Math.round(a.altitude / 100) * 100} ft` : a.holdShortRunway ? `holding short ${a.holdShortRunway}` : '', rw ? `runway ${rw}` : '', d != null && d < 15 ? `${d.toFixed(1)} NM final` : '', a.landingCleared ? 'cleared to land' : ''];
  const led = ledgerOf(e).text(a.callsign);
  return bits.filter(Boolean).join(', ') + (led ? ` | told: ${led}` : '');
}

interface EpisodeResult { seed: number; adversary: boolean; minutes: number; shots: Shot[]; calls: Record<string, number>; mind: Record<string, number>; movements: number; goArounds: number; incidents: Record<string, number>; lines: number; dialogue: Array<{ t: number; who: string; cs: string; text: string }> }

function episode(seed: number, adversary: boolean): EpisodeResult {
  const e = makeEngine(ICAO, { seed, ends: ENDS[ICAO] ?? null, pilotDelay: null, emergencies: 'off', pilotErrorRate: 0.02 });
  e.settings.autoMode = true; e.settings.autoTower = true; e.settings.autoGround = true; e.settings.autoApproach = true;
  e.settings.personas = true;
  const rnd = mulberry(seed * 9973 + 17);
  const shots: Shot[] = []; const steps: Step[] = [];
  const calls: Record<string, number> = {}; const dialogue: EpisodeResult['dialogue'] = [];
  let nextSpawn = 0, toggle = 0, nextAttack = 240, lines = 0;
  const busy = new Map<string, number>();
  const say = (kind: string, a: AircraftState, line: string): Shot | null => {
    const knew = snapshot(e, a);
    const r = executeText(e, line);
    if (!r.parse.ok) return null;
    const code = r.result.code;
    const verdict: Verdict = code === 'queried' || (!r.result.ok && code !== 'already' && code !== 'not_found') ? 'caught' : r.result.ok ? 'missed' : 'void';
    const reply = r.result.readback || r.result.reason || '';
    dialogue.push({ t: Math.round(e.time), who: 'ATC!', cs: a.callsign, text: line }, { t: Math.round(e.time), who: 'PILOT', cs: a.callsign, text: reply });
    return { kind, t: Math.round(e.time), callsign: a.callsign, crew: personaOf(a.callsign).kind, said: line, reply, code, verdict, knew };
  };
  const total = MINUTES * 60;
  while (e.time < total) {
    if (e.time >= nextSpawn && e.aircraft.filter((a) => a.phase !== 'parked').length < 16) { if (toggle++ % 2) e.spawnArrival(); else e.spawnDeparture(); nextSpawn = e.time + 45; }
    let evs: SimEvent[] = [];
    try { evs = e.step(Math.round(1 / FIXED)); } catch (err) { console.error(`seed ${seed}: engine threw at ${Math.round(e.time)} s: ${(err as Error).message}`); break; }
    for (const ev of evs) {
      if (ev.type === 'request' && ev.data && ev.data.type === 'request' && ev.data.change === 'raised') { calls[ev.data.request.kind] = (calls[ev.data.request.kind] ?? 0) + 1; dialogue.push({ t: Math.round(ev.at), who: 'PILOT', cs: ev.callsign, text: ev.message }); lines++; }
      else if (ev.type === 'transmission') { dialogue.push({ t: Math.round(ev.at), who: 'ATC', cs: ev.callsign, text: ev.message }); lines++; }
      else if (ev.type === 'readback') { dialogue.push({ t: Math.round(ev.at), who: 'PILOT', cs: ev.callsign, text: ev.message }); lines++; }
    }
    if (!adversary) continue;
    // second halves of two-step mistakes
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]; if (e.time < s.at) continue;
      steps.splice(i, 1);
      const a = e.find(s.cs); if (!a) continue;
      const line = s.line(a); if (!line) continue;
      const shot = say(s.kind, a, line); if (shot && shot.verdict !== 'void') shots.push(shot);
    }
    if (e.time < nextAttack) continue;
    nextAttack = e.time + 20 + rnd() * 30;
    const order = ATTACKS.map((x) => ({ x, r: rnd() })).sort((p, q) => p.r - q.r).map((p) => p.x);
    for (const atk of order) {
      const hit = atk.find(e, rnd); if (!hit) continue;
      if ((busy.get(hit.a.callsign) ?? -1e9) > e.time - 150) continue;
      busy.set(hit.a.callsign, e.time);
      if (hit.setup) {
        const r = executeText(e, hit.setup);
        if (!r.result.ok) continue;
        dialogue.push({ t: Math.round(e.time), who: 'ATC!', cs: hit.a.callsign, text: hit.setup });
        steps.push({ cs: hit.a.callsign, at: e.time + (hit.delay ?? 12), until: e.time + 60, kind: atk.kind, line: hit.line, expectCatch: true });
      } else {
        const line = hit.line(hit.a); if (!line) continue;
        const shot = say(atk.kind, hit.a, line); if (shot && shot.verdict !== 'void') shots.push(shot); else continue;
      }
      break;
    }
  }
  const st = e.stats;
  return { seed, adversary, minutes: Math.round(e.time / 60), shots, calls, mind: { ...mindOf(e).stats }, movements: st.movements, goArounds: st.goAroundsPilot + st.goAroundsPlayer, incidents: { ...(st.incidents as Record<string, number>) }, lines, dialogue };
}

const t0 = Date.now();
const results: EpisodeResult[] = [];
for (let s = 1; s <= SEEDS; s++) { results.push(episode(s, false)); results.push(episode(s, true)); process.stderr.write(`seed ${s} done (${Math.round((Date.now() - t0) / 1000)} s)\n`); }

const adv = results.filter((r) => r.adversary), base = results.filter((r) => !r.adversary);
const byKind: Record<string, { n: number; caught: number; examples: Shot[]; misses: Shot[] }> = {};
for (const atk of ATTACKS) byKind[atk.kind] = { n: 0, caught: 0, examples: [], misses: [] };
for (const r of adv) for (const s of r.shots) { const b = byKind[s.kind]; b.n++; if (s.verdict === 'caught') { b.caught++; if (b.examples.length < 3) b.examples.push(s); } else if (b.misses.length < 3) b.misses.push(s); }
const sum = (xs: EpisodeResult[], f: (r: EpisodeResult) => number) => xs.reduce((n, r) => n + f(r), 0);
const hours = (xs: EpisodeResult[]) => sum(xs, (r) => r.minutes) / 60;
const callKinds = [...new Set(results.flatMap((r) => Object.keys(r.calls)))].sort();
const summary = {
  airport: ICAO, seeds: SEEDS, minutesPerEpisode: MINUTES, wallSeconds: Math.round((Date.now() - t0) / 1000),
  mistakes: Object.entries(byKind).map(([kind, b]) => ({ kind, injected: b.n, caught: b.caught, rate: b.n ? b.caught / b.n : null, examples: b.examples, misses: b.misses })),
  total: { injected: sum(adv, (r) => r.shots.length), caught: sum(adv, (r) => r.shots.filter((s) => s.verdict === 'caught').length) },
  goodController: { hours: hours(base), movements: sum(base, (r) => r.movements), goArounds: sum(base, (r) => r.goArounds), lines: sum(base, (r) => r.lines), mind: Object.fromEntries(Object.keys(base[0]?.mind ?? {}).map((m) => [m, sum(base, (r) => r.mind[m])])), calls: Object.fromEntries(callKinds.map((c) => [c, sum(base, (r) => r.calls[c] ?? 0)])) },
  withAdversary: { hours: hours(adv), movements: sum(adv, (r) => r.movements), goArounds: sum(adv, (r) => r.goArounds), lines: sum(adv, (r) => r.lines), mind: Object.fromEntries(Object.keys(adv[0]?.mind ?? {}).map((m) => [m, sum(adv, (r) => r.mind[m])])) },
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
const ep = fs.createWriteStream(path.join(OUT, 'episodes.jsonl'));
for (const r of results) ep.write(JSON.stringify({ airport: ICAO, seed: r.seed, adversary: r.adversary, minutes: r.minutes, shots: r.shots, dialogue: r.dialogue }) + '\n');
ep.end();
console.log(`${ICAO}: ${SEEDS} seeds x ${MINUTES} min, with and without the adversary (${summary.wallSeconds} s)`);
for (const m of summary.mistakes) console.log(`  ${m.kind.padEnd(44)} ${String(m.caught).padStart(4)} / ${String(m.injected).padEnd(4)} ${m.rate == null ? '' : (m.rate * 100).toFixed(0) + ' %'}`);
console.log(`  total ${summary.total.caught} / ${summary.total.injected}`);
console.log(`good controller: ${summary.goodController.hours.toFixed(1)} h, ${summary.goodController.movements} movements, ${summary.goodController.goArounds} go-arounds, ${summary.goodController.lines} radio lines, pilots' own calls ${JSON.stringify(summary.goodController.mind)}`);
console.log(`with adversary:  ${summary.withAdversary.hours.toFixed(1)} h, ${summary.withAdversary.movements} movements, ${summary.withAdversary.goArounds} go-arounds, pilots' own calls ${JSON.stringify(summary.withAdversary.mind)}`);
