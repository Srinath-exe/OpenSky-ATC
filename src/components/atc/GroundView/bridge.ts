'use client';
// ============================================================
//  GroundView ↔ simStore bridge.
//
//  The view codes against the Wave-2 store interface (00-MASTER-PLAN §2.5 /
//  task brief). Only the members the ground map needs are declared here, typed
//  exactly as the store exposes them; `sim` is the singleton from ../simStore.
//  Optional members are the two ground-only hooks the store does not own
//  (quick-menu flag, vehicle selection) that the map writes for the shell.
// ============================================================
import { useSyncExternalStore } from 'react';
import { sim as storeSim } from '../simStore';
import type { SimEngine } from '@/lib/sim/engine';
import type { AircraftState, Stage, Vehicle, RunwayState, Alert, Position } from '@/lib/sim/types';
import type { CommandAST, CommandResult } from '@/lib/sim/commandAst';
import type { XY } from '@/lib/sim/projection';

/** Window events the map emits for the shell / panels (documented contract). */
export const EV_QUICK_MENU = 'atc:quick-menu';
export const EV_SELECT_VEHICLE = 'atc:select-vehicle';
/**
 * Vehicles-panel toggle. The store has no vehicles-panel flag, so the map
 * mirrors it on `sim.vehiclesPanelOpen` and dispatches `atc:toggle-vehicles`
 * with `{ open }` (plus the legacy alias `atc:toggle-vehicles-panel` the
 * GameShell listens to); inside a GameShell the toolbar prefers
 * `shell.toggle('vehicles')` through the ShellContext and emits nothing.
 */
export const EV_TOGGLE_VEHICLES = 'atc:toggle-vehicles';
export const EV_TOGGLE_VEHICLES_LEGACY = 'atc:toggle-vehicles-panel';

export type PlayerPosition = 'ground' | 'tower' | 'approach';
export type GroundTheme = 'satellite' | 'chart';

export interface GroundSettings {
  groundTheme?: GroundTheme;
  showRings?: boolean;
  strictFrequencies?: boolean;
}

export interface QuickMenuAt {
  /** CSS px relative to the map container. */
  x: number;
  y: number;
  /** Client (viewport) px for panels positioned outside the map. */
  clientX: number;
  clientY: number;
  kind: 'aircraft' | 'vehicle' | 'runway' | 'stand' | 'map';
  id: number | string | null;
  at: number;
}

export interface ToastLike { kind?: 'info' | 'success' | 'attention' | 'error'; text: string; detail?: string; duration?: number; key?: number | string; id?: string }

/** The store surface the ground map uses (subset of the W2-STORE SimStore). */
export interface GroundStore {
  engine: SimEngine | null;
  icao: string;
  loading: boolean;
  version: number;
  paused: boolean;
  position: Position | PlayerPosition;
  selectedId: number | null;
  hoveredId: number | null;
  settings: GroundSettings;
  mapReady: boolean;
  testMode?: boolean;
  subscribe(fn: () => void): () => void;
  select(id: number | null): void;
  hover(id: number | null): void;
  updateSettings(patch: Partial<GroundSettings> & Record<string, unknown>): void;
  pushToast(t: ToastLike): void;
  dispatchAst(ast: CommandAST): CommandResult;
  command(text: string): CommandResult;
  byId(id: number): AircraftState | undefined;
  aircraft(): AircraftState[];
  stageOf(a: AircraftState): Stage;
  vehicles(): Vehicle[];
  runways(): RunwayState[];
  alerts(): Alert[];
  registerProjector(kind: 'radar' | 'ground', fn: (xy: XY) => { x: number; y: number } | null, centerOn: (xy: XY) => void, camera: () => unknown): () => void;
  // ── ground-only hooks written by the map, read by the shell / command panel ──
  quickMenuAt?: QuickMenuAt | null;
  selectedVehicleId?: string | null;
  vehiclesPanelOpen?: boolean;
  setGroundCamera?: (cam: { lng: number; lat: number; zoom: number }) => void;
}

export const sim = storeSim as unknown as GroundStore;

/** Safe accessors: the map is resilient to a store that has not booted yet. */
export function storeVersion(): number { return typeof sim.version === 'number' ? sim.version : 0; }
export function playerPosition(): PlayerPosition {
  const p = sim.position as string | undefined;
  return p === 'tower' || p === 'approach' ? p : 'ground';
}
export function groundTheme(): GroundTheme { return sim.settings?.groundTheme === 'chart' ? 'chart' : 'satellite'; }
export function showRings(): boolean { return !!sim.settings?.showRings; }
export function engineOf(): SimEngine | null { return sim.engine ?? null; }
export function aircraftList(): AircraftState[] { return typeof sim.aircraft === 'function' ? sim.aircraft() : (sim.engine?.aircraft ?? []); }
export function vehicleList(): Vehicle[] { return typeof sim.vehicles === 'function' ? sim.vehicles() : (sim.engine?.fleet.list() ?? []); }
export function stageOfSafe(a: AircraftState): Stage | null {
  try { return typeof sim.stageOf === 'function' ? sim.stageOf(a) : (sim.engine ? sim.engine.stageOf(a) : null); } catch { return null; }
}
export function selectAircraft(id: number | null): void { if (typeof sim.select === 'function') sim.select(id); }
export function hoverAircraft(id: number | null): void { if (typeof sim.hover === 'function') sim.hover(id); }
export function toast(t: ToastLike): void { if (typeof sim.pushToast === 'function') sim.pushToast(t); }

