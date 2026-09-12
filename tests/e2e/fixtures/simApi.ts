/*
  SimApi — typed, page-side wrapper around `window.__atcTest` (src/lib/sim/testApi.ts).

  Every method is a thin `page.evaluate` that calls the matching test-API member by name and
  returns its plain-JSON result. Time-advancing calls flush React afterwards (rAF + setTimeout)
  so DOM assertions made right after `await sim.advance(n)` see the new state
  (05-TEST-STRATEGY §2.2 implementation notes / §2.3).

  Predicates for `advanceUntil` are passed as SOURCE STRINGS (they run inside the page):
      await sim.advanceUntil("s => s.aircraft.find(a => a.callsign === 'BAW1')?.phase === 'climb'", 120)
*/
import { expect, type Page } from '@playwright/test';
import type {
  AtcTestApi, AircraftView, Snapshot, SpawnSpec, RadioLine, FeatureFlag, CameraView, RelPos,
} from '@/lib/sim/testApi';
import type {
  AircraftState, Alert, Atis, EmergencyType, FlightPhase, PilotRequestKind, RunwayState, RunwayStatus, SimEvent, Stage, Vehicle, WeatherState,
} from '@/lib/sim/types';
import type { CommandAST, CommandResult } from '@/lib/sim/commandAst';
import type { ActionRow } from '@/lib/sim/commandTree';
import type { WeightClass } from '@/lib/sim/aircraftDB';
import type { Settings, StartConfig } from '@/components/atc/simStore';
import type { EngineSettings } from '@/lib/sim/engine';

export type { AtcTestApi, AircraftView, Snapshot, SpawnSpec, RadioLine, FeatureFlag, CameraView, RelPos, SimEvent, FlightPhase, Stage };

export type PlayerPosition = 'ground' | 'tower' | 'approach';
export interface AdvanceUntilResult { ok: boolean; elapsed: number; events: SimEvent[] }
/** Plain-JSON view of the store singleton (`window.__atcSim`) — available in live mode too (no `?test=1` needed). */
export interface StoreState {
  hasEngine: boolean; loading: boolean; testMode: boolean; icao: string; seed: number; position: PlayerPosition; rate: number; paused: boolean;
  highScore: number; autoSpawn: boolean; time: number | null; settings: Settings; lastConfig: StartConfig | null;
  /** Per-end runway rows straight from the engine (null without an engine). */
  runways: RunwayRow[] | null;
}
export interface RunwayRow { name: string; hdg: number; active: boolean; occupied: boolean; weights: WeightClass[] | null }
export interface ScreenPoint { x: number; y: number }

type ApiMethod = keyof AtcTestApi;

export class SimApi {
  constructor(readonly page: Page) {}

  // ── plumbing ──────────────────────────────────────────────────────────────
  /** Call `window.__atcTest[name](...args)` in the page and return the JSON result. */
  call<T = unknown>(name: ApiMethod, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(([n, a]) => {
      const api = (window as unknown as { __atcTest?: Record<string, (...x: unknown[]) => unknown> }).__atcTest;
      if (!api) throw new Error('window.__atcTest is not installed (open the game with ?test=1 and wait for ready())');
      const fn = api[n as string];
      if (typeof fn !== 'function') throw new Error(`__atcTest.${String(n)} is not a function`);
      return fn.apply(api, a as unknown[]);
    }, [name, args] as const) as Promise<T>;
  }

