// ============================================================
//  Clearance ledger: what every pilot has been told (docs/spec/13-PILOT-BRAIN.md §4.1-4.2)
//
//  Per aircraft, every instruction with its time and whether it is still in force. It is the pilot's memory:
//  the pilot questions an instruction that contradicts a recent one ("previously cleared FL080, confirm now
//  6000?") and executes it only when the controller repeats it, says roger, or corrects it. Kept beside the
//  engine (one ledger per engine instance), fed from dispatch(): the simulator stays the single source of truth.
//
//  A question is asked only for a suspicious amendment, never for a normal one (a step climb, a new vector):
//    R1 level reversal   a climb turned into a descent (or the reverse) within REVERSAL_S, before the first was flown
//    R2 heading reversal a new heading 120 degrees or more from one given within REVERSAL_S
//    R3 runway surprise  taxi to a runway other than the one the pilot was told to expect
// ============================================================
import type { CommandAST, SingleAircraftCommand } from './commandAst';
import type { AircraftState } from './types';
import { altitudeLabel } from './phraseology';

export const LEDGER_CONST = {
  /** A reversal is questioned only this soon after the instruction it reverses, s. */
  reversalS: 90,
  /** A pilot's question stays open this long; after it the instruction would be questioned again, s. */
  queryOpenS: 120,
  /** Entries kept per aircraft. */
  max: 60,
};

export type LedgerStatus = 'active' | 'superseded' | 'cancelled';

export interface LedgerEntry {
  id: number;
  /** sim time, s */
  at: number;
  kind: SingleAircraftCommand['kind'];
  ast: SingleAircraftCommand;
  /** One line a person (or a model) can read: "climb FL080". */
  text: string;
  status: LedgerStatus;
}

export interface PilotQuery {
  /** The instruction the pilot is asking about (not executed yet). */
  ast: SingleAircraftCommand;
  /** The earlier instruction it contradicts (null when the question comes from what the pilot sees or hears, pilotmind.ts). */
  earlier: LedgerEntry | null;
  rule: 'level_reversal' | 'heading_reversal' | 'runway_surprise' | 'runway_traffic' | 'traffic_on_final' | 'departure_rolling' | 'below_safe_level' | 'wrong_frequency';
  /** The pilot's question, without the callsign: "previously cleared FL080, confirm now 6000". */
  question: string;
  at: number;
}

interface AircraftLedger { entries: LedgerEntry[]; open: PilotQuery | null; seq: number }

/** Commands that set the same thing replace each other. */
const SLOT: Partial<Record<SingleAircraftCommand['kind'], string>> = {
  altitude: 'level', heading: 'lateral', direct: 'lateral', hold: 'lateral', speed: 'speed',
  ils: 'approach', loc: 'approach', visual: 'approach', cancelApproach: 'approach',
  expectRunway: 'expect', taxi: 'taxi', holdShort: 'limit', holdPosition: 'limit', continue: 'limit',
  lineup: 'runway', takeoff: 'runway', cancelTakeoff: 'runway', cancelLineup: 'runway', clearedLand: 'landing', goAround: 'landing',
  contact: 'frequency', squawk: 'squawk',
};
/** Never remembered as clearances (talk, not instructions). */
const NOT_RECORDED = new Set<SingleAircraftCommand['kind']>(['roger', 'sayAgain', 'standby', 'report', 'windCheck', 'ident', 'disregard', 'correction', 'unable']);

const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const hdg3 = (h: number) => String(Math.round(((h % 360) + 360) % 360) || 360).padStart(3, '0');
const up = (s: string | null | undefined) => (s ?? '').toUpperCase();

export class ClearanceLedger {
  private byCallsign = new Map<string, AircraftLedger>();

  private of(cs: string): AircraftLedger {
    let l = this.byCallsign.get(cs);
    if (!l) { l = { entries: [], open: null, seq: 0 }; this.byCallsign.set(cs, l); }
    return l;
  }

  /** Everything this aircraft was told, oldest first. */
  entries(cs: string): readonly LedgerEntry[] { return this.byCallsign.get(cs)?.entries ?? []; }
  /** What is in force now. */
  active(cs: string): LedgerEntry[] { return this.entries(cs).filter((e) => e.status === 'active'); }
  openQuery(cs: string): PilotQuery | null { return this.byCallsign.get(cs)?.open ?? null; }
  forget(cs: string): void { this.byCallsign.delete(cs); }

