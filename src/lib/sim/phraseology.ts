// ============================================================
//  Phraseology — controller transmissions and pilot readbacks (W1-SYSTEMS)
//
//  Generates the controller transmission (TX) and the pilot readback (RB) from
//  a CommandAST, in the ICAO (default) or FAA variant (03 §7 table, §G5
//  telephony, UX 04 §1.4 TX/RB columns, §G5.15 FAA diff list). All three input
//  paths (click / typed / voice) produce identical radio lines because they
//  all go through here.
//
//  Pure and deterministic: no rng anywhere in this module; the only free
//  parameter is the phraseology variant. Spoken numbers, runway/altitude/
//  heading/frequency speech, the telephony table and the magnetic conversion
//  are shared helpers; the per-kind templates (transmission / readback /
//  pilotRequestLine / unableLine) plus the emergency, safety-alert and vehicle
//  lines live at the bottom.
// ============================================================
import type {
  ApproachType, ClearedLandAst, CommandAST, CorrectionField, ExitSpec, GoAroundAst, HeadingAst, HoldAst, HoldShortTarget,
  IlsAst, ReportKind, SingleAircraftCommand, SpeedAst, SystemCommand, TakeoffAst, TaxiAst, TurnDir, UnableReason,
} from './commandAst';
import { callsignOf, describe, isSystemCommand, sortParts } from './commandAst';
import type { AircraftState, EmergencyLevel, EmergencyType, PendingCondition, PilotRequest, Position, VehicleTarget } from './types';

export type PhraseVariant = 'ICAO' | 'FAA';

/** Everything the templates need beyond the AST. Built by dispatch from the engine + weather. */
export interface PhraseCtx {
  variant: PhraseVariant;
  /** Telephony for a callsign ("Speedbird 117"); falls back to spelled ICAO code. */
  telephony(cs: string): string;
  /** Unit name used in "roger mayday, Heathrow Tower" / broadcasts. */
  unit(position: Position): string;
  /** Frequency string for a position ("118.505"), '' when unknown. */
  freq(position: Position): string;
  /** Current wind for "wind 260 degrees 8 knots" chips; null = omit. */
  wind: { dir: number; kts: number; gust: number } | null;
  qnh: number | null;
  atisLetter: string | null;
  /** Magnetic variation (deg, east positive) so spoken headings are magnetic. */
  magVar: number;
  transitionAltFt: number;
  /** Sim clock (s) for EFC "expect further clearance at 45". */
  time: number;
  /** The addressed aircraft (for climb/descend verb, runway defaults, type name); null for system commands. */
  aircraft: AircraftState | null;
  /** Spoken aircraft type for traffic info ("Boeing 737"). */
  spokenType(icao: string): string;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Telephony (UX §G5.14)
// ──────────────────────────────────────────────────────────────────────────────
export const AIRLINE_TELEPHONY: Record<string, string> = {
  BAW: 'Speedbird', UAL: 'United', AAL: 'American', DAL: 'Delta', DLH: 'Lufthansa', AFR: 'Air France',
  KLM: 'KLM', UAE: 'Emirates', QTR: 'Qatari', SIA: 'Singapore', CPA: 'Cathay', QFA: 'Qantas',
  SWR: 'Swiss', EIN: 'Shamrock', RYR: 'Ryanair', EZY: 'Easy', VIR: 'Virgin', JAL: 'Japan Air', ANA: 'All Nippon',
  AIC: 'Air India', IGO: 'IFly', SWA: 'Southwest', JBU: 'JetBlue', ASA: 'Alaska', FDX: 'FedEx', UPS: 'UPS',
};

const PHONETIC: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India',
  J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const DIGITS_ICAO = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];

/** Telephony + flight number ("Speedbird one one seven"); unknown airline -> phonetic letters. */
export function telephony(callsign: string, variant: PhraseVariant = 'ICAO'): string {
  const m = callsign.toUpperCase().match(/^([A-Z]{3})(\d+)([A-Z]*)$/);
  if (!m) return spellPhonetic(callsign);
  const name = AIRLINE_TELEPHONY[m[1]] ?? spellPhonetic(m[1]);
  const num = variant === 'FAA' ? groupNumber(m[2]) : spokenDigits(m[2], variant);
  const suffix = m[3] ? ' ' + spellPhonetic(m[3]) : '';
  return `${name} ${num}${suffix}`;
}

export function spellPhonetic(s: string): string {
  return s.toUpperCase().split('').map(c => PHONETIC[c] ?? (/\d/.test(c) ? DIGITS[+c] : c)).join(' ');
}

/** "240" -> "two four zero" (ICAO uses tree/fife/niner). */
export function spokenDigits(s: string | number, variant: PhraseVariant = 'ICAO'): string {
  const d = variant === 'ICAO' ? DIGITS_ICAO : DIGITS;
  return String(s).split('').map(c => (/\d/.test(c) ? d[+c] : c)).join(' ');
}

/** FAA group form: "1223" -> "twelve twenty-three", "117" -> "one seventeen". Falls back to digits for 4+ digit awkward cases. */
export function groupNumber(s: string): string {
  const n = parseInt(s, 10);
  if (!isFinite(n)) return spokenDigits(s, 'FAA');
  if (s.length <= 2) return smallNumber(n);
  if (s.length === 3) return `${DIGITS[+s[0]]} ${smallNumber(parseInt(s.slice(1), 10))}`;
  if (s.length === 4) return `${smallNumber(parseInt(s.slice(0, 2), 10))} ${smallNumber(parseInt(s.slice(2), 10))}`;
  return spokenDigits(s, 'FAA');
}
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function smallNumber(n: number): string {
  if (n < 10) return DIGITS[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10), u = n % 10;
  return u ? `${TENS[t]}-${DIGITS[u]}` : TENS[t];
}

/** "27L" -> "two seven left". */
export function spokenRunway(rwy: string, variant: PhraseVariant = 'ICAO'): string {
  const m = rwy.toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
  if (!m) return rwy;
  const side = m[2] === 'L' ? ' left' : m[2] === 'R' ? ' right' : m[2] === 'C' ? ' centre' : '';
  return spokenDigits(m[1].padStart(2, '0'), variant) + side;
}

/** Altitude speech: <= transition altitude "three thousand" / "four thousand five hundred"; above -> "flight level one three zero". FAA uses FL above 18 000. */
export function spokenAltitude(ft: number, variant: PhraseVariant = 'ICAO', transitionAltFt = 6000): string {
  const ta = variant === 'FAA' ? 18000 : transitionAltFt;
  if (ft > ta) return `flight level ${spokenDigits(String(Math.round(ft / 100)), variant)}`;
  const th = Math.floor(ft / 1000), hu = Math.round((ft % 1000) / 100);
  const parts: string[] = [];
  if (th) parts.push(`${spokenDigits(String(th), variant)} thousand`);
  if (hu) parts.push(`${spokenDigits(String(hu), variant)} hundred`);
  return parts.join(' ') || 'zero';
}

/** Display/speech form of an altitude for chips: "5000" or "FL070". */
export function altitudeLabel(ft: number, transitionAltFt = 6000): string {
  return ft > transitionAltFt ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : String(Math.round(ft));
}

/** True -> magnetic heading rounded to 1 deg, 001-360 (never 000). */
export function magneticHeading(trueDeg: number, magVar: number): number {
  const m = Math.round(((trueDeg - magVar) % 360 + 360) % 360);
  return m === 0 ? 360 : m;
}
/** Magnetic -> true. */
export function trueHeading(magDeg: number, magVar: number): number {
  return ((magDeg + magVar) % 360 + 360) % 360;
}

/** "heading two four zero" digits (3 digits, magnetic). */
export function spokenHeading(trueDeg: number, ctx: Pick<PhraseCtx, 'magVar' | 'variant'>): string {
  return spokenDigits(String(magneticHeading(trueDeg, ctx.magVar)).padStart(3, '0'), ctx.variant);
}

/** "118.505" -> ICAO "one one eight decimal five zero five" / FAA "one one eight point five". */
export function spokenFrequency(freq: string, variant: PhraseVariant = 'ICAO'): string {
  const [a, b = ''] = freq.split('.');
  const dec = variant === 'FAA' ? b.replace(/0+$/, '').slice(0, 2) || '0' : b;
  return `${spokenDigits(a, variant)} ${variant === 'FAA' ? 'point' : 'decimal'} ${spokenDigits(dec, variant)}`.trim();
}

/** "wind 260 degrees 8 knots [gusting 18]" (ICAO) / "wind 260 at 8 [gusts 18]" (FAA). */
export function spokenWind(w: { dir: number; kts: number; gust: number }, variant: PhraseVariant = 'ICAO', magVar = 0): string {
  const dir = spokenDigits(String(magneticHeading(w.dir, magVar)).padStart(3, '0'), variant);
  const kts = spokenDigits(String(Math.round(w.kts)), variant);
  const g = w.gust > 0 ? (variant === 'FAA' ? ` gusts ${spokenDigits(String(Math.round(w.gust)), variant)}` : ` gusting ${spokenDigits(String(Math.round(w.gust)), variant)}`) : '';
  return variant === 'FAA' ? `wind ${dir} at ${kts}${g}` : `wind ${dir} degrees ${kts} knots${g}`;
}

/** Spoken taxiway list "Alpha, Bravo". */
export function spokenTaxiways(names: string[]): string {
  return names.map(n => n.split('').map(c => (/[A-Z]/i.test(c) ? PHONETIC[c.toUpperCase()] : DIGITS[+c] ?? c)).join(' ')).join(', ');
}

