// The tutorial as the page runs it, headless: the real coach (src/game/Tutorial/runner.ts) on the real sim store, with a
// frame loop emulated at a chosen frame rate and the coach's quarter-second tick, a player who skips each briefing and
// types every call the card suggests into the command line (the store's path: readback, undo window), and the next
// mission opened the way the completion card opens it. lessons.test.ts checks the lessons against the engine alone;
// this checks the wiring between coach, store and engine, where the "back at the gate" and "waits forever" bugs were.
//
//   npx tsx --test tests/tutor/coach.test.ts           (FPS=20 for a slow machine; TAB=ground to run one track)
//
// Per mission it checks: the scene builds without a refused call; a continued mission carries on with the same
// aircraft where the last one left it (never back on its stand); the mission's traffic exists; every call the card
// suggests is accepted; no runway incursion or ground conflict; it finishes within its sim-time budget; fast-forward
// is off at the end; the map got its camera cue. Then each mission opened on its own (a fresh scene) the same way.
import '../store/stubs';
import test from 'node:test';
import assert from 'node:assert';
import type { SimEvent } from '../../src/lib/sim/types';
import { sim } from '../../src/components/atc/simStore';
import { coach } from '../../src/game/Tutorial/runner';
import { CHAPTERS, chaptersOf, TABS } from '../../src/game/Tutorial/lessons';
import { markListening, TUTOR_EVENT } from '../../src/components/atc/WorldMap/tutor';

// the page's window: events for the map cues; the coach's timers are driven by hand below
const g = globalThis as unknown as Record<string, unknown>;
const bus = new EventTarget();
g.addEventListener = bus.addEventListener.bind(bus); g.removeEventListener = bus.removeEventListener.bind(bus); g.dispatchEvent = bus.dispatchEvent.bind(bus);
const refused: string[] = [];
const warn = console.warn; console.warn = (...a: unknown[]) => { if (String(a[0]).startsWith('tutor setup call refused')) refused.push(a.slice(1).join(' ')); else warn(...a); };

type Chapter = (typeof CHAPTERS)[number];
type Tab = Chapter['tab'];

const FPS = Number(process.env.FPS || 60);
const cues: Array<{ kind: string }> = [];
bus.addEventListener(TUTOR_EVENT, (ev) => cues.push((ev as CustomEvent).detail));
markListening(true);
const events: SimEvent[] = [];
sim.eventTaps.add((evs) => events.push(...evs));

async function boot(tab: Tab) {
  await sim.load({ icao: 'KSFO', spawn: 'none', position: tab, ends: ['28L', '28R', '01L', '01R'] } as never);
  assert.ok(sim.engine, 'KSFO did not load');
  sim.stop();   // no requestAnimationFrame loop: the frames are stepped here
  coach.init(); coach.setTab(tab);
}
/** Wall time passing in the page: frames at FPS (the store's loop, rate and boost included) and the coach's tick. */
let tickAcc = 0;
function wall(seconds: number) {
  const dt = 1 / FPS;
  for (let t = 0; t < seconds; t += dt) {
    if (!sim.paused && sim.engine) sim.step(Math.min(dt, 0.1) * sim.rate * sim.boost);
    tickAcc += dt; if (tickAcc >= 0.25) { tickAcc -= 0.25; (coach as unknown as { tick(): void }).tick(); }
  }
}
const next = (ch: Chapter) => { const list = chaptersOf(ch.tab); return list[list.findIndex((c) => c.id === ch.id) + 1] ?? null; };
const BUDGET_S = Number(process.env.BUDGET || 420);   // sim seconds a mission may take before it counts as stuck

