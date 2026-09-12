// ============================================================
//  Phraseology — CONTRACT STUB (W1-SYSTEMS implements)
//
//  Generates the controller transmission (TX) and the pilot readback (RB) from
//  a CommandAST, in the ICAO (default) or FAA variant (03 §7 table, §G5
//  telephony, UX 04 §1.4 TX/RB columns, §G5.15 FAA diff list). All three input
//  paths (click / typed / voice) produce identical radio lines because they
//  all go through here.
//
//  Implemented here (pure, spec'd): spoken numbers, runway/altitude/heading/
//  frequency speech, telephony table, magnetic conversion. Stubbed: the
//  per-kind templates (transmission / readback / pilotRequestLine).
// ============================================================
import type { CommandAST, SingleAircraftCommand } from './commandAst';
import type { AircraftState, PilotRequest, Position } from './types';

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
//  Templates (STUBS) — see 03 §7 (ICAO column) and UX 04 §1.4; FAA diff §G5.15:
//    taxi: ICAO "taxi to holding point runway 27L via A, B" / FAA "runway 27L, taxi via A, B"
//    ils:  ICAO "cleared ILS approach runway 27L" / FAA "cleared ILS runway 27L approach"
//    descend: ICAO "descend to 3000" / FAA "descend and maintain 3000"
//    wind: ICAO "wind 260 degrees 8 knots" / FAA "wind 260 at 8"
//    cancel takeoff: ICAO "cancel takeoff" / FAA "cancel takeoff clearance"
//    hold short / line up and wait / climb and maintain / expedite: same
//    frequencies: "decimal" (ICAO) vs "point" (FAA); QNH hPa vs "altimeter 29.92"
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Controller line for an AST. Sequences are rendered as ONE transmission in
 * ICAO word order with the callsign once at the start (UX §1.5 example:
 * "BAW117, descend to 3000, cleared ILS approach runway 27L, report established.").
 * The log shows the ICAO callsign; `{cs}` in speech is telephony.
 */
export function transmission(ast: CommandAST, ctx: PhraseCtx): string {
  void ast; void ctx;
  throw new Error('not implemented');
}

/**
 * Pilot readback for an AST. `variant` overrides ctx.variant. `refused` parts
 * (from the engine outcome) render as "unable {part}" inside the readback and
 * the rest is read back normally (UX §1.5 pilot-side partial refusal). Callsign
 * comes LAST ("..., Speedbird 117.").
 */
export function readback(ast: CommandAST, ctx: PhraseCtx, variant?: PhraseVariant, refused: SingleAircraftCommand[] = []): string {
  void ast; void ctx; void variant; void refused;
  throw new Error('not implemented');
}

/** Spoken pilot request per UX §G8 catalogue ("Ground, Speedbird 117, stand 512, request pushback, information Kilo."). */
export function pilotRequestLine(req: PilotRequest, ctx: PhraseCtx): string {
  void req; void ctx;
  throw new Error('not implemented');
}

/** Pilot "unable" line for a refused command ("Unable 160, minimum clean 210, Speedbird 117."). */
export function unableLine(ast: CommandAST, reason: string, ctx: PhraseCtx): string {
  void ast; void reason; void ctx;
  throw new Error('not implemented');
}
