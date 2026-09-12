// ============================================================
//  Weather / ATIS (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  Owns WeatherState + Atis (types.ts), the ATIS letter sequence, runway
//  suggestion from wind, wind components per runway end, and the wind vector
//  applied to airborne motion. Pure helpers at the bottom are spec formulas so
//  the engine, pickers and tests share one arithmetic.
//
//  Master plan §2.2: "WeatherState (wind dir/kts/gust, vis, ceiling, QNH,
//  temp), ATIS letter + text, runway-in-use suggestion, wind applied to
//  airborne motion & takeoff/landing; change events."
//
//  Evolution model (03 §5, §2.12, §A12):
//    - continuous random walk: wind direction +-1 deg/min, speed +-0.5 kt/min,
//      QNH drift ~0.5 hPa/h, temperature follows a gentle diurnal slope;
//    - Markov "change" every 20-60 sim minutes (shift +-30 deg / +-8 kt, QNH
//      +-2, gust factor, visibility / ceiling band);
//    - rare frontal passage: wind veers/backs 40-120 deg over ~10 minutes with
//      a speed bump, then settles (runway-change trigger);
//    - scripted scenario events (wind_shift, gust_front, fog, snow_shower,
//      thunderstorm, clearing) at `atMin` relative to init;
//    - ATIS regenerates on: wind >= 30 deg / >= 5 kt vs the broadcast wind,
//      QNH >= 1 hPa, visibility / ceiling band change, runway change, LVP
//      on/off, hourly. Letter advances A..Z wrapping.
//  All randomness comes from the rng passed to init() (rng.ts subStream).
// ============================================================
import type { RunwayEnd as ManifestRunwayEnd } from '../runwayManifest';

/** What the weather model needs of a runway end: the manifest's RunwayEnd satisfies it; tests may pass `{ name, hdg }`. */
export type RunwayEnd = Pick<ManifestRunwayEnd, 'name' | 'hdg'> & Partial<ManifestRunwayEnd>;
import type { WeightClass } from './aircraftDB';
import type { Atis, Precip, RunwaySurface, SimEvent, WeatherEvent, WeatherState } from './types';

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
  /** Random-walk rates (03 task brief): +-1 deg/min direction, +-0.5 kt/min speed. */
  walkDirDegPerMin: 1,
  walkSpeedKtPerMin: 0.5,
  /** Frontal passage: probability per sim hour, shift 40-120 deg over ~10 min. */
  frontPerHour: 0.12,
  frontShiftDeg: [40, 120] as const,
  frontDurationS: 600,
  /** Pilot go-around probabilities at 1000 ft (03 §D4). */
  gaGustP: 0.05,
  gaWindshearP: 0.25,
  gaMicroburstP: 0.8,
  gaCrosswindOverP: 0.8,
  gaCrosswindOver5P: 1.0,
  /** Windshear alert expiry, s (5-15 min). */
  windshearExpiryS: [300, 900] as const,
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

/** Visibility band (ATIS / LVP category boundaries): 0 = < 550 m, 1 = < 1500, 2 = < 3000 (< 2 SM), 3 = < 5000, 4 = < 8000, 5 = >= 8 km/10 km+. */
export function visBand(visM: number): number {
  if (visM < 550) return 0;
  if (visM < 1500) return 1;
  if (visM < 3000) return 2;
  if (visM < 5000) return 3;
  if (visM < 8000) return 4;
  return 5;
}
/** Ceiling band: 0 = < 200 ft, 1 = < 500, 2 = < 1000, 3 = < 1500 (visual approach floor), 4 = < 3000, 5 = higher/none. */
export function ceilingBand(ceilingFt: number | null): number {
  if (ceilingFt == null) return 5;
  if (ceilingFt < 200) return 0;
  if (ceilingFt < 500) return 1;
  if (ceilingFt < 1000) return 2;
  if (ceilingFt < 1500) return 3;
  if (ceilingFt < 3000) return 4;
  return 5;
}

/** Spoken/ATIS visibility text: metres below 5 km, kilometres above ("10 kilometres or more" at 10 km+). */
export function visibilityText(visM: number): string {
  if (visM >= 10000) return '10 kilometres or more';
  if (visM >= 5000) return `${Math.round(visM / 1000)} kilometres`;
  return `${Math.round(visM / 50) * 50} metres`;
}

/** Cloud string ("FEW020 SCT035") -> ATIS words ("few 2000 feet, scattered 3500 feet"). */
export function cloudText(cloud: string, ceilingFt: number | null): string {
  if (!cloud || cloud === 'CAVOK') return 'CAVOK';
  if (cloud === 'NSC' || cloud === 'SKC' || cloud === 'CLR') return 'no significant cloud';
  const words: Record<string, string> = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast', VV: 'vertical visibility' };
  const parts = cloud.split(/\s+/).map(layer => {
    const m = layer.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    if (!m) return layer.toLowerCase();
    const ft = parseInt(m[2], 10) * 100;
    return `${words[m[1]]} ${ft} feet${m[3] === 'CB' ? ' cumulonimbus' : m[3] === 'TCU' ? ' towering cumulus' : ''}`;
  });
  const txt = parts.join(', ');
  return ceilingFt != null && !/broken|overcast|vertical/.test(txt) ? `${txt}, ceiling ${ceilingFt} feet` : txt;
}

function precipText(p: Precip, tempC: number): string {
  switch (p) {
    case 'none': return '';
    case 'drizzle': return tempC <= 0 ? 'freezing drizzle' : 'light drizzle';
    case 'rain': return 'rain';
    case 'snow': return 'snow';
    case 'freezing': return 'freezing rain';
  }
}

/** Surface condition implied by precipitation and temperature (03 §5). */
export function surfaceFor(precip: Precip, tempC: number): RunwaySurface {
  if (precip === 'none') return 'dry';
  if (precip === 'snow' || precip === 'freezing' || (precip === 'drizzle' && tempC <= 0)) return 'contaminated';
  return 'wet';
}