/** Minutes past the hour for EFC: sim seconds -> "four five". */
export function spokenEfc(simTimeS: number, variant: PhraseVariant = 'ICAO'): string {
  const min = Math.floor(simTimeS / 60) % 60;
  return spokenDigits(String(min).padStart(2, '0'), variant);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Templates — 03 §7 (ICAO column) and UX 04 §1.4; FAA diffs per §G5.15:
//    taxi: ICAO "taxi to holding point runway 27L via A, B" / FAA "runway 27L, taxi via A, B"
//    ils:  ICAO "cleared ILS approach runway 27L" / FAA "cleared ILS runway 27L approach"
//    descend: ICAO "descend to 3000" / FAA "descend and maintain 3000"
//    wind: ICAO "wind 260 degrees 8 knots" / FAA "wind 260 at 8"
//    cancel takeoff: ICAO "cancel takeoff" / FAA "cancel takeoff clearance"
//    hold short / line up and wait / climb and maintain / expedite: same
//    frequencies: "decimal" (ICAO) vs "point" (FAA); QNH hPa vs "altimeter 29.92"
//  Everything below is deterministic: the only free parameter is the variant.
// ──────────────────────────────────────────────────────────────────────────────

type V = PhraseVariant;

/** Spoken position word for "contact tower 118.5" (external = the unit name from ctx). */
export function positionWord(position: Position, ctx: PhraseCtx): string {
  switch (position) {
    case 'ground': return 'ground';
    case 'tower': return 'tower';
    case 'departure': return 'departure';
    case 'approach': return 'approach';
    case 'external': return ctx.unit('external') || 'centre';
  }
}

/** "contact tower one one eight decimal five" — frequency omitted when unknown. */
export function spokenContact(position: Position, ctx: PhraseCtx): string {
  const f = ctx.freq(position);
  return `contact ${positionWord(position, ctx)}${f ? ' ' + spokenFrequency(f, ctx.variant) : ''}`;
}

/** QNH speech: ICAO "QNH one zero one three" / FAA "altimeter two niner niner two" (hPa -> inHg). */
export function spokenQnh(qnh: number, variant: V): string {
  if (variant === 'FAA') {
    const inHg = Math.round(qnh * 0.02953 * 100); // e.g. 2992
    return `altimeter ${spokenDigits(String(inHg).padStart(4, '0'), variant)}`;
  }
  return `QNH ${spokenDigits(String(Math.round(qnh)), variant)}`;
}

/** Spoken speed: "one six zero knots". */
export function spokenSpeed(kts: number, variant: V): string {
  return `${spokenDigits(String(Math.round(kts)), variant)} knots`;
}

/** Spoken transponder code. */
export function spokenSquawk(code: string, variant: V): string {
  return spokenDigits(code, variant);
}

/** Spoken fix name: 5-letter waypoints are pronounced as words ("BIG", "LAM"); short/numeric ids are spelled. */
export function spokenFix(fix: string): string {
  const f = fix.toUpperCase();
  if (/^[A-Z]{3,5}$/.test(f)) return f;
  return spellPhonetic(f);
}

/** Spoken stand / gate ref: "five one two" or "Alpha one two". */
export function spokenStand(ref: string, variant: V): string {
  return ref.toUpperCase().split('').map(c => (/\d/.test(c) ? spokenDigits(c, variant) : PHONETIC[c] ?? c)).join(' ');
}

/** Spoken taxiway single designator "A1" -> "Alpha one". */
export function spokenTaxiway(name: string): string {
  return spokenTaxiways([name]);
}

const dirWord = (d: TurnDir | null | undefined) => (d === 'L' ? 'left' : d === 'R' ? 'right' : '');

function csOf(ast: CommandAST, ctx: PhraseCtx): string {
  const cs = callsignOf(ast);
  return cs ? ctx.telephony(cs) : '';
}

/** Capitalise the first letter and terminate with a full stop. */
function sentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim().replace(/[.,]+$/, '');
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

function holdTargetPhrase(t: HoldShortTarget, variant: V, short = false): string {
  switch (t.kind) {
    case 'runway': return short ? `hold short ${spokenRunway(t.runway, variant)}` : `hold short of runway ${spokenRunway(t.runway, variant)}`;
    case 'taxiway': return short ? `hold short ${spokenTaxiway(t.taxiway)}` : `hold short of taxiway ${spokenTaxiway(t.taxiway)}`;
    case 'node': return short ? `hold at ${t.label}` : `hold at ${t.label}`;
  }
}

function exitPhrase(e: ExitSpec, variant: V): string {
  void variant;
  return e.kind === 'taxiway' ? `vacate via ${spokenTaxiway(e.taxiway)}` : `take the next available exit on the ${dirWord(e.dir)}`;
}
function exitReadback(e: ExitSpec): string {
  return e.kind === 'taxiway' ? `vacating via ${spokenTaxiway(e.taxiway)}` : `next available ${dirWord(e.dir)}`;
}

function condPhrase(c: PendingCondition | null, ctx: PhraseCtx): { before: string; after: string } {
  if (!c) return { before: '', after: '' };
  const v = ctx.variant;
  switch (c.type) {
    case 'after_pushback': return { before: 'after pushback, ', after: '' };
    case 'on_reaching_hold': return { before: 'on reaching the holding point, ', after: '' };
    case 'at_or_below_alt': return { before: `when passing ${spokenAltitude(c.ft, v, ctx.transitionAltFt)}, `, after: '' };
    case 'at_or_above_alt': return { before: `on reaching ${spokenAltitude(c.ft, v, ctx.transitionAltFt)}, `, after: '' };
    case 'after_fix': return { before: `after ${spokenFix(c.fix)}, `, after: '' };
    case 'behind_aircraft': return { before: `behind the ${trafficWord(c.callsign, ctx)}, `, after: ', behind' };
    case 'after_vacated': return { before: 'when vacated, ', after: '' };
    case 'when_ready': return { before: 'when ready, ', after: '' };
  }
}

/** "Airbus 320" for a callsign when the ctx knows the aircraft, else the telephony. */
function trafficWord(callsign: string, ctx: PhraseCtx): string {
  const a = ctx.aircraft;
  if (a && a.callsign === callsign.toUpperCase()) return ctx.spokenType(a.perf.icaoCode);
  return ctx.telephony(callsign);
}

/** Climb / descend verb from the addressed aircraft's current altitude (maintain when level at it). */
function altVerb(ft: number, ctx: PhraseCtx): 'climb' | 'descend' | 'maintain' {
  const a = ctx.aircraft;
  if (!a) return 'climb';
  if (Math.abs(a.altitude - ft) < 100 && Math.abs(a.targetAltitude - ft) < 100) return 'maintain';
  return ft > a.altitude ? 'climb' : 'descend';
}

function altitudePhrase(ft: number, expedite: boolean, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const alt = spokenAltitude(ft, v, ctx.transitionAltFt);
  const verb = altVerb(ft, ctx);
  if (verb === 'maintain') return `maintain ${alt}`;
  const core = v === 'FAA' ? `${verb} and maintain ${alt}` : verb === 'climb' ? `climb to ${alt}` : `descend to ${alt}`;
  return expedite ? `${core}, expedite` : core;
}

function altitudeReadback(ft: number, expedite: boolean, ctx: PhraseCtx): string {
  const alt = spokenAltitude(ft, ctx.variant, ctx.transitionAltFt);
  const verb = altVerb(ft, ctx);
  return `${verb} ${alt}${expedite ? ', expediting' : ''}`;
}

function headingPhrase(ast: HeadingAst, ctx: PhraseCtx): string {
  const { before, after } = condPhrase(ast.when, ctx);
  if (ast.relative) return `${before}turn ${dirWord(ast.relative.dir)} ${spokenDigits(String(ast.relative.deg), ctx.variant)} degrees${after}`;
  const h = spokenHeading(ast.hdg, ctx);
  const core = ast.dir ? `turn ${dirWord(ast.dir)} heading ${h}` : `fly heading ${h}`;
  return `${before}${core}${after}`;
}
function headingReadback(ast: HeadingAst, ctx: PhraseCtx): string {
  if (ast.relative) return `${dirWord(ast.relative.dir)} ${spokenDigits(String(ast.relative.deg), ctx.variant)} degrees`;
  const h = spokenHeading(ast.hdg, ctx);
  const cond = ast.when ? condPhrase(ast.when, ctx).before : '';
  return `${cond}${ast.dir ? `${dirWord(ast.dir)} heading ${h}` : `heading ${h}`}`;
}

function windChip(ctx: PhraseCtx): string {
  return ctx.wind ? spokenWind(ctx.wind, ctx.variant, ctx.magVar) : '';
}

function taxiPhrase(ast: TaxiAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const via = ast.via.length ? spokenTaxiways(ast.via) : '';
  const cross = ast.cross.length ? `, cross runway${ast.cross.length > 1 ? 's' : ''} ${ast.cross.map(r => spokenRunway(r, v)).join(' and ')}` : '';
  const hs = ast.holdShortOf ? `, ${holdTargetPhrase(ast.holdShortOf, v)}` : '';
  const xp = ast.expedite ? ', expedite' : '';
  switch (ast.dest.kind) {
    case 'runway': {
      const rwy = spokenRunway(ast.dest.runway, v);
      const at = ast.dest.intersection ? ` at ${spokenTaxiway(ast.dest.intersection)}` : '';
      if (v === 'FAA') return `runway ${rwy}${at}, taxi${via ? ` via ${via}` : ''}${cross}${hs}${xp}`;
      return `taxi to holding point${at ? ` ${spokenTaxiway(ast.dest.intersection!)}` : ''} runway ${rwy}${via ? ` via ${via}` : ''}${cross}${hs}${xp}`;
    }
    case 'stand': return `taxi to stand ${spokenStand(ast.dest.ref, v)}${via ? ` via ${via}` : ''}${cross}${hs}${xp}`;
    case 'node': return `taxi to ${ast.dest.label}${via ? ` via ${via}` : ''}${cross}${hs}${xp}`;
  }
}
function taxiReadback(ast: TaxiAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const via = ast.via.length ? ` via ${spokenTaxiways(ast.via)}` : '';
  const cross = ast.cross.length ? `, cross ${ast.cross.map(r => spokenRunway(r, v)).join(' and ')}` : '';
  const hs = ast.holdShortOf ? `, ${holdTargetPhrase(ast.holdShortOf, v, true)}` : '';
  const xp = ast.expedite ? ', expediting' : '';
  switch (ast.dest.kind) {
    case 'runway': {
      const rwy = spokenRunway(ast.dest.runway, v);
      const at = ast.dest.intersection ? ` at ${spokenTaxiway(ast.dest.intersection)}` : '';
      return v === 'FAA' ? `runway ${rwy}${at}${via}${cross}${hs}${xp}` : `holding point${at ? ` ${spokenTaxiway(ast.dest.intersection!)}` : ''} runway ${rwy}${via}${cross}${hs}${xp}`;
    }
    case 'stand': return `stand ${spokenStand(ast.dest.ref, v)}${via}${cross}${hs}${xp}`;
    case 'node': return `${ast.dest.label}${via}${cross}${hs}${xp}`;
  }
}

function takeoffPhrase(ast: TakeoffAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const rwy = spokenRunway(ast.runway, v);
  const parts: string[] = [];
  const wind = ast.wind ? windChip(ctx) : '';
  if (v === 'ICAO' && wind) parts.push(wind);
  parts.push(`runway ${rwy}`);
  if (ast.afterDepHdg === 'runway') parts.push('fly runway heading');
  else if (typeof ast.afterDepHdg === 'number') parts.push(`after departure fly heading ${spokenHeading(ast.afterDepHdg, ctx)}`);
  if (ast.turn) parts.push(`after departure turn ${dirWord(ast.turn.dir)} ${spokenDigits(String(ast.turn.deg), v)} degrees`);
  if (ast.initialAlt != null) parts.push(`climb ${v === 'FAA' ? 'and maintain ' : 'to '}${spokenAltitude(ast.initialAlt, v, ctx.transitionAltFt)}`);
  if (ast.contactDeparture) parts.push(`on reaching ${spokenContact('departure', ctx)}`);
  parts.push(`cleared for ${ast.immediate ? 'immediate ' : ''}takeoff`);
  if (v === 'FAA' && wind) parts.push(wind);
  return parts.join(', ');
}
function takeoffReadback(ast: TakeoffAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts: string[] = [];
  if (ast.afterDepHdg === 'runway') parts.push('runway heading');
  else if (typeof ast.afterDepHdg === 'number') parts.push(`heading ${spokenHeading(ast.afterDepHdg, ctx)}`);
  if (ast.turn) parts.push(`${dirWord(ast.turn.dir)} ${spokenDigits(String(ast.turn.deg), v)} degrees`);
  if (ast.initialAlt != null) parts.push(`climb ${spokenAltitude(ast.initialAlt, v, ctx.transitionAltFt)}`);
  if (ast.contactDeparture) parts.push('contact departure on reaching');
  parts.push(`cleared for ${ast.immediate ? 'immediate ' : ''}takeoff runway ${spokenRunway(ast.runway, v)}`);
  return parts.join(', ');
}

function landPhrase(ast: ClearedLandAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const rwy = spokenRunway(ast.runway, v);
  const parts: string[] = [];
  const wind = ast.wind ? windChip(ctx) : '';
  if (v === 'ICAO' && wind) parts.push(wind);
  if (ast.number != null) parts.push(`number ${spokenDigits(String(ast.number), v)}`);
  if (ast.trafficInfo) parts.push(`traffic ${ast.trafficInfo}`);
  parts.push(`runway ${rwy}`);
  parts.push('cleared to land');
  if (ast.lahso) parts.push(`hold short of ${/^\d/.test(ast.lahso) ? 'runway ' + spokenRunway(ast.lahso, v) : 'taxiway ' + spokenTaxiway(ast.lahso)} for crossing traffic`);
  if (ast.exit) parts.push(exitPhrase(ast.exit, v));
  if (v === 'FAA' && wind) parts.push(wind);
  return parts.join(', ');
}
function landReadback(ast: ClearedLandAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts = [`cleared to land runway ${spokenRunway(ast.runway, v)}`];
  if (ast.lahso) parts.push(`hold short of ${/^\d/.test(ast.lahso) ? 'runway ' + spokenRunway(ast.lahso, v) : spokenTaxiway(ast.lahso)}`);
  if (ast.exit) parts.push(exitReadback(ast.exit));
  return parts.join(', ');
}

function goAroundPhrase(ast: GoAroundAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts = ['go around, I say again, go around'];
  if (ast.reason) parts.push(ast.reason);
  if (ast.heading === 'runway') parts.push('fly runway heading');
  else if (typeof ast.heading === 'number') parts.push(`fly heading ${spokenHeading(ast.heading, ctx)}`);
  if (ast.alt != null) parts.push(`climb ${v === 'FAA' ? 'and maintain ' : 'to '}${spokenAltitude(ast.alt, v, ctx.transitionAltFt)}`);
  if (ast.contact) parts.push(spokenContact(ast.contact, ctx));
  return parts.join(', ');
}
function goAroundReadback(ast: GoAroundAst, ctx: PhraseCtx): string {
  const parts = ['going around'];
  if (ast.heading === 'runway') parts.push('runway heading');
  else if (typeof ast.heading === 'number') parts.push(`heading ${spokenHeading(ast.heading, ctx)}`);
  if (ast.alt != null) parts.push(`climbing ${spokenAltitude(ast.alt, ctx.variant, ctx.transitionAltFt)}`);
  if (ast.contact) parts.push(`${positionWord(ast.contact, ctx)}${ctx.freq(ast.contact) ? ' ' + spokenFrequency(ctx.freq(ast.contact), ctx.variant) : ''}`);
  return parts.join(', ');
}

function holdPhrase(ast: HoldAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts = [`hold at ${spokenFix(ast.fix)}`];
  if (ast.inbound != null) parts.push(`inbound course ${spokenHeading(ast.inbound, ctx)}`);
  else parts.push('as published');
  if (ast.dir) parts.push(`${dirWord(ast.dir)} turns`);
  if (ast.legNM != null) parts.push(`${spokenDigits(String(ast.legNM), v)} mile legs`);
  else if (ast.legTimeMin != null) parts.push(`${spokenDigits(String(ast.legTimeMin), v)} minute legs`);
  if (ast.efc != null) parts.push(`expect further clearance at ${spokenEfc(ast.efc, v)}`);
  return parts.join(', ');
}
function holdReadback(ast: HoldAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts = [`hold at ${spokenFix(ast.fix)}`];
  if (ast.inbound != null) parts.push(`inbound ${spokenHeading(ast.inbound, ctx)}`);
  else parts.push('as published');
  if (ast.dir) parts.push(`${dirWord(ast.dir)} turns`);
  if (ast.legNM != null) parts.push(`${spokenDigits(String(ast.legNM), v)} mile legs`);
  else if (ast.legTimeMin != null) parts.push(`${spokenDigits(String(ast.legTimeMin), v)} minute legs`);
  if (ast.efc != null) parts.push(`EFC ${spokenEfc(ast.efc, v)}`);
  return parts.join(', ');
}

function ilsPhrase(ast: IlsAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const rwy = spokenRunway(ast.runway, v);
  const core = v === 'FAA' ? `cleared ILS runway ${rwy} approach` : `cleared ILS approach runway ${rwy}`;
  return ast.reportEstablished ? `${core}, report established` : core;
}
function ilsReadback(ast: IlsAst, ctx: PhraseCtx): string {
  return `cleared ILS runway ${spokenRunway(ast.runway, ctx.variant)}${ast.reportEstablished ? ', will report established' : ''}`;
}

function approachWord(t: ApproachType): string {
  return t === 'ILS' ? 'ILS' : t === 'LOC' ? 'localizer' : t === 'RNAV' ? 'RNAV' : 'visual';
}

function reportItemPhrase(item: ReportKind): string {
  switch (item) {
    case 'position': return 'report position';
    case 'heading': return 'say heading';
    case 'altitude': return 'say altitude';
    case 'airspeed': return 'say airspeed';
    case 'pob': return 'say persons on board';
    case 'fuel': return 'say fuel remaining in minutes';
    case 'nature': return 'say nature of the emergency';
    case 'dg': return 'say dangerous goods on board';
    case 'intentions': return 'say intentions';
    case 'established': return 'report established';
    case 'vacated': return 'report runway vacated';
    case 'ready': return 'report ready for departure';
    case 'reason': return 'say reason for the go-around';
    case 'readyou5': return 'read you five';
    case 'four_mile_final': return 'report four mile final';
    case 'rolling': return 'report rolling';
  }
}
function reportItemReadback(item: ReportKind, ctx: PhraseCtx): string {
  const a = ctx.aircraft;
  const v = ctx.variant;
  switch (item) {
    case 'position': return a?.holdShortNode ? `holding short runway ${spokenRunway(a.holdShortRunway ?? '', v)}` : a?.phase === 'taxi' ? 'taxiing' : 'position noted';
    case 'heading': return a ? `heading ${spokenHeading(a.heading, ctx)}` : 'heading';
    case 'altitude': return a ? `${a.targetAltitude !== a.altitude ? `passing ${spokenAltitude(Math.round(a.altitude / 100) * 100, v, ctx.transitionAltFt)} for ${spokenAltitude(a.targetAltitude, v, ctx.transitionAltFt)}` : `level ${spokenAltitude(a.altitude, v, ctx.transitionAltFt)}`}` : 'altitude';
    case 'airspeed': return a ? spokenSpeed(a.speed, v) : 'airspeed';
    case 'pob': return a?.emergency ? `${spokenDigits(String(a.emergency.soulsOnBoard), v)} persons on board` : 'persons on board';
    case 'fuel': return a ? `fuel ${spokenDigits(String(Math.round(a.emergency?.fuelMin ?? a.fuelMin ?? 60)), v)} minutes` : 'fuel';
    case 'nature': return a?.emergency ? a.emergency.type.replace('_', ' ') : 'nature';
    case 'dg': return 'no dangerous goods';
    case 'intentions': return a?.emergency?.requests[0] ?? 'request priority landing';
    case 'established': return 'wilco';
    case 'vacated': return 'wilco';
    case 'ready': return 'wilco';
    case 'reason': return 'unstable approach';
    case 'readyou5': return 'read you five';
    case 'four_mile_final': return 'wilco';
    case 'rolling': return 'wilco';
  }
}

function unableReasonWord(r: UnableReason): string {
  switch (r) {
    case 'traffic': return 'traffic';
    case 'wake': return 'wake turbulence';
    case 'runway_closed': return 'runway closed';
    case 'slot': return 'slot';
    case 'standby': return 'standby';
    case 'delay': return 'expect delay';
    case 'weather': return 'weather';
  }
}

function speedPhrase(ast: SpeedAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  if (ast.kts === 'resume') return v === 'FAA' ? 'resume normal speed' : 'no speed restrictions';
  const a = ctx.aircraft;
  const verb = a && a.speed > ast.kts + 5 ? 'reduce speed to' : a && a.speed < ast.kts - 5 ? 'increase speed to' : 'maintain';
  const until = ast.untilNM != null ? ` until ${spokenDigits(String(ast.untilNM), v)} mile final` : '';
  return `${verb} ${spokenSpeed(ast.kts, v)}${until}`;
}
function speedReadback(ast: SpeedAst, ctx: PhraseCtx): string {
  const v = ctx.variant;
  if (ast.kts === 'resume') return 'resuming normal speed';
  return `speed ${spokenSpeed(ast.kts, v)}${ast.untilNM != null ? ` until ${spokenDigits(String(ast.untilNM), v)} miles` : ''}`;
}

function vehicleCallsign(id: string): string {
  const m = id.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return id;
  const names: Record<string, string> = { FIRE: 'Fire', AMB: 'Medic', FOLLOW: 'Follow-me', TUG: 'Tug', OPS: 'Ops', SWEEP: 'Sweeper', BIRD: 'Bird', FUEL: 'Fuel', ICE: 'Iceman', DEICE: 'Iceman' };
  return `${names[m[1]] ?? m[1]} ${m[2]}`;
}

function targetPhrase(t: VehicleTarget, v: V): string {
  switch (t.kind) {
    case 'runway': return `runway ${spokenRunway(t.runway, v)}`;
    case 'aircraft': return `the ${t.callsign}`;
    case 'stand': return `stand ${spokenStand(t.ref, v)}`;
    case 'point': return 'the reported position';
    case 'station': return 'your station';
  }
}

/** Core phrase (no callsign, no capitalisation) for ONE single command. */
function txCore(ast: SingleAircraftCommand | SystemCommand, ctx: PhraseCtx): string {
  const v = ctx.variant;
  switch (ast.kind) {
    case 'startup': return `start-up approved${ast.expectRunway ? `, expect runway ${spokenRunway(ast.expectRunway, v)}` : ''}${ctx.qnh != null ? `, ${spokenQnh(ctx.qnh, v)}` : ''}`;
    case 'pushback': {
      const face = ast.dir !== 'any' ? `, face ${{ N: 'north', E: 'east', S: 'south', W: 'west' }[ast.dir]}` : '';
      const tail = ast.tailTo ? `, tail to ${spokenTaxiway(ast.tailTo)}` : '';
      return `${ast.startup ? 'start-up and ' : ''}pushback approved${face}${tail}${ast.expectRunway ? `, expect runway ${spokenRunway(ast.expectRunway, v)}` : ''}`;
    }
    case 'taxi': return taxiPhrase(ast, ctx);
    case 'holdShort': return holdTargetPhrase(ast.of, v);
    case 'holdPosition': return `hold position${ast.reason ? `, ${ast.reason}` : ''}`;
    case 'continue': return `continue taxi${ast.holdShortOf ? `, ${holdTargetPhrase(ast.holdShortOf, v)}` : ''}`;
    case 'cross': return ast.behind
      ? `behind the landing ${trafficWord(ast.behind, ctx)}, cross runway ${spokenRunway(ast.runway, v)}, behind${ast.expedite ? ', expedite' : ''}`
      : `cross runway ${spokenRunway(ast.runway, v)}${ast.expedite ? ', expedite' : ''}, report vacated`;
    case 'giveWay': return ast.mode === 'follow'
      ? `follow the ${trafficWord(ast.to, ctx)} ahead`
      : `give way to the ${trafficWord(ast.to, ctx)}, then continue`;
    case 'lineup': {
      const rwy = spokenRunway(ast.runway, v);
      const at = ast.intersection ? ` at ${spokenTaxiway(ast.intersection)}` : '';
      if (ast.behind) return `behind the landing ${trafficWord(ast.behind, ctx)}, line up and wait runway ${rwy}${at}, behind`;
      return `runway ${rwy}${at}, line up and wait${ast.trafficInfo ? `, traffic ${ast.trafficInfo}` : ''}`;
    }
    case 'takeoff': return takeoffPhrase(ast, ctx);
    case 'cancelTakeoff': {
      const a = ctx.aircraft;
      const rolling = a && a.phase === 'takeoff' && a.speed > 5;
      const cs = a ? ctx.telephony(a.callsign) : '';
      if (rolling) return `stop immediately, ${cs} stop immediately${ast.reason ? `, ${ast.reason}` : ''}`;
      const ct = v === 'FAA' ? 'cancel takeoff clearance' : 'cancel takeoff';
      return `hold position, ${ct}, I say again, ${ct}${ast.reason ? `, ${ast.reason}` : ''}`;
    }
    case 'cancelLineup': return `vacate runway${ast.via ? ` via ${spokenTaxiway(ast.via)}` : ', next available exit'}, hold short`;
    case 'exitAt': {
      const parts = [exitPhrase(ast.exit, v)];
      if (ast.expedite) parts.push('expedite, traffic on short final');
      if (ast.holdShortOf) parts.push(`after vacating ${holdTargetPhrase(ast.holdShortOf, v)}`);
      if (ast.contactGround) parts.push(`when vacated ${spokenContact('ground', ctx)}`);
      return parts.join(', ');
    }
    case 'expedite': return ast.on ? `expedite ${ast.scope}` : `cancel expedite, normal ${ast.scope}`;
    case 'clearedLand': return landPhrase(ast, ctx);
    case 'continueApproach': return `continue approach${ast.number != null ? `, number ${spokenDigits(String(ast.number), v)}` : ''}, expect late landing clearance`;
    case 'goAround': return goAroundPhrase(ast, ctx);
    case 'windCheck': return ctx.wind ? spokenWind(ctx.wind, v, ctx.magVar) : 'wind calm';
    case 'contact': {
      const c = spokenContact(ast.position, ctx);
      switch (ast.when) {
        case 'now': return c;
        case 'when_vacated': return `when vacated ${c}`;
        case 'on_reaching': return `on reaching ${c}`;
        case 'at_hold': return `at the holding point ${c}`;
      }
      return c;
    }
    case 'heading': return headingPhrase(ast, ctx);
    case 'altitude': {
      const { before, after } = condPhrase(ast.when, ctx);
      return `${before}${altitudePhrase(ast.ft, ast.expedite, ctx)}${after}`;
    }
    case 'speed': return speedPhrase(ast, ctx);
    case 'direct': return `proceed direct ${spokenFix(ast.fix)}${ast.thenHdg != null ? `, then fly heading ${spokenHeading(ast.thenHdg, ctx)}` : ''}`;
    case 'hold': return holdPhrase(ast, ctx);
    case 'ils': return ilsPhrase(ast, ctx);
    case 'loc': return `cleared localizer${v === 'FAA' ? ` runway ${spokenRunway(ast.runway, v)} approach` : ` approach runway ${spokenRunway(ast.runway, v)}`}${ast.maintainAlt != null ? `, maintain ${spokenAltitude(ast.maintainAlt, v, ctx.transitionAltFt)} until established` : ''}`;
    case 'visual': return `${ast.follow ? `follow the ${trafficWord(ast.follow, ctx)}, ` : ''}cleared visual approach runway ${spokenRunway(ast.runway, v)}${ast.follow ? ', caution wake turbulence' : ''}`;
    case 'cancelApproach': return `cancel approach clearance, turn ${dirWord(ast.dir) || 'left'} heading ${spokenHeading(ast.hdg, ctx)}, climb ${v === 'FAA' ? 'and maintain ' : 'to '}${spokenAltitude(ast.alt, v, ctx.transitionAltFt)}${ast.reason ? `, ${ast.reason}` : ''}`;
    case 'expectRunway': return `expect ${approachWord(ast.approach)} approach runway ${spokenRunway(ast.runway, v)}${ctx.atisLetter ? `, information ${spellPhonetic(ctx.atisLetter)}` : ''}`;
    case 'resumeSid': return 'resume own navigation, climb via SID';
    case 'squawk': return `squawk ${spokenSquawk(ast.code, v)}`;
    case 'ident': return 'squawk ident';
    case 'radarContact': {
      const parts = [`${ctx.unit('approach') || 'approach'}, radar contact`];
      if (ast.descendTo != null) parts.push(altitudePhrase(ast.descendTo, false, ctx));
      if (ctx.qnh != null) parts.push(spokenQnh(ctx.qnh, v));
      if (ast.expectRunway) parts.push(`expect ILS ${v === 'FAA' ? `runway ${spokenRunway(ast.expectRunway, v)} approach` : `approach runway ${spokenRunway(ast.expectRunway, v)}`}`);
      return parts.join(', ');
    }
    case 'sayAgain': return 'say again';
    case 'correction': return `negative, ${correctionPhrase(ast.field, ast.value, ctx)}, I say again, ${correctionPhrase(ast.field, ast.value, ctx)}`;
    case 'disregard': return 'disregard';
    case 'standby': return 'standby';
    case 'unable': return ast.reason === 'standby' ? 'unable, standby' : ast.reason === 'delay' ? 'expect delay, standby' : `unable, ${unableReasonWord(ast.reason)}, standby`;
    case 'report': return ast.items.length ? ast.items.map(reportItemPhrase).join(', ') : 'report position';
    case 'roger': return 'roger';
    case 'emergencyAck': {
      const a = ctx.aircraft;
      const level = a?.emergency?.level === 'PAN' ? 'PAN PAN' : 'MAYDAY';
      const unit = ctx.unit(a?.onFrequency ?? 'tower');
      const parts = [`roger ${level}${unit ? `, ${unit}` : ''}`];
      if (ast.squawk && a?.emergency?.type !== 'hijack' && a?.emergency?.type !== 'radio_failure') parts.push('squawk seven seven zero zero');
      const asks: string[] = [];
      if (ast.ask.includes('pob')) asks.push(v === 'FAA' ? 'souls on board' : 'persons on board');
      if (ast.ask.includes('fuel')) asks.push(v === 'FAA' ? 'fuel remaining in minutes' : 'endurance');
      if (ast.ask.includes('nature')) asks.push('nature of the emergency');
      if (ast.ask.includes('dg')) asks.push('dangerous goods on board');
      if (asks.length) parts.push(`${v === 'FAA' ? 'say' : 'report'} ${asks.join(' and ')}`);
      if (ast.ask.includes('intentions')) parts.push('state intentions');
      return parts.join(', ');
    }
    case 'priority': {
      const rwy = spokenRunway(ast.runway, v);
      const parts = [`roger, expect runway ${rwy}`];
      if (ast.numberOne) parts.push('you are number one');
      if (ast.straightIn) parts.push('straight-in');
      if (ast.clearIls) parts.push(v === 'FAA' ? `cleared ILS runway ${rwy} approach` : `cleared ILS approach runway ${rwy}`);
      if (ast.sterile) parts.push('runway is yours, no delay');
      parts.push('emergency services are alerted');
      return parts.join(', ');
    }
    case 'stopOnRunway': return ast.mode === 'stop'
      ? 'after landing stop on the runway if able, fire services are positioned'
      : `after landing vacate if able${ast.via ? ` via ${spokenTaxiway(ast.via)}` : ''}, fire services will follow you`;
    case 'emergencyCancelAck': return `roger, ${ctx.aircraft?.emergency?.level === 'PAN' ? 'PAN PAN' : 'MAYDAY'} cancelled`;
    // ── system ──
    case 'holdAll': {
      const unit = ctx.unit('tower') || 'tower';
      const scope = ast.scope === 'departures' ? `all departures runway ${ast.runway ? spokenRunway(ast.runway, v) : ''} hold position`
        : ast.scope === 'crossings' ? `all aircraft holding short${ast.runway ? ` of runway ${spokenRunway(ast.runway, v)}` : ''}, hold position, no crossings`
        : 'all aircraft hold position';
      return `all stations, ${unit}, emergency in progress, ${scope}`;
    }
    case 'resumeAll': return `all stations, ${ctx.unit('tower') || 'tower'}, emergency terminated, resume normal operations`;
    case 'reopenRunway': return ast.afterInspection
      ? `Ops 1, enter runway ${spokenRunway(ast.runway, v)}, runway closed, report inspection complete`
      : `all stations, runway ${spokenRunway(ast.runway, v)} is open`;
    case 'dispatchVehicle': {
      const names = ast.ids.length ? ast.ids.map(vehicleCallsign) : [ast.type === 'arff' ? `Fire ${Array.from({ length: Math.max(1, ast.count) }, (_, i) => i + 1).join(', ')}` : vehicleCallsign(`${ast.type.toUpperCase()}1`)];
      const who = names.join(', ');
      if (ast.type === 'arff') return `${who}, proceed to ${targetPhrase(ast.target, v)}${ast.target.kind === 'runway' ? ', runway is yours' : ''}`;
      if (ast.type === 'ops') return `${who}, enter ${targetPhrase(ast.target, v)} for inspection, report complete`;
      if (ast.type === 'followme') return `${who}, proceed to meet ${targetPhrase(ast.target, v)}`;
      if (ast.type === 'bird') return `${who}, proceed to ${targetPhrase(ast.target, v)}, bird activity reported, report dispersed`;
      return `${who}, proceed to ${targetPhrase(ast.target, v)}`;
    }
    case 'recallVehicle': return `${vehicleCallsign(ast.id)}, return to base`;
    case 'vehicleOp': {
      const who = vehicleCallsign(ast.id);
      switch (ast.op) {
        case 'hold': return `${who}, hold position`;
        case 'continue': return `${who}, continue`;
        case 'cross': return `${who}, cross runway ${ast.runway ? spokenRunway(ast.runway, v) : ''}, report vacated`;
        case 'rtb': return `${who}, return to base`;
      }
      return who;
    }
    case 'runwayStatus': return `all stations, runway ${spokenRunway(ast.runway, v)} is ${ast.status === 'open' ? 'open' : ast.status === 'inspection' ? 'closed for inspection' : ast.status === 'sterile' ? 'sterile for emergency traffic' : 'closed'}${ast.reason ? `, ${ast.reason}` : ''}`;
    case 'broadcast': return `all stations, ${ctx.unit('tower') || 'tower'}, ${ast.text}`;
  }
}

function correctionPhrase(field: CorrectionField, value: number | string, ctx: PhraseCtx): string {
  const v = ctx.variant;
  switch (field) {
    case 'heading': return `heading ${spokenHeading(Number(value), ctx)}`;
    case 'altitude': return spokenAltitude(Number(value), v, ctx.transitionAltFt);
    case 'speed': return `speed ${spokenSpeed(Number(value), v)}`;
    case 'runway': return `runway ${spokenRunway(String(value), v)}`;
    case 'squawk': return `squawk ${spokenSquawk(String(value), v)}`;
    case 'frequency': return spokenFrequency(String(value), v);
    case 'taxiway': return `taxiway ${spokenTaxiway(String(value))}`;
  }
}

/** Pilot readback core (no callsign) for ONE single command. */
function rbCore(ast: SingleAircraftCommand, ctx: PhraseCtx): string {
  const v = ctx.variant;
  switch (ast.kind) {
    case 'startup': return `start-up approved${ast.expectRunway ? `, runway ${spokenRunway(ast.expectRunway, v)}` : ''}${ctx.qnh != null ? `, ${spokenQnh(ctx.qnh, v)}` : ''}`;
    case 'pushback': {
      const face = ast.dir !== 'any' ? `, facing ${{ N: 'north', E: 'east', S: 'south', W: 'west' }[ast.dir]}` : '';
      return `${ast.startup ? 'start-up and ' : ''}pushback approved${face}${ast.expectRunway ? `, expect runway ${spokenRunway(ast.expectRunway, v)}` : ''}`;
    }
    case 'taxi': return taxiReadback(ast, ctx);
    case 'holdShort': return holdTargetPhrase(ast.of, v, true);
    case 'holdPosition': return ctx.aircraft?.phase === 'pushback' ? 'stopping' : 'holding position';
    case 'continue': return `continue taxi${ast.holdShortOf ? `, ${holdTargetPhrase(ast.holdShortOf, v, true)}` : ''}`;
    case 'cross': return ast.behind
      ? `behind the landing ${trafficWord(ast.behind, ctx)}, cross runway ${spokenRunway(ast.runway, v)}, behind`
      : `cross runway ${spokenRunway(ast.runway, v)}${ast.expedite ? ', expediting' : ''}, wilco`;
    case 'giveWay': return ast.mode === 'follow' ? `following the ${trafficWord(ast.to, ctx)}` : `give way to the ${trafficWord(ast.to, ctx)}`;
    case 'lineup': {
      const rwy = spokenRunway(ast.runway, v);
      if (ast.behind) return `behind the landing ${trafficWord(ast.behind, ctx)}, line up and wait runway ${rwy}, behind`;
      return `runway ${rwy}${ast.intersection ? ` at ${spokenTaxiway(ast.intersection)}` : ''}, line up and wait${ast.trafficInfo ? ', traffic in sight' : ''}`;
    }
    case 'takeoff': return takeoffReadback(ast, ctx);
    case 'cancelTakeoff': {
      const a = ctx.aircraft;
      return a && a.phase === 'takeoff' && a.speed > 5 ? 'stopping' : 'holding position';
    }
    case 'cancelLineup': return `vacating${ast.via ? ` via ${spokenTaxiway(ast.via)}` : ''}, hold short`;
    case 'exitAt': {
      const parts = [exitReadback(ast.exit)];
      if (ast.expedite) parts.push('expediting');
      if (ast.holdShortOf) parts.push(`${holdTargetPhrase(ast.holdShortOf, v, true)} after vacating`);
      if (ast.contactGround) parts.push(`ground${ctx.freq('ground') ? ' ' + spokenFrequency(ctx.freq('ground'), v) : ''} when vacated`);
      return parts.join(', ');
    }
    case 'expedite': return ast.on ? 'expediting' : 'roger';
    case 'clearedLand': return landReadback(ast, ctx);
    case 'continueApproach': return 'continue approach';
    case 'goAround': return goAroundReadback(ast, ctx);
    case 'windCheck': return 'roger';
    case 'contact': {
      const f = ctx.freq(ast.position);
      const who = `${positionWord(ast.position, ctx)}${f ? ' ' + spokenFrequency(f, v) : ''}`;
      const when = ast.when === 'when_vacated' ? ' when vacated' : ast.when === 'on_reaching' ? ' on reaching' : ast.when === 'at_hold' ? ' at the holding point' : '';
      const bye = ast.position === 'external' || ast.position === 'departure' ? ', good day' : '';
      return `${who}${when}${bye}`;
    }
    case 'heading': return headingReadback(ast, ctx);
    case 'altitude': {
      const cond = ast.when ? condPhrase(ast.when, ctx).before : '';
      return `${cond}${altitudeReadback(ast.ft, ast.expedite, ctx)}`;
    }
    case 'speed': return speedReadback(ast, ctx);
    case 'direct': return `direct ${spokenFix(ast.fix)}${ast.thenHdg != null ? `, then heading ${spokenHeading(ast.thenHdg, ctx)}` : ''}`;
    case 'hold': return holdReadback(ast, ctx);
    case 'ils': return ilsReadback(ast, ctx);
    case 'loc': return `cleared localizer ${spokenRunway(ast.runway, v)}${ast.maintainAlt != null ? `, maintain ${spokenAltitude(ast.maintainAlt, v, ctx.transitionAltFt)}` : ''}`;
    case 'visual': return `cleared visual approach runway ${spokenRunway(ast.runway, v)}${ast.follow ? `, following the ${trafficWord(ast.follow, ctx)}` : ''}`;
    case 'cancelApproach': return `cancel approach, ${dirWord(ast.dir) || 'left'} heading ${spokenHeading(ast.hdg, ctx)}, climb ${spokenAltitude(ast.alt, v, ctx.transitionAltFt)}`;
    case 'expectRunway': return `expect ${approachWord(ast.approach)} ${spokenRunway(ast.runway, v)}${ctx.atisLetter ? `, information ${spellPhonetic(ctx.atisLetter)}` : ''}`;
    case 'resumeSid': return 'resume own navigation, climb via SID';
    case 'squawk': return `squawk ${spokenSquawk(ast.code, v)}`;
    case 'ident': return 'ident';
    case 'radarContact': {
      const parts = ['radar contact'];
      if (ast.descendTo != null) parts.push(altitudeReadback(ast.descendTo, false, ctx));
      if (ctx.qnh != null) parts.push(spokenQnh(ctx.qnh, v));
      if (ast.expectRunway) parts.push(`ILS ${spokenRunway(ast.expectRunway, v)}`);
      return parts.join(', ');
    }
    case 'sayAgain': return sayAgainReply(ctx);
    case 'correction': return correctionPhrase(ast.field, ast.value, ctx);
    case 'disregard': return 'disregard';
    case 'standby': return 'standing by';
    case 'unable': return 'roger, standing by';
    case 'report': return ast.items.length ? ast.items.map(i => reportItemReadback(i, ctx)).join(', ') : reportItemReadback('position', ctx);
    case 'roger': return '';
    case 'emergencyAck': {
      const a = ctx.aircraft;
      const e = a?.emergency;
      if (!e) return 'roger';
      if (e.type === 'radio_failure') return '';
      if (e.type === 'hijack') return 'affirm';
      const parts: string[] = [];
      if (ast.ask.includes('pob')) parts.push(`${spokenDigits(String(e.soulsOnBoard), v)} ${v === 'FAA' ? 'souls on board' : 'persons on board'}`);
      if (ast.ask.includes('fuel')) parts.push(`fuel ${spokenDigits(String(Math.round(e.fuelMin ?? a?.fuelMin ?? 60)), v)} minutes`);
      if (ast.ask.includes('nature')) parts.push(emergencyNatureWord(e.type));
      if (ast.ask.includes('dg')) parts.push('no dangerous goods');
      if (ast.ask.includes('intentions')) parts.push(e.requests[0] ?? (e.runway || a?.plan.runway ? `request ILS ${spokenRunway(e.runway ?? a?.plan.runway ?? '', v)}` : 'request priority landing'));
      return parts.join(', ') || 'roger';
    }
    case 'priority': return `${ast.clearIls ? `cleared ILS ${spokenRunway(ast.runway, v)}` : `runway ${spokenRunway(ast.runway, v)}`}${ast.numberOne ? ', number one' : ''}`;
    case 'stopOnRunway': return ast.mode === 'stop' ? 'stopping on the runway' : `vacating if able${ast.via ? ` via ${spokenTaxiway(ast.via)}` : ''}`;
    case 'emergencyCancelAck': return 'roger';
  }
}

/** Spoken nature of an emergency for pilot answers. */
export function emergencyNatureWord(type: EmergencyType): string {
  switch (type) {
    case 'engine_fire': return 'engine fire';
    case 'engine_failure': return 'engine failure';
    case 'medical': return 'medical emergency, passenger unconscious';
    case 'fuel': return 'fuel emergency';
    case 'depressurization': return 'depressurization';
    case 'bird_strike': return 'bird strike';
    case 'gear': return 'unsafe gear indication';
    case 'smoke': return 'smoke in the cabin';
    case 'hydraulic': return 'hydraulic failure';
    case 'hijack': return 'unlawful interference';
    case 'radio_failure': return 'radio failure';
    case 'general': return 'flight control problem';
    case 'brake_fire': return 'hot brakes, possible brake fire';
  }
}

/** Pilot repeats the last transmission ("say again" answer) when the ctx knows it. */
function sayAgainReply(ctx: PhraseCtx): string {
  const last = ctx.aircraft?.readback.text;
  if (last) return last.replace(/,\s*[^,]+\.$/, '').replace(/\.$/, '');
  return 'say again';
}

/**
 * Controller line for an AST. Sequences are rendered as ONE transmission in
 * ICAO word order with the callsign once at the start (UX §1.5 example:
 * "BAW117, descend to 3000, cleared ILS approach runway 27L, report established.").
 * The log shows the ICAO callsign; `{cs}` in speech is telephony.
 */
export function transmission(ast: CommandAST, ctx: PhraseCtx): string {
  if (isSystemCommand(ast)) return sentence(txCore(ast, ctx));
  const cs = csOf(ast, ctx);
  if (ast.kind === 'sequence') {
    const parts = sortParts(ast.parts).map(p => txCore(p, ctx)).filter(Boolean);
    return sentence(`${cs}, ${parts.join(', ')}`);
  }
  const core = txCore(ast, ctx);
  if (ast.kind === 'roger') return sentence(`${cs}, roger`);
  return sentence(`${cs}, ${core}`);
}

/**
 * Pilot readback for an AST. `variant` overrides ctx.variant. `refused` parts
 * (from the engine outcome) render as "unable {part}" inside the readback and
 * the rest is read back normally (UX §1.5 pilot-side partial refusal). Callsign
 * comes LAST ("..., Speedbird 117.").
 */
export function readback(ast: CommandAST, ctx: PhraseCtx, variant?: PhraseVariant, refused: SingleAircraftCommand[] = []): string {
  const c: PhraseCtx = variant && variant !== ctx.variant ? { ...ctx, variant } : ctx;
  if (isSystemCommand(ast)) return systemReadback(ast, c);
  const cs = csOf(ast, c);
  const isRefused = (p: SingleAircraftCommand) => refused.some(r => r === p || (r.kind === p.kind && JSON.stringify(r) === JSON.stringify(p)));
  const one = (p: SingleAircraftCommand): string => (isRefused(p) ? `unable ${unableFragment(p, c)}` : rbCore(p, c));
  if (ast.kind === 'sequence') {
    const parts = sortParts(ast.parts).map(one).filter(Boolean);
    return sentence(`${parts.join(', ')}, ${cs}`);
  }
  if (ast.kind === 'roger') return '';
  const core = one(ast);
  if (!core) return '';
  return sentence(`${core}, ${cs}`);
}

/** Driver / station acknowledgement for system commands (vehicles read back; broadcasts have none). */
function systemReadback(ast: SystemCommand, ctx: PhraseCtx): string {
  const v = ctx.variant;
  switch (ast.kind) {
    case 'holdAll': case 'resumeAll': case 'broadcast': case 'runwayStatus': return '';
    case 'reopenRunway': return ast.afterInspection ? sentence(`entering runway ${spokenRunway(ast.runway, v)}, Ops 1`) : '';
    case 'dispatchVehicle': {
      const names = ast.ids.length ? ast.ids.map(vehicleCallsign) : [ast.type === 'arff' ? 'Fire station' : vehicleCallsign(`${ast.type.toUpperCase()}1`)];
      return sentence(`${ast.type === 'arff' && !ast.ids.length ? 'Fire station copies, rolling' : `proceeding to ${targetPhrase(ast.target, v)}, ${names.join(' and ')}`}`);
    }
    case 'recallVehicle': return sentence(`returning to base, ${vehicleCallsign(ast.id)}`);
    case 'vehicleOp': {
      const who = vehicleCallsign(ast.id);
      switch (ast.op) {
        case 'hold': return sentence(`holding position, ${who}`);
        case 'continue': return sentence(`continuing, ${who}`);
        case 'cross': return sentence(`crossing ${ast.runway ? spokenRunway(ast.runway, v) : 'runway'}, ${who}`);
        case 'rtb': return sentence(`returning to base, ${who}`);
      }
      return '';
    }
  }
}

/** The short spoken fragment a pilot uses when refusing a part ("unable one six zero"). */
function unableFragment(ast: SingleAircraftCommand, ctx: PhraseCtx): string {
  const v = ctx.variant;
  switch (ast.kind) {
    case 'speed': return ast.kts === 'resume' ? 'speed' : spokenSpeed(ast.kts, v);
    case 'altitude': return spokenAltitude(ast.ft, v, ctx.transitionAltFt);
    case 'heading': return `heading ${spokenHeading(ast.hdg, ctx)}`;
    case 'clearedLand': return ast.lahso ? 'hold short' : `runway ${spokenRunway(ast.runway, v)}`;
    case 'exitAt': return ast.exit.kind === 'taxiway' ? spokenTaxiway(ast.exit.taxiway) : 'that exit';
    case 'takeoff': return ast.immediate ? 'immediate' : 'takeoff';
    case 'ils': case 'loc': case 'visual': return `${approachWord(ast.kind === 'ils' ? 'ILS' : ast.kind === 'loc' ? 'LOC' : 'VISUAL')} runway ${spokenRunway(ast.runway, v)}`;
    case 'direct': return `direct ${spokenFix(ast.fix)}`;
    case 'hold': return `hold at ${spokenFix(ast.fix)}`;
    case 'taxi': return ast.via.length ? `via ${spokenTaxiways(ast.via)}` : 'that routing';
    case 'lineup': return 'line up';
    case 'cross': return `cross runway ${spokenRunway(ast.runway, v)}`;
    default: return describe(ast).toLowerCase();
  }
}

/** Pilot "unable" line for a refused command ("Unable 160, minimum clean 210, Speedbird 117."). */
export function unableLine(ast: CommandAST, reason: string, ctx: PhraseCtx): string {
  const cs = csOf(ast, ctx);
  if (isSystemCommand(ast)) return sentence(`unable${reason ? `, ${reason}` : ''}`);
  const frag = ast.kind === 'sequence' ? (ast.parts.length ? unableFragment(ast.parts[0], ctx) : '') : unableFragment(ast, ctx);
  const r = reason ? `, ${reason.replace(/[.]+$/, '')}` : '';
  return sentence(`unable${frag ? ' ' + frag : ''}${r}, ${cs}`);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Pilot requests (UX §G8 catalogue)
// ──────────────────────────────────────────────────────────────────────────────
function unitOf(ctx: PhraseCtx): string {
  const a = ctx.aircraft;
  const pos = a?.onFrequency ?? 'ground';
  return ctx.unit(pos) || positionWord(pos, ctx).replace(/^./, c => c.toUpperCase());
}
function infoSuffix(ctx: PhraseCtx): string {
  return ctx.atisLetter ? `, information ${spellPhonetic(ctx.atisLetter)}` : '';
}

/** Spoken pilot request per UX §G8 catalogue ("Ground, Speedbird 117, stand 512, request pushback, information Kilo."). */
export function pilotRequestLine(req: PilotRequest, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const a = ctx.aircraft && ctx.aircraft.callsign === req.callsign.toUpperCase() ? ctx.aircraft : null;
  const cs = ctx.telephony(req.callsign);
  const unit = unitOf(ctx);
  const stand = a?.reservedStand ?? a?.plan.gateRef ?? null;
  const standPart = stand ? `, stand ${spokenStand(stand, v)}` : '';
  const rwy = (typeof req.param === 'string' && req.param) ? req.param : a?.holdShortRunway ?? a?.plan.runway ?? '';
  const spokenRwy = rwy ? spokenRunway(rwy, v) : 'runway';
  switch (req.kind) {
    case 'clearance': return sentence(`${unit}, ${cs}${standPart}, request IFR clearance${a?.plan.dest ? ` to ${a.plan.dest}` : ''}${infoSuffix(ctx)}`);
    case 'pushback': return sentence(`${unit}, ${cs}${standPart}, request pushback${infoSuffix(ctx)}`);
    case 'startup': return sentence(`${unit}, ${cs}${standPart}, request start-up${infoSuffix(ctx)}`);
    case 'taxi': return sentence(`${unit}, ${cs}, ready to taxi${infoSuffix(ctx)}`);
    case 'cross': return sentence(`${cs}, holding short runway ${spokenRwy}, request cross`);
    case 'ready': return sentence(v === 'FAA' ? `${unit}, ${cs}, holding short runway ${spokenRwy}, ready` : `${unit}, ${cs}, holding point runway ${spokenRwy}, ready for departure`);
    case 'with_you': return sentence(withYouLine(req, a, cs, unit, ctx));
    case 'higher': return sentence(`${cs}, request higher${typeof req.param === 'number' ? `, ${spokenAltitude(req.param, v, ctx.transitionAltFt)}` : ''}`);
    case 'lower': return sentence(`${cs}, request descent${typeof req.param === 'number' ? ` to ${spokenAltitude(req.param, v, ctx.transitionAltFt)}` : ''}`);
    case 'direct': return sentence(`${cs}, request direct ${typeof req.param === 'string' && req.param ? spokenFix(req.param) : a?.plan.fix ? spokenFix(a.plan.fix) : 'the field'}`);
    case 'hold': return sentence(`${cs}, request hold, or delay vectors`);
    case 'taxi_in': return sentence(`${unit}, ${cs}, runway vacated${typeof req.param === 'string' && req.param ? ` at ${spokenTaxiway(req.param)}` : ''}, request taxi${stand ? ` to stand ${spokenStand(stand, v)}` : ''}`);
    case 'say_again': return sentence(`${cs}, say again`);
    case 'radio_check': return sentence(`${unit}, ${cs}, radio check`);
    case 'cancel_mayday': return sentence(`${cs}, cancel ${a?.emergency?.level === 'PAN' ? 'PAN PAN' : 'MAYDAY'}${typeof req.param === 'string' && req.param ? `, ${req.param}` : ', problem resolved'}`);
    case 'return_to_stand': return sentence(`${cs}, request return to stand${typeof req.param === 'string' && req.param ? `, ${req.param}` : ', technical problem'}`);
    case 'wind_check': return sentence(`${cs}, request wind check`);
    case 'confirm_cleared': return sentence(`${cs}, ${typeof req.param === 'number' ? spokenDigits(String(req.param), v) : 'four'} mile final, confirm cleared to land`);
    case 'further': return sentence(`${cs}, request further clearance and revised expect further clearance time`);
    case 'intersection': return sentence(`${cs}, request intersection departure${typeof req.param === 'string' && req.param ? ` from ${spokenTaxiway(req.param)}` : ''}`);
    case 'runway_vacated': return sentence(`${cs}, runway ${spokenRwy} vacated`);
    case 'going_around': return sentence(`${cs}, going around${typeof req.param === 'string' && req.param ? `, ${req.param}` : ''}`);
  }
}

function withYouLine(req: PilotRequest, a: AircraftState | null, cs: string, unit: string, ctx: PhraseCtx): string {
  const v = ctx.variant;
  if (!a) return `${unit}, ${cs}, with you`;
  const info = infoSuffix(ctx);
  if (a.plan.kind === 'arrival') {
    if (a.ilsCaptured || a.phase === 'approach' || a.phase === 'landing') {
      const nm = typeof req.param === 'number' ? spokenDigits(String(Math.round(req.param)), v) : null;
      return `${unit}, ${cs}, ILS runway ${spokenRunway(a.assignedRunway ?? a.plan.runway ?? '', v)}${nm ? `, ${nm} miles` : ''}`;
    }
    if (a.phase === 'rollout' || a.phase === 'taxi') return `${unit}, ${cs}, runway vacated, request taxi${a.reservedStand ? ` to stand ${spokenStand(a.reservedStand, v)}` : ''}`;
    return `${unit}, ${cs}, ${spokenAltitude(Math.round(a.altitude / 100) * 100, v, ctx.transitionAltFt)}${a.targetAltitude < a.altitude - 100 ? ` descending ${spokenAltitude(a.targetAltitude, v, ctx.transitionAltFt)}` : ''}${info}`;
  }
  // departure
  if (a.phase === 'hold_short' || a.holdShortNode) return v === 'FAA' ? `${unit}, ${cs}, holding short runway ${spokenRunway(a.holdShortRunway ?? a.plan.runway ?? '', v)}` : `${unit}, ${cs}, holding point runway ${spokenRunway(a.holdShortRunway ?? a.plan.runway ?? '', v)}`;
  if (a.phase === 'taxi') return `${unit}, ${cs}, taxiing to runway ${spokenRunway(a.plan.runway ?? '', v)}`;
  // still on the runway (lined up / cleared, not yet airborne): never "passing zero climbing zero"
  if (a.phase === 'lineup' || (a.phase === 'takeoff' && a.altitude < 50)) return `${unit}, ${cs}, ${a.speed > 30 ? 'rolling' : 'lined up'} runway ${spokenRunway(a.plan.runway ?? '', v)}`;
  if (a.phase === 'takeoff' || a.phase === 'climb' || a.phase === 'cruise') return `${unit}, ${cs}, passing ${spokenAltitude(Math.round(a.altitude / 100) * 100, v, ctx.transitionAltFt)} climbing ${spokenAltitude(a.targetAltitude, v, ctx.transitionAltFt)}`;
  return `${unit}, ${cs}, with you${info}`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Emergency / safety / vehicle lines (03 §4, §7, §D4, §1.13)
// ──────────────────────────────────────────────────────────────────────────────
/** "{cs}, roger MAYDAY, Heathrow Tower, say intentions." */
export function emergencyAckLine(callsign: string, level: EmergencyLevel, ctx: PhraseCtx): string {
  const unit = ctx.unit(ctx.aircraft?.onFrequency ?? 'tower');
  return sentence(`${ctx.telephony(callsign)}, roger ${level === 'PAN' ? 'PAN PAN' : 'MAYDAY'}${unit ? `, ${unit}` : ''}, say intentions`);
}

/** "{cs}, say souls on board and fuel remaining in minutes" (ICAO: persons on board and endurance). */
export function soulsFuelQueryLine(callsign: string, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, ${ctx.variant === 'FAA' ? 'say souls on board and fuel remaining in minutes' : 'report persons on board and endurance'}`);
}

/** Pilot answer: "one four seven souls, fuel one hour two zero, {cs}". */
export function soulsFuelReplyLine(callsign: string, souls: number, fuelMin: number, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const h = Math.floor(fuelMin / 60), m = Math.round(fuelMin % 60);
  const fuel = h > 0 ? `${spokenDigits(String(h), v)} hour${h > 1 ? 's' : ''} ${spokenDigits(String(m).padStart(2, '0'), v)}` : `${spokenDigits(String(m), v)} minutes`;
  return sentence(`${spokenDigits(String(souls), v)} ${v === 'FAA' ? 'souls' : 'persons on board'}, fuel ${fuel}, ${ctx.telephony(callsign)}`);
}

/** "{cs}, traffic alert, {position}, turn left heading 240 immediately." */
export function trafficAlertLine(callsign: string, position: string, advice: string, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, traffic alert, ${position}, ${advice} immediately`);
}

/** "{cs}, low altitude alert, check your altitude immediately, the MVA in your area is 3000, climb 3000." */
export function lowAltitudeAlertLine(callsign: string, mvaFt: number, ctx: PhraseCtx): string {
  const alt = spokenAltitude(mvaFt, ctx.variant, ctx.transitionAltFt);
  return sentence(`${ctx.telephony(callsign)}, low altitude alert, check your altitude immediately, the MVA in your area is ${alt}, climb ${ctx.variant === 'FAA' ? 'and maintain ' : 'to '}${alt}`);
}

/** "{cs}, windshear alert, runway 27L arrival, 20 knot loss, 2 mile final." */
export function windshearAlertLine(callsign: string, alert: { runway: string; type: 'WS' | 'MB'; lossKt: number }, role: 'arrival' | 'departure', ctx: PhraseCtx): string {
  const v = ctx.variant;
  return sentence(`${ctx.telephony(callsign)}, ${alert.type === 'MB' ? 'microburst' : 'windshear'} alert, runway ${spokenRunway(alert.runway, v)} ${role}, ${spokenDigits(String(Math.round(alert.lossKt)), v)} knot loss, ${role === 'arrival' ? 'two mile final' : 'one mile final'}`);
}

/** "{cs}, information Kilo now current, QNH 1013." */
export function atisCurrentLine(callsign: string, letter: string, qnh: number | null, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, information ${spellPhonetic(letter)} now current${qnh != null ? `, ${spokenQnh(qnh, ctx.variant)}` : ''}`);
}

/** Controller acknowledgement of a pilot-initiated go-around: "{cs}, roger, fly runway heading, climb 3000, contact approach 119.7." */
export function goAroundAckLine(callsign: string, altFt: number, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, roger, fly runway heading, climb ${ctx.variant === 'FAA' ? 'and maintain ' : 'to '}${spokenAltitude(altFt, ctx.variant, ctx.transitionAltFt)}, ${spokenContact('approach', ctx)}`);
}

/** "{cs}, caution wake turbulence, departing heavy Boeing 777." */
export function wakeCautionLine(callsign: string, leaderType: string, leaderCat: 'HEAVY' | 'SUPER' | 'MEDIUM' | 'LIGHT', ctx: PhraseCtx): string {
  const cat = leaderCat === 'SUPER' ? 'super ' : leaderCat === 'HEAVY' ? 'heavy ' : '';
  return sentence(`${ctx.telephony(callsign)}, caution wake turbulence, departing ${cat}${ctx.spokenType(leaderType)}`);
}

/** "{cs}, hold for wake turbulence, heavy Boeing 777 departing, expect two minutes." */
export function wakeHoldLine(callsign: string, leaderType: string, minutes: number, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, hold for wake turbulence, ${ctx.spokenType(leaderType)} departing, expect ${spokenDigits(String(minutes), ctx.variant)} minutes`);
}

/** "{cs}, caution, bird activity reported in the vicinity of runway 27L." */
export function birdCautionLine(callsign: string, runway: string, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, caution, bird activity reported in the vicinity of runway ${spokenRunway(runway, ctx.variant)}`);
}

