'use client';
import { useEffect, useRef, useCallback } from 'react';
import { useGroundTraffic } from '@/context/GroundTrafficContext';
import { updateAircraft } from '@/lib/physics';
import { processScheduler } from '@/lib/autoScheduler';
import type { SimAircraft } from '@/lib/aircraft';

export function useSimLoop() {
  const { state, dispatch } = useGroundTraffic();
  const lastTimeRef = useRef(performance.now());

  // Use refs to always access latest state inside RAF loop
  const aircraftsRef = useRef(state.aircrafts);
  const taxiGraphRef = useRef(state.taxiGraph);
  const isRunningRef = useRef(state.isRunning);
  const speedMultRef = useRef(state.speedMultiplier);

  // Keep refs in sync
  aircraftsRef.current = state.aircrafts;
  taxiGraphRef.current = state.taxiGraph;
  isRunningRef.current = state.isRunning;
  speedMultRef.current = state.speedMultiplier;

  // Stable dispatch ref
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!state.isRunning) return;

    let raf: number;
    const loop = (now: number) => {
      const isRunning = isRunningRef.current;
      if (!isRunning) {
        raf = requestAnimationFrame(loop);
        return;
      }

      const dt = ((now - lastTimeRef.current) / 1000) * speedMultRef.current;
      lastTimeRef.current = now;

      if (dt > 0.5) {
        raf = requestAnimationFrame(loop);
        return;
      }

      const currentAircrafts = aircraftsRef.current;
      const currentGraph = taxiGraphRef.current;
      const currentDispatch = dispatchRef.current;

      // ── 1. Run scheduler ──
      const schedulerUpdates = processScheduler(
        currentAircrafts,
        currentGraph,
        currentDispatch
      );

      // Apply scheduler updates
      let workingAircrafts = new Map(currentAircrafts);
      for (const updated of schedulerUpdates) {
        workingAircrafts.set(updated.id, updated);
      }

      // ── 2. Physics update ──
      const updates = new Map<string, SimAircraft>();
      const despawns: string[] = [];
      const allAircrafts = Array.from(workingAircrafts.values());

      for (const ac of allAircrafts) {
        const ctx = {
          otherAircraft: allAircrafts.filter(a => a.id !== ac.id),
          graph: currentGraph,
        };
        const updated = updateAircraft(ac, dt, ctx);
        updates.set(ac.id, updated);

        // Despawn aircraft that have handed off (departed) — wait a couple
        // seconds after HANDED_OFF so the climb-out is visible.
        if (updated.state === 'HANDED_OFF') {
          const ageMs = Date.now() - updated.stateChangedAt;
          if (ageMs > 4000) despawns.push(updated.id);
        }
        // Despawn aircraft that arrived at gate and have sat for a while
        if (updated.state === 'ARRIVED_GATE') {
          const ageMs = Date.now() - updated.stateChangedAt;
          if (ageMs > 8000) despawns.push(updated.id);
        }
      }

      if (updates.size > 0) {
        currentDispatch({ type: 'TICK', updates });
      }
      for (const id of despawns) {
        currentDispatch({ type: 'DESPAWN', id });
      }

      raf = requestAnimationFrame(loop);
    };

    lastTimeRef.current = performance.now();
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state.isRunning]);
}
