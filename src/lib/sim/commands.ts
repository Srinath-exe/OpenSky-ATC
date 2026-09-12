// ============================================================
//  Command text parser — tokenizer + recursive-descent grammar -> CommandAST.
//
//  One grammar, three inputs (UX 04 §1.1 rule 3): the click tree (toAst), this
//  parser (typed command line) and STT text all produce the same CommandAST,
//  so transmission/readback text is identical whichever way a command is
//  built. The parser is pure: it never touches the engine; callsign / runway /
//  taxiway / fix / stand identifiers are resolved against a small ParseCtx the
//  store builds from the engine (or left lenient when the lists are absent).
//
//  Grammar summary (upper-cased, fillers TO/THE/OF/AND/FOR ignored where sensible):
//    <callsign> <part> [THEN|AND|,] <part> ...     (max 1 base + 3 parts)
//    callsign = BAW117 | 117 (last digits, unique) | SPEEDBIRD 117 (telephony)
//               | omitted -> ctx.lastCallsign
//    conditions before a part: AT 4000 | WHEN PASSING 4000 | ON REACHING [4000]
//               | AFTER OCK | AFTER PUSHBACK | WHEN VACATED | WHEN READY | AT PILOTS DISCRETION
//    numbers:  headings 3 digits (magnetic -> TRUE via ctx.magVar); altitudes ft
//              or FL80 / FLIGHT LEVEL 80 / "80" (hundreds) / "8" (thousands);
//              speeds 100-350 kt; squawks 4 octal digits; spoken digits
//              ("two four zero", niner/tree/fife) are normalised first.
//    shorthand (Endless ATC / 03 §7): H240 L240 R240 D3000 A3000 C3000 S180 I27L
//              HS 27L, CTO, CTL, LUAW, GA, CT TWR, DCT, SQ, RC, GW, EXP ...
//  Every describe() string from commandAst.ts is also accepted so that
//  parse(describe(ast)) round-trips (tests/commands/roundtrip.test.ts).
// ============================================================
import type { FlightKind, Position, Stage } from './types';
import type { PendingCondition } from './types';
import type {
  ApproachType, CommandAST, CommandKind, ContactWhen, CorrectionField, EmergencyInfoKind, ExitSpec, HoldAllScope, HoldShortTarget,
  PushDir, ReportKind, SingleAircraftCommand, TaxiDest, TurnDir, UnableReason,
} from './commandAst';
import { incompatibleParts, makeAst, sequence, sortParts } from './commandAst';
import type { ActionId } from './commandTree';
import { ACTION_DEFS, enabledActionsForStage, visibleActionsForStage } from './commandTree';
import { AIRLINE_TELEPHONY, trueHeading } from './phraseology';
import type { VehicleType, RunwayStatus } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Context + results
// ──────────────────────────────────────────────────────────────────────────────
/** AircraftView / AircraftState-compatible slice the parser needs. */
export interface ParseAircraft {
  /** Engine id (fills VehicleTarget.id for "dispatch fire to BAW117"). */
  id?: number;
  callsign: string;
  flightNo?: string;
  airline?: string;
  type?: string;
  stage?: Stage;
  altitude?: number;
  heading?: number;
  plan?: { kind?: FlightKind; runway?: string | null; gateRef?: string | null; fix?: string | null };
  holdShortRunway?: string | null;
  assignedRunway?: string | null;
  onFrequency?: Position;
  takeoffCleared?: boolean;
  ilsArmed?: boolean;
  /** Open pilot request (REQ chip) — ranks the callsign first in suggestions. */
  hasRequest?: boolean;
  /** Emergency in progress — the emergency verbs are offered only then (unless enabledActions says otherwise). */
  emergency?: boolean;
  /** Ids from actionsFor(); when present they are the authoritative verb filter for suggestions. */
  enabledActions?: ActionId[];
  /** Minimum clean speed for "reduce to minimum clean speed". */
  minCleanKt?: number;
}

export interface ParseCtx {
  aircraft?: ParseAircraft[];
  runways?: string[];
  taxiways?: string[];
  fixes?: string[];
  stands?: string[];
  vehicles?: string[];
  /** "Last aircraft" context: a verb-first line addresses this callsign. */
  lastCallsign?: string | null;
  /** Magnetic variation (deg, east positive): typed headings are magnetic, the AST is TRUE. */
  magVar?: number;
  /** Sim clock (s) used to resolve EFC "45" (minutes past the current hour). */
  time?: number;
  /** Force strict identifier checking even when the lists are empty (default: strict iff the list is non-empty). */
  strict?: boolean;
  /** Resolve "hold at the intersection of A and B" to a graph node. */
  intersectionNode?(a: string, b: string): { nodeId: string; label: string } | null;
  /** Runway heading (TRUE) for a bare "fly runway heading". */
  runwayHeadingTrue?(runway: string): number | null;
}

export type ParseErrorCode =
  | 'empty' | 'unknown_callsign' | 'ambiguous_callsign' | 'unknown_verb' | 'missing_param' | 'invalid_number'
  | 'invalid_heading' | 'invalid_altitude' | 'invalid_speed' | 'invalid_runway' | 'invalid_squawk' | 'invalid_condition'
  | 'unknown_runway' | 'unknown_taxiway' | 'unknown_fix' | 'unknown_stand' | 'unknown_aircraft' | 'unknown_vehicle'
  | 'trailing_tokens' | 'incompatible_parts' | 'too_many_parts' | 'unsupported';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  /** Token index the error refers to (tokens.length = end of input). */
  at: number;
  token: string | null;
  /** What would have been valid here: literal keywords or placeholders like '<runway>'. */
  expected: string[];
}

export interface Token { text: string; raw: string; index: number }

export interface ParseResult {
  ok: boolean;
  ast: CommandAST | null;
  callsign: string | null;
  errors: ParseError[];
  /** Next-token suggestions when the parse failed or stopped short (same vocabulary as suggest()). */
  suggestions: string[];
  tokens: Token[];
  /** Candidate callsigns when the address was ambiguous (e.g. "117" matches two aircraft). */
  ambiguous?: string[];
  /** Conditions that could not be attached to the AST (kinds without a `when` field, e.g. "after pushback taxi"). The engine infers them from the stage. */
  detachedConditions?: Array<{ kind: CommandKind; condition: PendingCondition }>;
}

export type SuggestionKind = 'callsign' | 'verb' | 'keyword' | 'runway' | 'taxiway' | 'fix' | 'stand' | 'aircraft' | 'vehicle' | 'number' | 'position';
export interface Suggestion { text: string; kind: SuggestionKind; label: string; score: number }

// ──────────────────────────────────────────────────────────────────────────────
//  Tokenizer + spoken-number normalisation (UX §G5.13)
// ──────────────────────────────────────────────────────────────────────────────
const DIGIT_WORDS: Record<string, string> = {
  ZERO: '0', OH: '0', ONE: '1', WUN: '1', TWO: '2', TOO: '2', THREE: '3', TREE: '3', FOUR: '4', FOWER: '4', FIVE: '5', FIFE: '5',
  SIX: '6', SEVEN: '7', EIGHT: '8', AIT: '8', NINE: '9', NINER: '9',
};
const RUNWAY_RE = /^(0?[1-9]|[12]\d|3[0-6])([LRC])?$/;
const CALLSIGN_RE = /^[A-Z]{1,3}\d{1,4}[A-Z]{0,2}$/;
const FIX_RE = /^[A-Z]{2,5}$/;
const TAXIWAY_RE = /^[A-Z]{1,2}\d{0,2}$/;
const STAND_RE = /^[A-Z]{0,2}\d{1,3}[A-Z]?$/;
const NUM_RE = /^\d+(\.\d+)?$/;
const FILLERS = new Set(['TO', 'THE', 'OF', 'FOR', 'PLEASE', 'A', 'AN']);