/** Subscribe to the store (identity-stable selector results are the caller's job). */
export function useSimSelector<T>(selector: (s: GroundStore) => T): T {
  return useSyncExternalStore(
    (cb) => (typeof sim.subscribe === 'function' ? sim.subscribe(cb) : () => {}),
    () => selector(sim),
    () => selector(sim),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Ground-view UI state (view-owned: follow, layers, popovers, presets slots).
//  Tiny external store so the canvas loop and React share it without re-render churn.
// ──────────────────────────────────────────────────────────────────────────────
export interface GroundLayers {
  taxiwayLabels: boolean;
  standLabels: boolean;
  holdBars: boolean;
  trails: boolean;
  vehicles: boolean;
  corridor: boolean;
}
export interface GroundUiState {
  follow: boolean;
  layers: GroundLayers;
  popover: 'layers' | 'presets' | null;
  /** Hovered vehicle id (map only). */
  hoveredVehicleId: string | null;
  selectedVehicleId: string | null;
}

const LS_LAYERS = 'skycontrol_ground_layers';
const DEFAULT_LAYERS: GroundLayers = { taxiwayLabels: true, standLabels: true, holdBars: true, trails: true, vehicles: true, corridor: true };

class GroundUiStore {
  state: GroundUiState = { follow: false, layers: { ...DEFAULT_LAYERS }, popover: null, hoveredVehicleId: null, selectedVehicleId: null };
  version = 0;
  private listeners = new Set<() => void>();
  constructor() {
    if (typeof window !== 'undefined') {
      try { const raw = localStorage.getItem(LS_LAYERS); if (raw) this.state.layers = { ...DEFAULT_LAYERS, ...JSON.parse(raw) }; } catch { /* ignore */ }
    }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { this.version++; for (const l of this.listeners) l(); }
  patch(p: Partial<GroundUiState>) { this.state = { ...this.state, ...p }; this.emit(); }
  setLayer<K extends keyof GroundLayers>(k: K, v: boolean) {
    this.state = { ...this.state, layers: { ...this.state.layers, [k]: v } };
    try { localStorage.setItem(LS_LAYERS, JSON.stringify(this.state.layers)); } catch { /* ignore */ }
    this.emit();
  }
  setFollow(on: boolean) { if (this.state.follow !== on) this.patch({ follow: on }); }
  togglePopover(p: 'layers' | 'presets') { this.patch({ popover: this.state.popover === p ? null : p }); }
  closePopover() { if (this.state.popover) this.patch({ popover: null }); }
  selectVehicle(id: string | null) {
    if (this.state.selectedVehicleId === id) return;
    this.patch({ selectedVehicleId: id });
    sim.selectedVehicleId = id;
    for (const v of sim.engine?.fleet.list() ?? []) v.selected = v.id === id;   // the live fleet objects (the store hands out copies)
    (sim as unknown as { emit?: () => void }).emit?.();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EV_SELECT_VEHICLE, { detail: { id } }));
  }
}
export const groundUi = new GroundUiStore();

export function useGroundUi<T>(selector: (s: GroundUiState) => T): T {
  return useSyncExternalStore(groundUi.subscribe, () => selector(groundUi.state), () => selector(groundUi.state));
}

/** Right-click quick menu hook: select + flag on the store + DOM event for the command panel. */
export function openQuickMenu(at: QuickMenuAt): void {
  if (at.kind === 'aircraft' && typeof at.id === 'number') selectAircraft(at.id);
  sim.quickMenuAt = at;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EV_QUICK_MENU, { detail: at }));
}

/** Vehicles panel toggle (owned by the shell; the map only asks). */
export function toggleVehiclesPanel(): void {
  sim.vehiclesPanelOpen = !sim.vehiclesPanelOpen;
  if (typeof window === 'undefined') return;
  const detail = { open: sim.vehiclesPanelOpen };
  window.dispatchEvent(new CustomEvent(EV_TOGGLE_VEHICLES, { detail }));
  window.dispatchEvent(new CustomEvent(EV_TOGGLE_VEHICLES_LEGACY, { detail }));
}