/** "{cs}, confirm squawking seven five zero zero." (once, never mention the hijack) */
export function confirm7500Line(callsign: string, ctx: PhraseCtx): string {
  return sentence(`${ctx.telephony(callsign)}, confirm squawking seven five zero zero`);
}

/** Transmit-blind line for radio failure: "{cs}, {unit}, if you read, turn left heading 240, acknowledge by ident." */
export function blindTransmissionLine(callsign: string, instruction: string, ctx: PhraseCtx): string {
  const unit = ctx.unit(ctx.aircraft?.onFrequency ?? 'tower');
  return sentence(`${ctx.telephony(callsign)}${unit ? `, ${unit}` : ''}, if you read, ${instruction}, acknowledge by ident`);
}

/** Vehicle driver lines (03 §1.13). */
export function vehicleLine(kind: 'request_cross' | 'crossing' | 'vacated' | 'onscene' | 'inspection_complete' | 'fod_found' | 'birds_dispersed' | 'rolling' | 'holding_short' | 'request_enter' | 'returning', vehicleId: string, runway: string | null, ctx: PhraseCtx, unitPosition: Position = 'ground'): string {
  const v = ctx.variant;
  const who = vehicleCallsign(vehicleId);
  const unit = ctx.unit(unitPosition) || positionWord(unitPosition, ctx).replace(/^./, c => c.toUpperCase());
  const rwy = runway ? spokenRunway(runway, v) : 'runway';
  switch (kind) {
    case 'request_cross': return sentence(`${unit}, ${who}, request cross runway ${rwy}`);
    case 'holding_short': return sentence(`${unit}, ${who}, holding short runway ${rwy}`);
    case 'crossing': return sentence(`crossing ${rwy}, ${who}`);
    case 'vacated': return sentence(`runway ${rwy} vacated, ${who}`);
    case 'onscene': return sentence(`${unit}, ${who}, on scene${runway ? ` runway ${rwy}` : ''}`);
    case 'inspection_complete': return sentence(`${unit}, ${who}, runway ${rwy} inspection complete, no FOD found, vacating`);
    case 'fod_found': return sentence(`${unit}, ${who}, FOD found on runway ${rwy}, request five more minutes`);
    case 'birds_dispersed': return sentence(`${unit}, ${who}, birds dispersed${runway ? ` runway ${rwy}` : ''}, returning to base`);
    case 'rolling': return sentence(`${unit}, ${who}, rolling${runway ? ` to runway ${rwy}` : ''}`);
    case 'request_enter': return sentence(`${unit}, ${who}, request enter runway ${rwy} for inspection`);
    case 'returning': return sentence(`${unit}, ${who}, returning to base`);
  }
}