const norm360 = (d: number) => ((Math.round(d) % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const signedDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

/** Runway number (01-36) of an end name; used to pair reciprocal/parallel ends. */
function rwyNumber(name: string): number { return parseInt(name.replace(/[^0-9]/g, ''), 10) || 0; }
function rwySide(name: string): string { return name.replace(/[0-9]/g, ''); }
/** Reciprocal end name: 27L -> 09R. */
export function reciprocalName(name: string): string {
  const n = rwyNumber(name);
  const r = ((n + 18 - 1) % 36) + 1;
  const side = rwySide(name);
  const rside = side === 'L' ? 'R' : side === 'R' ? 'L' : side;
  return `${String(r).padStart(2, '0')}${rside}`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Regional climatology (plausible initial states by ICAO prefix)
// ──────────────────────────────────────────────────────────────────────────────
interface Climate { windMean: number; windSpread: number; windKt: [number, number]; temp: [number, number]; dewDepression: [number, number]; qnh: [number, number]; wetP: number; fogP: number; snowP: number }
const CLIMATE: Array<{ prefix: RegExp; c: Climate }> = [
  { prefix: /^EG/, c: { windMean: 240, windSpread: 60, windKt: [5, 22], temp: [4, 22], dewDepression: [1, 7], qnh: [995, 1030], wetP: 0.3, fogP: 0.06, snowP: 0.03 } },
  { prefix: /^(ED|EH|EB|LF|LS|LO|EK|ES|EN|EI)/, c: { windMean: 230, windSpread: 70, windKt: [4, 20], temp: [0, 26], dewDepression: [1, 8], qnh: [995, 1032], wetP: 0.28, fogP: 0.06, snowP: 0.06 } },
  { prefix: /^(LE|LI|LP|LG|LT)/, c: { windMean: 250, windSpread: 90, windKt: [3, 18], temp: [8, 32], dewDepression: [3, 14], qnh: [1005, 1028], wetP: 0.12, fogP: 0.03, snowP: 0.01 } },
  { prefix: /^KSFO|^KLAX|^KSAN|^KSEA|^KPDX/, c: { windMean: 280, windSpread: 40, windKt: [5, 20], temp: [9, 26], dewDepression: [2, 12], qnh: [1008, 1026], wetP: 0.12, fogP: 0.08, snowP: 0 } },
  { prefix: /^K/, c: { windMean: 250, windSpread: 100, windKt: [3, 20], temp: [-2, 32], dewDepression: [2, 14], qnh: [1000, 1032], wetP: 0.2, fogP: 0.04, snowP: 0.05 } },
  { prefix: /^C/, c: { windMean: 260, windSpread: 90, windKt: [4, 20], temp: [-15, 26], dewDepression: [1, 10], qnh: [995, 1035], wetP: 0.2, fogP: 0.04, snowP: 0.2 } },
  { prefix: /^(VI|VA|VO|VE)/, c: { windMean: 290, windSpread: 80, windKt: [2, 14], temp: [18, 40], dewDepression: [4, 22], qnh: [1000, 1018], wetP: 0.1, fogP: 0.1, snowP: 0 } },
  { prefix: /^(OM|OE|OT|OB|OK)/, c: { windMean: 330, windSpread: 60, windKt: [4, 18], temp: [22, 44], dewDepression: [8, 28], qnh: [1002, 1020], wetP: 0.02, fogP: 0.04, snowP: 0 } },
  { prefix: /^(RJ|RK|Z|VH|WS|WM|VT|RP)/, c: { windMean: 150, windSpread: 120, windKt: [3, 18], temp: [10, 34], dewDepression: [1, 10], qnh: [1002, 1026], wetP: 0.3, fogP: 0.03, snowP: 0.02 } },
  { prefix: /^(Y|NZ|FA|SA|SB|SC|MM)/, c: { windMean: 200, windSpread: 120, windKt: [4, 20], temp: [8, 32], dewDepression: [2, 12], qnh: [1000, 1028], wetP: 0.18, fogP: 0.03, snowP: 0.01 } },
];
function climateFor(icao: string): Climate {
  const u = icao.toUpperCase();
  for (const { prefix, c } of CLIMATE) if (prefix.test(u)) return c;
  return CLIMATE[CLIMATE.length - 1].c;
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
  /** Optional: magnetic variation (deg, east positive) so ATIS winds are broadcast magnetic. Default 0. */
  magVar?: number;
  /** Optional: Zulu minutes past midnight at sim t = 0 for the ATIS time group. Default 600 (10:00Z). */
  startZuluMin?: number;
  /** Optional: initial ATIS letter (scenario `startState.atisLetter`). Default 'A'. */
  atisLetter?: string;
  /** Optional: preferred calm-wind dep/arr ends (03 §2.9 `preferredCalmConfig`). */
  calmPreferred?: { dep: string[]; arr: string[] } | null;
}

export interface WeatherStepResult {
  events: SimEvent[];
  /** True when the ATIS letter advanced this step. */
  atisChanged: boolean;
  /** Runway config suggestion when it differs from the active one (UX: HUD prompt), else null. */
  suggestion: { dep: string[]; arr: string[]; reason: string } | null;
}

/** Fine-grained change record since the last drain (`changes()` / `events()`), for HUD toasts and tests. */
export type WeatherChangeKind = 'wind_shift' | 'atis_update' | 'runway_suggestion' | 'vis_change' | 'qnh_change' | 'windshear' | 'lvp' | 'front' | 'gust_front' | 'precip';
export interface WeatherChange { kind: WeatherChangeKind; at: number; detail: string; params: Record<string, number | string | boolean | null> }

export interface RunwaySuggestion { dep: string[]; arr: string[]; changed: boolean; reason: string }

interface Front { targetDir: number; startDir: number; startedAt: number; durationS: number; speedBump: number }

/**
 * The weather model. One instance per session, owned by the engine.
 *
 *   init(cfg, rng)         -> state from cfg.initial or randomised for the airport's
 *                            climate (wind bias, temp, QNH, visibility, cloud), ATIS
 *                            letter issued at cfg.time with the full ICAO-order text.
 *   step(dt)               -> random walk + Markov changes + fronts + scripted events;
 *                            regenerates ATIS on the WX triggers (letter advances, `atis`
 *                            event with reason); hourly regeneration; updates lvp and the
 *                            surface condition; expires windshear alerts; re-evaluates the
 *                            runway suggestion on every wind trigger (03 §A12).
 *   state()                -> current WeatherState (JSON).
 *   atis()                 -> current Atis (JSON).
 *   regenerateAtis(reason, activeDep, activeArr, remarks) -> forced regeneration
 *                            (runway change, closure, reopen); returns the new Atis.
 *   suggestRunways(ends, current) -> best dep/arr ends by runwayScore (parallel pairs
 *                            kept together; one physical runway both roles when only one
 *                            exists), with hysteresis: no change is suggested while the
 *                            current config has <= 5 kt tailwind and <= 25 kt crosswind.
 *   applyWindToGroundSpeed(hdgTrue, tasKt) -> { gsKt, trackTrue } for airborne motion.
 *   crosswindGoAroundP / gustGoAroundP -> pilot go-around probabilities at 1000 ft (03 §D4).
 *   setWind / setState / scheduleEvent / changes() -> test + scenario hooks.
 */
export class WeatherModel {
  private wx: WeatherState = defaultWeather();
  private current: Atis | null = null;
  private rng: () => number = () => 0.5;
  private cfg: WeatherInit | null = null;
  private time = 0;
  private initTime = 0;
  private nextChangeAt = 0;
  private lastAtisCheckAt = 0;
  private front: Front | null = null;
  private script: Array<WeatherEvent & { fired: boolean }> = [];
  private pending: SimEvent[] = [];
  private changeLog: WeatherChange[] = [];
  private activeDep: string[] = [];
  private activeArr: string[] = [];
  private remarks: string[] = [];
  private lastSuggestionKey = '';
  private walkAcc = 0;
  private tempBase = 15;

  init(cfg: WeatherInit, rng: () => number): void {
    this.cfg = cfg;
    this.rng = rng;
    this.time = cfg.time;
    this.initTime = cfg.time;
    this.activeDep = [...cfg.activeDep];
    this.activeArr = [...cfg.activeArr];
    this.remarks = [];
    this.front = null;
    this.pending = [];
    this.changeLog = [];
    this.lastSuggestionKey = '';
    this.script = cfg.script.map(e => ({ ...e, fired: false }));
    this.wx = this.randomInitial(cfg);
    if (cfg.initial) Object.assign(this.wx, cfg.initial);
    this.wx.windDirTrue = norm360(this.wx.windDirTrue);
    this.wx.windKt = Math.max(0, Math.round(this.wx.windKt));
    this.wx.gustKt = this.wx.gustKt > this.wx.windKt ? Math.round(this.wx.gustKt) : 0;
    this.wx.runwayCondition = cfg.initial?.runwayCondition ?? surfaceFor(this.wx.precip, this.wx.tempC);
    this.wx.lvp = isLvp(this.wx);
    this.wx.updatedAt = cfg.time;
    this.tempBase = this.wx.tempC;
    this.nextChangeAt = cfg.time + this.rf(WX.changeEveryMin[0], WX.changeEveryMin[1]) * 60;
    this.lastAtisCheckAt = cfg.time;
    const letter = (cfg.atisLetter ?? 'A').toUpperCase().slice(0, 1) || 'A';
    this.current = this.buildAtis(letter, 'initial');
  }

  // ── random helpers (only via the injected rng) ──
  private rf(lo: number, hi: number): number { return lo + this.rng() * (hi - lo); }
  private chance(p: number): boolean { return this.rng() < p; }

  private randomInitial(cfg: WeatherInit): WeatherState {
    const c = climateFor(cfg.icao);
    const w = defaultWeather(cfg.time);
    // wind: climatological mean +- spread (triangular-ish), speed within range, 20 % gusty
    const spread = (this.rng() + this.rng() - 1) * c.windSpread;
    w.windDirTrue = norm360(c.windMean + spread);
    w.windKt = Math.round(this.rf(c.windKt[0], c.windKt[1]));
    w.gustKt = w.windKt >= 12 && this.chance(0.2) ? w.windKt + Math.round(this.rf(8, 15)) : 0;
    if (w.windKt < 3) { w.windKt = 0; w.gustKt = 0; }
    w.qnh = Math.round(this.rf(c.qnh[0], c.qnh[1]));
    w.tempC = Math.round(this.rf(c.temp[0], c.temp[1]));
    w.dewC = w.tempC - Math.round(this.rf(c.dewDepression[0], c.dewDepression[1]));
    // precipitation / cloud / visibility
    const r = this.rng();
    if (r < c.fogP) {
      w.precip = 'none'; w.visM = Math.round(this.rf(300, 1400) / 50) * 50; w.ceilingFt = Math.round(this.rf(100, 400) / 100) * 100;
      w.cloud = `OVC00${Math.max(1, Math.round(w.ceilingFt / 100))}`.replace(/OVC00(\d\d)/, 'OVC0$1'); w.dewC = w.tempC;
    } else if (r < c.fogP + c.snowP && w.tempC <= 2) {
      w.precip = 'snow'; w.visM = Math.round(this.rf(1500, 5000) / 100) * 100; w.ceilingFt = Math.round(this.rf(800, 2500) / 100) * 100;
      w.cloud = `BKN${String(Math.round(w.ceilingFt / 100)).padStart(3, '0')} OVC${String(Math.round(w.ceilingFt / 100) + 10).padStart(3, '0')}`;
    } else if (r < c.fogP + c.snowP + c.wetP) {
      w.precip = this.chance(0.3) ? 'drizzle' : 'rain';
      w.visM = Math.round(this.rf(4000, 9000) / 100) * 100; w.ceilingFt = Math.round(this.rf(800, 3000) / 100) * 100;
      w.cloud = `SCT${String(Math.max(3, Math.round(w.ceilingFt / 100) - 5)).padStart(3, '0')} BKN${String(Math.round(w.ceilingFt / 100)).padStart(3, '0')}`;
    } else {
      w.precip = 'none'; w.visM = 10000;
      const k = this.rng();
      if (k < 0.35) { w.cloud = 'CAVOK'; w.ceilingFt = null; }
      else if (k < 0.7) { const b = Math.round(this.rf(15, 45)); w.cloud = `FEW${String(b).padStart(3, '0')}`; w.ceilingFt = null; }
      else if (k < 0.9) { const b = Math.round(this.rf(20, 45)); w.cloud = `SCT${String(b).padStart(3, '0')}`; w.ceilingFt = null; }
      else { const b = Math.round(this.rf(25, 60)); w.cloud = `BKN${String(b).padStart(3, '0')}`; w.ceilingFt = b * 100; }
    }
    w.runwayCondition = surfaceFor(w.precip, w.tempC);
    return w;
  }

  // ── stepping ──
  step(dt: number): WeatherStepResult {
    if (!this.cfg || !this.current) throw new Error('WeatherModel not initialised');
    const prev: WeatherState = { ...this.wx };
    this.time += dt;
    const w = this.wx;

    // 1. continuous random walk, integrated per minute of sim time
    this.walkAcc += dt;
    while (this.walkAcc >= 60) {
      this.walkAcc -= 60;
      if (!this.front) w.windDirTrue = norm360(w.windDirTrue + (this.rng() * 2 - 1) * WX.walkDirDegPerMin * 2);
      w.windKt = clamp(w.windKt + (this.rng() * 2 - 1) * WX.walkSpeedKtPerMin * 2, 0, 60);
      if (w.gustKt > 0) w.gustKt = clamp(w.gustKt + (this.rng() * 2 - 1) * 1.5, w.windKt + 5, w.windKt + 25);
      w.qnh += (this.rng() * 2 - 1) * 0.03;                       // ~0.5 hPa/h drift amplitude
      w.tempC += (this.rng() * 2 - 1) * 0.06;                     // slow diurnal wander
      w.dewC = Math.min(w.dewC, w.tempC);
      if (w.visM < 10000 && !this.front) w.visM = clamp(w.visM + (this.rng() * 2 - 1) * 150, 100, 10000);
      if (w.ceilingFt != null) w.ceilingFt = clamp(w.ceilingFt + (this.rng() * 2 - 1) * 40, 100, 6000);
    }

    // 2. frontal passage in progress
    if (this.front) {
      const f = this.front;
      const k = clamp((this.time - f.startedAt) / f.durationS, 0, 1);
      const eased = k * k * (3 - 2 * k);
      w.windDirTrue = norm360(f.startDir + signedDelta(f.startDir, f.targetDir) * eased);
      const bump = Math.sin(k * Math.PI) * f.speedBump;
      w.windKt = clamp(w.windKt + bump * (dt / f.durationS) * 2, 0, 60);
      if (k >= 1) { this.front = null; this.log('front', `frontal passage complete, wind now ${norm360(w.windDirTrue)}/${Math.round(w.windKt)}`, { dir: norm360(w.windDirTrue), kts: Math.round(w.windKt) }); }
    }

    // 3. Markov change / rare front
    if (this.time >= this.nextChangeAt) {
      this.nextChangeAt = this.time + this.rf(WX.changeEveryMin[0], WX.changeEveryMin[1]) * 60;
      this.markovChange();
    }
    if (!this.front && this.chance((WX.frontPerHour * dt) / 3600)) this.startFront();

    // 4. scripted events
    for (const ev of this.script) {
      if (ev.fired) continue;
      if (this.time >= this.initTime + ev.atMin * 60) { ev.fired = true; this.applyScripted(ev); }
    }

    // 5. derived state
    w.runwayCondition = this.cfg.initial?.runwayCondition && this.time - this.initTime < 1 ? w.runwayCondition : surfaceFor(w.precip, w.tempC);
    const lvp = isLvp(w);
    if (lvp !== w.lvp) { w.lvp = lvp; this.log('lvp', lvp ? 'LVP in operation' : 'LVP cancelled', { lvp }); }
    if (w.windshearAlert && this.time >= w.windshearAlert.until) { w.windshearAlert = null; this.log('windshear', 'windshear alert expired', {}); }
    w.updatedAt = this.time;

    // 6. change log for HUD
    const dDir = Math.abs(signedDelta(prev.windDirTrue, w.windDirTrue));
    if (dDir >= 10 || Math.abs(prev.windKt - w.windKt) >= 5) this.log('wind_shift', `wind ${norm360(w.windDirTrue)}/${Math.round(w.windKt)}${w.gustKt ? `G${Math.round(w.gustKt)}` : ''}`, { dir: norm360(w.windDirTrue), kts: Math.round(w.windKt), gust: Math.round(w.gustKt) });
    if (visBand(prev.visM) !== visBand(w.visM) || ceilingBand(prev.ceilingFt) !== ceilingBand(w.ceilingFt)) this.log('vis_change', `visibility ${visibilityText(w.visM)}, ${cloudText(w.cloud, w.ceilingFt)}`, { visM: Math.round(w.visM), ceilingFt: w.ceilingFt == null ? null : Math.round(w.ceilingFt) });
    if (Math.round(prev.qnh) !== Math.round(w.qnh)) this.log('qnh_change', `QNH ${Math.round(w.qnh)}`, { qnh: Math.round(w.qnh) });

    // 7. ATIS triggers (vs the BROADCAST state, not the previous step)
    let atisChanged = false;
    const reason = this.atisTriggerReason();
    if (reason) { this.regenerateAtis(reason, this.activeDep, this.activeArr, this.remarks); atisChanged = true; }

    // 8. runway suggestion on wind triggers / periodically
    let suggestion: WeatherStepResult['suggestion'] = null;
    if (this.cfg.ends.length && (atisChanged || dDir >= 5 || this.time - this.lastAtisCheckAt >= 600)) {
      this.lastAtisCheckAt = this.time;
      const s = this.suggestRunways(this.cfg.ends, { dep: this.activeDep, arr: this.activeArr });
      if (s.changed) {
        const key = `${s.dep.join('+')}|${s.arr.join('+')}`;
        suggestion = { dep: s.dep, arr: s.arr, reason: s.reason };
        if (key !== this.lastSuggestionKey) {
          this.lastSuggestionKey = key;
          this.log('runway_suggestion', s.reason, { dep: s.dep.join(','), arr: s.arr.join(',') });
          this.pending.push({ type: 'info', id: -1, callsign: 'ATIS', message: `Runway change suggested: ${s.reason}`, at: this.time, who: 'SYS' });
        }
      } else this.lastSuggestionKey = '';
    }

    const events = this.pending; this.pending = [];
    return { events, atisChanged, suggestion };
  }

  private markovChange(): void {
    const w = this.wx;
    const r = this.rng();
    if (r < 0.45) {
      // wind shift +-30 deg / +-8 kt
      const dDir = (this.rng() * 2 - 1) * 30, dKt = (this.rng() * 2 - 1) * 8;
      w.windDirTrue = norm360(w.windDirTrue + dDir);
      w.windKt = clamp(w.windKt + dKt, 0, 60);
      if (w.windKt < 2) w.windKt = 0;
      if (w.gustKt && w.gustKt < w.windKt + 5) w.gustKt = 0;
      this.log('wind_shift', `wind shift to ${norm360(w.windDirTrue)}/${Math.round(w.windKt)}`, { dir: norm360(w.windDirTrue), kts: Math.round(w.windKt) });
    } else if (r < 0.6) {
      // gust factor appears / disappears
      if (w.gustKt) { w.gustKt = 0; this.log('gust_front', 'gusts subsided', { gust: 0 }); }
      else if (w.windKt >= 8) { w.gustKt = Math.round(w.windKt + this.rf(8, 16)); this.log('gust_front', `gusts to ${w.gustKt} kt`, { gust: w.gustKt }); }
    } else if (r < 0.72) {
      w.qnh += (this.rng() * 2 - 1) * 2;
    } else if (r < 0.85) {
      // visibility / cloud evolution
      if (w.visM >= 10000 && this.chance(0.4)) { w.visM = Math.round(this.rf(3000, 8000) / 100) * 100; w.cloud = w.cloud === 'CAVOK' ? 'SCT025' : w.cloud; }
      else if (w.visM < 10000) { w.visM = clamp(w.visM * this.rf(1.2, 2.5), 100, 10000); if (w.visM >= 9500) w.visM = 10000; }
      if (w.ceilingFt != null && this.chance(0.5)) w.ceilingFt = clamp(Math.round(w.ceilingFt * this.rf(0.6, 1.6) / 100) * 100, 100, 6000);
      if (w.visM >= 10000 && w.ceilingFt != null && w.ceilingFt > 4500 && this.chance(0.4)) { w.ceilingFt = null; w.cloud = 'FEW035'; }
    } else {
      // precipitation start / stop
      if (w.precip === 'none') {
        if (w.tempC - w.dewC <= 4 && this.chance(0.7)) {
          w.precip = w.tempC <= 1 ? 'snow' : this.chance(0.3) ? 'drizzle' : 'rain';
          if (w.visM >= 10000) w.visM = Math.round(this.rf(4000, 9000) / 100) * 100;
          if (w.ceilingFt == null) { w.ceilingFt = Math.round(this.rf(1000, 3000) / 100) * 100; w.cloud = `BKN${String(Math.round(w.ceilingFt / 100)).padStart(3, '0')}`; }
          this.log('precip', `${precipText(w.precip, w.tempC)} started`, { precip: w.precip });
        }
      } else {
        w.precip = 'none';
        this.log('precip', 'precipitation stopped', { precip: 'none' });
      }
    }
  }

  private startFront(): void {
    const w = this.wx;
    const shift = this.rf(WX.frontShiftDeg[0], WX.frontShiftDeg[1]) * (this.chance(0.5) ? 1 : -1);
    this.front = { startDir: w.windDirTrue, targetDir: norm360(w.windDirTrue + shift), startedAt: this.time, durationS: WX.frontDurationS, speedBump: this.rf(4, 12) };
    this.log('front', `frontal passage starting, wind veering to ${this.front.targetDir}`, { targetDir: this.front.targetDir });
    this.pending.push({ type: 'info', id: -1, callsign: 'ATIS', message: `Weather: wind shifting towards ${String(this.front.targetDir).padStart(3, '0')} over the next 10 minutes`, at: this.time, who: 'SYS' });
  }

  private applyScripted(ev: WeatherEvent): void {
    const w = this.wx;
    const p = ev.params ?? {};
    const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : Number(p[k] ?? d) || d);
    switch (ev.kind) {
      case 'wind_shift': {
        const dir = num('dir', norm360(w.windDirTrue + 90)), kts = num('kts', w.windKt), dur = num('durationS', 0);
        if (dur > 0) this.front = { startDir: w.windDirTrue, targetDir: norm360(dir), startedAt: this.time, durationS: dur, speedBump: Math.max(0, kts - w.windKt) };
        else { w.windDirTrue = norm360(dir); w.windKt = kts; }
        w.gustKt = num('gust', 0);
        this.log('wind_shift', `scripted wind shift ${norm360(dir)}/${kts}`, { dir: norm360(dir), kts });
        break;
      }
      case 'gust_front': {
        w.gustKt = w.windKt + num('gust', 15);
        w.windKt = num('kts', w.windKt);
        w.windshearAlert = { runway: String(p.runway ?? this.activeArr[0] ?? ''), type: 'WS', lossKt: num('lossKt', 20), until: this.time + this.rf(WX.windshearExpiryS[0], WX.windshearExpiryS[1]) };
        this.log('gust_front', `gust front, gusts ${w.gustKt} kt`, { gust: w.gustKt });
        this.log('windshear', `windshear alert runway ${w.windshearAlert.runway}, ${w.windshearAlert.lossKt} kt loss`, { runway: w.windshearAlert.runway, lossKt: w.windshearAlert.lossKt });
        break;
      }
      case 'fog': {
        w.visM = num('visM', 400); w.ceilingFt = num('ceilingFt', 100); w.cloud = 'OVC001'; w.dewC = w.tempC; w.windKt = Math.min(w.windKt, 4); w.gustKt = 0;
        this.log('vis_change', 'fog rolling in', { visM: w.visM });
        break;
      }
      case 'snow_shower': {
        w.precip = 'snow'; w.tempC = Math.min(w.tempC, num('tempC', 0)); w.dewC = w.tempC - 1; w.visM = num('visM', 2000); w.ceilingFt = num('ceilingFt', 1200); w.cloud = 'BKN012 OVC025';
        this.log('precip', 'snow shower', { precip: 'snow' });
        break;
      }
      case 'thunderstorm': {
        w.precip = 'rain'; w.gustKt = w.windKt + num('gust', 25); w.visM = num('visM', 3000); w.ceilingFt = num('ceilingFt', 1500); w.cloud = 'BKN015CB';
        w.windshearAlert = { runway: String(p.runway ?? this.activeArr[0] ?? ''), type: 'MB', lossKt: num('lossKt', 40), until: this.time + this.rf(WX.windshearExpiryS[0], WX.windshearExpiryS[1]) };
        this.log('windshear', `microburst alert runway ${w.windshearAlert.runway}`, { runway: w.windshearAlert.runway, lossKt: w.windshearAlert.lossKt });
        break;
      }
      case 'clearing': {
        w.precip = 'none'; w.visM = 10000; w.ceilingFt = null; w.cloud = 'FEW030'; w.gustKt = 0; w.windshearAlert = null;
        this.log('vis_change', 'clearing', { visM: 10000 });
        break;
      }
    }
    this.pending.push({ type: 'info', id: -1, callsign: 'ATIS', message: `Weather: ${ev.kind.replace('_', ' ')}`, at: this.time, who: 'SYS' });
  }

  private log(kind: WeatherChangeKind, detail: string, params: WeatherChange['params']): void {
    this.changeLog.push({ kind, at: this.time, detail, params });
    if (this.changeLog.length > 200) this.changeLog.splice(0, this.changeLog.length - 200);
  }

  /** Reason string when the current state differs enough from the broadcast ATIS, else null. */
  private atisTriggerReason(): string | null {
    const a = this.current; if (!a) return null;
    const w = this.wx;
    const dDir = Math.abs(signedDelta(a.wind.dir, this.broadcastDir()));
    if (dDir >= WX.atisWindDeltaDeg) return `wind direction ${a.wind.dir} to ${this.broadcastDir()}`;
    if (Math.abs(a.wind.kts - Math.round(w.windKt)) >= WX.atisWindDeltaKt) return `wind speed ${a.wind.kts} to ${Math.round(w.windKt)} kt`;
    if ((a.wind.gust > 0) !== (w.gustKt > 0) && Math.abs(a.wind.gust - Math.round(w.gustKt)) >= WX.atisWindDeltaKt) return w.gustKt ? `gusts ${Math.round(w.gustKt)} kt` : 'gusts ceased';
    if (Math.abs(a.qnh - Math.round(w.qnh)) >= WX.atisQnhDeltaHpa) return `QNH ${a.qnh} to ${Math.round(w.qnh)}`;
    if (visBand(a.visM) !== visBand(w.visM)) return `visibility ${visibilityText(w.visM)}`;
    if (ceilingBand(this.atisCeiling) !== ceilingBand(w.ceilingFt)) return `ceiling ${w.ceilingFt == null ? 'none' : Math.round(w.ceilingFt) + ' ft'}`;
    if (this.atisLvp !== w.lvp) return w.lvp ? 'LVP in operation' : 'LVP cancelled';
    if (this.time - a.issuedAt >= WX.atisHourlyS) return 'hourly';
    return null;
  }
  private atisCeiling: number | null = null;
  private atisLvp = false;

  private broadcastDir(): number {
    return magneticDir(this.wx.windDirTrue, this.cfg?.magVar ?? 0);
  }

  state(): WeatherState { return this.wx; }

  atis(): Atis {
    if (!this.current) throw new Error('WeatherModel not initialised');
    return this.current;
  }

  /** Active runway config as last told to the model (kept for ATIS regeneration on weather triggers). */
  activeConfig(): { dep: string[]; arr: string[] } { return { dep: [...this.activeDep], arr: [...this.activeArr] }; }

  regenerateAtis(reason: string, activeDep: string[], activeArr: string[], remarks: string[] = [], opts: { silent?: boolean } = {}): Atis {
    if (!this.cfg) throw new Error('WeatherModel not initialised');
    this.activeDep = [...activeDep];
    this.activeArr = [...activeArr];
    this.remarks = [...remarks];
    // silent: rebuild the current information in place (boot-time runway config) — no new letter, no comm-log line
    if (opts.silent && this.current) { this.current = this.buildAtis(this.current.letter, 'initial'); return this.current; }
    const letter = this.current ? nextAtisLetter(this.current.letter) : (this.cfg.atisLetter ?? 'A');
    this.current = this.buildAtis(letter, reason);
    this.log('atis_update', `information ${letter}: ${reason}`, { letter, reason });
    this.pending.push({ type: 'atis', id: -1, callsign: 'ATIS', message: `ATIS ${letter} — ${reason}`, at: this.time, who: 'SYS', data: { type: 'atis', atis: this.current, reason } });
    return this.current;
  }

  private buildAtis(letter: string, reason: string): Atis {
    const cfg = this.cfg!;
    const w = this.wx;
    const dir = this.broadcastDir();
    const kts = Math.round(w.windKt), gust = Math.round(w.gustKt);
    const qnh = Math.round(w.qnh);
    const tl = transitionLevel(qnh);
    const zulu = ((cfg.startZuluMin ?? 600) * 60 + (this.time - this.initTime)) % 86400;
    const hh = String(Math.floor(zulu / 3600)).padStart(2, '0'), mm = String(Math.floor((zulu % 3600) / 60)).padStart(2, '0');
    const arr = this.activeArr.length ? this.activeArr : this.activeDep;
    const dep = this.activeDep.length ? this.activeDep : this.activeArr;
    const sameCfg = arr.join(',') === dep.join(',');
    const rwyText = !arr.length ? '' : sameCfg ? `Runway in use ${arr.join(' and ')}.` : `Landing runway ${arr.join(' and ')}, departing runway ${dep.join(' and ')}.`;
    const wind = kts === 0 ? 'Wind calm.' : `Wind ${String(dir).padStart(3, '0')} degrees ${kts} knots${gust ? `, gusting ${gust} knots` : ''}${w.variableFrom != null && w.variableTo != null ? `, variable between ${String(w.variableFrom).padStart(3, '0')} and ${String(w.variableTo).padStart(3, '0')}` : ''}.`;
    const vis = `Visibility ${visibilityText(w.visM)}.`;
    const wxTxt = precipText(w.precip, w.tempC);
    const cloud = cloudText(w.cloud, w.ceilingFt == null ? null : Math.round(w.ceilingFt));
    const remarks = [...this.remarks];
    if (w.lvp) remarks.unshift('Low visibility procedures in operation');
    if (w.runwayCondition !== 'dry') remarks.push(`Runway ${w.runwayCondition === 'wet' ? 'wet, braking action good' : 'contaminated, braking action medium'}`);
    if (w.windshearAlert) remarks.push(`${w.windshearAlert.type === 'MB' ? 'Microburst' : 'Windshear'} alert runway ${w.windshearAlert.runway}`);
    if (w.tempC <= 3 && (w.precip !== 'none' || w.tempC - w.dewC <= 2)) remarks.push('De-icing in progress, expect delays');
    const text = [
      `${cfg.airportName || cfg.icao} information ${phoneticLetter(letter)}, time ${hh}${mm} Zulu.`,
      rwyText,
      arr.length ? 'Expect ILS approach.' : '',
      `Transition level ${tl}.`,
      wind,
      vis,
      wxTxt ? `${wxTxt.charAt(0).toUpperCase()}${wxTxt.slice(1)}.` : '',
      `${cloud.charAt(0).toUpperCase()}${cloud.slice(1)}.`,
      `Temperature ${Math.round(w.tempC)}, dew point ${Math.round(w.dewC)}.`,
      `QNH ${qnh} hectopascals.`,
      remarks.length ? `${remarks.join('. ')}.` : '',
      `Acknowledge information ${phoneticLetter(letter)} on first contact.`,
    ].filter(Boolean).join(' ');
    this.atisCeiling = w.ceilingFt == null ? null : Math.round(w.ceilingFt);
    this.atisLvp = w.lvp;
    void reason;
    return {
      letter, issuedAt: this.time, text,
      wind: { dir, kts, gust }, visM: Math.round(w.visM), cloud: w.cloud, qnh, tempC: Math.round(w.tempC), dewC: Math.round(w.dewC),
      activeDep: [...dep], activeArr: [...arr], transitionLevel: tl, remarks,
    };
  }

  /**
   * Best departure / arrival ends from the wind (03 §2.9 / §A12). Parallel ends
   * (same runway number, different side) are kept as a pair (dep on one, arr on
   * the other, mirroring the current split); a single physical runway serves both.
   * `changed` is true only when the current config is outside limits (tailwind
   * > 5 kt on any current end, crosswind > 25 kt) or a reversal is clearly better.
   */
  suggestRunways(ends: RunwayEnd[], current: { dep: string[]; arr: string[] }): RunwaySuggestion {
    const w = this.wx;
    if (!ends.length) return { dep: [...current.dep], arr: [...current.arr], changed: false, reason: 'no runway data' };
    const cur = new Set([...current.dep, ...current.arr].map(s => s.toUpperCase()));
    const calm = this.cfg?.calmPreferred ?? null;
    const calmSet = new Set([...(calm?.dep ?? []), ...(calm?.arr ?? [])].map(s => s.toUpperCase()));
    const scored = ends.map(e => ({ end: e, score: runwayScore(w.windDirTrue, w.windKt, w.gustKt, e, { current: cur.has(e.name.toUpperCase()), calmPreferred: calmSet.has(e.name.toUpperCase()) }), comp: windComponents(w.windDirTrue, Math.max(w.windKt, w.gustKt), e.hdg) }))
      .sort((a, b) => b.score - a.score);
    // group by direction family: ends within 15 deg of the best end's heading
    const best = scored[0];
    const family = scored.filter(s => Math.abs(signedDelta(s.end.hdg, best.end.hdg)) <= 15);
    let dep: string[], arr: string[];
    if (family.length >= 2) {
      // mirror the current split if the current config used a pair; else arr on the best, dep on the second
      const names = family.map(f => f.end.name);
      const curArrSide = current.arr.map(s => rwySide(s.toUpperCase()));
      const arrPick = names.find(n => curArrSide.includes(rwySide(n))) ?? names[0];
      const depPick = names.find(n => n !== arrPick) ?? names[0];
      arr = [arrPick]; dep = [depPick];
    } else { dep = [best.end.name]; arr = [best.end.name]; }
    // hysteresis: keep the current config unless it violates limits
    const curEnds = ends.filter(e => cur.has(e.name.toUpperCase()));
    let worstTail = -Infinity, worstCross = 0;
    for (const e of curEnds) {
      const c = windComponents(w.windDirTrue, Math.max(w.windKt, w.gustKt), e.hdg);
      worstTail = Math.max(worstTail, -c.headKt); worstCross = Math.max(worstCross, c.crossKt);
    }
    const sameSet = curEnds.length > 0 && dep.every(d => cur.has(d.toUpperCase())) && arr.every(a => cur.has(a.toUpperCase()));
    const tailOk = curEnds.length > 0 && worstTail <= WX.tailwindPreferKt;
    const crossOk = worstCross <= WX.crosswindPromptKt;
    const windTxt = `${String(magneticDir(w.windDirTrue, this.cfg?.magVar ?? 0)).padStart(3, '0')}/${Math.round(w.windKt)}${w.gustKt ? `G${Math.round(w.gustKt)}` : ''}`;
    if (sameSet || (tailOk && crossOk)) {
      return { dep: [...current.dep], arr: [...current.arr], changed: false, reason: curEnds.length ? `wind ${windTxt}, current runways within limits` : `wind ${windTxt}` };
    }
    const why = !tailOk && curEnds.length ? `tailwind ${Math.round(worstTail)} kt on ${curEnds.map(e => e.name).join('/')}` : !crossOk ? `crosswind ${Math.round(worstCross)} kt` : 'better into wind';
    const reason = `wind ${windTxt} — runway ${arr[0] === dep[0] ? arr[0] : `${arr[0]} landing / ${dep[0]} departing`} recommended (current ${[...cur].join('/') || 'none'}, ${why})`;
    return { dep, arr, changed: true, reason };
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
    const limit = WX.crosswindLimit[weightClass];
    const { crossKt } = this.componentsFor(runwayHdgTrue);
    if (crossKt > limit + 5) return WX.gaCrosswindOver5P;
    if (crossKt > limit) return WX.gaCrosswindOverP;
    return 0;
  }

  /** Pilot go-around probability at 1000 ft from gusts / windshear (03 §D4, §5); 0 when not gusting. */
  gustGoAroundP(): number {
    const w = this.wx;
    let p = 0;
    if (w.windshearAlert) p = Math.max(p, w.windshearAlert.type === 'MB' ? WX.gaMicroburstP : WX.gaWindshearP);
    if (w.gustKt > 0 && w.gustKt - w.windKt >= WX.gustGaKt) p = Math.max(p, WX.gaGustP);
    else if (w.gustKt > WX.gustGaKt) p = Math.max(p, WX.gaGustP);
    return p;
  }

  /** Tailwind-driven pilot go-around probability at 1000 ft (03 §D4: > 10 kt tailwind -> 50 %). */
  tailwindGoAroundP(runwayHdgTrue: number): number {
    const { headKt } = this.componentsFor(runwayHdgTrue);
    return -headKt > WX.tailwindMaxKt ? 0.5 : 0;
  }

  setWind(dirTrue: number, kts: number, gust = 0): void {
    const w = this.wx;
    const prev = { ...w };
    w.windDirTrue = norm360(dirTrue);
    w.windKt = Math.max(0, kts);
    w.gustKt = gust > kts ? gust : 0;
    w.updatedAt = this.time;
    this.front = null;
    if (Math.abs(signedDelta(prev.windDirTrue, w.windDirTrue)) >= 10 || Math.abs(prev.windKt - w.windKt) >= 5) this.log('wind_shift', `wind set ${norm360(w.windDirTrue)}/${Math.round(w.windKt)}`, { dir: norm360(w.windDirTrue), kts: Math.round(w.windKt), gust: Math.round(w.gustKt) });
    // immediate ATIS check so the next step() carries the event
    if (this.current && this.cfg) {
      const reason = this.atisTriggerReason();
      if (reason) this.regenerateAtis(reason, this.activeDep, this.activeArr, this.remarks);
    }
  }

  /** Test / scenario hook: overwrite any subset of the state (vis, ceiling, QNH, precip, ...) and re-check ATIS. */
  setState(patch: Partial<WeatherState>): void {
    Object.assign(this.wx, patch);
    this.wx.windDirTrue = norm360(this.wx.windDirTrue);
    this.wx.runwayCondition = patch.runwayCondition ?? surfaceFor(this.wx.precip, this.wx.tempC);
    this.wx.lvp = isLvp(this.wx);
    this.wx.updatedAt = this.time;
    if (this.current && this.cfg) {
      const reason = this.atisTriggerReason();
      if (reason) this.regenerateAtis(reason, this.activeDep, this.activeArr, this.remarks);
    }
  }

  /** Raise a windshear / microburst alert on a runway (D4), expiring after 5-15 min. */
  setWindshear(runway: string, type: 'WS' | 'MB', lossKt: number): void {
    this.wx.windshearAlert = { runway, type, lossKt, until: this.time + this.rf(WX.windshearExpiryS[0], WX.windshearExpiryS[1]) };
    this.log('windshear', `${type === 'MB' ? 'microburst' : 'windshear'} alert runway ${runway}, ${lossKt} kt loss`, { runway, type, lossKt });
    this.pending.push({ type: 'info', id: -1, callsign: 'LLWAS', message: `${type === 'MB' ? 'MICROBURST' : 'WINDSHEAR'} ALERT runway ${runway}, ${lossKt}-knot loss`, at: this.time, who: 'SYS' });
  }

  /** Queue a scripted event relative to now (test / scenario hook). */
  scheduleEvent(ev: WeatherEvent): void {
    const atMin = (this.time - this.initTime) / 60 + ev.atMin;
    this.script.push({ ...ev, atMin, fired: false });
  }

  /** Drain the fine-grained change log (wind_shift / atis_update / runway_suggestion / vis_change / ...). */
  changes(): WeatherChange[] { const out = this.changeLog; this.changeLog = []; return out; }
  /** Alias of changes() (task brief name). */
  events(): WeatherChange[] { return this.changes(); }

  /** Current sim time as seen by the model. */
  now(): number { return this.time; }
}

/** Magnetic wind direction (rounded to 10 deg like a METAR/ATIS), 001-360. */
export function magneticDir(trueDeg: number, magVar: number): number {
  const m = Math.round(((trueDeg - magVar) % 360 + 360) % 360 / 10) * 10;
  return m === 0 ? 360 : m;
}

const PHONETIC_LETTERS: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India',
  J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};
export function phoneticLetter(letter: string): string { return PHONETIC_LETTERS[letter.toUpperCase()] ?? letter; }

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

/** Takeoff / landing distance factor from surface and tailwind (03 §5): wet x1.3, contaminated x1.6, +10 % per 5 kt tailwind. */
export function performanceFactor(surface: RunwaySurface, headKt: number, tempC = 15): number {
  let f = surface === 'wet' ? 1.3 : surface === 'contaminated' ? 1.6 : 1;
  const tail = Math.max(0, -headKt);
  f *= 1 + 0.1 * (tail / 5);
  if (tempC > 30) f *= 1.05;
  return f;
}