  /** Let React commit + paint after a synchronous store mutation (rAF, then a macrotask). */
  flush(): Promise<void> {
    return this.page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    }));
  }

  /** True once the test API is installed and the engine is loaded. */
  isReady(): Promise<boolean> {
    return this.page.evaluate(() => {
      const api = (window as unknown as { __atcTest?: { ready(): boolean } }).__atcTest;
      try { return !!api && api.ready() === true; } catch { return false; }
    });
  }

  /** Wait for `__atcTest.ready()` (engine loaded, not loading). */
  async waitReady(timeout = 60_000): Promise<void> {
    await this.page.waitForFunction(() => {
      const api = (window as unknown as { __atcTest?: { ready(): boolean } }).__atcTest;
      try { return !!api && api.ready() === true; } catch { return false; }
    }, null, { timeout });
    await this.flush();
  }

  /** Wait for the MapLibre ground map `load` (only meaningful on GROUND / TOWER). */
  async waitMapReady(timeout = 60_000): Promise<void> {
    await this.page.waitForFunction(() => {
      const api = (window as unknown as { __atcTest?: { mapReady(): boolean } }).__atcTest;
      try { return !!api && api.mapReady() === true; } catch { return false; }
    }, null, { timeout });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  ready() { return this.call<boolean>('ready'); }
  mapReady() { return this.call<boolean>('mapReady'); }
  features() { return this.call<Record<FeatureFlag, boolean>>('features'); }
  async hasFeature(flag: FeatureFlag): Promise<boolean> { return !!(await this.features())[flag]; }
  /** Re-load the airport deterministically (same page, new engine). Waits for ready. */
  async reset(opts: { icao?: string; seed?: number; spawn?: 'none' | 'default' } = {}): Promise<void> {
    await this.call<void>('reset', opts);
    await this.waitReady();
  }
  seed(n: number) { return this.call<void>('seed', n); }

  // ── time ──────────────────────────────────────────────────────────────────
  /** Advance the sim by N sim-seconds (synchronous stepping in the page), then flush React. Returns the events. */
  async advance(simSeconds: number): Promise<SimEvent[]> {
    const ev = await this.call<SimEvent[]>('advance', simSeconds);
    await this.flush();
    return ev;
  }
  /**
   * Step until `predSrc` (a JS arrow-function source taking the Snapshot) returns true, at most `maxSimSeconds`.
   * `stepS` is the chunk size between predicate checks (default 1 sim-s).
   */
  async advanceUntil(predSrc: string, maxSimSeconds: number, stepS = 1): Promise<AdvanceUntilResult> {
    const r = await this.page.evaluate(([src, max, step]) => {
      const api = (window as unknown as { __atcTest?: AtcTestApi }).__atcTest;
      if (!api) throw new Error('window.__atcTest is not installed');
      const pred = new Function('s', `return (${src})(s)`) as (s: Snapshot) => boolean;
      return api.advanceUntil(pred, max, step);
    }, [predSrc, maxSimSeconds, stepS] as const);
    await this.flush();
    return r;
  }
  /** advanceUntil + assert it succeeded; returns the elapsed sim-seconds. */
  async advanceUntilOk(predSrc: string, maxSimSeconds: number, stepS = 1): Promise<number> {
    const r = await this.advanceUntil(predSrc, maxSimSeconds, stepS);
    expect(r.ok, `advanceUntil timed out after ${r.elapsed}s: ${predSrc}`).toBe(true);
    return r.elapsed;
  }
  /** Convenience: advance until `callsign` reaches `phase`. */
  advanceUntilPhase(callsign: string, phase: FlightPhase, maxSimSeconds: number) {
    return this.advanceUntilOk(`s => s.aircraft.find(a => a.callsign === ${JSON.stringify(callsign)})?.phase === ${JSON.stringify(phase)}`, maxSimSeconds);
  }
  /** Advance real seconds through the rate (rate tests only), then flush. */
  async advanceReal(realSeconds: number): Promise<SimEvent[]> {
    const ev = await this.call<SimEvent[]>('advanceReal', realSeconds);
    await this.flush();
    return ev;
  }
  lastStepDt() { return this.call<number>('lastStepDt'); }
  time() { return this.call<number>('time'); }

  // ── read state ────────────────────────────────────────────────────────────
  snapshot() { return this.call<Snapshot>('snapshot'); }
  aircraft(cs: string) { return this.call<AircraftView | null>('aircraft', cs); }
  /** aircraft() that fails the test when the callsign is unknown. */
  async aircraftOrFail(cs: string): Promise<AircraftView> {
    const a = await this.aircraft(cs);
    expect(a, `aircraft ${cs} not in the sim`).not.toBeNull();
    return a as AircraftView;
  }
  async callsigns(): Promise<string[]> { return (await this.snapshot()).aircraft.map((a) => a.callsign); }
  radio() { return this.call<RadioLine[]>('radio'); }
  async lastRadio(who?: RadioLine['who']): Promise<RadioLine | null> {
    const lines = await this.radio();
    for (let i = lines.length - 1; i >= 0; i--) if (!who || lines[i].who === who) return lines[i];
    return null;
  }
  events() { return this.call<SimEvent[]>('events'); }
  clearEvents() { return this.call<void>('clearEvents'); }
  runways() { return this.call<RunwayRow[]>('runways'); }
  beacons() { return this.call<string[]>('beacons'); }
  gates() { return this.call<string[]>('gates'); }
  taxiways() { return this.call<string[]>('taxiways'); }
  state(cs: string) { return this.call<AircraftState | null>('state', cs); }
  stage(cs: string) { return this.call<Stage | null>('stage', cs); }
  actions(cs: string) { return this.call<ActionRow[]>('actions', cs); }
  alerts() { return this.call<Alert[]>('alerts'); }
  vehicles() { return this.call<Vehicle[]>('vehicles'); }
  runwayStates() { return this.call<RunwayState[]>('runwayStates'); }
  atis() { return this.call<{ letter: string; wind: { dir: number; kts: number }; activeRunways: string[]; issuedAt: number }>('atis'); }
  wakeTimers() { return this.call<Record<string, { runway: string; leader: string; remainingS: number }>>('wakeTimers'); }
  stca() { return this.call<{ pairs: [string, string][]; active: boolean }>('stca'); }
  arff() { return this.call<{ vehicles: Array<{ id: string; pos: { x: number; y: number }; state: string; target?: string }> }>('arff'); }
  /** One fleet vehicle by id ('FIRE1', 'AMB1', 'OPS1' ...), null when unknown. */
  async vehicle(id: string): Promise<Vehicle | null> { return (await this.vehicles()).find((v) => v.id === id) ?? null; }
  /** CSS px of a vehicle inside the active canvas (`screenPosOf(v.pos)`), null when the vehicle is unknown. */
  async vehicleScreenPos(id: string): Promise<ScreenPoint | null> {
    const v = await this.vehicle(id);
    return v ? this.screenPosOf(v.pos) : null;
  }
  /** One alert by id from the engine's full list (resolved ones included), null when unknown. */
  async alertById(id: string): Promise<Alert | null> { return (await this.alerts()).find((a) => a.id === id) ?? null; }
  /** Active (unresolved) alerts. */
  async activeAlerts(): Promise<Alert[]> { return (await this.alerts()).filter((a) => a.resolvedAt == null); }
  /** Score ledger entries seen in the event ring buffer since the last clearEvents(). */
  async scoreEvents(): Promise<Array<{ at: number; code: string; points: number; primary: string; detail: string }>> {
    const evs = await this.events();
    const out: Array<{ at: number; code: string; points: number; primary: string; detail: string }> = [];
    for (const e of evs) {
      const d = e.data as { type?: string; score?: { code: string; points: number; primary: string; detail: string } } | undefined;
      if (e.type === 'score' && d?.type === 'score' && d.score) out.push({ at: e.at, code: d.score.code, points: d.score.points, primary: d.score.primary, detail: d.score.detail });
    }
    return out;
  }

  // ── write state ───────────────────────────────────────────────────────────
  /** Deterministic aircraft factory; flushes React so the strip exists when this resolves. */
  async spawnAt(spec: SpawnSpec): Promise<AircraftView> {
    const v = await this.call<AircraftView>('spawnAt', spec);
    await this.flush();
    return v;
  }
  async setState(cs: string, patch: Partial<AircraftState & { posLL?: { lat: number; lng: number }; posRel?: RelPos }>): Promise<AircraftView> {
    const v = await this.call<AircraftView>('setState', cs, patch);
    await this.flush();
    return v;
  }
  async remove(cs: string) { await this.call<void>('remove', cs); await this.flush(); }
  async clear() { await this.call<void>('clear'); await this.flush(); }
  async setAutoSpawn(on: boolean) { await this.call<void>('setAutoSpawn', on); await this.flush(); }
  async setAutoTower(on: boolean) { await this.call<void>('setAutoTower', on); await this.flush(); }
  async setScore(n: number) { await this.call<void>('setScore', n); await this.flush(); }
  async setSkill(n: number) { await this.call<void>('setSkill', n); await this.flush(); }
  async setPilotDelay(s: number) { await this.call<void>('setPilotDelay', s); await this.flush(); }
  async setWeather(w: Partial<WeatherState>) { await this.call<void>('setWeather', w); await this.flush(); }
  async setWind(dirDeg: number, kts: number, gustKts?: number) { await this.call<void>('setWind', dirDeg, kts, gustKts); await this.flush(); }
  async setActiveRunways(ends: string[]) { await this.call<void>('setActiveRunways', ends); await this.flush(); }
  async setRunwayStatus(runway: string, status: RunwayStatus) { await this.call<void>('setRunwayStatus', runway, status); await this.flush(); }
  async forceEmergency(cs: string, kind: EmergencyType) { await this.call<void>('forceEmergency', cs, kind); await this.flush(); }
  async request(cs: string, kind: PilotRequestKind, param?: string | number) { await this.call<void>('request', cs, kind, param); await this.flush(); }
  ackAlert(id: string) { return this.call<boolean>('ackAlert', id); }
  /** Text command through the store (same path as the comm-log input, minus the DOM). Prefer `game.send()` in specs. */
  async command(text: string): Promise<CommandResult> {
    const r = await this.call<CommandResult>('command', text);
    await this.flush();
    return r;
  }
  async dispatchAst(ast: CommandAST): Promise<CommandResult> {
    const r = await this.call<CommandResult>('dispatchAst', ast);
    await this.flush();
    return r;
  }
  async setPosition(p: PlayerPosition) { await this.call<void>('setPosition', p); await this.flush(); }
  /** Select an aircraft (or null) exactly as a click would. */
  async select(cs: string | null) { await this.call<void>('select', cs); await this.flush(); }

  // ── geometry for canvas hit-testing ───────────────────────────────────────
  /** CSS px relative to the ACTIVE canvas element (radar-canvas on APPROACH, ground-map otherwise); null when off-view. */
  screenPos(cs: string) { return this.call<ScreenPoint | null>('screenPos', cs); }
  screenPosOf(xy: { x: number; y: number }) { return this.call<ScreenPoint>('screenPosOf', xy); }
  /** A point on the active canvas far from every aircraft / vehicle and not under floating chrome. */
  emptySpot() { return this.call<ScreenPoint>('emptySpot'); }
  camera() { return this.call<CameraView>('camera'); }
  async centerOn(cs: string) { await this.call<void>('centerOn', cs); await this.flush(); }
  async setCamera(cam: CameraView) { await this.call<void>('setCamera', cam); await this.flush(); }

  // ── store-level reads (window.__atcSim; independent of the test API, so they work on live boots too) ──
  /** Snapshot of the store singleton: settings, seed, position, lastConfig, high score, engine runways. */
  storeState(): Promise<StoreState> {
    return this.page.evaluate(() => {
      type RS = { name: string; headingMag: number; activeDep: boolean; activeArr: boolean; occupiedBy: unknown[]; weightAllow: WeightClass[] | null };
      type Store = {
        engine: { time: number; runways: RS[] } | null; loading: boolean; testMode: boolean; icao: string; seed: number; position: PlayerPosition;
        rate: number; paused: boolean; highScore: number; autoSpawn: boolean; settings: Settings; lastConfig: StartConfig | null;
      };
      const s = (window as unknown as { __atcSim?: Store }).__atcSim;
      if (!s) throw new Error('window.__atcSim is not installed (no store on this page)');
      return {
        hasEngine: !!s.engine, loading: s.loading, testMode: s.testMode, icao: s.icao, seed: s.seed, position: s.position, rate: s.rate, paused: s.paused,
        highScore: s.highScore, autoSpawn: s.autoSpawn, time: s.engine ? s.engine.time : null, settings: { ...s.settings },
        lastConfig: s.lastConfig ? { ...s.lastConfig } : null,
        runways: s.engine ? s.engine.runways.map((r) => ({ name: r.name, hdg: Math.round(r.headingMag), active: r.activeDep || r.activeArr, occupied: r.occupiedBy.length > 0, weights: r.weightAllow })) : null,
      };
    });
  }
  /** The store's persisted `Settings` blob as the live store holds it (`sim.settings`). */
  async storeSettings(): Promise<Settings> { return (await this.storeState()).settings; }
  /** `engine.settings` of the live engine (what the store applied through `applySettingsToEngine`). */
  engineSettings(): Promise<EngineSettings> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __atcSim?: { engine: { settings: EngineSettings } | null } }).__atcSim;
      if (!s?.engine) throw new Error('no live engine on window.__atcSim');
      return { ...s.engine.settings };
    });
  }
  /** True when a store singleton with a live engine exists on this window (home / settings "resume" state). */
  hasLiveEngine(): Promise<boolean> {
    return this.page.evaluate(() => !!(window as unknown as { __atcSim?: { engine: unknown } }).__atcSim?.engine);
  }
  /** The full ATIS broadcast the store renders (`sim.atis()`: letter, wind, qnh, activeDep / activeArr, text ...), null when none. */
  storeAtis(): Promise<Atis | null> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __atcSim?: { atis(): Atis | null } }).__atcSim;
      if (!s) throw new Error('window.__atcSim is not installed (no store on this page)');
      const a = s.atis();
      return a ? { ...a } : null;
    });
  }
  /** The live weather state the store renders (`sim.weather()`: windDirTrue, windKt, gustKt, qnh, visM, cloud ...), null without an engine. */
  storeWeather(): Promise<WeatherState | null> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __atcSim?: { weather(): WeatherState | null } }).__atcSim;
      if (!s) throw new Error('window.__atcSim is not installed (no store on this page)');
      const w = s.weather();
      return w ? { ...w } : null;
    });
  }
  /** Store-side view state that the test API does not expose: hovered / selected ids, lastCallsign, comm-log length. */
  storeView(): Promise<{ hoveredId: number | null; selectedId: number | null; lastCallsign: string | null; radioCount: number }> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __atcSim?: { hoveredId: number | null; selectedId: number | null; lastCallsign: string | null; radio: unknown[] } }).__atcSim;
      if (!s) throw new Error('window.__atcSim is not installed (no store on this page)');
      return { hoveredId: s.hoveredId, selectedId: s.selectedId, lastCallsign: s.lastCallsign, radioCount: s.radio.length };
    });
  }
}

/** `expect(await sim.aircraft(cs)).phase` shortcut. */
export async function expectPhase(sim: SimApi, cs: string, phase: FlightPhase): Promise<void> {
  const a = await sim.aircraft(cs);
  expect(a, `aircraft ${cs} not in the sim`).not.toBeNull();
  expect(a!.phase).toBe(phase);
}
