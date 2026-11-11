// Who is flying (docs/spec/13-PILOT-BRAIN.md §4.5): every crew has a character that stays the same for the whole
// flight and decides how fast they answer, how often they read back wrong, how much they can take in at once and how
// they sound. The character comes from the callsign alone (a hash), so the simulator, the comm log and the voice agree
// without sharing state. Stress is read from the flight's own state and shifts the same numbers.
//
// Wording never touches a number, a callsign, a runway or a fix: a persona only adds hesitation around the phraseology.
import type { AircraftState } from './types';

export type PersonaKind = 'captain' | 'line' | 'rookie' | 'visitor' | 'student';

export interface Persona {
  kind: PersonaKind;
  /** For the strip and the debrief. */
  label: string;
  /** Reply delay, x the normal 2-4 s (air) / 4-8 s (ground). */
  delay: number;
  /** Wrong-readback rate, x the session's setting. */
  error: number;
  /** Chance of "say again" for each instruction beyond the second in one transmission. */
  overload: number;
  /** Speaking pace of the voice, x its own pace. */
  rate: number;
  hesitant: boolean;
}

const P: Record<PersonaKind, Persona> = {
  captain: { kind: 'captain', label: 'long-haul captain', delay: 0.7, error: 0.4, overload: 0, rate: 1.04, hesitant: false },
  line: { kind: 'line', label: 'line crew', delay: 1, error: 1, overload: 0.02, rate: 1, hesitant: false },
  rookie: { kind: 'rookie', label: 'new first officer', delay: 1.35, error: 2, overload: 0.12, rate: 0.96, hesitant: true },
  visitor: { kind: 'visitor', label: 'crew new to the airport', delay: 1.5, error: 1.5, overload: 0.22, rate: 0.9, hesitant: false },
  student: { kind: 'student', label: 'student pilot', delay: 1.6, error: 2.5, overload: 0.3, rate: 0.92, hesitant: true },
};

/** FNV-1a, the same on every platform. */
export function personaHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Airline flights are "ABC123"; anything else is a registration: general aviation, where the students are. */
const isAirline = (cs: string) => /^[A-Z]{3}\d/.test(cs);

export function personaOf(callsign: string): Persona {
  const cs = callsign.toUpperCase();
  const r = (personaHash(`crew:${cs}`) % 1000) / 1000;
  if (!isAirline(cs)) return r < 0.45 ? P.student : r < 0.8 ? P.line : P.captain;
  return r < 0.25 ? P.captain : r < 0.7 ? P.line : r < 0.85 ? P.rookie : P.visitor;
}

/** 0 (calm) to 1: an emergency, go-arounds, low fuel and being left waiting all add up. */
export function stressOf(a: AircraftState): number {
  let s = 0;
  if (a.emergency) s += 0.6;
  s += Math.min(0.5, 0.25 * (a.goAroundCount ?? 0));
  if (a.fuelMin != null && a.fuelMin < 30) s += 0.3;
  const req = a.requests[0];
  if (req && req.answeredAt == null && req.recalls >= 2) s += 0.2;
  return Math.max(0, Math.min(1, s));
}

/** Reply delay factor: an old hand gets sharper under pressure, everybody else slower. */
export function delayFactor(p: Persona, stress: number): number {
  return p.kind === 'captain' ? p.delay * (1 - 0.2 * stress) : p.delay * (1 + 0.4 * stress);
}
/** Wrong-readback factor. */
export function errorFactor(p: Persona, stress: number): number {
  return p.kind === 'captain' ? p.error : p.error * (1 + stress);
}
/** Chance that a transmission with `parts` instructions is too much at once and comes back as "say again". */
export function overloadChance(p: Persona, stress: number, parts: number): number {
  return parts < 3 ? 0 : Math.min(0.9, (parts - 2) * p.overload * (1 + stress));
}

const LOWER_FIRST = /^(Cleared|Climb|Climbing|Descend|Descending|Turn|Heading|Fly|Taxi|Hold|Holding|Line|Lining|Contact|Roger|Wilco|Reduce|Increase|Speed|Squawk|Direct|Proceed|Cross|Crossing|Push|Pushback|Start|Behind|Maintain|Continue|Going|Unable|Runway|Left|Right|After|Expect|Stand|Give|Monitor|Via|When|Request|With|Ready|Say|Standing|Vacate|Vacating)\b/;

/**
 * The same line as this crew would say it. `roll` is a uniform random number (the caller owns the generator).
 * Only hesitation is added; the phraseology and every value in it are untouched.
 */
export function personaLine(text: string, p: Persona, stress: number, roll: number): string {
  if (!text || !p.hesitant) return text;
  if (roll >= 0.25 + 0.35 * stress) return text;
  if (/^(Uh|Er),? /i.test(text)) return text;
  const body = LOWER_FIRST.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
  return `Uh, ${body}`;
}