interface Run { id: string; how: string; simS: number; calls: string[]; issues: string[] }
/** Play the open mission like a player: skip the briefing, use every suggested call, until it is done or stuck. */
async function play(ch: Chapter, how: string, prev: { cs: string; x: number; y: number; phase: string } | null): Promise<Run> {
  const run: Run = { id: ch.id, how, simS: 0, calls: [], issues: [] };
  const e = sim.engine!;
  if (ch.ui) { for (const gl of ch.goals) coach.markMet(gl.id); if (coach.state.stage !== 'done') run.issues.push('page lesson did not finish'); return run; }
  if (coach.state.stage === 'story') { if (!sim.paused) run.issues.push('briefing did not pause the sim'); wall(1); coach.begin(); }
  refused.length = 0; cues.length = 0; events.length = 0;
  const live = (coach as unknown as { live: { ctx: { cs: string; others: string[] }; t0: number } | null }).live;
  if (!live) { run.issues.push('no live scene after begin'); return run; }
  const { cs, others } = live.ctx; const a0 = e.find(cs);
  if (refused.length) run.issues.push(`setup calls refused: ${refused.join(' | ')}`);
  if (!a0) run.issues.push(`${cs} not in the scene`);
  for (const o of others) if (!e.find(o)) run.issues.push(`traffic ${o} missing`);
  if (prev && a0 && prev.cs === cs) {
    const jump = Math.hypot(a0.pos.x - prev.x, a0.pos.y - prev.y);
    if (a0.phase === 'parked' && prev.phase !== 'parked') run.issues.push(`${cs} is back on its stand`);
    if (jump > 60) run.issues.push(`${cs} jumped ${Math.round(jump)} m from where the last mission left it (not continued)`);
  }
  const t0 = e.time; const said = new Set<string>();
  await new Promise((r) => setTimeout(r, 700));   // the map cues go out on the page's timers
  if (ch.cues && !cues.some((c) => c.kind === 'camera')) run.issues.push('no camera cue for the map');
  while (coach.state.stage !== 'done' && e.time - t0 < BUDGET_S) {
    const goal = coach.current(); const line = coach.phrase(goal);
    if (goal && line && !said.has(`${goal.id}|${line}`)) {
      said.add(`${goal.id}|${line}`);
      const r = sim.command(line);
      run.calls.push(`${line}${r.ok ? '' : ` -> REFUSED ${r.code} ${r.reason ?? ''}`}`);
      if (!r.ok) run.issues.push(`call refused: "${line}" (${r.code} ${r.reason ?? ''})`);
    }
    wall(0.5);
  }
  run.simS = Math.round(e.time - t0);
  if (coach.state.stage !== 'done') {
    const a = e.find(cs); const cur = coach.current();
    run.issues.push(`not finished after ${run.simS} s: waiting on "${cur?.title ?? '?'}" [${a ? `${a.phase} ${Math.round(a.speed)} kt ${a.holdShortRunway ?? ''} ${a.trafficHold ? 'held: ' + ((e as unknown as { sc(a: unknown): { holdReason: string | null } }).sc(a).holdReason ?? '') : ''}` : 'gone'}]`);
  }
  if (coach.fast) run.issues.push('fast-forward still on');
  for (const ev of events) {
    if (ev.type === 'ground_conflict') run.issues.push(`ground conflict: ${ev.message}`);
    if (ev.type === 'alert' && (ev.data as { alert?: { kind?: string } } | undefined)?.alert?.kind === 'runway_incursion') run.issues.push(`runway incursion: ${ev.message}`);
  }
  return run;
}
const report = (runs: Run[]) => console.log(runs.map((r) => `${r.issues.length ? 'FAIL' : ' ok '} ${r.id.padEnd(12)} ${r.how.padEnd(9)} ${String(r.simS).padStart(4)} s  ${r.calls.length} calls${r.issues.length ? '\n       - ' + r.issues.join('\n       - ') : ''}`).join('\n'));

const tabs = (process.env.TAB ? [process.env.TAB] : TABS.map((t) => t.id)) as Tab[];
for (const tab of tabs) {
  test(`${tab}: the whole track in one go, each mission carrying on from the last (${FPS} fps)`, async () => {
    await boot(tab);
    const runs: Run[] = []; let ch: Chapter | null = chaptersOf(tab)[0]; let prev: { cs: string; x: number; y: number; phase: string } | null = null;
    coach.open(ch.id);
    while (ch) {
      const r = await play(ch, runs.length ? 'continued' : 'first', prev); runs.push(r);
      const live = (coach as unknown as { live: { ctx: { cs: string } } | null }).live; const a = live ? sim.engine!.find(live.ctx.cs) : null;
      prev = a ? { cs: a.callsign, x: a.pos.x, y: a.pos.y, phase: a.phase } : null;
      ch = next(ch); if (ch) { coach.setTab(ch.tab); coach.open(ch.id); }
    }
    coach.dispose(); report(runs);
    assert.deepEqual(runs.filter((r) => r.issues.length).map((r) => r.id), [], 'missions with problems (see the report above)');
  });
  test(`${tab}: each mission opened on its own`, async () => {
    const runs: Run[] = [];
    for (const ch of chaptersOf(tab)) {
      if (ch.ui) continue;
      await boot(tab);   // a fresh session: nothing to carry on from, the mission builds its own scene
      coach.open(ch.id);
      runs.push(await play(ch, 'on its own', null));
    }
    coach.dispose(); report(runs);
    assert.deepEqual(runs.filter((r) => r.issues.length).map((r) => r.id), [], 'missions with problems (see the report above)');
  });
}
