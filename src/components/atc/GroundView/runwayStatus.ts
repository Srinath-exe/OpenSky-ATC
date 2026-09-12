// ============================================================
//  Per-runway occupancy state — shared by the ground map (strip tint) and the
//  shell's Tower occupancy bars (UX §2.2: green free / amber lined-up / red
//  occupied / purple closed; `runway-bar-{rwy}-state` = free|lined|occupied|closed|emerg).
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { RunwayState } from '@/lib/sim/types';

export type RunwayBarState = 'free' | 'lined' | 'occupied' | 'closed' | 'emerg';

export interface RunwayOccupancy {
  name: string;
  ref: string;
  state: RunwayBarState;
  status: RunwayState['status'];
  /** Callsigns / vehicle ids on the strip. */
  occupants: string[];
  /** First occupant callsign (the bar's label). */
  occupant: string | null;
  lineUp: string | null;
  takeoffClearance: string | null;
  landingClearances: string[];
  wakeRemainingS: number;
  arrivalOnFinalNM: number | null;
}

export function runwayBarState(rs: RunwayState, engine: SimEngine | null): RunwayBarState {
  if (rs.status === 'closed' || rs.status === 'inspection') return 'closed';
  if (rs.status === 'sterile') return 'emerg';
  const occ = rs.occupiedBy;
  if (!occ.length) return 'free';
  if (engine) {
    let allLined = true;
    for (const o of occ) {
      if (typeof o.id !== 'number') { allLined = false; break; }
      const a = engine.byId(o.id);
      if (!a || a.phase !== 'lineup' || a.speed > 2) { allLined = false; break; }
    }
    if (allLined) return 'lined';
  }
  return 'occupied';
}

/** One entry per runway END (the shell shows one bar per active end). */
export function runwayOccupancy(engine: SimEngine | null): RunwayOccupancy[] {
  if (!engine) return [];
  return engine.runwayStates().map((rs) => {
    const state = runwayBarState(rs, engine);
    const occupants = rs.occupiedBy.map(o => o.callsign);
    const lineUp = state === 'lined' ? (rs.occupiedBy[0]?.callsign ?? null) : null;
    const final = engine.arrivalOnFinal(rs.name, 12);
    return {
      name: rs.name, ref: rs.ref, state, status: rs.status, occupants, occupant: occupants[0] ?? null, lineUp,
      takeoffClearance: rs.takeoffClearance, landingClearances: rs.landingClearances,
      wakeRemainingS: rs.wakeTimer && rs.wakeTimer.expiresAt > engine.time ? Math.round(rs.wakeTimer.expiresAt - engine.time) : 0,
      arrivalOnFinalNM: final ? Math.round(final.nm * 10) / 10 : null,
    };
  });
}
