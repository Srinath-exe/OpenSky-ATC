// ============================================================
//  View-side position history (radar "sweeps"): one sample per SWEEP_S of sim
//  time per aircraft, kept for HISTORY_S. Drives the 5-dot history trail and
//  the hold oval drawn from the actual flown track (the engine trail is only
//  ~2 km long, far too short for a racetrack).
// ============================================================
import type { XY } from '@/lib/sim/projection';
import type { AircraftState } from '@/lib/sim/types';

export const SWEEP_S = 4;
const HISTORY_S = 420;
const MAX_SAMPLES = Math.ceil(HISTORY_S / SWEEP_S) + 1;

export interface Sample extends XY { t: number; hold: boolean }

export class PositionHistory {
  private byId = new Map<number, Sample[]>();
  private holdStart = new Map<number, number>();

  /** Call once per frame with the live aircraft list and sim time. */
  update(aircraft: AircraftState[], simTime: number): void {
    const seen = new Set<number>();
    for (const a of aircraft) {
      seen.add(a.id);
      let arr = this.byId.get(a.id);
      if (!arr) { arr = []; this.byId.set(a.id, arr); }
      const inHold = a.navMode === 'hold' && a.holdFix != null;
      if (inHold) { if (!this.holdStart.has(a.id)) this.holdStart.set(a.id, simTime); }
      else this.holdStart.delete(a.id);
      const last = arr[arr.length - 1];
      if (!last || simTime - last.t >= SWEEP_S || simTime < last.t) {
        if (last && simTime < last.t) arr.length = 0; // sim restarted
        arr.push({ x: a.pos.x, y: a.pos.y, t: simTime, hold: inHold });
        if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
      }
    }
    for (const id of this.byId.keys()) if (!seen.has(id)) { this.byId.delete(id); this.holdStart.delete(id); }
  }

  /** Last `n` sweeps before the current position (oldest first). */
  dots(id: number, n: number): Sample[] {
    const arr = this.byId.get(id);
    if (!arr || arr.length < 2) return [];
    return arr.slice(Math.max(0, arr.length - 1 - n), arr.length - 1);
  }

  /** Samples flown since the hold began (oldest first), or [] when not holding. */
  holdTrack(id: number): Sample[] {
    const arr = this.byId.get(id);
    const start = this.holdStart.get(id);
    if (!arr || start == null) return [];
    const out: Sample[] = [];
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].t < start) break; out.push(arr[i]); }
    return out.reverse();
  }

  clear(): void { this.byId.clear(); this.holdStart.clear(); }
}