/** ARFF intercom line (03 §7): "Local standby / full emergency, runway 27L, Boeing 737, engine fire, 147 souls, 80 minutes fuel, ETA 12 minutes." */
export function arffIntercomLine(level: 'local' | 'full', runway: string | null, type: string, nature: string, souls: number, fuelMin: number | null, etaMin: number | null, ctx: PhraseCtx): string {
  const v = ctx.variant;
  const parts = [level === 'full' ? 'full emergency' : 'local standby'];
  if (runway) parts.push(`runway ${spokenRunway(runway, v)}`);
  parts.push(ctx.spokenType(type), nature, `${souls} souls`);
  if (fuelMin != null) parts.push(`${Math.round(fuelMin)} minutes fuel`);
  if (etaMin != null) parts.push(`ETA ${Math.max(1, Math.round(etaMin))} minutes`);
  return sentence(parts.join(', '));
}

/** All aircraft-addressed AST kinds, for exhaustiveness tests. */
export const ALL_SINGLE_KINDS: readonly SingleAircraftCommand['kind'][] = [
  'startup', 'pushback', 'taxi', 'holdShort', 'holdPosition', 'continue', 'cross', 'giveWay', 'lineup', 'takeoff',
  'cancelTakeoff', 'cancelLineup', 'exitAt', 'expedite', 'clearedLand', 'continueApproach', 'goAround', 'windCheck', 'contact',
  'heading', 'altitude', 'speed', 'direct', 'hold', 'ils', 'loc', 'visual', 'cancelApproach', 'expectRunway', 'resumeSid',
  'squawk', 'ident', 'radarContact', 'sayAgain', 'correction', 'disregard', 'standby', 'unable', 'report', 'roger',
  'emergencyAck', 'priority', 'stopOnRunway', 'emergencyCancelAck',
];
