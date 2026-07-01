import { SimAircraft, ClearanceSet, TaxiRoute } from '@/lib/aircraft';
import { TaxiGraph } from '@/lib/airportData';
import React, { createContext, useContext, useReducer, ReactNode } from 'react';

// ============================================================
//  Ground Traffic Context Types
// ============================================================

export interface GMSState {
  aircrafts: Map<string, SimAircraft>;
  selectedId: string | null;
  taxiGraph: TaxiGraph | null;
  isRunning: boolean;
  speedMultiplier: number;
  lastTick: number;
}

export type GMSAction =
  | { type: 'SPAWN'; aircraft: SimAircraft }
  | { type: 'DESPAWN'; id: string }
  | { type: 'TICK'; updates: Map<string, SimAircraft> }
  | { type: 'SELECT'; id: string | null }
  | { type: 'SET_GRAPH'; graph: TaxiGraph }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'SET_SPEED'; multiplier: number }
  | { type: 'GRANT_CLEARANCE'; id: string; clearanceType: keyof ClearanceSet; value?: any }
  | { type: 'REVOKE_CLEARANCE'; id: string; clearanceType: keyof ClearanceSet }
  | { type: 'ASSIGN_ROUTE'; id: string; route: TaxiRoute }
  | { type: 'CLEAR_ROUTE'; id: string }
  | { type: 'UPDATE_SINGLE'; id: string; aircraft: SimAircraft }
  | { type: 'RESET' };

// ============================================================
//  Initial State
// ============================================================

export const initialGMSState: GMSState = {
  aircrafts: new Map(),
  selectedId: null,
  taxiGraph: null,
  isRunning: false,
  speedMultiplier: 2,
  lastTick: 0,
};

// ============================================================
//  Reducer
// ============================================================

export function gmsReducer(state: GMSState, action: GMSAction): GMSState {
  switch (action.type) {
    case 'SPAWN': {
      const next = new Map(state.aircrafts);
      next.set(action.aircraft.id, action.aircraft);
      return { ...state, aircrafts: next };
    }

    case 'DESPAWN': {
      const next = new Map(state.aircrafts);
      next.delete(action.id);
      const selectedId = state.selectedId === action.id ? null : state.selectedId;
      return { ...state, aircrafts: next, selectedId };
    }

    case 'TICK': {
      const next = new Map(state.aircrafts);
      for (const [id, ac] of action.updates) {
        next.set(id, ac);
      }
      return { ...state, aircrafts: next, lastTick: Date.now() };
    }

    case 'SELECT': {
      return { ...state, selectedId: action.id };
    }

    case 'SET_GRAPH': {
      return { ...state, taxiGraph: action.graph };
    }

    case 'SET_RUNNING': {
      return { ...state, isRunning: action.running };
    }

    case 'SET_SPEED': {
      return { ...state, speedMultiplier: action.multiplier };
    }

    case 'GRANT_CLEARANCE': {
      const ac = state.aircrafts.get(action.id);
      if (!ac) return state;
      const cleared = {
        ...ac,
        clearances: { ...ac.clearances },
      };
      if (action.clearanceType === 'holdShort' || action.clearanceType === 'crossRunway') {
        (cleared.clearances as any)[action.clearanceType] = action.value ?? null;
      } else {
        (cleared.clearances as any)[action.clearanceType] = true;
      }
      const next = new Map(state.aircrafts);
      next.set(action.id, cleared);
      return { ...state, aircrafts: next };
    }

    case 'REVOKE_CLEARANCE': {
      const ac = state.aircrafts.get(action.id);
      if (!ac) return state;
      const revoked = {
        ...ac,
        clearances: { ...ac.clearances },
      };
      if (action.clearanceType === 'holdShort' || action.clearanceType === 'crossRunway') {
        (revoked.clearances as any)[action.clearanceType] = null;
      } else {
        (revoked.clearances as any)[action.clearanceType] = false;
      }
      const next = new Map(state.aircrafts);
      next.set(action.id, revoked);
      return { ...state, aircrafts: next };
    }

    case 'ASSIGN_ROUTE': {
      const ac = state.aircrafts.get(action.id);
      if (!ac) return state;
      const routed = {
        ...ac,
        route: action.route,
        routeProgress: { segmentIndex: 0, completed: false, holdingAt: null, distanceInSegment: 0, routeDistanceTravelled: 0 },
      };
      const next = new Map(state.aircrafts);
      next.set(action.id, routed);
      return { ...state, aircrafts: next };
    }

    case 'CLEAR_ROUTE': {
      const ac = state.aircrafts.get(action.id);
      if (!ac) return state;
      const cleared = {
        ...ac,
        route: null,
        routeProgress: { segmentIndex: 0, completed: false, holdingAt: null, distanceInSegment: 0, routeDistanceTravelled: 0 },
      };
      const next = new Map(state.aircrafts);
      next.set(action.id, cleared);
      return { ...state, aircrafts: next };
    }

    case 'UPDATE_SINGLE': {
      const next = new Map(state.aircrafts);
      next.set(action.id, action.aircraft);
      return { ...state, aircrafts: next };
    }

    case 'RESET': {
      return { ...initialGMSState };
    }

    default:
      return state;
  }
}

// ============================================================
//  React Context
// ============================================================

const GMSContext = createContext<{
  state: GMSState;
  dispatch: React.Dispatch<GMSAction>;
} | null>(null);

export function GMSProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(gmsReducer, initialGMSState);
  return (
    <GMSContext.Provider value={{ state, dispatch }}>
      {children}
    </GMSContext.Provider>
  );
}

export function useGroundTraffic() {
  const ctx = useContext(GMSContext);
  if (!ctx) throw new Error('useGroundTraffic must be inside GMSProvider');
  return ctx;
}