  /** The clearances in force as text, for the comm log, a model's context or a debrief: "12:04 climb FL080 · 12:05 heading 270". */
  text(cs: string): string { return this.active(cs).map((e) => e.text).join(' · '); }

  /** An executed instruction enters the ledger and replaces what it amends. */
  record(cs: string, part: SingleAircraftCommand, time: number, transitionAltFt: number, magHdg: (trueDeg: number) => number): LedgerEntry | null {
    if (NOT_RECORDED.has(part.kind)) return null;
    const l = this.of(cs);
    const slot = SLOT[part.kind];
    if (slot) for (const e of l.entries) if (e.status === 'active' && SLOT[e.kind] === slot) e.status = 'superseded';
    const entry: LedgerEntry = { id: ++l.seq, at: time, kind: part.kind, ast: part, text: describeForLedger(part, transitionAltFt, magHdg), status: 'active' };
    l.entries.push(entry);
    if (l.entries.length > LEDGER_CONST.max) l.entries.splice(0, l.entries.length - LEDGER_CONST.max);
    return entry;
  }

  /** "Disregard": the last instruction in force is withdrawn. */
  cancelLast(cs: string): void {
    const l = this.byCallsign.get(cs); if (!l) return;
    l.open = null;
    for (let i = l.entries.length - 1; i >= 0; i--) if (l.entries[i].status === 'active') { l.entries[i].status = 'cancelled'; return; }
  }

  /**
   * Does this instruction contradict what the pilot was told? Returns the question to ask, or null to execute.
   * An instruction that answers the open question (the same instruction again) is never questioned twice.
   */
  check(a: AircraftState, part: SingleAircraftCommand, time: number, transitionAltFt: number, magHdg: (trueDeg: number) => number, extra?: () => Omit<PilotQuery, 'at' | 'ast'> | null): PilotQuery | null {
    const l = this.of(a.callsign);
    if (l.open && time - l.open.at > LEDGER_CONST.queryOpenS) l.open = null;
    if (l.open && sameInstruction(l.open.ast, part)) { l.open = null; return null; }   // the controller confirmed by repeating it
    const last = (slot: string) => { for (let i = l.entries.length - 1; i >= 0; i--) { const e = l.entries[i]; if (e.status === 'active' && SLOT[e.kind] === slot) return e; } return null; };
    let q: Omit<PilotQuery, 'at' | 'ast'> | null = null;

    if (part.kind === 'altitude') {
      const e = last('level');
      if (e && e.ast.kind === 'altitude' && time - e.at <= LEDGER_CONST.reversalS) {
        const was = Math.sign(e.ast.ft - a.altitude), now = Math.sign(part.ft - a.altitude);
        const unfinished = Math.abs(e.ast.ft - a.altitude) > 300;
        if (unfinished && was !== 0 && now !== 0 && was !== now) {
          q = { earlier: e, rule: 'level_reversal', question: `previously cleared ${was > 0 ? 'to climb' : 'to descend'} ${altitudeLabel(e.ast.ft, transitionAltFt)}, confirm now ${altitudeLabel(part.ft, transitionAltFt)}` };
        }
      }
    } else if (part.kind === 'heading') {
      const e = last('lateral');
      if (e && e.ast.kind === 'heading' && time - e.at <= LEDGER_CONST.reversalS && angle(e.ast.hdg, part.hdg) >= 120) {
        q = { earlier: e, rule: 'heading_reversal', question: `previously heading ${hdg3(magHdg(e.ast.hdg))}, confirm now heading ${hdg3(magHdg(part.hdg))}` };
      }
    } else if (part.kind === 'taxi' && part.dest.kind === 'runway') {
      const e = lastExpected(l.entries);
      if (e && up(e.runway) !== up(part.dest.runway)) {
        q = { earlier: e.entry, rule: 'runway_surprise', question: `we were told to expect runway ${up(e.runway)}, confirm runway ${up(part.dest.runway)}` };
      }
    }
    if (!q && extra) q = extra();   // what the pilot sees and hears (pilotmind.ts): same question-and-confirm flow
    if (!q) return null;
    l.open = { ...q, ast: part, at: time };
    return l.open;
  }

