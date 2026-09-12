// ============================================================
//  Actions the shell binds to keyboard shortcuts (UX §4, §G6). The view fills
//  `radarActions` while mounted; every method is a safe no-op when unmounted.
//  Also exposed as window.__atcRadar for the test harness.
// ============================================================
export type RangePreset = '30' | '15' | '10' | 'final';

export interface ApproachViewApi {
  zoomIn(): void;
  zoomOut(): void;
  /** 30 / 15 / 10 NM around the field, or the final-approach area of the active arrival runway. */
  setRange(preset: RangePreset): void;
  range(): RangePreset | null;
  /** Range rings on/off (persists through sim.updateSettings). */
  toggleRings(): void;
  /** Follow the selected aircraft; toggles off on manual pan. */
  toggleFollow(): void;
  following(): boolean;
  /** Measure tool (click-click mode). Shift-drag / right-drag measure without arming it. */
  toggleMeasure(): void;
  measuring(): boolean;
  clearMeasures(): void;
  /** Centre on an aircraft id (eased). */
  centerOn(id: number): void;
  centerOnField(): void;
  /** Cancel any open draft bubble (heading / direct / ILS / altitude). */
  cancelDraft(): void;
  /** Send the open draft bubble, if any. Returns true when something was transmitted. */
  sendDraft(): boolean;
  hasDraft(): boolean;
  /** Set the pending heading draft turn direction (while dragging or in the bubble). */
  setDraftTurn(dir: 'L' | 'R' | null): void;
}

const noop = () => {};
const NOOP_API: ApproachViewApi = {
  zoomIn: noop, zoomOut: noop, setRange: noop, range: () => null, toggleRings: noop, toggleFollow: noop, following: () => false,
  toggleMeasure: noop, measuring: () => false, clearMeasures: noop, centerOn: noop, centerOnField: noop, cancelDraft: noop,
  sendDraft: () => false, hasDraft: () => false, setDraftTurn: noop,
};

let current: ApproachViewApi = NOOP_API;

/** Live radar actions (no-ops when the ApproachView is not mounted). */
export const radarActions: ApproachViewApi = new Proxy(NOOP_API, {
  get: (_t, key: keyof ApproachViewApi) => current[key],
}) as ApproachViewApi;

export function installRadarApi(api: ApproachViewApi | null): void {
  current = api ?? NOOP_API;
  if (typeof window !== 'undefined') (window as unknown as { __atcRadar?: ApproachViewApi }).__atcRadar = current;
}
