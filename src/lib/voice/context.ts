/*
  Voice input — the compact game-state context the System-1 model reads (docs/spec/11-VOICE-MODEL.md §1).

  The model sees: who is talking (position), the active runways, and one short line per aircraft (callsign, the words
  a controller would use for it, kind, frequency, phase, level, magnetic heading, runway, open request). It is the same
  string at training time (ml/data/export.ts) and at inference time in the browser, so it lives here, pure and with
  relative imports only (the headless harness has no `@/` alias).

  Also: `canonicalLine()` — the command line the model must produce and the command bar shows. It is the comm-log
  description of the AST with headings turned magnetic (typed headings are magnetic, the AST is TRUE), so the ordinary
  parser reads it back into the same AST.
*/
import type { SimEngine } from '../sim/engine';
import type { AircraftState, PlayerPosition, Position } from '../sim/types';
import { describe } from '../sim/commandAst';
import type { CommandAST } from '../sim/commandAst';
import { AIRLINE_TELEPHONY } from '../sim/phraseology';

const FREQ: Record<Position, string> = { ground: 'GND', tower: 'TWR', approach: 'APP', departure: 'DEP', external: 'EXT' };
const POS: Record<PlayerPosition, string> = { ground: 'GND', tower: 'TWR', approach: 'APP' };

/** Which player position works an aircraft on this frequency (departure is worked by approach). */
export function positionOf(f: Position): PlayerPosition | null {
  return f === 'ground' ? 'ground' : f === 'tower' ? 'tower' : f === 'approach' || f === 'departure' ? 'approach' : null;
}

const mag = (trueDeg: number, magVar: number) => { const m = Math.round(trueDeg - magVar) % 360; return m <= 0 ? m + 360 : m; };

/** The words a controller uses for an aircraft: telephony + flight number ("delta 421"), or the spelled callsign. */
export function spokenName(a: Pick<AircraftState, 'callsign' | 'flightNo'>): string {
  const m = a.callsign.match(/^([A-Z]{3})(\d+[A-Z]{0,2})$/);
  const tel = m ? AIRLINE_TELEPHONY[m[1]] : undefined;
  return tel && m ? `${tel.toLowerCase()} ${m[2].toLowerCase()}` : a.callsign.toLowerCase();
}

export interface VoiceContext { text: string; callsigns: string[] }

/** Compact context: `@APP 31L 31R` then one line per aircraft, the speaker's own frequency first. */
export function voiceContext(e: SimEngine, position: PlayerPosition): VoiceContext {
  const mv = e.magVar ?? 0;
  const own = (a: AircraftState) => positionOf(a.onFrequency) === position;
  const list = [...e.aircraft].sort((x, y) => Number(own(y)) - Number(own(x)) || x.callsign.localeCompare(y.callsign));
  const rwys = [...new Set([...e.activeEnds('dep'), ...e.activeEnds('arr')].map(r => r.name))];
  const lines = list.map(a => {
    const air = a.altitude > 50;
    const req = a.requests.find(r => r.answeredAt == null);
    return [a.callsign, spokenName(a), a.plan.kind === 'arrival' ? 'ARR' : 'DEP', FREQ[a.onFrequency], a.phase,
      air ? `${Math.round(a.altitude / 100) * 100}ft` : '', `h${String(mag(a.heading, mv)).padStart(3, '0')}`,
      a.assignedRunway ?? a.plan.runway ?? '', req ? `req:${req.kind}` : ''].filter(Boolean).join(' ');
  });
  return { text: [`@${POS[position]} ${rwys.join(' ')}`.trim(), ...lines].join('\n'), callsigns: list.map(a => a.callsign) };
}

const HDG_KEYS = new Set(['hdg', 'thenHdg', 'afterDepHdg', 'inbound']);
/** The command line for an AST, as typed: `CALLSIGN <description>` with magnetic headings. */
export function canonicalLine(ast: CommandAST, magVar: number): string {
  const m = JSON.parse(JSON.stringify(ast), (k, v) => (HDG_KEYS.has(k) && typeof v === 'number' ? mag(v, magVar) : v)) as CommandAST;
  return ('callsign' in m && m.callsign ? `${m.callsign} ` : '') + describe(m);
}