  /** "Roger" / "affirm" while a question is open: the instruction the pilot asked about, to execute now. */
  takeConfirmed(cs: string, time: number): SingleAircraftCommand | null {
    const l = this.byCallsign.get(cs);
    if (!l?.open || time - l.open.at > LEDGER_CONST.queryOpenS) return null;
    const ast = l.open.ast;   // left open: check() closes it when the same instruction comes through dispatch
    return ast;
  }
}

/** The runway the pilot was last told to expect (start-up, pushback or an explicit "expect runway"). */
function lastExpected(entries: LedgerEntry[]): { runway: string; entry: LedgerEntry } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]; if (e.status === 'cancelled') continue;
    if (e.ast.kind === 'taxi' && e.ast.dest.kind === 'runway') return null;   // already taxiing to a runway: a new one is an amendment
    if ((e.ast.kind === 'startup' || e.ast.kind === 'pushback') && e.ast.expectRunway) return { runway: e.ast.expectRunway, entry: e };
    if (e.ast.kind === 'expectRunway') return { runway: e.ast.runway, entry: e };
  }
  return null;
}

function sameInstruction(x: SingleAircraftCommand, y: SingleAircraftCommand): boolean {
  if (x.kind !== y.kind) return false;
  if (x.kind === 'altitude' && y.kind === 'altitude') return Math.round(x.ft) === Math.round(y.ft);
  if (x.kind === 'heading' && y.kind === 'heading') return angle(x.hdg, y.hdg) < 1.5;
  if (x.kind === 'taxi' && y.kind === 'taxi') return x.dest.kind === 'runway' && y.dest.kind === 'runway' && up(x.dest.runway) === up(y.dest.runway);
  if (x.kind === 'contact' && y.kind === 'contact') return x.position === y.position;
  if ((x.kind === 'clearedLand' || x.kind === 'lineup' || x.kind === 'cross') && 'runway' in y) return up(x.runway) === up((y as { runway: string }).runway);
  return false;
}

function describeForLedger(p: SingleAircraftCommand, ta: number, mag: (t: number) => number): string {
  switch (p.kind) {
    case 'altitude': return `level ${altitudeLabel(p.ft, ta)}`;
    case 'heading': return `heading ${hdg3(mag(p.hdg))}`;
    case 'speed': return p.kts === 'resume' ? 'resume normal speed' : `speed ${p.kts}`;
    case 'direct': return `direct ${p.fix}`;
    case 'hold': return `hold at ${p.fix}`;
    case 'ils': return `cleared ILS ${p.runway}`;
    case 'loc': return `cleared localizer ${p.runway}`;
    case 'visual': return `cleared visual ${p.runway}`;
    case 'expectRunway': return `expect runway ${p.runway}`;
    case 'startup': return `start-up approved${p.expectRunway ? `, expect ${p.expectRunway}` : ''}`;
    case 'pushback': return `pushback approved${p.expectRunway ? `, expect ${p.expectRunway}` : ''}`;
    case 'taxi': return p.dest.kind === 'runway' ? `taxi to runway ${p.dest.runway}${p.via.length ? ` via ${p.via.join(' ')}` : ''}` : p.dest.kind === 'stand' ? `taxi to stand ${p.dest.ref}` : 'taxi';
    case 'holdShort': return `hold short of ${p.of.kind === 'runway' ? `runway ${p.of.runway}` : p.of.kind === 'taxiway' ? p.of.taxiway : p.of.label}`;
    case 'holdPosition': return 'hold position';
    case 'cross': return `cross runway ${p.runway}`;
    case 'lineup': return `line up runway ${p.runway}`;
    case 'takeoff': return `cleared for takeoff ${p.runway}`;
    case 'clearedLand': return `cleared to land ${p.runway}`;
    case 'goAround': return 'go around';
    case 'contact': return `contact ${p.position}`;
    case 'squawk': return `squawk ${p.code}`;
    default: return p.kind;
  }
}

// one ledger per engine, without touching the engine class
const LEDGERS = new WeakMap<object, ClearanceLedger>();
export function ledgerOf(engine: object): ClearanceLedger {
  let l = LEDGERS.get(engine);
  if (!l) { l = new ClearanceLedger(); LEDGERS.set(engine, l); }
  return l;
}
/** Parts of a command as single instructions. */
export function partsOf(ast: CommandAST): SingleAircraftCommand[] {
  if (!('callsign' in ast)) return [];
  return ast.kind === 'sequence' ? ast.parts : [ast as SingleAircraftCommand];
}