/** Upper-case, split on whitespace/punctuation, join spoken digits ("two four zero" -> "240", "flight level eight zero" -> "FL80"). */
export function tokenize(text: string): Token[] {
  const cleaned = text
    .toUpperCase()
    .replace(/[’']/g, '')
    .replace(/([A-Z])-([A-Z])/g, '$1 $2')       // START-UP, GO-AROUND, LINE-UP
    .replace(/(\d)-([A-Z])/g, '$1 $2')          // 4-mile, 2-minute
    .replace(/([A-Z])\/([A-Z])/g, '$1 $2')      // pob/fuel/intentions
    .replace(/\s\/\s/g, ' THEN ')               // describe() sequence separator
    .replace(/[(),;:?!"+]/g, ' ')
    .replace(/\.(?!\d)/g, ' ');                 // keep 118.5, drop sentence periods
  const raw = cleaned.split(/\s+/).filter(Boolean);
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    // spoken digits run
    if (DIGIT_WORDS[t] !== undefined && !(t === 'A' || t === 'OH' && i === 0)) {
      let digits = '';
      let j = i;
      while (j < raw.length && DIGIT_WORDS[raw[j]] !== undefined) { digits += DIGIT_WORDS[raw[j]]; j++; }
      // "<d> THOUSAND [<d> HUNDRED]" / "<d> HUNDRED"
      if (j < raw.length && raw[j] === 'THOUSAND') {
        let v = parseInt(digits, 10) * 1000; j++;
        if (j + 1 < raw.length && DIGIT_WORDS[raw[j]] !== undefined && raw[j + 1] === 'HUNDRED') { v += parseInt(DIGIT_WORDS[raw[j]], 10) * 100; j += 2; }
        digits = String(v);
      } else if (j < raw.length && raw[j] === 'HUNDRED') { digits = String(parseInt(digits, 10) * 100); j++; }
      // DECIMAL / POINT joins frequencies
      if (j + 1 < raw.length && (raw[j] === 'DECIMAL' || raw[j] === 'POINT') && DIGIT_WORDS[raw[j + 1]] !== undefined) {
        let dec = ''; j++;
        while (j < raw.length && DIGIT_WORDS[raw[j]] !== undefined) { dec += DIGIT_WORDS[raw[j]]; j++; }
        digits = `${digits}.${dec}`;
      }
      out.push({ text: digits, raw: raw.slice(i, j).join(' '), index: out.length });
      i = j - 1;
      continue;
    }
    if (t === 'FLIGHT' && raw[i + 1] === 'LEVEL' && raw[i + 2] && NUM_RE.test(normDigits(raw[i + 2]))) {
      let j = i + 2; let digits = '';
      if (/^\d+$/.test(raw[j])) { digits = raw[j]; j++; }
      else while (j < raw.length && DIGIT_WORDS[raw[j]] !== undefined) { digits += DIGIT_WORDS[raw[j]]; j++; }
      out.push({ text: `FL${digits}`, raw: raw.slice(i, j).join(' '), index: out.length });
      i = j - 1; continue;
    }
    if (/^\d+$/.test(t) && raw[i + 1] === 'THOUSAND') {
      let v = parseInt(t, 10) * 1000; let j = i + 2;
      if (raw[j] && /^\d$/.test(raw[j]) && raw[j + 1] === 'HUNDRED') { v += parseInt(raw[j], 10) * 100; j += 2; }
      out.push({ text: String(v), raw: raw.slice(i, j).join(' '), index: out.length }); i = j - 1; continue;
    }
    if (t === 'FL' && raw[i + 1] && /^\d{2,3}$/.test(raw[i + 1])) { out.push({ text: `FL${raw[i + 1]}`, raw: `${t} ${raw[i + 1]}`, index: out.length }); i++; continue; }
    if (t === 'HEAVY' || t === 'SUPER') { const prev = out[out.length - 1]?.text ?? ''; if (CALLSIGN_RE.test(prev) || /^\d{1,4}[A-Z]{0,2}$/.test(prev)) continue; }
    t = t.replace(/^(\d+)KTS?$/, '$1');
    out.push({ text: t, raw: raw[i], index: out.length });
  }
  return out;
}
function normDigits(w: string): string { return DIGIT_WORDS[w] ?? w; }

// ──────────────────────────────────────────────────────────────────────────────
//  Parser core
// ──────────────────────────────────────────────────────────────────────────────
class ParseFail extends Error { constructor(public readonly err: ParseError) { super(err.message); } }

const POSITION_WORDS: Record<string, Position> = {
  TOWER: 'tower', TWR: 'tower', GROUND: 'ground', GND: 'ground', DEPARTURE: 'departure', DEP: 'departure', DEPARTURES: 'departure',
  APPROACH: 'approach', APP: 'approach', RADAR: 'approach', DIRECTOR: 'approach', CENTER: 'external', CENTRE: 'external', CTR: 'external',
  CONTROL: 'external', EXTERNAL: 'external', UNICOM: 'external',
};
const PUSH_DIRS: Record<string, PushDir> = { N: 'N', NORTH: 'N', E: 'E', EAST: 'E', S: 'S', SOUTH: 'S', W: 'W', WEST: 'W', ANY: 'any' };
const VEHICLE_WORDS: Record<string, { type: VehicleType; prefix: string }> = {
  FIRE: { type: 'arff', prefix: 'FIRE' }, ARFF: { type: 'arff', prefix: 'FIRE' }, RESCUE: { type: 'arff', prefix: 'FIRE' }, CRASH: { type: 'arff', prefix: 'FIRE' },
  AMBULANCE: { type: 'ambulance', prefix: 'AMB' }, MEDIC: { type: 'ambulance', prefix: 'AMB' }, AMB: { type: 'ambulance', prefix: 'AMB' },
  FOLLOWME: { type: 'followme', prefix: 'FOLLOW' }, FOLLOW: { type: 'followme', prefix: 'FOLLOW' }, FM: { type: 'followme', prefix: 'FOLLOW' },
  TUG: { type: 'tug', prefix: 'TUG' }, OPS: { type: 'ops', prefix: 'OPS' }, INSPECTION: { type: 'ops', prefix: 'OPS' },
  SWEEPER: { type: 'sweeper', prefix: 'SWEEP' }, SWEEP: { type: 'sweeper', prefix: 'SWEEP' }, BIRD: { type: 'bird', prefix: 'BIRD' },
  FUEL: { type: 'fuel', prefix: 'FUEL' }, DEICE: { type: 'deice', prefix: 'DEICE' },
};
const REPORT_WORDS: Record<string, ReportKind> = {
  POSITION: 'position', HEADING: 'heading', HDG: 'heading', ALTITUDE: 'altitude', ALT: 'altitude', LEVEL: 'altitude', AIRSPEED: 'airspeed', SPEED: 'airspeed', SPD: 'airspeed',
  POB: 'pob', SOULS: 'pob', PERSONS: 'pob', FUEL: 'fuel', ENDURANCE: 'fuel', NATURE: 'nature', DG: 'dg', DANGEROUS: 'dg', INTENTIONS: 'intentions',
  ESTABLISHED: 'established', VACATED: 'vacated', READY: 'ready', REASON: 'reason', ROLLING: 'rolling', AIRBORNE: 'rolling', READYOU5: 'readyou5', FOUR_MILE_FINAL: 'four_mile_final',
};
const UNABLE_WORDS: Record<string, UnableReason> = { TRAFFIC: 'traffic', WAKE: 'wake', RUNWAY: 'runway_closed', CLOSED: 'runway_closed', SLOT: 'slot', STANDBY: 'standby', DELAY: 'delay', WEATHER: 'weather', WX: 'weather' };
const CORRECTION_WORDS: Record<string, CorrectionField> = { HEADING: 'heading', HDG: 'heading', ALTITUDE: 'altitude', ALT: 'altitude', SPEED: 'speed', SPD: 'speed', RUNWAY: 'runway', RWY: 'runway', SQUAWK: 'squawk', FREQUENCY: 'frequency', FREQ: 'frequency', TAXIWAY: 'taxiway', TWY: 'taxiway' };

/** Describe()/type shorthand for the confirm chips + suggestions. Verb text -> kinds -> actions (for stage filtering). */
export interface VerbDef { text: string; kinds: CommandKind[]; actions: ActionId[]; air?: boolean; ground?: boolean }
export const VERBS: readonly VerbDef[] = [
  { text: 'PUSHBACK APPROVED', kinds: ['pushback'], actions: ['action-pushback'] },
  { text: 'STARTUP APPROVED', kinds: ['startup'], actions: ['action-startup'] },
  { text: 'TAXI', kinds: ['taxi'], actions: ['action-taxi-runway', 'action-taxi-stand', 'action-taxi-point', 'action-amend-route'] },
  { text: 'TAXI TO STAND', kinds: ['taxi'], actions: ['action-taxi-stand'] },
  { text: 'HOLD SHORT', kinds: ['holdShort'], actions: ['action-hold-short'] },
  { text: 'HOLD POSITION', kinds: ['holdPosition'], actions: ['action-hold-position'] },
  { text: 'CONTINUE TAXI', kinds: ['continue'], actions: ['action-continue'] },
  { text: 'CROSS', kinds: ['cross'], actions: ['action-cross'] },
  { text: 'GIVE WAY TO', kinds: ['giveWay'], actions: ['action-giveway'] },
  { text: 'FOLLOW', kinds: ['giveWay'], actions: ['action-giveway'] },
  { text: 'LINE UP AND WAIT', kinds: ['lineup'], actions: ['action-lineup'] },
  { text: 'CLEARED FOR TAKEOFF', kinds: ['takeoff'], actions: ['action-takeoff'] },
  { text: 'CANCEL TAKEOFF', kinds: ['cancelTakeoff'], actions: ['action-cancel-takeoff'] },
  { text: 'CANCEL LINE UP', kinds: ['cancelLineup'], actions: ['action-cancel-lineup'] },
  { text: 'EXIT AT', kinds: ['exitAt'], actions: ['action-exit', 'action-plan-exit'] },
  { text: 'VACATE', kinds: ['exitAt', 'cancelLineup'], actions: ['action-exit', 'action-cancel-lineup'] },
  { text: 'EXPEDITE', kinds: ['expedite'], actions: ['action-expedite'] },
  { text: 'CLEARED TO LAND', kinds: ['clearedLand'], actions: ['action-land'] },
  { text: 'CONTINUE APPROACH', kinds: ['continueApproach'], actions: ['action-land'], air: true },
  { text: 'GO AROUND', kinds: ['goAround'], actions: ['action-goaround'] },
  { text: 'WIND CHECK', kinds: ['windCheck'], actions: ['action-wind-check'] },
  { text: 'CONTACT TOWER', kinds: ['contact'], actions: ['action-handoff'] },
  { text: 'CONTACT GROUND', kinds: ['contact'], actions: ['action-handoff'] },
  { text: 'CONTACT DEPARTURE', kinds: ['contact'], actions: ['action-handoff'] },
  { text: 'CONTACT APPROACH', kinds: ['contact'], actions: ['action-handoff'] },
  { text: 'TURN LEFT HEADING', kinds: ['heading'], actions: ['action-heading'] },
  { text: 'TURN RIGHT HEADING', kinds: ['heading'], actions: ['action-heading'] },
  { text: 'FLY HEADING', kinds: ['heading'], actions: ['action-heading'] },
  { text: 'CLIMB', kinds: ['altitude'], actions: ['action-altitude'] },
  { text: 'DESCEND', kinds: ['altitude'], actions: ['action-altitude'] },
  { text: 'MAINTAIN', kinds: ['altitude', 'speed'], actions: ['action-altitude', 'action-speed'] },
  { text: 'SPEED', kinds: ['speed'], actions: ['action-speed'] },
  { text: 'REDUCE SPEED', kinds: ['speed'], actions: ['action-speed'] },
  { text: 'RESUME NORMAL SPEED', kinds: ['speed'], actions: ['action-speed'] },
  { text: 'DIRECT', kinds: ['direct'], actions: ['action-direct'] },
  { text: 'RESUME SID', kinds: ['resumeSid'], actions: ['action-resume-sid'] },
  { text: 'HOLD AT', kinds: ['hold'], actions: ['action-hold-fix'] },
  { text: 'CLEARED ILS', kinds: ['ils'], actions: ['action-ils', 'action-change-runway'] },
  { text: 'CLEARED LOCALIZER', kinds: ['loc'], actions: ['action-ils'] },
  { text: 'CLEARED VISUAL', kinds: ['visual'], actions: ['action-ils'] },
  { text: 'CANCEL APPROACH', kinds: ['cancelApproach'], actions: ['action-cancel-approach'] },
  { text: 'EXPECT RUNWAY', kinds: ['expectRunway'], actions: ['action-expect-runway'] },
  { text: 'SQUAWK', kinds: ['squawk', 'ident'], actions: [], air: true },
  { text: 'IDENT', kinds: ['ident'], actions: [], air: true },
  { text: 'RADAR CONTACT', kinds: ['radarContact'], actions: [], air: true },
  { text: 'SAY AGAIN', kinds: ['sayAgain'], actions: ['action-say-again'] },
  { text: 'CORRECTION', kinds: ['correction'], actions: ['action-correction'] },
  { text: 'DISREGARD', kinds: ['disregard'], actions: [] },
  { text: 'STANDBY', kinds: ['standby'], actions: ['action-standby'] },
  { text: 'UNABLE', kinds: ['unable'], actions: ['action-unable'] },
  { text: 'REPORT', kinds: ['report'], actions: ['action-report'] },
  { text: 'ROGER', kinds: ['roger'], actions: [] },
  { text: 'ROGER MAYDAY', kinds: ['emergencyAck'], actions: ['emerg-ack'] },
  { text: 'PRIORITY RUNWAY', kinds: ['priority'], actions: ['emerg-priority'] },
  { text: 'STOP ON THE RUNWAY', kinds: ['stopOnRunway'], actions: ['emerg-stop-runway'] },
  { text: 'VACATE IF ABLE', kinds: ['stopOnRunway'], actions: ['emerg-stop-runway'] },
  { text: 'MAYDAY CANCELLED', kinds: ['emergencyCancelAck'], actions: ['emerg-cancel-ack'] },
];
/** System-level verbs (no callsign). */
export const SYSTEM_VERBS: readonly string[] = ['DISPATCH', 'RECALL', 'CLOSE RUNWAY', 'REOPEN', 'RUNWAY', 'INSPECT', 'HOLD ALL', 'RESUME ALL', 'BROADCAST', 'ALL STATIONS', 'STERILE'];

/** Continuation keywords after a complete part, per kind (suggest()). */
const CONTINUATIONS: Partial<Record<CommandKind, string[]>> = {
  taxi: ['VIA', 'HOLD SHORT', 'CROSS', 'EXPEDITE', 'AT'],
  heading: ['CLIMB', 'DESCEND', 'SPEED', 'THEN CLEARED ILS', 'THEN'],
  altitude: ['EXPEDITE', 'THEN CLEARED ILS', 'SPEED', 'TURN LEFT HEADING', 'TURN RIGHT HEADING', 'AT PILOTS DISCRETION'],
  speed: ['UNTIL 4 MILE FINAL', 'CLIMB', 'DESCEND'],
  takeoff: ['FLY HEADING', 'FLY RUNWAY HEADING', 'CLIMB', 'CONTACT DEPARTURE', 'IMMEDIATE'],
  lineup: ['BEHIND', 'AT'],
  clearedLand: ['HOLD SHORT', 'EXIT AT', 'NEXT EXIT LEFT', 'NEXT EXIT RIGHT'],
  ils: ['REPORT ESTABLISHED', 'SPEED', 'CONTACT TOWER'],
  goAround: ['FLY RUNWAY HEADING', 'FLY HEADING', 'CLIMB', 'CONTACT APPROACH'],
  pushback: ['FACE NORTH', 'FACE SOUTH', 'FACE EAST', 'FACE WEST', 'EXPECT RUNWAY', 'THEN TAXI'],
  startup: ['EXPECT RUNWAY'],
  hold: ['INBOUND', 'LEFT TURNS', 'RIGHT TURNS', '1 MINUTE LEGS', 'EFC'],
  cross: ['EXPEDITE', 'BEHIND'],
  exitAt: ['EXPEDITE', 'HOLD SHORT', 'CONTACT GROUND'],
  direct: ['THEN HEADING', 'CLIMB', 'DESCEND'],
  cancelApproach: ['TURN LEFT HEADING', 'TURN RIGHT HEADING', 'CLIMB'],
  continue: ['HOLD SHORT'],
  loc: ['MAINTAIN'],
  visual: ['FOLLOW'],
  contact: [],
};

const VERB_STARTERS = new Set(['PUSH', 'PUSHBACK', 'START', 'STARTUP', 'TAXI', 'RUNWAY', 'RWY', 'AMEND', 'HOLD', 'HS', 'STOP', 'CONTINUE', 'CONT', 'RESUME', 'CROSS', 'GIVE', 'GW', 'FOLLOW', 'LINE', 'LINEUP', 'LUAW', 'BEHIND', 'CLEARED', 'TAKEOFF', 'CTO', 'CANCEL', 'ABORT', 'REJECT', 'VACATE', 'EXIT', 'TAKE', 'NEXT', 'PLAN', 'EXPEDITE', 'EXPD', 'EXP', 'LAND', 'CTL', 'GO', 'GA', 'GOAROUND', 'MISSED', 'WIND', 'CONTACT', 'CT', 'MONITOR', 'HANDOFF', 'TURN', 'FLY', 'HEADING', 'HDG', 'VECTOR', 'CLIMB', 'DESCEND', 'MAINTAIN', 'ALTITUDE', 'ALT', 'SPEED', 'SPD', 'REDUCE', 'INCREASE', 'NO', 'DIRECT', 'DCT', 'PROCEED', 'ILS', 'LOC', 'LOCALIZER', 'LOCALISER', 'LLZ', 'JOIN', 'VISUAL', 'VIS', 'EXPECT', 'CHANGE', 'SQUAWK', 'SQ', 'IDENT', 'RADAR', 'RC', 'SAY', 'CORRECTION', 'NEGATIVE', 'DISREGARD', 'STANDBY', 'STAND', 'UNABLE', 'REPORT', 'READ', 'ROGER', 'RGR', 'COPIED', 'READBACK', 'ACKNOWLEDGE', 'ACK', 'MAYDAY', 'PRIORITY', 'NUMBER', 'AFTER', 'AT', 'WHEN', 'ON', 'LEAVING', 'PASSING', 'REACHING', 'A', 'C', 'D', 'H', 'I', 'L', 'R', 'S', 'T', 'OWN', 'RNAV', 'VOR', 'ORBIT']);

class Parser {
  i = 0;
  readonly strict: { runway: boolean; taxiway: boolean; fix: boolean; stand: boolean; aircraft: boolean; vehicle: boolean };
  detached: Array<{ kind: CommandKind; condition: PendingCondition }> = [];
  /** Original (case-preserved) input, used for free-text broadcasts. */
  source = '';
  constructor(readonly toks: Token[], readonly ctx: ParseCtx, readonly self: ParseAircraft | null) {
    const s = (list?: unknown[]) => !!list && (ctx.strict ?? list.length > 0);
    this.strict = { runway: s(ctx.runways), taxiway: s(ctx.taxiways), fix: s(ctx.fixes), stand: s(ctx.stands), aircraft: s(ctx.aircraft), vehicle: s(ctx.vehicles) };
  }
  get eof(): boolean { return this.i >= this.toks.length; }
  peek(k = 0): string { return this.toks[this.i + k]?.text ?? ''; }
  next(): string { return this.toks[this.i++]?.text ?? ''; }
  /** Match a phrase ("HOLD SHORT") at the cursor; alternatives separated by '|' in each word ("LINE|LINEUP"). */
  at(phrase: string, offset = 0): boolean {
    const words = phrase.split(' ');
    for (let k = 0; k < words.length; k++) {
      const t = this.peek(offset + k);
      if (!words[k].split('|').includes(t)) return false;
    }
    return true;
  }
  accept(...phrases: string[]): string | null {
    for (const p of phrases) if (this.at(p)) { this.i += p.split(' ').length; return p; }
    return null;
  }
  skip(...words: string[]): void { while (!this.eof && words.includes(this.peek())) this.i++; }
  fillers(): void { this.skip(...FILLERS); }
  fail(code: ParseErrorCode, message: string, expected: string[] = [], at = this.i): never {
    throw new ParseFail({ code, message, at, token: this.toks[at]?.text ?? null, expected });
  }
  // ── identifier readers ────────────────────────────────────────────────────
  runwayToken(): string | null {
    const t = this.peek();
    if (!t) return null;
    let m = t.match(RUNWAY_RE);
    let consumed = 1;
    if (m && /^\d{1,2}$/.test(t)) {
      const s = this.peek(1);
      const side = s === 'LEFT' || s === 'L' ? 'L' : s === 'RIGHT' || s === 'R' ? 'R' : s === 'CENTER' || s === 'CENTRE' || s === 'C' ? 'C' : '';
      if (side) { m = [`${t}${side}`, t, side] as unknown as RegExpMatchArray; consumed = 2; }
    }
    if (!m) return null;
    const name = `${m[1].padStart(2, '0')}${m[2] ?? ''}`;
    this.i += consumed;
    return name;
  }
  runway(required = true, defaultRunway: string | null = null): string {
    this.skip('RUNWAY', 'RWY');
    const save = this.i;
    const r = this.runwayToken();
    if (r == null) {
      if (defaultRunway) return defaultRunway;
      if (!required) return '';
      this.fail('missing_param', 'Runway required', ['<runway>']);
    }
    if (this.strict.runway && !this.ctx.runways!.map(x => x.toUpperCase()).includes(r)) { this.i = save; this.fail('unknown_runway', `Unknown runway ${r}`, ['<runway>']); }
    return r;
  }
  isRunwayAhead(offset = 0): boolean { const t = this.peek(offset); return !!t && RUNWAY_RE.test(t) && (this.strict.runway ? this.ctx.runways!.some(x => x.toUpperCase() === `${t.match(RUNWAY_RE)![1].padStart(2, '0')}${t.match(RUNWAY_RE)![2] ?? ''}`) : true); }
  isTaxiwayAhead(offset = 0): boolean { const t = this.peek(offset); return !!t && (this.strict.taxiway ? this.ctx.taxiways!.some(x => x.toUpperCase() === t) : TAXIWAY_RE.test(t) && !RUNWAY_RE.test(t)); }
  taxiway(): string {
    this.skip('TAXIWAY', 'TWY');
    const t = this.peek();
    if (!t) this.fail('missing_param', 'Taxiway required', ['<taxiway>']);
    if (this.strict.taxiway) { if (!this.ctx.taxiways!.some(x => x.toUpperCase() === t)) this.fail('unknown_taxiway', `Unknown taxiway ${t}`, ['<taxiway>']); }
    else if (!TAXIWAY_RE.test(t)) this.fail('unknown_taxiway', `Not a taxiway: ${t}`, ['<taxiway>']);
    this.i++;
    return t;
  }
  fix(): string {
    const t = this.peek();
    if (!t) this.fail('missing_param', 'Fix required', ['<fix>']);
    if (this.strict.fix) { if (!this.ctx.fixes!.some(x => x.toUpperCase() === t)) this.fail('unknown_fix', `Unknown fix ${t}`, ['<fix>']); }
    else if (!FIX_RE.test(t)) this.fail('unknown_fix', `Not a fix: ${t}`, ['<fix>']);
    this.i++;
    return t;
  }
  isFixAhead(offset = 0): boolean { const t = this.peek(offset); return !!t && (this.strict.fix ? this.ctx.fixes!.some(x => x.toUpperCase() === t) : FIX_RE.test(t) && !VERB_STARTERS.has(t)); }
  stand(): string {
    this.skip('STAND', 'GATE');
    const t = this.peek();
    if (!t) this.fail('missing_param', 'Stand required', ['<stand>']);
    if (this.strict.stand) { if (!this.ctx.stands!.some(x => x.toUpperCase() === t)) this.fail('unknown_stand', `Unknown stand ${t}`, ['<stand>']); }
    else if (!STAND_RE.test(t)) this.fail('unknown_stand', `Not a stand: ${t}`, ['<stand>']);
    this.i++;
    return t;
  }
  /** Another aircraft (give way / behind / follow / break off): callsign, flight number, last digits, telephony, or unique type. */
  otherAircraft(): string {
    this.skip('THE', 'COMPANY', 'LANDING', 'DEPARTING', 'ARRIVING');
    const r = resolveCallsign(this.toks, this.i, this.ctx, this.self?.callsign ?? null);
    if (r.callsign) { this.i += r.consumed; this.skip('AHEAD', 'ON', 'FINAL', 'SHORT'); return r.callsign; }
    if (r.ambiguous.length) this.fail('ambiguous_callsign', `Ambiguous: ${r.ambiguous.join(', ')}`, r.ambiguous);
    // unique type match ("follow the A320")
    const t = this.peek();
    const byType = (this.ctx.aircraft ?? []).filter(a => a.type?.toUpperCase() === t && a.callsign !== this.self?.callsign);
    if (byType.length === 1) { this.i++; this.skip('AHEAD'); return byType[0].callsign; }
    if (byType.length > 1) this.fail('ambiguous_callsign', `Ambiguous type ${t}: ${byType.map(a => a.callsign).join(', ')}`, byType.map(a => a.callsign));
    if (!t) this.fail('missing_param', 'Aircraft required', ['<aircraft>']);
    if (!this.strict.aircraft && CALLSIGN_RE.test(t)) { this.i++; return t; }
    this.fail('unknown_aircraft', `Unknown aircraft ${t}`, ['<aircraft>']);
  }
  number(): number | null { const t = this.peek(); if (NUM_RE.test(t)) { this.i++; return parseFloat(t); } return null; }
  /** Heading: 3-digit token (magnetic) -> TRUE degrees. */
  heading(): number {
    const t = this.peek();
    if (!/^\d{1,3}$/.test(t)) this.fail('missing_param', 'Heading required', ['<heading>']);
    const n = parseInt(t, 10);
    if (n < 1 || n > 360) this.fail('invalid_heading', `Heading ${t} must be 001-360`, ['<heading>']);
    this.i++;
    this.skip('DEGREES');
    const tr = Math.round(trueHeading(n, this.ctx.magVar ?? 0));
    return ((tr % 360) + 360) % 360 || 360;
  }
  /** Altitude token: 3000 | FL80 | 80 (hundreds) | 8 (thousands); rejects non-100 multiples and silly values. */
  altitude(): number {
    let t = this.peek();
    if (!t) this.fail('missing_param', 'Altitude required', ['<altitude>']);
    let ft: number;
    if (/^FL\d{2,3}$/.test(t)) ft = parseInt(t.slice(2), 10) * 100;
    else if (t === 'FL' && /^\d{2,3}$/.test(this.peek(1))) { this.i++; t = this.peek(); ft = parseInt(t, 10) * 100; }
    else if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      ft = n >= 1000 ? n : n < 10 ? n * 1000 : n * 100;
    } else this.fail('missing_param', 'Altitude required', ['<altitude>']);
    if (ft % 100 !== 0 || ft < 100 || ft > 45000) this.fail('invalid_altitude', `Altitude ${t} must be a multiple of 100 ft up to FL450`, ['<altitude>']);
    this.i++;
    this.skip('FEET', 'FT');
    return ft;
  }
  speed(): number {
    const t = this.peek();
    if (!/^\d{2,3}$/.test(t)) this.fail('missing_param', 'Speed required', ['<speed>']);
    const n = parseInt(t, 10);
    if (n < 100 || n > 350) this.fail('invalid_speed', `Speed ${t} must be 100-350 kt`, ['<speed>']);
    this.i++;
    this.skip('KNOTS', 'KTS', 'KT');
    return n;
  }
  position(required = true): Position | null {
    this.skip('THE');
    const t = this.peek();
    const p = POSITION_WORDS[t];
    if (!p) { if (required) this.fail('missing_param', 'Position required', ['TOWER', 'GROUND', 'DEPARTURE', 'APPROACH']); return null; }
    this.i++;
    // optional unit name + frequency ("London Control 127.4", "118.5")
    if (p === 'external' && /^[A-Z]+$/.test(this.peek()) && POSITION_WORDS[this.peek()] === undefined) { /* keep */ }
    if (/^\d{3}\.\d{1,3}$/.test(this.peek())) this.i++;
    this.skip('GOOD', 'DAY', 'BYE', 'GOODBYE');
    return p;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Callsign resolution
// ──────────────────────────────────────────────────────────────────────────────
const TELEPHONY_TO_ICAO: Record<string, string> = Object.fromEntries(Object.entries(AIRLINE_TELEPHONY).map(([k, v]) => [v.toUpperCase().replace(/\s+/g, ''), k]));

export interface CallsignMatch { callsign: string | null; consumed: number; ambiguous: string[] }

/** Resolve the aircraft addressed at tokens[i]: exact callsign, flight number, "BAW 117", telephony "SPEEDBIRD 117", or unique last 2-3 digits. */
export function resolveCallsign(toks: Token[], i: number, ctx: ParseCtx, exclude: string | null = null): CallsignMatch {
  const list = (ctx.aircraft ?? []).filter(a => a.callsign !== exclude);
  const t0 = toks[i]?.text ?? '';
  const t1 = toks[i + 1]?.text ?? '';
  if (!t0) return { callsign: null, consumed: 0, ambiguous: [] };
  const byCs = (cs: string) => list.find(a => a.callsign.toUpperCase() === cs || (a.flightNo && a.flightNo.toUpperCase() === cs));
  // 1. exact callsign / flight number
  let a = byCs(t0);
  if (a) return { callsign: a.callsign, consumed: 1, ambiguous: [] };
  // 2. "BAW 117" split
  if (/^[A-Z]{2,3}$/.test(t0) && /^\d{1,4}[A-Z]{0,2}$/.test(t1)) {
    a = byCs(t0 + t1);
    if (a) return { callsign: a.callsign, consumed: 2, ambiguous: [] };
  }
  // 3. telephony ("SPEEDBIRD 117", "AIR FRANCE 447")
  for (const words of [2, 1]) {
    const name = toks.slice(i, i + words).map(t => t.text).join('');
    const icao = TELEPHONY_TO_ICAO[name];
    const num = toks[i + words]?.text ?? '';
    if (icao && /^\d{1,4}[A-Z]{0,2}$/.test(num)) {
      a = byCs(icao + num);
      if (a) return { callsign: a.callsign, consumed: words + 1, ambiguous: [] };
      const suffix = toks[i + words + 1]?.text ?? '';
      if (/^[A-Z]{1,2}$/.test(suffix)) { a = byCs(icao + num + suffix); if (a) return { callsign: a.callsign, consumed: words + 2, ambiguous: [] }; }
      if (!list.length) return { callsign: icao + num, consumed: words + 1, ambiguous: [] };
    }
  }
  // 4. last 2-3 digits when unique
  if (/^\d{2,4}$/.test(t0) && list.length) {
    const hits = list.filter(x => { const d = x.callsign.replace(/[^0-9]/g, ''); return d.endsWith(t0) || (x.flightNo ?? '').replace(/[^0-9]/g, '').endsWith(t0); });
    if (hits.length === 1) return { callsign: hits[0].callsign, consumed: 1, ambiguous: [] };
    if (hits.length > 1) return { callsign: null, consumed: 0, ambiguous: hits.map(h => h.callsign) };
  }
  // 5. lenient (no aircraft list): any callsign-shaped token
  if (!list.length && CALLSIGN_RE.test(t0) && !VERB_STARTERS.has(t0) && !POSITION_WORDS[t0]) return { callsign: t0, consumed: 1, ambiguous: [] };
  return { callsign: null, consumed: 0, ambiguous: [] };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Part grammar
// ──────────────────────────────────────────────────────────────────────────────
type Part = SingleAircraftCommand;
interface Pending { cond: PendingCondition | null; contactWhen: 'when_vacated' | 'on_reaching' | 'at_hold' | null; behind: string | null }

function parseCondition(p: Parser, self: ParseAircraft | null): Pending {
  const out: Pending = { cond: null, contactWhen: null, behind: null };
  const altCond = (ft: number): PendingCondition => {
    const cur = self?.altitude;
    return cur != null && cur > ft ? { type: 'at_or_below_alt', ft } : { type: 'at_or_above_alt', ft };
  };
  for (;;) {
    if (p.accept('AT OR BELOW')) { out.cond = { type: 'at_or_below_alt', ft: p.altitude() }; continue; }
    if (p.accept('AT OR ABOVE')) { out.cond = { type: 'at_or_above_alt', ft: p.altitude() }; continue; }
    if (p.accept('AFTER PUSHBACK', 'WHEN PUSHBACK COMPLETE', 'AFTER PUSH')) { out.cond = { type: 'after_pushback' }; p.skip(','); continue; }
    if (p.accept('WHEN VACATED', 'AFTER VACATING', 'WHEN CLEAR OF THE RUNWAY', 'WHEN CLEAR', 'AFTER VACATED')) { out.cond = { type: 'after_vacated' }; out.contactWhen = 'when_vacated'; continue; }
    if (p.accept('WHEN READY', 'AT PILOTS DISCRETION', 'PILOTS DISCRETION', 'AT YOUR DISCRETION', 'PD')) { out.cond = { type: 'when_ready' }; continue; }
    if (p.accept('AT THE HOLDING POINT', 'AT THE HOLD', 'AT HOLDING POINT', 'HOLDING POINT')) { out.contactWhen = 'at_hold'; continue; }
    if (p.at('ON REACHING') || p.at('WHEN REACHING') || p.at('REACHING')) {
      p.accept('ON REACHING', 'WHEN REACHING', 'REACHING');
      if (/^(FL)?\d+$/.test(p.peek())) { const ft = p.altitude(); out.cond = altCond(ft); out.contactWhen = 'on_reaching'; continue; }
      out.cond = { type: 'on_reaching_hold' }; out.contactWhen = 'on_reaching';
      continue;
    }
    if (p.at('WHEN PASSING') || p.at('PASSING') || p.at('LEAVING') || p.at('WHEN LEAVING') || p.at('AT')) {
      const save = p.i;
      const kw = p.accept('WHEN PASSING', 'PASSING', 'WHEN LEAVING', 'LEAVING', 'AT')!;
      if (/^(FL)?\d+$/.test(p.peek()) && !(kw === 'AT' && RUNWAY_RE.test(p.peek()) && (p.peek(1) === 'LEFT' || p.peek(1) === 'RIGHT'))) {
        const ft = p.altitude();
        out.cond = kw === 'LEAVING' || kw === 'WHEN LEAVING' ? (self?.altitude != null && self.altitude > ft ? { type: 'at_or_below_alt', ft } : { type: 'at_or_above_alt', ft }) : altCond(ft);
        continue;
      }
      if (kw !== 'AT' && p.isFixAhead()) { out.cond = { type: 'after_fix', fix: p.fix() }; continue; }
      if (kw === 'AT' && p.isFixAhead() && !p.isRunwayAhead() && !p.at('THE')) {
        // "AT OCK TURN..." = after fix; but "AT 4000" handled above. Avoid eating "AT A1" intersections (taxi handles those itself).
        const t = p.peek();
        if (!(TAXIWAY_RE.test(t) && (p.ctx.taxiways ?? []).some(x => x.toUpperCase() === t))) { out.cond = { type: 'after_fix', fix: p.fix() }; continue; }
      }
      p.i = save;
      break;
    }
    if (p.at('AFTER') && (p.isFixAhead(1) || p.at('AFTER PASSING'))) { p.accept('AFTER PASSING', 'AFTER'); out.cond = { type: 'after_fix', fix: p.fix() }; continue; }
    if (p.at('BEHIND')) {
      p.next(); p.skip('THE', 'LANDING', 'DEPARTING', 'ARRIVING', 'NEXT');
      out.behind = p.otherAircraft();
      p.skip(',', 'BEHIND');
      continue;
    }
    break;
  }
  return out;
}

function parsePart(p: Parser, cs: string, self: ParseAircraft | null): { part: Part; pending: Pending } {
  const pending = parseCondition(p, self);
  const mk = <K extends Part['kind']>(kind: K, fields: Partial<Omit<Extract<Part, { kind: K }>, 'kind' | 'callsign'>>) => makeAst(kind, cs, fields as never) as Extract<Part, { kind: K }>;
  const t = p.peek();
  const t1 = p.peek(1);
  const stage = self?.stage;
  const plannedRunway = self?.plan?.runway ?? self?.assignedRunway ?? null;
  const air = stage ? !['parked', 'startup', 'pushback', 'taxi_out', 'taxi_in', 'hold_short_dep', 'hold_short_cross', 'lineup', 'takeoff_roll', 'rollout', 'arrived'].includes(stage) : null;

  // ── shorthand single tokens ─────────────────────────────────────────────
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^H(\d{3})$/))) { p.i++; return done(mk('heading', { hdg: hdgTrue(p, m[1]), dir: null })); }
  if ((m = t.match(/^([LR])(\d{3})$/))) { p.i++; return done(mk('heading', { hdg: hdgTrue(p, m[2]), dir: m[1] as TurnDir })); }
  if ((m = t.match(/^S(\d{3})$/))) { p.i++; const n = parseInt(m[1], 10); if (n < 100 || n > 350) p.fail('invalid_speed', `Speed ${m[1]} must be 100-350 kt`, ['<speed>'], p.i - 1); return done(mk('speed', { kts: n })); }
  if ((m = t.match(/^[ACD](\d{2,5})$/)) || /^FL\d{2,3}$/.test(t)) {
    if (m) { p.toks[p.i] = { ...p.toks[p.i], text: m[1] }; }
    const ft = p.altitude();
    return done(mk('altitude', { ft, expedite: !!p.accept('EXPEDITE', 'EXPD', 'EXP') }));
  }
  if ((m = t.match(/^I(\d{1,2}[LRC]?)$/))) { p.toks[p.i] = { ...p.toks[p.i], text: m[1] }; return done(mk('ils', { runway: p.runway() })); }

  switch (t) {
    // ── ground ──────────────────────────────────────────────────────────────
    case 'PUSH': case 'PUSHBACK': return done(parsePushback(p, mk));
    case 'START': case 'STARTUP': {
      p.next(); p.accept('UP'); p.accept('APPROVED');
      if (p.accept('AND PUSH', 'AND PUSHBACK', 'PUSH', 'PUSHBACK')) { const pb = parsePushback(p, mk, true); return done(pb); }
      return done(mk('startup', { expectRunway: parseExpectRunway(p) }));
    }
    case 'TAXI': return done(parseTaxi(p, mk, self));
    case 'RUNWAY': case 'RWY': {
      // FAA: "RUNWAY 27L TAXI VIA A B" / "RUNWAY 27L LINE UP AND WAIT" / "RUNWAY 27L CLEARED FOR TAKEOFF|TO LAND"
      const save = p.i; p.next();
      const rwy = p.runwayToken();
      if (rwy) {
        if (p.at('TAXI')) { p.next(); return done(parseTaxiBody(p, mk, { kind: 'runway', runway: rwy, intersection: null }, self)); }
        if (p.at('LINE|LINEUP|LUAW')) return done(parseLineup(p, mk, rwy, pending));
        if (p.at('CLEARED FOR') || p.at('CLEARED TAKEOFF') || p.at('CLEARED IMMEDIATE')) { p.next(); p.skip('FOR'); const imm = !!p.accept('IMMEDIATE'); p.accept('TAKEOFF', 'TAKE OFF', 'DEPARTURE'); return done(mk('takeoff', { runway: rwy, immediate: imm })); }
        if (p.at('CLEARED TO LAND') || p.at('CLEARED LAND')) { p.next(); p.skip('TO'); p.next(); return done(parseLandBody(p, mk, rwy)); }
        if (p.accept('HEADING')) return done(runwayHeadingPart(mk, runwayHeading(p, rwy)));
      } else if (p.accept('HEADING')) {
        // "runway heading" as its own part (describe() / after-departure / go-around)
        return done(runwayHeadingPart(mk, runwayHeading(p, plannedRunway)));
      }
      p.i = save;
      p.fail('unknown_verb', 'Expected a clearance after the runway', ['TAXI', 'LINE UP AND WAIT', 'CLEARED FOR TAKEOFF', 'CLEARED TO LAND'], save + 1 + (rwy ? 1 : 0));
    }
    // fallthrough impossible (fail throws)
    case 'AMEND': { p.next(); p.accept('ROUTING', 'ROUTE'); p.skip(','); p.accept('TAXI'); return done(parseTaxiBody(p, mk, null, self, false)); }
    case 'HS': { p.next(); return done(mk('holdShort', { of: parseHoldTarget(p) })); }
    case 'HOLD': {
      p.next();
      if (p.accept('SHORT')) { p.skip('OF'); if (p.eof && stage === 'rollout') return done(mk('holdPosition', {})); return done(mk('holdShort', { of: parseHoldTarget(p, self) })); }
      if (p.accept('POSITION', 'YOUR POSITION', 'IN POSITION', 'HERE')) { p.skip(','); return done(mk('holdPosition', { reason: restText(p) })); }
      if (p.at('ALL')) p.fail('unknown_verb', '"Hold all" is a system command (no callsign)', ['POSITION', 'SHORT', 'AT']);
      if (p.accept('FOR')) { p.skip('WAKE', 'TURBULENCE', 'TRAFFIC'); return done(mk('holdPosition', { reason: 'wake turbulence' })); }
      if (p.at('AT') || p.at('OVER') || p.isFixAhead() || p.at('AS PUBLISHED')) return done(parseHold(p, mk, self));
      if (p.eof) { if (stage && isAirStageName(stage)) p.fail('missing_param', 'Hold at which fix?', ['AT <FIX>']); return done(mk('holdPosition', {})); }
      // "HOLD TRAFFIC ON FINAL" style reason
      return done(mk('holdPosition', { reason: restText(p) }));
    }
    case 'STOP': {
      p.next();
      if (p.accept('ON THE RUNWAY', 'ON RUNWAY')) { p.skip('IF', 'ABLE', ','); restText(p); return done(mk('stopOnRunway', { mode: 'stop' })); }
      if (p.accept('IMMEDIATELY') || stage === 'takeoff_roll' || (stage === 'lineup' && self?.takeoffCleared)) { p.skip(','); p.accept(`${cs} STOP IMMEDIATELY`); p.skip(','); return done(mk('cancelTakeoff', { reason: restText(p) })); }
      if (p.accept('PUSHBACK', 'PUSH')) return done(mk('holdPosition', { reason: 'stop pushback' }));
      return done(mk('holdPosition', { reason: restText(p) }));
    }
    case 'CONTINUE': case 'CONT': {
      p.next();
      if (p.accept('APPROACH')) { const n = parseNumberChip(p); p.skip(','); p.accept('EXPECT LATE LANDING CLEARANCE', 'EXPECT LATE CLEARANCE'); restText(p); return done(mk('continueApproach', { number: n })); }
      p.accept('TAXI', 'TAXIING', 'PUSHBACK', 'PUSH', 'AS CLEARED', 'THE PUSH');
      p.skip(',');
      let hs: HoldShortTarget | null = null;
      if (p.accept('HOLD SHORT', 'HS')) { p.skip('OF'); hs = parseHoldTarget(p, self); }
      return done(mk('continue', { holdShortOf: hs }));
    }
    case 'RESUME': {
      p.next();
      if (p.accept('NORMAL SPEED', 'SPEED', 'NORMAL')) { p.accept('SPEED'); return done(mk('speed', { kts: 'resume' })); }
      if (p.accept('SID', 'OWN NAVIGATION', 'OWN NAV', 'NAVIGATION', 'NAV', 'THE SID')) { p.accept('CLIMB VIA SID', 'CLIMB VIA THE SID'); return done(mk('resumeSid', {})); }
      if (p.accept('TAXI', 'PUSHBACK', 'PUSH')) return done(mk('continue', {}));
      if (p.at('ALL')) p.fail('unknown_verb', '"Resume all" is a system command (no callsign)', ['NORMAL SPEED', 'SID', 'TAXI']);
      p.fail('unknown_verb', 'Resume what?', ['NORMAL SPEED', 'SID', 'OWN NAVIGATION', 'TAXI']);
    }
    // eslint-disable-next-line no-fallthrough
    case 'CROSS': {
      p.next(); p.skip('RUNWAY', 'RWY');
      const rwy = p.runway(false, self?.holdShortRunway ?? null);
      if (!rwy) p.fail('missing_param', 'Cross which runway?', ['<runway>']);
      p.skip(',');
      if (p.accept('AT')) p.taxiway();
      const exp = !!p.accept('EXPEDITE', 'EXPD', 'NO DELAY', 'WITHOUT DELAY');
      p.accept('REPORT VACATED', 'REPORT CLEAR');
      let behind = pending.behind;
      if (p.accept('BEHIND')) { p.skip('THE', 'LANDING', 'DEPARTING'); if (!p.eof) { behind = p.otherAircraft(); p.accept('BEHIND'); } }
      return done(mk('cross', { runway: rwy, expedite: exp, behind }));
    }
    case 'GIVE': case 'GW': {
      p.next(); p.accept('WAY'); p.skip('TO', 'THE');
      const to = p.otherAircraft(); restText(p);
      return done(mk('giveWay', { to, mode: 'give_way' }));
    }
    case 'FOLLOW': {
      p.next(); p.skip('THE', 'COMPANY');
      if (p.accept('FOLLOW ME', 'FOLLOWME', 'FM', 'THE FOLLOW ME')) { restText(p); return done(mk('giveWay', { to: 'FOLLOW1', mode: 'follow' })); }
      const to = p.otherAircraft(); restText(p);
      return done(mk('giveWay', { to, mode: 'follow' }));
    }
    case 'LINE': case 'LINEUP': case 'LUAW': return done(parseLineup(p, mk, null, pending, plannedRunway));
    case 'CLEARED': {
      p.next();
      if (p.accept('FOR IMMEDIATE TAKEOFF', 'IMMEDIATE TAKEOFF', 'FOR IMMEDIATE TAKE OFF', 'FOR IMMEDIATE DEPARTURE')) { const rwy = p.runway(false, plannedRunway); return done(mk('takeoff', { runway: rwy, immediate: true })); }
      if (p.accept('FOR TAKEOFF', 'TAKEOFF', 'FOR TAKE OFF', 'TAKE OFF', 'FOR DEPARTURE', 'DEPARTURE')) {
        const rwy = p.runway(false, plannedRunway);
        p.skip(',');
        const imm = !!p.accept('IMMEDIATE');
        p.accept('REPORT ROLLING', 'REPORT AIRBORNE');
        return done(mk('takeoff', { runway: rwy, immediate: imm }));
      }
      if (p.accept('TO LAND', 'LAND', 'FOR LANDING', 'LANDING')) { const rwy = p.runway(false, plannedRunway); return done(parseLandBody(p, mk, rwy)); }
      p.skip('FOR', 'THE');
      if (p.accept('TOUCH AND GO', 'LOW APPROACH', 'THE OPTION', 'OPTION', 'STOP AND GO')) p.fail('unsupported', 'Pattern operations are not supported yet', []);
      if (p.accept('ILS', 'ILS APPROACH', 'THE ILS')) { p.accept('APPROACH'); const rwy = p.runway(false, plannedRunway); p.accept('APPROACH'); return done(parseIlsTail(p, mk('ils', { runway: rwy }), p)); }
      if (p.accept('LOCALIZER', 'LOCALISER', 'LOC', 'LLZ')) { p.accept('APPROACH'); const rwy = p.runway(false, plannedRunway); p.accept('APPROACH'); p.skip(','); let alt: number | null = null; if (p.accept('MAINTAIN', 'MAINTAINING')) alt = p.altitude(); p.accept('UNTIL ESTABLISHED'); return done(mk('loc', { runway: rwy, maintainAlt: alt })); }
      if (p.accept('VISUAL', 'VISUAL APPROACH')) { p.accept('APPROACH'); const rwy = p.runway(false, plannedRunway); p.skip(','); let follow: string | null = null; if (p.accept('FOLLOW', 'FOLLOWING')) { p.skip('THE'); follow = p.otherAircraft(); } return done(mk('visual', { runway: rwy, follow })); }
      if (p.accept('RNAV', 'VOR', 'NDB', 'GPS')) p.fail('unsupported', 'Non-ILS approaches are Phase 2', ['ILS', 'VISUAL', 'LOCALIZER']);
      if (p.accept('APPROACH')) { const rwy = p.runway(false, plannedRunway); return done(parseIlsTail(p, mk('ils', { runway: rwy }), p)); }
      p.fail('unknown_verb', 'Cleared for what?', ['FOR TAKEOFF', 'TO LAND', 'ILS', 'VISUAL', 'LOCALIZER']);
    }
    // eslint-disable-next-line no-fallthrough
    case 'TAKEOFF': case 'CTO': {
      p.next();
      const rwy = p.runway(false, plannedRunway);
      const ast = mk('takeoff', { runway: rwy });
      for (;;) {
        if (p.accept('IMM', 'IMMEDIATE')) { ast.immediate = true; continue; }
        if (p.accept('HDG', 'HEADING')) { ast.afterDepHdg = p.heading(); continue; }
        break;
      }
      return done(ast);
    }
    case 'CANCEL': {
      p.next();
      if (p.accept('TAKEOFF', 'TAKE OFF', 'THE TAKEOFF', 'DEPARTURE')) { p.accept('CLEARANCE'); p.skip(','); p.accept('I SAY AGAIN CANCEL TAKEOFF', 'I SAY AGAIN', 'CANCEL TAKEOFF'); p.skip(','); return done(mk('cancelTakeoff', { reason: restAll(p) })); }
      if (p.accept('LINE UP', 'LINEUP', 'LINE UP AND WAIT', 'THE LINE UP', 'LINE UP CLEARANCE')) { p.skip(','); let via: string | null = null; if (p.accept('VACATE', 'VIA', 'VACATE VIA', 'VACATE RUNWAY')) { p.skip('RUNWAY', 'VIA'); if (p.isRunwayAhead()) p.runwayToken(); p.skip('VIA'); if (p.isTaxiwayAhead()) via = p.taxiway(); } return done(mk('cancelLineup', { via })); }
      if (p.accept('APPROACH', 'APPROACH CLEARANCE', 'THE APPROACH', 'ILS', 'ILS CLEARANCE')) { p.accept('CLEARANCE'); p.skip(','); return done(mk('cancelApproach', {})); }
      if (p.accept('MAYDAY', 'EMERGENCY')) return done(mk('emergencyCancelAck', {}));
      if (p.accept('SID', 'THE SID')) { p.skip(','); if (p.accept('FLY HEADING', 'HEADING', 'FLY')) { p.accept('HEADING'); return done(mk('heading', { hdg: p.heading() })); } p.fail('missing_param', 'Cancel SID needs a heading', ['FLY HEADING']); }
      if (p.accept('HOLD', 'HOLDING', 'THE HOLD')) { p.skip(','); return done(mk('continue', {})); }
      if (p.accept('SPEED', 'SPEED RESTRICTION', 'SPEED RESTRICTIONS')) return done(mk('speed', { kts: 'resume' }));
      if (p.eof) {
        if (stage === 'takeoff_roll' || (self?.takeoffCleared && (stage === 'lineup' || stage === 'hold_short_dep' || stage === 'taxi_out'))) return done(mk('cancelTakeoff', {}));
        if (stage === 'arr_armed' || stage === 'arr_established' || stage === 'arr_final' || self?.ilsArmed) return done(mk('cancelApproach', {}));
        return done(mk('disregard', {}));
      }
      p.fail('unknown_verb', 'Cancel what?', ['TAKEOFF', 'APPROACH CLEARANCE', 'LINE UP']);
    }
    // eslint-disable-next-line no-fallthrough
    case 'ABORT': case 'REJECT': { p.next(); p.accept('TAKEOFF', 'TAKE OFF'); p.skip(','); return done(mk('cancelTakeoff', { reason: restAll(p) })); }
    case 'VACATE': {
      p.next();
      if (p.accept('IF ABLE', 'IF POSSIBLE', 'WHEN ABLE')) { p.skip(','); let via: string | null = null; if (p.accept('VIA', 'AT')) via = p.taxiway(); return done(mk('stopOnRunway', { mode: 'vacate_if_able', via })); }
      const arrival = stage ? ['rollout', 'arr_final', 'arr_short_final', 'arr_established', 'arr_armed', 'arr_inbound', 'taxi_in'].includes(stage) : self?.plan?.kind === 'arrival';
      if (stage === 'lineup' || (!arrival && p.at('RUNWAY'))) {
        p.skip('RUNWAY'); if (p.isRunwayAhead()) p.runwayToken(); p.skip(',');
        let via: string | null = null; if (p.accept('VIA', 'AT')) via = p.taxiway(); p.accept('HOLD SHORT');
        return done(mk('cancelLineup', { via }));
      }
      if (p.accept('RUNWAY', 'THE RUNWAY') && p.isRunwayAhead()) p.runwayToken();
      return done(parseExitBody(p, mk, null));
    }
    case 'EXIT': { p.next(); return done(parseExitBody(p, mk, null)); }
    case 'TAKE': case 'NEXT': { if (t === 'TAKE') p.next(); p.accept('THE'); p.accept('NEXT'); p.accept('AVAILABLE'); p.accept('EXIT', 'TAXIWAY'); return done(parseExitBody(p, mk, 'next')); }
    case 'PLAN': { p.next(); p.accept('TO'); p.accept('VACATE', 'EXIT'); return done(parseExitBody(p, mk, null)); }
    case 'EXPEDITE': case 'EXPD': case 'EXP': {
      p.next();
      const scope = p.accept('TAXI', 'CROSSING', 'VACATING', 'CLIMB', 'DESCENT', 'DESCEND', 'THE CROSSING', 'YOUR TAXI');
      let sc: 'taxi' | 'crossing' | 'vacating' | 'climb' | 'descent' = scope ? (scope.replace('THE ', '').replace('YOUR ', '').replace('DESCEND', 'DESCENT').toLowerCase() as never) : (air === false ? 'taxi' : 'climb');
      if (!scope && stage === 'hold_short_cross') sc = 'crossing'; else if (!scope && stage === 'rollout') sc = 'vacating';
      restText(p);
      return done(mk('expedite', { on: true, scope: sc }));
    }
    case 'LAND': { p.next(); return done(parseLandBody(p, mk, p.runway(false, plannedRunway))); }
    case 'CTL': { p.next(); const rwy = p.runway(false, plannedRunway); const ast = mk('clearedLand', { runway: rwy }); for (;;) { if (p.accept('EXIT')) { const e = p.next(); ast.exit = e === 'L' || e === 'R' ? { kind: 'next', dir: e } : { kind: 'taxiway', taxiway: e }; continue; } if (p.accept('LAHSO')) { ast.lahso = p.runway(); continue; } break; } return done(ast); }
    case 'GO': case 'GA': case 'GOAROUND': case 'MISSED': {
      p.next(); p.accept('AROUND'); p.accept('APPROACH'); p.skip(',');
      p.accept('I SAY AGAIN GO AROUND', 'I SAY AGAIN', 'GO AROUND'); p.skip(',');
      return done(mk('goAround', { reason: restTextUntilVerb(p) }));
    }
    case 'WIND': { p.next(); p.accept('CHECK'); restText(p); return done(mk('windCheck', {})); }
    case 'CONTACT': case 'CT': case 'MONITOR': case 'HANDOFF': {
      p.next();
      if (p.accept('APPROACH FOR RE-SEQUENCING')) return done(mk('contact', { position: 'approach', when: pending.contactWhen ?? 'now' }));
      // "CONTACT LONDON CONTROL 127.4" -> external
      if (!POSITION_WORDS[p.peek()] && /^[A-Z]+$/.test(p.peek()) && POSITION_WORDS[p.peek(1)]) p.next();
      const pos = p.position()!;
      let when: ContactWhen = pending.contactWhen ?? (pending.cond?.type === 'on_reaching_hold' ? 'on_reaching' : 'now');
      for (;;) {
        p.skip(',');
        if (p.accept('WHEN VACATED', 'AFTER VACATING', 'WHEN CLEAR OF THE RUNWAY', 'WHEN CLEAR')) { when = 'when_vacated'; continue; }
        if (p.accept('ON REACHING', 'WHEN REACHING')) { if (/^(FL)?\d+$/.test(p.peek())) p.altitude(); when = 'on_reaching'; continue; }
        if (p.accept('AT THE HOLDING POINT', 'AT THE HOLD', 'AT HOLDING POINT', 'AT THE HOLDING POINT RUNWAY')) { if (p.isRunwayAhead()) p.runwayToken(); when = 'at_hold'; continue; }
        if (p.accept('FOR RE SEQUENCING', 'FOR RESEQUENCING', 'GOOD DAY', 'GOODBYE', 'BYE')) continue;
        break;
      }
      restText(p);
      return done(mk('contact', { position: pos, when }));
    }
    // ── approach ────────────────────────────────────────────────────────────
    case 'TURN': {
      p.next();
      const dir = p.accept('LEFT', 'RIGHT') as 'LEFT' | 'RIGHT' | null;
      if (!dir) { p.accept('HEADING', 'HDG'); return done(mk('heading', { hdg: p.heading(), dir: null })); }
      const d: TurnDir = dir === 'LEFT' ? 'L' : 'R';
      if (p.accept('HEADING', 'HDG')) return done(mk('heading', { hdg: p.heading(), dir: d }));
      const tok = p.peek();
      if (/^\d{1,3}$/.test(tok) && (p.peek(1) === 'DEGREES' || p.peek(1) === 'DEG' || tok.length < 3)) { p.next(); p.accept('DEGREES', 'DEG'); const deg = parseInt(tok, 10); if (deg < 5 || deg > 180) p.fail('invalid_heading', 'Relative turn 5-180 degrees', ['<degrees>'], p.i - 1); return done(mk('heading', { hdg: relativeHeading(self, d, deg), dir: d, relative: { dir: d, deg } })); }
      if (p.accept('TURNS')) { p.fail('unknown_verb', 'Hold turns belong to a hold command', ['HOLD AT']); }
      return done(mk('heading', { hdg: p.heading(), dir: d }));
    }
    case 'FLY': {
      p.next();
      if (p.accept('RUNWAY HEADING', 'THE RUNWAY HEADING')) return done(runwayHeadingPart(mk, runwayHeading(p, plannedRunway)));
      if (p.accept('PRESENT HEADING', 'CURRENT HEADING')) { if (self?.heading == null) p.fail('missing_param', 'Present heading unknown', ['<heading>']); return done(mk('heading', { hdg: Math.round(self.heading) || 360, dir: null })); }
      p.accept('HEADING', 'HDG');
      return done(mk('heading', { hdg: p.heading(), dir: null }));
    }
    case 'HEADING': case 'HDG': case 'VECTOR': case 'H': {
      p.next(); p.accept('HEADING', 'HDG'); p.skip('TO');
      if (p.accept('RUNWAY HEADING')) return done(runwayHeadingPart(mk, runwayHeading(p, plannedRunway)));
      const hdg = p.heading();
      const dir = p.accept('LEFT', 'L') ? 'L' : p.accept('RIGHT', 'R') ? 'R' : null;
      return done(mk('heading', { hdg, dir }));
    }
    case 'L': case 'R': { p.next(); p.accept('HEADING', 'HDG'); return done(mk('heading', { hdg: p.heading(), dir: t as TurnDir })); }
    case 'LEFT': case 'RIGHT': {
      if (!p.at('LEFT HEADING') && !p.at('RIGHT HEADING') && !p.at('LEFT HDG') && !p.at('RIGHT HDG') && !p.at('LEFT TURN HEADING') && !p.at('RIGHT TURN HEADING')) break;
      p.next(); p.accept('TURN'); p.accept('HEADING', 'HDG');
      return done(mk('heading', { hdg: p.heading(), dir: t === 'LEFT' ? 'L' : 'R' }));
    }
    case 'CLIMB': case 'DESCEND': case 'ALTITUDE': case 'ALT': case 'A': case 'C': case 'D': {
      p.next();
      if (t === 'D' && (p.isFixAhead() || (!/^(FL)?\d+$/.test(p.peek()) && FIX_RE.test(p.peek())))) return done(parseDirectBody(p, mk));
      if (t === 'CLIMB' && p.accept('VIA SID', 'VIA THE SID')) return done(mk('resumeSid', {}));
      if (p.accept('IN THE HOLD', 'IN HOLD')) { /* descend in hold */ }
      p.accept('AND MAINTAIN'); p.skip('TO', 'AND', 'MAINTAIN', 'ALTITUDE');
      if (t === 'DESCEND' && p.accept('VIA STAR', 'VIA THE STAR')) p.fail('unsupported', 'STARs are Phase 2', ['<altitude>']);
      const ft = p.altitude();
      const ast = mk('altitude', { ft });
      for (;;) {
        if (p.accept('EXPEDITE', 'EXPD', 'EXP')) { ast.expedite = true; p.accept('CLIMB', 'DESCENT', 'THROUGH', 'UNTIL PASSING'); if (/^(FL)?\d+$/.test(p.peek())) p.altitude(); continue; }
        if (p.accept('AT PILOTS DISCRETION', 'PILOTS DISCRETION', 'WHEN READY', 'PD', 'AT YOUR DISCRETION')) { ast.when = { type: 'when_ready' }; continue; }
        break;
      }
      return done(ast);
    }
    case 'MAINTAIN': {
      p.next();
      const tok = p.peek();
      if (p.accept('PRESENT HEADING', 'HEADING')) { if (self?.heading == null) p.fail('missing_param', 'Present heading unknown', ['<heading>']); return done(mk('heading', { hdg: Math.round(self.heading) || 360 })); }
      if (p.accept('SPEED', 'MINIMUM CLEAN SPEED', 'MIN CLEAN')) { if (/^\d+$/.test(p.peek())) return done(parseSpeedTail(p, mk, p.speed())); return done(minClean(p, mk, self)); }
      if (/^FL\d+$/.test(tok) || (/^\d+$/.test(tok) && (parseInt(tok, 10) >= 1000 || parseInt(tok, 10) < 100))) return done(mk('altitude', { ft: p.altitude(), expedite: !!p.accept('EXPEDITE') }));
      if (/^\d{3}$/.test(tok)) { const n = parseInt(tok, 10); if (p.peek(1) === 'KNOTS' || p.peek(1) === 'KTS' || p.peek(1) === 'KT' || (n >= 100 && n <= 350 && p.peek(1) !== 'FEET')) return done(parseSpeedTail(p, mk, p.speed())); return done(mk('altitude', { ft: p.altitude() })); }
      p.fail('missing_param', 'Maintain what?', ['<altitude>', '<speed>']);
    }
    // eslint-disable-next-line no-fallthrough
    case 'SPEED': case 'SPD': case 'S': case 'REDUCE': case 'INCREASE': {
      p.next(); p.accept('SPEED', 'SPD'); p.skip('TO');
      if (p.accept('RESUME', 'NORMAL', 'RESUME NORMAL')) { p.accept('SPEED'); return done(mk('speed', { kts: 'resume' })); }
      if (p.accept('MINIMUM CLEAN', 'MIN CLEAN', 'MINIMUM CLEAN SPEED', 'MINCLEAN')) { p.accept('SPEED'); return done(minClean(p, mk, self)); }
      if (p.accept('FINAL APPROACH SPEED', 'APPROACH SPEED', 'VAPP')) p.fail('unsupported', 'Final approach speed needs the picker (per-type)', ['<speed>']);
      return done(parseSpeedTail(p, mk, p.speed()));
    }
    case 'NO': { p.next(); if (p.accept('SPEED RESTRICTION', 'SPEED RESTRICTIONS', 'SPEED')) return done(mk('speed', { kts: 'resume' })); p.fail('unknown_verb', 'Unknown instruction', ['SPEED RESTRICTION']); }
    // eslint-disable-next-line no-fallthrough
    case 'DIRECT': case 'DCT': case 'PROCEED': { p.next(); p.accept('DIRECT', 'DCT', 'TO'); return done(parseDirectBody(p, mk)); }
    case 'ILS': case 'I': { p.next(); p.accept('APPROACH'); const rwy = p.runway(false, plannedRunway); p.accept('APPROACH'); return done(parseIlsTail(p, mk('ils', { runway: rwy }), p)); }
    case 'LOC': case 'LOCALIZER': case 'LOCALISER': case 'LLZ': case 'JOIN': {
      p.next(); p.accept('THE'); p.accept('LOCALIZER', 'LOCALISER', 'LOC', 'LLZ'); p.accept('APPROACH');
      const rwy = p.runway(false, plannedRunway); p.accept('APPROACH'); p.skip(',');
      let alt: number | null = null; if (p.accept('MAINTAIN', 'MAINTAINING', 'AT')) alt = p.altitude(); p.accept('UNTIL ESTABLISHED');
      return done(mk('loc', { runway: rwy, maintainAlt: alt }));
    }
    case 'VISUAL': case 'VIS': { p.next(); p.accept('APPROACH'); const rwy = p.runway(false, plannedRunway); p.skip(','); let follow: string | null = null; if (p.accept('FOLLOW', 'FOLLOWING')) { p.skip('THE'); follow = p.otherAircraft(); } return done(mk('visual', { runway: rwy, follow })); }
    case 'EXPECT': {
      p.next();
      if (/^\d+$/.test(p.peek()) && (p.peek(1) === 'MINUTES' || p.peek(1) === 'MINUTE' || p.peek(1) === 'MIN')) { p.next(); p.next(); p.accept('DELAY'); restText(p); return done(mk('unable', { reason: 'delay' })); }
      if (p.accept('DELAY')) { restText(p); return done(mk('unable', { reason: 'delay' })); }
      p.accept('VECTORS', 'VECTORS FOR', 'VECTORS FOR THE', 'THE');
      let approach: ApproachType = 'ILS';
      const ap = p.accept('ILS', 'VISUAL', 'LOC', 'LOCALIZER', 'LOCALISER', 'RNAV');
      if (ap) approach = ap === 'VISUAL' ? 'VISUAL' : ap === 'RNAV' ? 'RNAV' : ap === 'ILS' ? 'ILS' : 'LOC';
      p.accept('APPROACH');
      const rwy = p.runway();
      p.skip(','); if (p.accept('INFORMATION')) p.next();
      return done(mk('expectRunway', { runway: rwy, approach }));
    }
    case 'CHANGE': {
      p.next(); p.accept('OF', 'TO'); p.accept('RUNWAY', 'RWY'); p.skip(',');
      if (p.at('EXPECT')) {
        p.next(); p.accept('VECTORS', 'VECTORS FOR', 'THE');
        const ap = p.accept('ILS', 'VISUAL', 'LOC', 'LOCALIZER', 'LOCALISER', 'RNAV'); p.accept('APPROACH'); p.accept('RUNWAY', 'RWY');
        const approach: ApproachType = ap === 'VISUAL' ? 'VISUAL' : ap === 'RNAV' ? 'RNAV' : ap === 'ILS' || !ap ? 'ILS' : 'LOC';
        return done(mk('expectRunway', { runway: p.runway(), approach }));
      }
      const rwy = p.runway();
      p.skip(','); p.accept('CLEARED ILS', 'EXPECT ILS'); if (p.isRunwayAhead()) p.runwayToken();
      if (air === false) return done(mk('expectRunway', { runway: rwy, approach: 'ILS' }));
      return done(mk('ils', { runway: rwy }));
    }
    case 'SQUAWK': case 'SQ': {
      p.next();
      if (p.accept('IDENT')) return done(mk('ident', {}));
      const code = p.peek();
      if (!/^\d{4}$/.test(code)) p.fail('missing_param', 'Squawk code required', ['<squawk>']);
      if (!/^[0-7]{4}$/.test(code)) p.fail('invalid_squawk', `Squawk ${code} must be four octal digits`, ['<squawk>']);
      p.next();
      return done(mk('squawk', { code }));
    }
    case 'IDENT': { p.next(); return done(mk('ident', {})); }
    case 'RADAR': case 'RC': {
      p.next(); p.accept('CONTACT'); p.skip(',');
      const ast = mk('radarContact', {});
      for (;;) {
        if (p.accept('DESCEND', 'DESCEND TO', 'DESCEND AND MAINTAIN')) { ast.descendTo = p.altitude(); p.skip(','); continue; }
        if (p.accept('QNH', 'ALTIMETER')) { p.number(); p.skip(','); continue; }
        if (p.accept('EXPECT')) { p.accept('ILS', 'RUNWAY', 'ILS RUNWAY'); ast.expectRunway = p.runway(); p.skip(','); continue; }
        break;
      }
      return done(ast);
    }
    // ── meta ────────────────────────────────────────────────────────────────
    case 'SAY': {
      p.next();
      if (p.accept('AGAIN')) { restText(p); return done(mk('sayAgain', {})); }
      if (p.accept('WIND')) return done(mk('windCheck', {}));
      return done(mk('report', { items: parseReportItems(p) }));
    }
    case 'CORRECTION': case 'NEGATIVE': {
      p.next(); p.skip(',');
      if (t === 'NEGATIVE' && p.eof) return done(mk('unable', { reason: 'traffic' }));
      const field = CORRECTION_WORDS[p.peek()];
      if (!field) p.fail('missing_param', 'Correction of what?', Object.keys(CORRECTION_WORDS));
      p.next();
      const v = p.peek();
      if (!v) p.fail('missing_param', 'Corrected value required', ['<value>']);
      p.next();
      p.skip('DEGREES', 'FEET', 'KNOTS', ',');
      if (p.accept('I SAY AGAIN', 'SAY AGAIN', 'AGAIN')) { p.skip(','); if (CORRECTION_WORDS[p.peek()] === field) p.next(); if (p.peek() === v) p.next(); p.skip('DEGREES', 'FEET', 'KNOTS'); }
      restText(p);
      const value: number | string = field === 'runway' || field === 'taxiway' || field === 'squawk' || field === 'frequency' ? v : (field === 'altitude' ? altitudeFromToken(v) : parseInt(v, 10));
      return done(mk('correction', { field, value }));
    }
    case 'DISREGARD': { p.next(); restText(p); return done(mk('disregard', {})); }
    case 'STANDBY': case 'STAND': { p.next(); p.accept('BY'); restText(p); return done(mk('standby', {})); }
    case 'UNABLE': {
      p.next(); p.skip(',');
      let reason: UnableReason = 'traffic';
      const w = p.peek();
      if (UNABLE_WORDS[w]) { reason = UNABLE_WORDS[w]; p.next(); p.accept('CLOSED'); }
      restText(p);
      return done(mk('unable', { reason }));
    }
    case 'REPORT': { p.next(); return done(mk('report', { items: parseReportItems(p) })); }
    case 'READ': { p.next(); p.accept('YOU'); p.accept('FIVE', '5', 'FIVE BY FIVE', 'LOUD AND CLEAR'); return done(mk('report', { items: ['readyou5'] })); }
    case 'ROGER': case 'RGR': case 'COPIED': case 'READBACK': {
      p.next(); p.accept('CORRECT'); p.skip(',');
      if (p.accept('MAYDAY CANCELLED', 'MAYDAY CANCELED', 'PAN CANCELLED', 'EMERGENCY CANCELLED')) return done(mk('emergencyCancelAck', {}));
      if (p.accept('MAYDAY', 'PAN PAN', 'PAN', 'THE MAYDAY', 'YOUR MAYDAY', 'EMERGENCY')) return done(parseEmergencyAckTail(p, mk));
      restText(p);
      return done(mk('roger', {}));
    }
    case 'ACKNOWLEDGE': case 'ACK': case 'MAYDAY': {
      p.next(); p.accept('MAYDAY', 'ACKNOWLEDGED', 'RECEIVED');
      if (p.accept('CANCELLED', 'CANCELED')) return done(mk('emergencyCancelAck', {}));
      return done(parseEmergencyAckTail(p, mk));
    }
    case 'PRIORITY': case 'NUMBER': {
      p.next();
      const ast = mk('priority', { numberOne: false, clearIls: false });
      if (t === 'NUMBER') { p.accept('ONE', '1'); ast.numberOne = true; }
      p.skip(','); p.accept('RUNWAY', 'RWY');
      ast.runway = p.runway(false, plannedRunway);
      if (!ast.runway) p.fail('missing_param', 'Priority runway required', ['<runway>']);
      for (;;) {
        p.skip(',');
        if (p.accept('NUMBER ONE', 'NUMBER 1')) { ast.numberOne = true; continue; }
        if (p.accept('STRAIGHT IN', 'STRAIGHT-IN')) { ast.straightIn = true; p.accept('ILS'); if (p.isRunwayAhead()) p.runwayToken(); continue; }
        if (p.accept('CLEARED ILS', 'CLEARED ILS APPROACH')) { ast.clearIls = true; p.accept('APPROACH'); if (p.isRunwayAhead()) p.runwayToken(); continue; }
        if (p.accept('RUNWAY STERILE', 'STERILE', 'RUNWAY WILL BE STERILE')) { ast.sterile = true; continue; }
        if (p.accept('EMERGENCY SERVICES ALERTED', 'EMERGENCY SERVICES WILL BE ALERTED')) continue;
        break;
      }
      return done(ast);
    }
    case 'AFTER': {
      // "AFTER DEPARTURE FLY HEADING 250" -> a heading part (folded into takeoff later)
      p.next(); p.accept('DEPARTURE', 'TAKEOFF', 'AIRBORNE'); p.skip(',');
      return parsePart(p, cs, self);
    }
    default: break;
  }
  const verbs = VERBS.map(v => v.text);
  p.fail('unknown_verb', t ? `Unknown instruction "${t}"` : 'Instruction required', t ? verbs.filter(v => v.startsWith(t[0])).concat(verbs.filter(v => !v.startsWith(t[0]))).slice(0, 12) : verbs.slice(0, 12));

  function done(part: Part): { part: Part; pending: Pending } { return { part, pending }; }
}

// ── helpers used by the part grammar ─────────────────────────────────────────
type Mk = <K extends Part['kind']>(kind: K, fields: Partial<Omit<Extract<Part, { kind: K }>, 'kind' | 'callsign'>>) => Extract<Part, { kind: K }>;

function hdgTrue(p: Parser, digits: string): number {
  const n = parseInt(digits, 10);
  if (n < 1 || n > 360) p.fail('invalid_heading', `Heading ${digits} must be 001-360`, ['<heading>'], p.i - 1);
  const tr = Math.round(trueHeading(n, p.ctx.magVar ?? 0));
  return ((tr % 360) + 360) % 360 || 360;
}
/** Heading parts produced by "runway heading" (fold() turns them into afterDepHdg / goAround.heading = 'runway'). */
const RUNWAY_HDG_PARTS = new WeakSet<object>();
function runwayHeadingPart(mk: Mk, hdg: number): Part {
  const part = mk('heading', { hdg, dir: null });
  RUNWAY_HDG_PARTS.add(part);
  return part;
}
/** Free-text tail up to the next THEN separator (reasons that may contain verb words, e.g. "vehicle on runway"). */
function restAll(p: Parser): string | null {
  const words: string[] = [];
  while (!p.eof && p.peek() !== 'THEN') words.push(p.next());
  return words.length ? words.join(' ').toLowerCase() : null;
}
function runwayHeading(p: Parser, rwy: string | null): number {
  if (!rwy) p.fail('missing_param', 'Runway heading unknown — no runway assigned', ['<heading>']);
  const h = p.ctx.runwayHeadingTrue?.(rwy);
  if (h == null) {
    const m = rwy.match(/^(\d{1,2})/);
    if (!m) p.fail('missing_param', 'Runway heading unknown', ['<heading>']);
    const mag = parseInt(m[1], 10) * 10;
    const tr = Math.round(trueHeading(mag, p.ctx.magVar ?? 0));
    return ((tr % 360) + 360) % 360 || 360;
  }
  return Math.round(h) || 360;
}
function relativeHeading(self: ParseAircraft | null, dir: TurnDir, deg: number): number {
  const cur = self?.heading ?? 0;
  const h = ((Math.round(cur + (dir === 'L' ? -deg : deg)) % 360) + 360) % 360;
  return h || 360;
}
function altitudeFromToken(v: string): number {
  if (/^FL\d{2,3}$/.test(v)) return parseInt(v.slice(2), 10) * 100;
  const n = parseInt(v, 10);
  return n >= 1000 ? n : n < 10 ? n * 1000 : n * 100;
}
/** True when the token at the cursor starts a new part ("LEFT HEADING" counts, a bare "LEFT" in a reason does not). */
function verbAhead(p: Parser): boolean {
  const t = p.peek();
  if ((t === 'LEFT' || t === 'RIGHT') && /^(HEADING|HDG)$/.test(p.peek(1))) return true;
  return VERB_STARTERS.has(t);
}
function restText(p: Parser): string | null {
  // free-text tail (reasons) up to the next THEN separator; stops at a verb starter so the next part still parses
  const words: string[] = [];
  while (!p.eof && p.peek() !== 'THEN' && !(verbAhead(p) && !['A', 'C', 'D', 'H', 'I', 'L', 'R', 'S', 'T', 'AT', 'ON'].includes(p.peek()) && words.length >= 0 && !['I', 'SAY'].includes(p.peek()))) {
    const w = p.next();
    if (w === 'I' && p.peek() === 'SAY') { p.next(); p.accept('AGAIN'); continue; }
    words.push(w);
  }
  return words.length ? words.join(' ').toLowerCase() : null;
}
const SOFT_STARTERS = new Set(['ON', 'AT', 'A', 'C', 'D', 'H', 'I', 'L', 'R', 'S', 'T', 'NO', 'OWN', 'RUNWAY', 'RWY']);
/** Like verbAhead but prepositions / single letters only count when they really open a part ("ON REACHING", "AT 4000", "D OCK"). */
function hardVerbAhead(p: Parser): boolean {
  const t = p.peek();
  if (!SOFT_STARTERS.has(t)) return verbAhead(p);
  if (t === 'ON') return p.at('ON REACHING');
  if (t === 'AT') return /^(FL)?\d+$/.test(p.peek(1)) || p.at('AT OR') || p.at('AT PILOTS');
  if (t === 'NO') return p.at('NO SPEED');
  if (t === 'RUNWAY' || t === 'RWY') return RUNWAY_RE.test(p.peek(1)) || p.peek(1) === 'HEADING';
  if (t === 'D') return p.isFixAhead(1);
  return /^(FL)?\d+$/.test(p.peek(1));
}
function restTextUntilVerb(p: Parser): string | null {
  const words: string[] = [];
  while (!p.eof && p.peek() !== 'THEN' && !hardVerbAhead(p)) words.push(p.next());
  return words.length ? words.join(' ').toLowerCase() : null;
}
function parseNumberChip(p: Parser): number | null {
  p.skip(',');
  if (p.accept('NUMBER', 'NO')) { const w = p.next(); const n = w === 'ONE' ? 1 : w === 'TWO' ? 2 : w === 'THREE' ? 3 : parseInt(w, 10); return isFinite(n) ? n : null; }
  return null;
}
function parseExpectRunway(p: Parser): string | null {
  p.skip(',');
  if (p.accept('EXPECT')) { p.accept('RUNWAY', 'RWY'); return p.runway(); }
  if (p.accept('RUNWAY', 'RWY')) return p.runway();
  return null;
}
function parsePushback(p: Parser, mk: Mk, withStartup = false): Part {
  p.next(); p.accept('BACK'); p.accept('APPROVED', 'APPROVE');
  const ast = mk('pushback', { startup: withStartup });
  for (;;) {
    p.skip(',');
    if (p.accept('AND START', 'AND STARTUP', 'START UP APPROVED', 'STARTUP APPROVED', 'START APPROVED', 'START', 'STARTUP')) { p.accept('UP'); p.accept('APPROVED'); ast.startup = true; continue; }
    if (p.accept('FACE', 'FACING', 'NOSE')) { const d = PUSH_DIRS[p.peek()]; if (!d) p.fail('missing_param', 'Facing direction required', ['NORTH', 'EAST', 'SOUTH', 'WEST']); p.next(); ast.dir = d; continue; }
    if (p.accept('TAIL', 'TAIL TO')) { p.skip('TO', 'TAXIWAY', 'TWY'); ast.tailTo = p.taxiway(); continue; }
    if (p.at('EXPECT') || p.at('RUNWAY') || p.at('RWY')) { ast.expectRunway = parseExpectRunway(p); continue; }
    if (p.accept('AS REQUIRED', 'ANY')) { ast.dir = 'any'; continue; }
    break;
  }
  return ast;
}
function parseHoldTarget(p: Parser, self: ParseAircraft | null = null): HoldShortTarget {
  p.skip('OF', 'THE');
  if (p.accept('TAXIWAY', 'TWY')) return { kind: 'taxiway', taxiway: p.taxiway() };
  if (p.accept('RUNWAY', 'RWY') || p.isRunwayAhead()) { const r = p.runway(false, self?.holdShortRunway ?? null); if (!r) p.fail('missing_param', 'Hold short of which runway?', ['<runway>']); return { kind: 'runway', runway: r }; }
  if (p.isTaxiwayAhead()) return { kind: 'taxiway', taxiway: p.taxiway() };
  if (p.eof && self?.holdShortRunway) return { kind: 'runway', runway: self.holdShortRunway };
  p.fail('missing_param', 'Hold short of what?', ['<runway>', '<taxiway>']);
}
function parseTaxi(p: Parser, mk: Mk, self: ParseAircraft | null): Part {
  p.next();
  p.skip('TO', 'THE');
  if (p.accept('AND HOLD AT', 'AND HOLD', 'HOLD AT', 'HOLD SHORT OF THE INTERSECTION', 'HOLD AT THE INTERSECTION OF', 'AND HOLD AT THE INTERSECTION OF')) {
    p.skip('THE', 'INTERSECTION', 'OF', 'TAXIWAY', 'TAXIWAYS');
    const a = p.taxiway(); p.skip('AND', 'WITH', 'TAXIWAY'); const b = p.taxiway();
    const node = p.ctx.intersectionNode?.(a, b) ?? { nodeId: `${a}/${b}`, label: `${a}/${b}` };
    return parseTaxiBody(p, mk, { kind: 'node', nodeId: node.nodeId, label: node.label }, self);
  }
  if (p.accept('STAND', 'GATE', 'APRON')) { const ref = p.stand(); return parseTaxiBody(p, mk, { kind: 'stand', ref }, self); }
  if (p.accept('HOLDING POINT', 'HOLD SHORT', 'HOLDING POINT RUNWAY', 'HOLD POINT')) { p.skip('OF'); }
  if (p.accept('DE-ICING PAD', 'DEICING PAD', 'PAD')) p.fail('unsupported', 'De-icing pads are Phase 2', ['<runway>', 'STAND']);
  let intersection: string | null = null;
  if (p.at('RUNWAY') || p.at('RWY') || p.isRunwayAhead() || (RUNWAY_RE.test(p.peek()) && !(p.strict.stand ? p.ctx.stands!.some(s => s.toUpperCase() === p.peek()) : false))) {
    const rwy = p.runway();
    if (p.accept('AT')) intersection = p.taxiway();
    return parseTaxiBody(p, mk, { kind: 'runway', runway: rwy, intersection }, self);
  }
  if (p.isTaxiwayAhead() && p.isTaxiwayAhead(1) && (p.peek(2) === '' || ['VIA', 'HOLD', 'HS', 'EXPEDITE', 'THEN', 'CROSS'].includes(p.peek(2)))) {
    // "taxi A B" (describe() form of a node destination = intersection of A and B)
    const a = p.taxiway(); const b = p.taxiway();
    const node = p.ctx.intersectionNode?.(a, b) ?? { nodeId: `${a}/${b}`, label: `${a}/${b}` };
    return parseTaxiBody(p, mk, { kind: 'node', nodeId: node.nodeId, label: node.label }, self);
  }
  if (p.isTaxiwayAhead() && p.peek(1) === 'AND' && p.isTaxiwayAhead(2) && !p.at('VIA')) {
    const a = p.taxiway(); p.next(); const b = p.taxiway();
    const node = p.ctx.intersectionNode?.(a, b) ?? { nodeId: `${a}/${b}`, label: `${a}/${b}` };
    return parseTaxiBody(p, mk, { kind: 'node', nodeId: node.nodeId, label: node.label }, self);
  }
  if (p.at('VIA') || p.eof) {
    // destination from the aircraft's plan (amend / progressive)
    const dest = planDest(self);
    if (!dest) p.fail('missing_param', 'Taxi where? (runway or stand)', ['<runway>', 'STAND']);
    return parseTaxiBody(p, mk, dest, self, false);
  }
  // "TAXI 512" (bare stand) when it is a known stand
  if (p.strict.stand ? p.ctx.stands!.some(s => s.toUpperCase() === p.peek()) : STAND_RE.test(p.peek()) && !RUNWAY_RE.test(p.peek())) { const ref = p.stand(); return parseTaxiBody(p, mk, { kind: 'stand', ref }, self); }
  p.fail('missing_param', 'Taxi where? (runway or stand)', ['<runway>', 'STAND']);
}
function planDest(self: ParseAircraft | null): TaxiDest | null {
  if (!self?.plan) return null;
  if (self.plan.kind === 'arrival' && self.plan.gateRef) return { kind: 'stand', ref: self.plan.gateRef };
  if (self.plan.runway) return { kind: 'runway', runway: self.plan.runway, intersection: null };
  if (self.plan.gateRef) return { kind: 'stand', ref: self.plan.gateRef };
  return null;
}
function parseTaxiBody(p: Parser, mk: Mk, dest: TaxiDest | null, self: ParseAircraft | null, autoDefault = true): Part {
  const d = dest ?? planDest(self);
  if (!d) p.fail('missing_param', 'Taxi where? (runway or stand)', ['<runway>', 'STAND']);
  const ast = mk('taxi', { dest: d, auto: autoDefault });
  for (;;) {
    p.skip(',');
    if (p.accept('VIA', 'ROUTE')) {
      p.skip(',');
      while (!p.eof && p.isTaxiwayAhead() && !['HOLD', 'HS', 'CROSS', 'EXPEDITE', 'THEN', 'CONTACT', 'AT', 'REPORT'].includes(p.peek())) { ast.via.push(p.taxiway()); p.skip(',', 'AND', 'THEN'); if (p.peek() === 'THEN') break; }
      if (!ast.via.length) {
        if (!p.eof && !VERB_STARTERS.has(p.peek()) && !RUNWAY_RE.test(p.peek())) p.taxiway(); // raises unknown_taxiway with the offending token
        p.fail('missing_param', 'Taxiway route required after VIA', ['<taxiway>']);
      }
      ast.auto = false;
      continue;
    }
    if (p.accept('AT') && ast.dest.kind === 'runway') { (ast.dest as { intersection: string | null }).intersection = p.taxiway(); continue; }
    if (p.accept('HOLD SHORT', 'HS', 'HOLDING SHORT')) { p.skip('OF'); ast.holdShortOf = parseHoldTarget(p); continue; }
    if (p.accept('CROSS')) { p.skip('RUNWAY', 'RWY', 'RUNWAYS'); ast.cross.push(p.runway()); if (p.accept('AT')) p.taxiway(); while (p.accept('AND', ',')) { p.skip('RUNWAY', 'RWY'); ast.cross.push(p.runway()); } continue; }
    if (p.accept('EXPEDITE', 'EXPD', 'NO DELAY')) { ast.expedite = true; continue; }
    if (p.accept('AUTO', 'AUTO ROUTE', 'SHORTEST')) { ast.auto = true; continue; }
    break;
  }
  if (ast.via.length) ast.auto = false;
  return ast;
}
function parseLineup(p: Parser, mk: Mk, rwy: string | null, pending: Pending, plannedRunway: string | null = null): Part {
  p.accept('LINE UP AND WAIT', 'LINE UP', 'LINEUP', 'LUAW', 'LINE UP AND WAIT RUNWAY');
  p.accept('AND WAIT'); p.accept('RUNWAY', 'RWY');
  const runway = rwy ?? p.runway(false, plannedRunway);
  const ast = mk('lineup', { runway, behind: pending.behind });
  for (;;) {
    p.skip(',');
    if (p.accept('AT')) { ast.intersection = p.taxiway(); continue; }
    if (p.accept('BEHIND')) { p.skip('THE', 'LANDING', 'DEPARTING', 'NEXT'); if (p.eof) continue; ast.behind = p.otherAircraft(); p.accept('BEHIND'); continue; }
    if (p.accept('AND WAIT', 'WAIT')) continue;
    if (p.accept('TRAFFIC')) { ast.trafficInfo = restText(p); continue; }
    if (p.accept('BE READY FOR IMMEDIATE DEPARTURE', 'BE READY')) continue;
    break;
  }
  return ast;
}
function parseLandBody(p: Parser, mk: Mk, rwy: string): Part {
  const ast = mk('clearedLand', { runway: rwy });
  for (;;) {
    p.skip(',');
    const n = parseNumberChip(p); if (n != null) { ast.number = n; continue; }
    if (p.accept('HOLD SHORT', 'HS', 'LAHSO')) { p.skip('OF'); const t = parseHoldTarget(p); ast.lahso = t.kind === 'runway' ? t.runway : t.kind === 'taxiway' ? t.taxiway : t.label; p.accept('FOR CROSSING TRAFFIC'); continue; }
    if (p.accept('EXIT AT', 'EXIT', 'VACATE AT', 'VACATE VIA', 'VACATE', 'PLAN TO VACATE AT', 'PLAN TO VACATE')) {
      const e = p.accept('LEFT', 'RIGHT');
      if (e) { ast.exit = { kind: 'next', dir: e === 'LEFT' ? 'L' : 'R' }; p.accept('AT', 'VIA'); if (p.isTaxiwayAhead()) ast.exit = { kind: 'taxiway', taxiway: p.taxiway() }; continue; }
      p.skip('AT', 'VIA'); ast.exit = { kind: 'taxiway', taxiway: p.taxiway() }; continue;
    }
    if (p.accept('NEXT EXIT LEFT', 'NEXT AVAILABLE EXIT LEFT', 'NEXT AVAILABLE LEFT', 'NEXT LEFT')) { ast.exit = { kind: 'next', dir: 'L' }; continue; }
    if (p.accept('NEXT EXIT RIGHT', 'NEXT AVAILABLE EXIT RIGHT', 'NEXT AVAILABLE RIGHT', 'NEXT RIGHT')) { ast.exit = { kind: 'next', dir: 'R' }; continue; }
    if (p.accept('WIND')) { p.number(); p.accept('DEGREES'); p.number(); p.accept('KNOTS'); continue; }
    if (p.accept('TRAFFIC', 'FOLLOWING')) { ast.trafficInfo = restText(p); continue; }
    if (p.accept('CAUTION WAKE TURBULENCE')) { restTextUntilVerb(p); continue; }
    break;
  }
  return ast;
}
function parseExitBody(p: Parser, mk: Mk, mode: 'next' | null): Part {
  let exit: ExitSpec | null = null;
  const dir = p.accept('LEFT', 'RIGHT', 'L', 'R');
  const d: 'L' | 'R' | null = dir ? (dir.startsWith('L') ? 'L' : 'R') : null;
  if (p.accept('NEXT', 'NEXT AVAILABLE', 'THE NEXT', 'THE NEXT AVAILABLE')) { p.accept('EXIT', 'TAXIWAY'); const d2 = p.accept('LEFT', 'RIGHT', 'ON THE LEFT', 'ON THE RIGHT'); exit = { kind: 'next', dir: d2 ? (d2.endsWith('LEFT') ? 'L' : 'R') : d ?? 'L' }; }
  else if (p.accept('AT', 'VIA')) exit = { kind: 'taxiway', taxiway: p.taxiway() };
  else if (p.isTaxiwayAhead()) exit = { kind: 'taxiway', taxiway: p.taxiway() };
  else if (d) exit = { kind: 'next', dir: d };
  else if (mode === 'next') { const d3 = p.accept('LEFT', 'RIGHT', 'ON THE LEFT', 'ON THE RIGHT'); exit = { kind: 'next', dir: d3 ? (d3.endsWith('LEFT') ? 'L' : 'R') : 'L' }; }
  if (!exit) p.fail('missing_param', 'Exit where? (taxiway or left/right)', ['<taxiway>', 'LEFT', 'RIGHT']);
  if (exit.kind === 'taxiway' && p.accept('ON THE LEFT', 'ON THE RIGHT', 'LEFT', 'RIGHT')) { /* redundant side */ }
  const ast = mk('exitAt', { exit });
  for (;;) {
    p.skip(',');
    if (p.accept('EXPEDITE', 'EXPD', 'NO DELAY')) { ast.expedite = true; p.accept('TRAFFIC'); if (p.at('TRAFFIC') || /^\d/.test(p.peek())) restTextUntilVerb(p); continue; }
    if (p.accept('HOLD SHORT', 'HS', 'AND HOLD SHORT')) { p.skip('OF'); ast.holdShortOf = parseHoldTarget(p); continue; }
    if (p.accept('CONTACT GROUND', 'THEN CONTACT GROUND', 'WHEN VACATED CONTACT GROUND', 'CONTACT GND')) { if (/^\d{3}\.\d+$/.test(p.peek())) p.next(); ast.contactGround = true; continue; }
    if (p.accept('TRAFFIC')) { restTextUntilVerb(p); continue; }
    break;
  }
  return ast;
}
function parseHold(p: Parser, mk: Mk, self: ParseAircraft | null): Part {
  p.accept('AT', 'OVER');
  let fix: string;
  if (p.accept('AS PUBLISHED', 'PRESENT POSITION')) { fix = self?.plan?.fix ?? ''; if (!fix) p.fail('missing_param', 'Hold at which fix?', ['<fix>']); }
  else fix = p.fix();
  const ast = mk('hold', { fix });
  for (;;) {
    p.skip(',');
    if (p.accept('AS PUBLISHED')) continue;
    if (p.accept('INBOUND', 'INBOUND COURSE', 'INBOUND TRACK', 'I')) { p.accept('COURSE', 'TRACK', 'HEADING'); ast.inbound = p.heading(); continue; }
    if (p.accept('LEFT TURNS', 'LEFT HAND', 'LEFT', 'L', 'NON STANDARD')) { p.accept('TURNS'); ast.dir = 'L'; continue; }
    if (p.accept('RIGHT TURNS', 'RIGHT HAND', 'RIGHT', 'R', 'STANDARD')) { p.accept('TURNS'); ast.dir = 'R'; continue; }
    if (p.accept('LEG', 'LEGS')) { const n = p.number(); if (n == null) p.fail('missing_param', 'Leg length required', ['<number>']); const u = p.accept('MIN', 'MINUTE', 'MINUTES', 'NM', 'MILE', 'MILES'); if (u === 'NM' || u === 'MILE' || u === 'MILES') { ast.legNM = n; ast.legTimeMin = null; } else ast.legTimeMin = n; p.accept('LEGS'); continue; }
    if (/^\d+(\.\d+)?$/.test(p.peek()) && /^(MIN|MINUTE|MINUTES|NM|MILE|MILES)$/.test(p.peek(1))) { const n = p.number()!; const u = p.next(); if (u.startsWith('MI') && u !== 'MIN' && u !== 'MINUTE' && u !== 'MINUTES') { ast.legNM = n; ast.legTimeMin = null; } else if (u === 'NM') { ast.legNM = n; ast.legTimeMin = null; } else ast.legTimeMin = n; p.accept('LEGS', 'LEG'); continue; }
    if (p.accept('EFC', 'EXPECT FURTHER CLEARANCE', 'EXPECT FURTHER CLEARANCE AT', 'EXPECT FURTHER CLEARANCE TIME')) { p.accept('AT', 'TIME'); const tok = p.peek(); if (!/^\d{2,4}$/.test(tok)) p.fail('missing_param', 'EFC time required (HHMM)', ['<time>']); p.next(); ast.efc = efcSeconds(tok, p.ctx.time ?? 0); continue; }
    if (p.accept('EXPECT')) { const n = p.number(); p.accept('MINUTES', 'MINUTE', 'MIN'); p.accept('DELAY'); if (n != null) ast.efc = (p.ctx.time ?? 0) + n * 60; continue; }
    break;
  }
  if (ast.legTimeMin == null && ast.legNM == null) ast.legTimeMin = 1;
  return ast;
}
function efcSeconds(tok: string, now: number): number {
  if (tok.length === 4) return parseInt(tok.slice(0, 2), 10) * 3600 + parseInt(tok.slice(2), 10) * 60;
  const min = parseInt(tok, 10) % 60;
  const hour = Math.floor(now / 3600);
  const s = hour * 3600 + min * 60;
  return s >= now ? s : s + 3600;
}
function parseDirectBody(p: Parser, mk: Mk): Part {
  p.skip('TO', 'THE');
  const fix = p.fix();
  const ast = mk('direct', { fix });
  p.skip(',');
  if (p.accept('THEN HEADING', 'THEN FLY HEADING', 'THEN HDG', 'T', 'THEN')) { p.accept('FLY', 'HEADING', 'HDG'); if (/^\d{1,3}$/.test(p.peek())) ast.thenHdg = p.heading(); else p.i -= 1; }
  return ast;
}
function parseIlsTail(p: Parser, ast: Extract<Part, { kind: 'ils' }>, _p: Parser): Part {
  void _p;
  for (;;) {
    p.skip(',');
    if (p.accept('REPORT ESTABLISHED', 'REPORT ESTABLISHED ON THE LOCALIZER', 'REPORT ESTABLISHED LOCALIZER')) { ast.reportEstablished = true; continue; }
    if (p.accept('NO REPORT', 'NO NEED TO REPORT')) { ast.reportEstablished = false; continue; }
    if (p.accept('MAINTAIN')) { if (/^(FL)?\d+$/.test(p.peek())) p.altitude(); p.accept('UNTIL ESTABLISHED', 'UNTIL ESTABLISHED ON THE LOCALIZER'); continue; }
    break;
  }
  return ast;
}
function parseSpeedTail(p: Parser, mk: Mk, kts: number): Part {
  const ast = mk('speed', { kts });
  p.skip(',');
  if (p.accept('UNTIL', 'TO', 'TILL')) {
    const n = p.number();
    if (n == null) { p.accept('FURTHER ADVISED', 'ADVISED'); return ast; }
    p.accept('MILE FINAL', 'MILES FINAL', 'MILE', 'MILES', 'DME', 'NM', 'NM FINAL', 'MILES FROM TOUCHDOWN');
    ast.untilNM = n;
  }
  p.accept('OR GREATER', 'OR LESS');
  return ast;
}
function minClean(p: Parser, mk: Mk, self: ParseAircraft | null): Part {
  if (self?.minCleanKt) return mk('speed', { kts: self.minCleanKt });
  p.fail('unsupported', 'Minimum clean speed unknown for this type — give a value', ['<speed>']);
}
function parseReportItems(p: Parser): ReportKind[] {
  const items: ReportKind[] = [];
  for (;;) {
    p.skip('AND', ',', 'YOUR', 'THE', 'ON', 'BOARD', 'REMAINING', 'FOR', 'OF');
    if (p.accept('RUNWAY VACATED', 'VACATED', 'CLEAR OF THE RUNWAY')) { items.push('vacated'); continue; }
    if (p.accept('READY FOR DEPARTURE', 'READY')) { items.push('ready'); continue; }
    if (p.accept('ESTABLISHED', 'ESTABLISHED ON THE LOCALIZER', 'ESTABLISHED LOCALIZER')) { items.push('established'); continue; }
    if (p.accept('4 MILE FINAL', '4 MILES', 'FOUR MILE FINAL', 'FOUR MILES')) { items.push('four_mile_final'); continue; }
    if (p.accept('REASON FOR GO AROUND', 'REASON')) { items.push('reason'); continue; }
    if (p.accept('PERSONS ON BOARD', 'SOULS ON BOARD', 'POB', 'SOULS', 'PERSONS')) { items.push('pob'); continue; }
    if (p.accept('FUEL REMAINING', 'FUEL', 'ENDURANCE')) { p.accept('IN MINUTES'); items.push('fuel'); continue; }
    if (p.accept('DANGEROUS GOODS', 'DG')) { items.push('dg'); continue; }
    if (p.accept('NATURE OF EMERGENCY', 'NATURE')) { items.push('nature'); continue; }
    if (p.accept('READ YOU FIVE', 'READ YOU 5', 'READYOU5')) { items.push('readyou5'); continue; }
    const k = REPORT_WORDS[p.peek()];
    if (k) { p.next(); items.push(k); continue; }
    break;
  }
  if (!items.length) items.push('position');
  return [...new Set(items)];
}
function parseEmergencyAckTail(p: Parser, mk: Mk): Part {
  const ast = mk('emergencyAck', { ask: [], squawk: false });
  for (;;) {
    p.skip(',');
    if (p.accept('SQUAWK 7700', 'SQUAWK SEVEN SEVEN ZERO ZERO', 'SQUAWK')) { if (p.peek() === '7700') p.next(); ast.squawk = true; continue; }
    if (p.accept('SAY', 'STATE', 'REPORT', 'ADVISE')) { for (const it of parseReportItems(p)) if (['pob', 'fuel', 'nature', 'dg', 'intentions'].includes(it)) ast.ask.push(it as EmergencyInfoKind); continue; }
    if (p.accept('INTENTIONS')) { ast.ask.push('intentions'); continue; }
    break;
  }
  if (!ast.ask.length) ast.ask = ['pob', 'fuel', 'intentions'];
  if (p.eof && ast.squawk === false && ast.ask.length === 3) ast.squawk = true;
  ast.ask = [...new Set(ast.ask)];
  return ast;
}

// ──────────────────────────────────────────────────────────────────────────────
//  System commands (no callsign)
// ──────────────────────────────────────────────────────────────────────────────
function vehicleId(p: Parser, required = true): string | null {
  const t = p.peek();
  const known = (id: string) => (p.strict.vehicle ? p.ctx.vehicles!.some(v => v.toUpperCase() === id) : true);
  // FIRE1 / FIRE 1 / RESCUE 1 / Fire-1
  let m = t.match(/^([A-Z]+)(\d+)$/);
  if (m && VEHICLE_WORDS[m[1]]) { const id = `${VEHICLE_WORDS[m[1]].prefix}${m[2]}`; if (!known(id)) p.fail('unknown_vehicle', `Unknown vehicle ${t}`, ['<vehicle>']); p.next(); return id; }
  if (VEHICLE_WORDS[t] && /^\d+$/.test(p.peek(1)) && !(p.peek(2) === 'X')) { const id = `${VEHICLE_WORDS[t].prefix}${p.peek(1)}`; if (!known(id)) p.fail('unknown_vehicle', `Unknown vehicle ${t} ${p.peek(1)}`, ['<vehicle>']); p.i += 2; return id; }
  m = t.match(/^([A-Z]+\d+)$/);
  if (m && known(t) && (p.strict.vehicle || /^(FIRE|AMB|FOLLOW|TUG|OPS|SWEEP|BIRD|FUEL|DEICE)\d+$/.test(t))) { p.next(); return t; }
  if (required) p.fail('missing_param', 'Vehicle id required', ['<vehicle>']);
  return null;
}
function parseVehicleTarget(p: Parser): Extract<CommandAST, { kind: 'dispatchVehicle' }>['target'] {
  p.skip('TO', 'THE');
  if (p.accept('STATION', 'BASE')) return { kind: 'station' };
  if (p.accept('STAND', 'GATE')) return { kind: 'stand', ref: p.stand() };
  if (p.at('RUNWAY') || p.at('RWY') || p.isRunwayAhead()) return { kind: 'runway', runway: p.runway() };
  if (p.accept('MAP', 'POINT', 'MAP POINT', 'POSITION')) p.fail('unsupported', 'Map-point targets come from the map picker', ['<runway>', '<aircraft>']);
  const r = resolveCallsign(p.toks, p.i, p.ctx);
  if (r.callsign) { p.i += r.consumed; const a = (p.ctx.aircraft ?? []).find(x => x.callsign === r.callsign); return { kind: 'aircraft', id: a?.id ?? -1, callsign: r.callsign }; }
  p.fail('missing_param', 'Dispatch where? (runway, aircraft or stand)', ['<runway>', '<aircraft>', 'STAND']);
}
function parseSystem(p: Parser): CommandAST | null {
  const t = p.peek();
  const save = p.i;
  const sys = <K extends CommandAST['kind']>(kind: K, fields: Partial<Omit<Extract<CommandAST, { kind: K }>, 'kind'>>) => makeAst(kind, null, fields as never) as Extract<CommandAST, { kind: K }>;
  switch (t) {
    case 'DISPATCH': case 'SEND': case 'ROLL': {
      p.next();
      const ast = sys('dispatchVehicle', { ids: [], count: 0 });
      let count: number | null = null;
      const n = p.number(); if (n != null) { count = n; p.accept('X'); }
      // ids or type
      for (;;) {
        const id = vehicleId(p, false);
        if (id) { ast.ids.push(id); ast.type = VEHICLE_WORDS[id.replace(/\d+$/, '')]?.type ?? ast.type; p.skip(',', 'AND'); continue; }
        break;
      }
      if (!ast.ids.length) {
        const w = p.peek();
        if (!VEHICLE_WORDS[w] && !/^\d+$/.test(w)) p.fail('missing_param', 'Vehicle type or id required', ['FIRE', 'AMBULANCE', 'FOLLOW ME', 'TUG', 'OPS', '<vehicle>']);
        if (VEHICLE_WORDS[w]) { ast.type = VEHICLE_WORDS[w].type; p.next(); p.accept('ME', 'TRUCKS', 'TRUCK', 'VEHICLES', 'SERVICES'); }
        if (count == null) { const n2 = p.number(); if (n2 != null) count = n2; else if (p.accept('X')) count = p.number(); }
      }
      ast.count = ast.ids.length || count || (ast.type === 'arff' ? 2 : 1);
      ast.target = parseVehicleTarget(p);
      restText(p);
      return ast;
    }
    case 'RECALL': { p.next(); p.accept('VEHICLE'); const id = vehicleId(p)!; restText(p); return sys('recallVehicle', { id }); }
    case 'CLOSE': { p.next(); p.accept('RUNWAY', 'RWY'); const rwy = p.runway(); p.skip(','); return sys('runwayStatus', { runway: rwy, status: 'closed', reason: restText(p) }); }
    case 'OPEN': { p.next(); p.accept('RUNWAY', 'RWY'); const rwy = p.runway(); return sys('runwayStatus', { runway: rwy, status: 'open', reason: restText(p) }); }
    case 'REOPEN': { p.next(); p.accept('RUNWAY', 'RWY'); const rwy = p.runway(); p.skip(','); const insp = !!p.accept('AFTER INSPECTION', 'INSPECTION'); restText(p); return sys('reopenRunway', { runway: rwy, afterInspection: insp }); }
    case 'INSPECT': { p.next(); p.accept('RUNWAY', 'RWY'); const rwy = p.runway(); return sys('runwayStatus', { runway: rwy, status: 'inspection', reason: restText(p) }); }
    case 'STERILE': { p.next(); p.accept('RUNWAY', 'RWY'); const rwy = p.runway(); return sys('holdAll', { scope: 'departures', runway: rwy }); }
    case 'RUNWAY': case 'RWY': {
      p.next();
      const rwy = p.runwayToken();
      if (!rwy) { p.i = save; return null; }
      const st = p.accept('OPEN', 'CLOSE', 'CLOSED', 'STERILE', 'INSPECTION', 'INSPECT', 'REOPEN');
      if (!st) { p.i = save; return null; }
      if (st === 'REOPEN') return sys('reopenRunway', { runway: rwy, afterInspection: !!p.accept('AFTER INSPECTION') });
      const status: RunwayStatus = st === 'OPEN' ? 'open' : st === 'STERILE' ? 'sterile' : st.startsWith('INSPECT') ? 'inspection' : 'closed';
      p.skip(',');
      return sys('runwayStatus', { runway: rwy, status, reason: restText(p) });
    }
    case 'HOLD': {
      if (!p.at('HOLD ALL') && !p.at('HOLD DEPARTURES') && !p.at('HOLD CROSSINGS')) return null;
      p.next();
      p.accept('ALL');
      let scope: HoldAllScope = 'all';
      const s = p.accept('DEPARTURES', 'CROSSINGS', 'GROUND MOVEMENT', 'GROUND', 'TRAFFIC', 'MOVEMENT');
      if (s === 'DEPARTURES') scope = 'departures'; else if (s === 'CROSSINGS') scope = 'crossings';
      p.skip('ON', 'RUNWAY', 'RWY');
      const rwy = p.isRunwayAhead() ? p.runway() : null;
      restText(p);
      return sys('holdAll', { scope, runway: rwy });
    }
    case 'RESUME': {
      if (!p.at('RESUME ALL') && !p.at('RESUME NORMAL OPERATIONS') && !p.at('RESUME OPERATIONS')) return null;
      p.next(); p.accept('ALL', 'NORMAL'); p.accept('TRAFFIC', 'OPERATIONS', 'MOVEMENT');
      return sys('resumeAll', {});
    }
    case 'BROADCAST': { p.next(); const text = broadcastText(p); if (!text) p.fail('missing_param', 'Broadcast text required', ['<text>']); return sys('broadcast', { text }); }
    case 'ALL': {
      if (!p.at('ALL STATIONS')) return null;
      p.i += 2; p.skip(',');
      if (p.accept('HOLD POSITION', 'HOLD', 'EMERGENCY IN PROGRESS HOLD POSITION')) { restText(p); return sys('holdAll', { scope: 'all', runway: null }); }
      const text = broadcastText(p);
      if (!text) p.fail('missing_param', 'Broadcast text required', ['<text>']);
      return sys('broadcast', { text });
    }
    case 'VEH': case 'VEHICLE': { p.next(); return parseVehicleOp(p, sys, vehicleId(p)!); }
    default: break;
  }
  // "FIRE 1 CROSS 27L" / "FIRE1: cross 27L" / "RESCUE 1 HOLD" / "OPS 1 RTB"
  const id = vehicleId(p, false);
  if (id) {
    if (p.eof) p.fail('missing_param', `${id}: hold / continue / cross / return to base?`, ['HOLD', 'CONTINUE', 'CROSS', 'RTB']);
    return parseVehicleOp(p, sys, id);
  }
  p.i = save;
  return null;
}
/** Free text after BROADCAST / ALL STATIONS, case preserved from the original input when available. */
function broadcastText(p: Parser): string {
  const fromTokens = p.toks.slice(p.i).map(x => x.raw).join(' ');
  p.i = p.toks.length;
  const m = p.source.match(/^\s*(?:broadcast|all\s+stations)[\s,:;-]*(?:hold\s+position[\s,]*)?(.*)$/i);
  const raw = m?.[1]?.trim() ?? '';
  return raw.replace(/[.]+$/, '') || fromTokens;
}
function parseVehicleOp(p: Parser, sys: <K extends CommandAST['kind']>(kind: K, f: Partial<Omit<Extract<CommandAST, { kind: K }>, 'kind'>>) => Extract<CommandAST, { kind: K }>, id: string): CommandAST {
  p.skip(',');
  if (p.accept('HOLD', 'HOLD POSITION', 'HOLD SHORT', 'STOP')) { if (p.isRunwayAhead() || p.at('RUNWAY')) p.runway(); return sys('vehicleOp', { id, op: 'hold', runway: null }); }
  if (p.accept('CONTINUE', 'PROCEED', 'RESUME', 'GO')) { restText(p); return sys('vehicleOp', { id, op: 'continue', runway: null }); }
  if (p.accept('CROSS', 'ENTER')) { const rwy = p.runway(); restText(p); return sys('vehicleOp', { id, op: 'cross', runway: rwy }); }
  if (p.accept('RTB', 'RETURN TO BASE', 'RETURN TO STATION', 'RETURN')) { restText(p); return sys('vehicleOp', { id, op: 'rtb', runway: null }); }
  if (p.accept('RECALL', 'RECALLED')) { restText(p); return sys('recallVehicle', { id }); }
  if (p.accept('TO', 'DISPATCH', 'DISPATCH TO', 'PROCEED TO')) { const target = parseVehicleTarget(p); return sys('dispatchVehicle', { type: VEHICLE_WORDS[id.replace(/\d+$/, '')]?.type ?? 'arff', ids: [id], count: 1, target }); }
  p.fail('unknown_verb', `${id}: hold / continue / cross / return to base?`, ['HOLD', 'CONTINUE', 'CROSS', 'RTB']);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Folding multi-part transmissions into the base clearance (UX §1.5)
// ──────────────────────────────────────────────────────────────────────────────
function fold(parts: Part[], p: Parser): Part[] {
  const take = <K extends Part['kind']>(kind: K): Extract<Part, { kind: K }> | null => {
    const i = parts.findIndex(x => x.kind === kind);
    if (i < 0) return null;
    return parts.splice(i, 1)[0] as Extract<Part, { kind: K }>;
  };
  const takeoff = parts.find(x => x.kind === 'takeoff') as Extract<Part, { kind: 'takeoff' }> | undefined;
  if (takeoff) {
    const h = take('heading'); if (h) { if (h.relative) takeoff.turn = h.relative; else takeoff.afterDepHdg = RUNWAY_HDG_PARTS.has(h) ? 'runway' : h.hdg; }
    const a = take('altitude'); if (a) takeoff.initialAlt = a.ft;
    const c = parts.find(x => x.kind === 'contact' && x.position === 'departure'); if (c) { parts.splice(parts.indexOf(c), 1); takeoff.contactDeparture = true; }
  }
  const ga = parts.find(x => x.kind === 'goAround') as Extract<Part, { kind: 'goAround' }> | undefined;
  if (ga) {
    const h = take('heading'); if (h) ga.heading = RUNWAY_HDG_PARTS.has(h) ? 'runway' : h.hdg;
    const a = take('altitude'); if (a) ga.alt = a.ft;
    const c = take('contact'); if (c) ga.contact = c.position;
  }
  const ca = parts.find(x => x.kind === 'cancelApproach') as Extract<Part, { kind: 'cancelApproach' }> | undefined;
  if (ca) {
    const h = take('heading'); if (h) { ca.hdg = h.hdg; ca.dir = h.dir; }
    const a = take('altitude'); if (a) ca.alt = a.ft;
    if (!ca.hdg || !ca.alt) p.fail('missing_param', 'Cancel approach needs heading and altitude', ['TURN LEFT HEADING', 'CLIMB'], p.toks.length);
  }
  const land = parts.find(x => x.kind === 'clearedLand') as Extract<Part, { kind: 'clearedLand' }> | undefined;
  if (land) {
    const hs = take('holdShort'); if (hs) land.lahso = hs.of.kind === 'runway' ? hs.of.runway : hs.of.kind === 'taxiway' ? hs.of.taxiway : hs.of.label;
    const ex = take('exitAt'); if (ex) land.exit = ex.exit;
  }
  const taxi = parts.find(x => x.kind === 'taxi') as Extract<Part, { kind: 'taxi' }> | undefined;
  if (taxi) {
    const hs = take('holdShort'); if (hs && !taxi.holdShortOf) taxi.holdShortOf = hs.of;
    const cr = take('cross'); if (cr) taxi.cross.push(cr.runway);
    const ex = take('expedite'); if (ex) taxi.expedite = true;
  }
  const push = parts.find(x => x.kind === 'pushback') as Extract<Part, { kind: 'pushback' }> | undefined;
  if (push) { const st = take('startup'); if (st) { push.startup = true; push.expectRunway = push.expectRunway ?? st.expectRunway; } }
  const exit = parts.find(x => x.kind === 'exitAt') as Extract<Part, { kind: 'exitAt' }> | undefined;
  if (exit) {
    const hs = take('holdShort'); if (hs) exit.holdShortOf = hs.of;
    const c = parts.find(x => x.kind === 'contact' && x.position === 'ground'); if (c) { parts.splice(parts.indexOf(c), 1); exit.contactGround = true; }
  }
  const cont = parts.find(x => x.kind === 'continue') as Extract<Part, { kind: 'continue' }> | undefined;
  if (cont) { const hs = take('holdShort'); if (hs) cont.holdShortOf = hs.of; }
  const direct = parts.find(x => x.kind === 'direct') as Extract<Part, { kind: 'direct' }> | undefined;
  if (direct) {
    // only a heading spoken AFTER the fix is the "then heading" clause; a heading before it is an incompatible pair (UX §G13.7)
    const hi = parts.findIndex(x => x.kind === 'heading');
    if (hi > parts.indexOf(direct)) { const h = parts.splice(hi, 1)[0] as Extract<Part, { kind: 'heading' }>; direct.thenHdg = h.hdg; }
  }
  const alt = parts.find(x => x.kind === 'altitude') as Extract<Part, { kind: 'altitude' }> | undefined;
  if (alt) { const ex = parts.find(x => x.kind === 'expedite' && (x.scope === 'climb' || x.scope === 'descent')); if (ex) { parts.splice(parts.indexOf(ex), 1); alt.expedite = true; } }
  const ack = parts.find(x => x.kind === 'emergencyAck') as Extract<Part, { kind: 'emergencyAck' }> | undefined;
  if (ack) {
    const sq = take('squawk'); if (sq) ack.squawk = true;
    const rp = take('report'); if (rp) ack.ask = [...new Set([...ack.ask, ...rp.items.filter(i => ['pob', 'fuel', 'nature', 'dg', 'intentions'].includes(i)) as EmergencyInfoKind[]])];
  }
  const rc = parts.find(x => x.kind === 'radarContact') as Extract<Part, { kind: 'radarContact' }> | undefined;
  if (rc) { const a = take('altitude'); if (a) rc.descendTo = a.ft; const e = take('expectRunway'); if (e) rc.expectRunway = e.runway; }
  const prio = parts.find(x => x.kind === 'priority') as Extract<Part, { kind: 'priority' }> | undefined;
  if (prio) { const ils = take('ils'); if (ils) prio.clearIls = true; }
  // merge duplicate kinds (last wins) — e.g. "CLIMB 3000 CLIMB 4000"
  const seen = new Map<string, number>();
  for (let i = parts.length - 1; i >= 0; i--) { const k = parts[i].kind; if (seen.has(k)) parts.splice(i, 1); else seen.set(k, i); }
  return parts;
}

// ──────────────────────────────────────────────────────────────────────────────
//  parseCommand
// ──────────────────────────────────────────────────────────────────────────────
type LegacyEngine = { find(cs: string): unknown; cmdStartup?: unknown; phraseCtx?: unknown; aircraft?: unknown[] };

export function parseCommand(text: string, ctx?: ParseCtx): ParseResult;
/** @deprecated Wave-2 shim for the old `parseCommand(engine, text)` call in simStore: parses + dispatches when the engine implements EngineCommandApi, otherwise returns a SYS line. */
export function parseCommand(engine: LegacyEngine, text: string): { ok: boolean; reply: string; callsign?: string };
export function parseCommand(a: string | LegacyEngine, b?: ParseCtx | string): ParseResult | { ok: boolean; reply: string; callsign?: string } {
  if (typeof a !== 'string') return legacyParse(a, String(b ?? ''));
  return parseText(a, (b as ParseCtx | undefined) ?? {});
}

function parseText(text: string, ctx: ParseCtx): ParseResult {
  const tokens = tokenize(text);
  const result: ParseResult = { ok: false, ast: null, callsign: null, errors: [], suggestions: [], tokens };
  if (!tokens.length) { result.errors.push({ code: 'empty', message: 'Empty command', at: 0, token: null, expected: ['<callsign>'] }); result.suggestions = ['<callsign>']; return result; }
  const p = new Parser(tokens, ctx, null); p.source = text;
  try {
    // 1. system commands
    const sys = parseSystem(p);
    if (sys) {
      if (!p.eof) p.fail('trailing_tokens', `Unexpected "${p.peek()}"`, []);
      result.ok = true; result.ast = sys; return result;
    }
    // 2. callsign
    const cr = resolveCallsign(tokens, 0, ctx);
    let cs = cr.callsign;
    if (!cs && cr.ambiguous.length) { result.ambiguous = cr.ambiguous; p.fail('ambiguous_callsign', `Which aircraft: ${cr.ambiguous.join(', ')}?`, cr.ambiguous, 0); }
    if (cs) p.i = cr.consumed;
    else if (ctx.lastCallsign && (VERB_STARTERS.has(tokens[0].text) || /^[HLRSACDI](\d|\d{2}[LRC]?)/.test(tokens[0].text) || /^FL\d/.test(tokens[0].text))) cs = ctx.lastCallsign.toUpperCase();
    else p.fail('unknown_callsign', `No aircraft "${tokens[0].text}" on frequency`, ['<callsign>'], 0);
    result.callsign = cs!;
    const self = (ctx.aircraft ?? []).find(x => x.callsign.toUpperCase() === cs) ?? null;
    const pp = new Parser(tokens, ctx, self); pp.i = p.i; pp.source = text;
    if (pp.eof) pp.fail('unknown_verb', 'Instruction required', ['<verb>']);
    // 3. parts
    const parts: Part[] = [];
    while (!pp.eof) {
      pp.skip(',', 'THEN', 'AND');
      if (pp.eof) break;
      const { part, pending } = parsePart(pp, cs!, self);
      // trailing condition at the end of the line ("turn right heading 090 when passing 4000"); before a further part it binds forward
      if (!pp.eof && !pending.cond && (part.kind === 'heading' || part.kind === 'altitude' || part.kind === 'contact' || part.kind === 'taxi' || part.kind === 'lineup' || part.kind === 'cross')) {
        const save = pp.i;
        pp.skip(',');
        const trailing = parseCondition(pp, self);
        if ((trailing.cond || trailing.behind) && pp.eof) { pending.cond = trailing.cond; pending.contactWhen = pending.contactWhen ?? trailing.contactWhen; pending.behind = pending.behind ?? trailing.behind; }
        else pp.i = save;
      }
      if (pending.cond) {
        if (part.kind === 'heading' || part.kind === 'altitude') part.when = pending.cond;
        else if (part.kind === 'contact') {
          if (pending.cond.type === 'after_vacated') part.when = 'when_vacated';
          else if (pending.cond.type === 'on_reaching_hold') part.when = 'on_reaching';
          else { if (pending.cond.type === 'at_or_above_alt' || pending.cond.type === 'at_or_below_alt') part.when = 'on_reaching'; pp.detached.push({ kind: part.kind, condition: pending.cond }); }
        }
        else if (part.kind === 'lineup' || part.kind === 'cross') { if (pending.behind) part.behind = pending.behind; else pp.detached.push({ kind: part.kind, condition: pending.cond }); }
        else pp.detached.push({ kind: part.kind, condition: pending.cond });
      } else if (pending.contactWhen && part.kind === 'contact') part.when = pending.contactWhen;
      else if (pending.behind && (part.kind === 'lineup' || part.kind === 'cross')) part.behind = pending.behind;
      parts.push(part);
      if (parts.length > 8) pp.fail('too_many_parts', 'Too many parts', []);
    }
    if (!parts.length) pp.fail('unknown_verb', 'Instruction required', ['<verb>']);
    const folded = fold(parts, pp);
    if (folded.length > 4) pp.fail('too_many_parts', 'Max 1 base + 3 parts per transmission', [], tokens.length);
    const inc = incompatibleParts(folded);
    if (inc) pp.fail('incompatible_parts', `Incompatible parts: ${inc[0]} and ${inc[1]}`, [], tokens.length);
    result.ast = sequence(cs!, sortParts(folded));
    result.ok = true;
    if (pp.detached.length) result.detachedConditions = pp.detached;
    return result;
  } catch (e) {
    if (e instanceof ParseFail) {
      result.errors.push(e.err);
      result.suggestions = e.err.expected;
      return result;
    }
    throw e;
  }
}

function legacyParse(engine: LegacyEngine, text: string): { ok: boolean; reply: string; callsign?: string } {
  const list = (engine.aircraft as ParseAircraft[] | undefined) ?? [];
  const r = parseText(text, { aircraft: list });
  if (!r.ok || !r.ast) return { ok: false, reply: r.errors[0]?.message ?? 'unable — say again', callsign: r.callsign ?? undefined };
  if (typeof engine.cmdStartup === 'function' && typeof engine.phraseCtx === 'function') {
    // Engine implements EngineCommandApi: run the real dispatch (lazy import avoids a module cycle at load).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const d = (globalThis as { __atcDispatch?: (e: unknown, ast: CommandAST) => { ok: boolean; readback: string; reason?: string; transmission: string } }).__atcDispatch;
    if (d) { const res = d(engine, r.ast); return { ok: res.ok, reply: res.readback || res.reason || res.transmission, callsign: r.callsign ?? undefined }; }
  }
  return { ok: false, reply: `parsed ${r.ast.kind}; legacy parseCommand(engine, text) is retired — use executeText(engine, text, ctx) from dispatch.ts`, callsign: r.callsign ?? undefined };
}

/** @deprecated kept for the Wave-2 store rewrite; throws with a pointer to executeText(). */
export function parseCommandLegacy(engine: LegacyEngine, text: string): never {
  void engine; void text;
  throw new Error('parseCommandLegacy is retired: use parseCommand(text, ctx) + dispatch(engine, ast), or executeText(engine, text, ctx)');
}

// ──────────────────────────────────────────────────────────────────────────────
//  suggest — ranked completions for the next token (comm-log autocomplete)
// ──────────────────────────────────────────────────────────────────────────────
const PLACEHOLDER_NUMBERS: Record<string, string[]> = {
  '<altitude>': ['3000', '4000', '5000', '6000', 'FL80', 'FL100', 'FL130'],
  '<speed>': ['160', '180', '210', '250'],
  '<heading>': ['090', '180', '270', '360'],
  '<squawk>': [],
  '<degrees>': ['10', '20', '30'],
  '<time>': [],
  '<number>': ['1', '2', '4'],
  '<value>': [],
  '<text>': [],
};

const isEmergencyVerb = (v: VerbDef) => v.actions.length > 0 && v.actions.every(id => id.startsWith('emerg-'));

/** Verbs offered for an aircraft, best first: enabledActions (authoritative) > statically enabled cells > disabled-with-reason cells; emergency verbs only during an emergency. */
function verbsForAircraft(a: ParseAircraft | null): VerbDef[] {
  if (!a) return VERBS.filter(v => !isEmergencyVerb(v));
  if (a.enabledActions?.length) {
    const set = new Set(a.enabledActions);
    return VERBS.filter(v => !v.actions.length ? (v.air == null || isAirStageName(a.stage) === v.air) : v.actions.some(id => set.has(id)));
  }
  if (a.stage) {
    const vis = new Set(visibleActionsForStage(a.stage));
    const on = new Set(enabledActionsForStage(a.stage));
    const air = isAirStageName(a.stage);
    const list = VERBS.filter(v => (!v.actions.length ? (v.air == null || air === v.air || air == null) : v.actions.some(id => vis.has(id))) && (a.emergency || !isEmergencyVerb(v)));
    const rank = (v: VerbDef) => (!v.actions.length ? 1 : v.actions.some(id => on.has(id)) ? 0 : 2);
    return list.sort((x, y) => rank(x) - rank(y));
  }
  return VERBS.filter(v => !isEmergencyVerb(v));
}
function isAirStageName(s?: Stage): boolean | null {
  if (!s) return null;
  return !['parked', 'startup', 'pushback', 'taxi_out', 'taxi_in', 'hold_short_dep', 'hold_short_cross', 'lineup', 'takeoff_roll', 'rollout', 'arrived'].includes(s);
}
function actionOrder(v: VerbDef): number { return Math.min(...v.actions.map(id => ACTION_DEFS[id].order), v.actions.length ? 999 : 200); }

/**
 * Ranked completions for the text typed so far. `prefix` ending in a space asks
 * for the NEXT token; otherwise the last token is completed. Candidates come from
 * the grammar's expectation at the cursor (callsigns, stage-valid verbs, runways,
 * taxiways, fixes, stands, vehicles, positions, number presets, continuations).
 */
export function suggest(prefix: string, ctx: ParseCtx = {}): Suggestion[] {
  const trailingSpace = /\s$/.test(prefix) || prefix === '';
  const toks = tokenize(prefix);
  const partial = trailingSpace ? '' : (toks[toks.length - 1]?.text ?? '');
  const head = trailingSpace ? toks : toks.slice(0, -1);
  const headText = head.map(t => t.raw).join(' ');
  const out: Suggestion[] = [];
  const add = (text: string, kind: SuggestionKind, label = text, base = 50) => {
    const T = text.toUpperCase();
    if (partial && !T.startsWith(partial) && !T.includes(partial)) return;
    if (out.some(s => s.text === T)) return;
    const digitsTail = partial && /^\d+$/.test(partial) && kind === 'callsign' && T.replace(/[^0-9]/g, '').endsWith(partial);
    const score = base + (partial ? (T.startsWith(partial) ? 40 : digitsTail ? 30 : 10) : 0);
    out.push({ text: T, kind, label, score });
  };
  const list = ctx.aircraft ?? [];
  const addCallsigns = () => {
    const sorted = [...list].sort((x, y) => Number(!!y.hasRequest) - Number(!!x.hasRequest) || x.callsign.localeCompare(y.callsign));
    sorted.forEach((a, i) => add(a.callsign, 'callsign', a.hasRequest ? `${a.callsign} REQ` : a.callsign, 100 - Math.min(i, 40) + (a.hasRequest ? 20 : 0)));
  };
  const addVerbs = (a: ParseAircraft | null) => {
    const vs = verbsForAircraft(a);
    const on = a?.stage ? new Set(enabledActionsForStage(a.stage)) : null;
    const tier = (v: VerbDef) => (a?.enabledActions?.length || !on ? 0 : !v.actions.length ? 1 : v.actions.some(id => on.has(id)) ? 0 : 2);
    vs.sort((x, y) => tier(x) - tier(y) || actionOrder(x) - actionOrder(y));
    vs.forEach((v, i) => add(v.text, 'verb', v.text, 80 - Math.min(i, 60)));
  };
  const addPlaceholder = (ph: string, self: ParseAircraft | null) => {
    switch (ph) {
      case '<callsign>': addCallsigns(); break;
      case '<verb>': addVerbs(self); break;
      case '<runway>': { const pref = self?.plan?.runway ?? self?.assignedRunway ?? null; (ctx.runways ?? []).forEach((r, i) => add(r, 'runway', r, r === pref ? 95 : 70 - Math.min(i, 20))); break; }
      case '<taxiway>': (ctx.taxiways ?? []).forEach((t, i) => add(t, 'taxiway', t, 70 - Math.min(i, 40))); break;
      case '<fix>': (ctx.fixes ?? []).forEach((f, i) => add(f, 'fix', f, f === self?.plan?.fix ? 95 : 70 - Math.min(i, 40))); break;
      case '<stand>': (ctx.stands ?? []).forEach((s, i) => add(s, 'stand', s, s === self?.plan?.gateRef ? 95 : 70 - Math.min(i, 40))); break;
      case '<aircraft>': list.filter(x => x.callsign !== self?.callsign).forEach((x, i) => add(x.callsign, 'aircraft', x.callsign, 70 - Math.min(i, 40))); break;
      case '<vehicle>': (ctx.vehicles ?? []).forEach((v, i) => add(v, 'vehicle', v, 70 - Math.min(i, 20))); break;
      default:
        if (PLACEHOLDER_NUMBERS[ph]) PLACEHOLDER_NUMBERS[ph].forEach((n, i) => add(n, 'number', n, 60 - i));
        else if (!ph.startsWith('<')) add(ph, 'keyword', ph, 60);
    }
  };
  if (!head.length) {
    addCallsigns();
    SYSTEM_VERBS.forEach((v, i) => add(v, 'keyword', v, 30 - i));
    if (ctx.lastCallsign) addVerbs(list.find(a => a.callsign === ctx.lastCallsign) ?? null);
    return finish(out, partial);
  }
  // Callsign-only head -> verbs for that aircraft's stage
  const cr = resolveCallsign(head, 0, ctx);
  const self = cr.callsign ? (list.find(a => a.callsign === cr.callsign) ?? null) : null;
  if (cr.callsign && cr.consumed === head.length) { addVerbs(self); return finish(out, partial); }
  if (!cr.callsign && cr.ambiguous.length) { cr.ambiguous.forEach(c => add(c, 'callsign', c, 90)); return finish(out, partial); }
  // Parse the head; use the failure expectation or the continuation set
  const r = parseText(headText, ctx);
  const selfCs = r.callsign ? (list.find(a => a.callsign === r.callsign) ?? null) : self;
  if (!r.ok) {
    const err = r.errors[0];
    if (err && err.at >= head.length) for (const ex of err.expected) addPlaceholder(ex, selfCs);
    else if (err && err.code === 'unknown_verb') addVerbs(selfCs);
    else if (err) for (const ex of err.expected) addPlaceholder(ex, selfCs);
    if (!out.length && err?.code === 'unknown_callsign') addCallsigns();
    return finish(out, partial);
  }
  if (r.ast) {
    const parts = r.ast.kind === 'sequence' ? r.ast.parts : [r.ast];
    const last = parts[parts.length - 1];
    const cont = CONTINUATIONS[last.kind] ?? [];
    cont.forEach((c, i) => add(c, 'keyword', c, 70 - i));
    if (last.kind === 'taxi' && (last as Extract<Part, { kind: 'taxi' }>).via.length) (ctx.taxiways ?? []).forEach((t, i) => add(t, 'taxiway', t, 60 - Math.min(i, 30)));
    add('THEN', 'keyword', 'THEN', 20);
  }
  return finish(out, partial);
}
function finish(out: Suggestion[], partial: string): Suggestion[] {
  void partial;
  return out.sort((x, y) => y.score - x.score || x.text.localeCompare(y.text)).slice(0, 24);
}

/** Convenience for the store: the verb list for an aircraft (help overlay / cheat sheet). */
export function verbsFor(a: ParseAircraft | null): string[] { return verbsForAircraft(a).map(v => v.text); }
