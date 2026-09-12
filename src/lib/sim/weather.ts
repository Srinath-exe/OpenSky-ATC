// ============================================================
//  Weather / ATIS — CONTRACT STUB (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  Owns WeatherState + Atis (types.ts), the ATIS letter sequence, runway
//  suggestion from wind, wind components per runway end, and the wind vector
//  applied to airborne motion. Pure helpers at the bottom are IMPLEMENTED (they
//  are spec formulas) so the engine, pickers and tests share one arithmetic.
//
//  Master plan §2.2: "WeatherState (wind dir/kts/gust, vis, ceiling, QNH,
//  temp), ATIS letter + text, runway-in-use suggestion, wind applied to
//  airborne motion & takeoff/landing; change events."
// ============================================================
import type { RunwayEnd } from '../runwayManifest';
import type { WeightClass } from './aircraftDB';
import type { Atis, SimEvent, WeatherEvent, WeatherState } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Constants (03 §2.9, §2.12, §5, §8, §A12)
// ──────────────────────────────────────────────────────────────────────────────
export const WX = {
  /** ATIS regenerates when wind changes by >= 30 deg or >= 5 kt, QNH >= 1 hPa, vis category, runway config, closures, LVP. */
  atisWindDeltaDeg: 30,
  atisWindDeltaKt: 5,
  atisQnhDeltaHpa: 1,
  /** Hourly ATIS regeneration, s. */
  atisHourlyS: 3600,
  /** Runway selection: tailwind <= 5 kt preferred, <= 10 allowed, > 10 forbidden. */
  tailwindPreferKt: 5,
  tailwindMaxKt: 10,
  /** Crosswind limits (kt) incl. gust: jets 35 (prompt change > 25), turboprop 30, light 15. */
  crosswindPromptKt: 25,
  crosswindLimit: { L: 15, M: 35, H: 35, S: 35 } as const,
  /** Transition altitude / level (03 §5 QNH). */
  transitionAltFt: 6000,
  /** LVP when RVR/vis < 550 m or ceiling < 200 ft. */
  lvpVisM: 550,
  lvpCeilingFt: 200,
  /** Markov change interval, sim minutes [min,max]. */
  changeEveryMin: [20, 60] as const,
  /** Gust > 15 kt -> 5 % go-around per landing; windshear -> 25 %. */
  gustGaKt: 15,
} as const;

// ──────────────────────────────────────────────────────────────────────────────
//  Pure helpers (implemented)
// ──────────────────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

/** Head/cross wind components for a runway heading. head < 0 = tailwind; cross is absolute (side in `crossFrom`). */
export function windComponents(windDirTrue: number, windKt: number, runwayHdgTrue: number): { headKt: number; crossKt: number; crossFrom: 'L' | 'R' } {
  const rel = ((windDirTrue - runwayHdgTrue) + 540) % 360 - 180; // -180..180, + = wind from the right
  const head = Math.cos(rel * DEG) * windKt;
  const cross = Math.sin(rel * DEG) * windKt;
  return { headKt: round1(head), crossKt: round1(Math.abs(cross)), crossFrom: cross >= 0 ? 'R' : 'L' };
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Runway-end score for active-runway selection (03 §A12):
 *   headwind - 0.25|crosswind| - (tailwind > 5 ? 40 : 0) - (tailwind > 10 ? 1e6 : 0)
 *   + noisePref + calmPref (+50 when wind < 5 kt and end is the preferred calm config) + hysteresis (+20 current)
 */
export function runwayScore(windDirTrue: number, windKt: number, gustKt: number, end: RunwayEnd, opts: { current?: boolean; calmPreferred?: boolean; noisePref?: number } = {}): number {
  const w = Math.max(windKt, gustKt);
  const { headKt, crossKt } = windComponents(windDirTrue, w, end.hdg);
  const tail = -headKt;
  let s = headKt - 0.25 * crossKt - (tail > WX.tailwindPreferKt ? 40 : 0) - (tail > WX.tailwindMaxKt ? 1e6 : 0);
  s += opts.noisePref ?? 0;
  if (windKt < 5 && opts.calmPreferred) s += 50;
  if (opts.current) s += 20;
  return s;
}

/** Transition level (FL) from QNH with TA 5000/6000 practice (03 §5): >= 1013 -> 60/70, < 1013 -> 70, < 978 -> 75. */
export function transitionLevel(qnh: number): number {
  if (qnh < 978) return 75;
  if (qnh < 1013) return 70;
  return WX.transitionAltFt >= 6000 ? 70 : 60;
}

/** Next ATIS letter A..Z wrapping. */
export function nextAtisLetter(letter: string): string {
  const c = letter.toUpperCase().charCodeAt(0);
  return c >= 90 || c < 65 ? 'A' : String.fromCharCode(c + 1);
}

/** Is the change between two wind states large enough to regenerate ATIS? */
export function atisWindTrigger(prev: WeatherState, next: WeatherState): boolean {
  const dDir = Math.abs(((next.windDirTrue - prev.windDirTrue + 540) % 360) - 180);
  return dDir >= WX.atisWindDeltaDeg || Math.abs(next.windKt - prev.windKt) >= WX.atisWindDeltaKt || Math.abs(next.qnh - prev.qnh) >= WX.atisQnhDeltaHpa;
}

/** LVP predicate (03 §5). */
export function isLvp(w: WeatherState): boolean {
  return w.visM < WX.lvpVisM || (w.ceilingFt != null && w.ceilingFt < WX.lvpCeilingFt);
}

/** Default CAVOK state used before init() and by tests. */
export function defaultWeather(time = 0): WeatherState {
  return {
    windDirTrue: 270, windKt: 8, gustKt: 0, variableFrom: null, variableTo: null, visM: 10000, ceilingFt: null,
    cloud: 'CAVOK', qnh: 1013, tempC: 15, dewC: 9, precip: 'none', runwayCondition: 'dry', lvp: false,
    windshearAlert: null, updatedAt: time,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Model
// ──────────────────────────────────────────────────────────────────────────────
export interface WeatherInit {
  icao: string;
  /** Sim time at init. */
  time: number;
  /** Fixed initial state (home config / scenario) or null = randomise within the season. */
  initial: Partial<WeatherState> | null;
  /** Scripted events (scenario). */
  script: WeatherEvent[];
  /** Runway ends with headings (RUNWAY_MANIFEST[icao] flattened) for ATIS active-runway text and suggestions. */
  ends: RunwayEnd[];
  /** Currently active ends (from the start config) for the first ATIS. */
  activeDep: string[];
  activeArr: string[];
  airportName: string;
}

export interface WeatherStepResult {
  events: SimEvent[];
  /** True when the ATIS letter advanced this step. */
  atisChanged: boolean;
  /** Runway config suggestion when it differs from the active one (UX: HUD prompt), else null. */
  suggestion: { dep: string[]; arr: string[]; reason: string } | null;
}

/**
 * The weather model. One instance per session, owned by the engine.
 *
 *   init(cfg, rng)         -> state from cfg.initial or randomised (wind 0-359 /
 *                            3-25 kt, gusts 20 %, QNH 990-1030, vis, cloud, temp),
 *                            ATIS letter 'A' issued at cfg.time with full text.
 *   step(dt)               -> Markov evolution: every 20-60 sim minutes drift wind
 *                            +-30 deg / +-8 kt, QNH +-2; scripted events fire at
 *                            their `atMin`; regenerates ATIS on the triggers in WX
 *                            (letter advances, `atis` event with reason); hourly
 *                            regeneration; updates lvp; expires windshear alerts.
 *   state()                -> current WeatherState (JSON).
 *   atis()                 -> current Atis (JSON).
 *   regenerateAtis(reason, activeDep, activeArr, remarks) -> forced regeneration
 *                            (runway change, closure, reopen); returns the new Atis.
 *   suggestRunways(ends)   -> best dep/arr ends by runwayScore (parallel pairs
 *                            kept together; one physical runway both roles when
 *                            only one exists), with hysteresis for the current config.
 *   applyWindToGroundSpeed(hdgTrue, tasKt) -> { gsKt, trackTrue } for airborne
 *                            motion: engine moves the aircraft along `trackTrue`
 *                            at `gsKt` instead of heading/TAS. Ground speed on the
 *                            ground is NOT wind-affected (UX §G5.4).
 *   crosswindGoAroundP(weightClass, rwyHdg) / gustGoAroundP() -> pilot go-around
 *                            probabilities at 1000 ft (03 §D4).
 *   setWind(dir, kts, gust) -> test hook (forces an immediate ATIS check).
 */
export class WeatherModel {
  private wx: WeatherState = defaultWeather();
  private current: Atis | null = null;

  init(cfg: WeatherInit, rng: () => number): void {
    void cfg; void rng;
    throw new Error('not implemented');
  }

  step(dt: number): WeatherStepResult {
    void dt;
    throw new Error('not implemented');
  }

  state(): WeatherState { return this.wx; }

  atis(): Atis {
    if (!this.current) throw new Error('WeatherModel not initialised');
    return this.current;
  }

  regenerateAtis(reason: string, activeDep: string[], activeArr: string[], remarks: string[] = []): Atis {
    void reason; void activeDep; void activeArr; void remarks;
    throw new Error('not implemented');
  }

  suggestRunways(ends: RunwayEnd[], current: { dep: string[]; arr: string[] }): { dep: string[]; arr: string[]; reason: string } {
    void ends; void current;
    throw new Error('not implemented');
  }

  applyWindToGroundSpeed(hdgTrue: number, tasKt: number): { gsKt: number; trackTrue: number } {
    return applyWind(this.wx, hdgTrue, tasKt);
  }

  /** Wind components for a runway end using the CURRENT (gust-inclusive when gusting) wind. */
  componentsFor(runwayHdgTrue: number): { headKt: number; crossKt: number; crossFrom: 'L' | 'R' } {
    return windComponents(this.wx.windDirTrue, Math.max(this.wx.windKt, this.wx.gustKt), runwayHdgTrue);
  }

  /** Pilot go-around probability at 1000 ft from the crosswind on `runwayHdgTrue` vs the class limit (03 §D4); 0 when within limits. */
  crosswindGoAroundP(weightClass: WeightClass, runwayHdgTrue: number): number {
    void weightClass; void runwayHdgTrue;
    throw new Error('not implemented');
  }

  /** Pilot go-around probability at 1000 ft from gusts (03 §D4); 0 when not gusting. */
  gustGoAroundP(): number {
    throw new Error('not implemented');
  }

  setWind(dirTrue: number, kts: number, gust = 0): void {
    void dirTrue; void kts; void gust;
    throw new Error('not implemented');
  }

  /** Queue a scripted event relative to now (test / scenario hook). */
  scheduleEvent(ev: WeatherEvent): void {
    void ev;
    throw new Error('not implemented');
  }
}

/** Pure wind-triangle: returns ground speed and track for a heading/TAS in the given wind (implemented). */
export function applyWind(w: WeatherState, hdgTrue: number, tasKt: number): { gsKt: number; trackTrue: number } {
  // wind FROM windDirTrue -> wind vector blows TOWARD windDirTrue + 180
  const toward = (w.windDirTrue + 180) * DEG;
  const wx = Math.sin(toward) * w.windKt, wy = Math.cos(toward) * w.windKt;
  const ax = Math.sin(hdgTrue * DEG) * tasKt, ay = Math.cos(hdgTrue * DEG) * tasKt;
  const gx = ax + wx, gy = ay + wy;
  const gs = Math.hypot(gx, gy);
  const track = gs < 1e-6 ? hdgTrue : (Math.atan2(gx, gy) / DEG + 360) % 360;
  return { gsKt: gs, trackTrue: track };
}
