'use client'
/*
  Single import point for the simulation store inside the game UI panels
  (CommandPanel, StripBay, VehiclePanel). Everything codes to THE STORE
  INTERFACE of `src/components/atc/simStore.ts` (W2-STORE):
    sim.selectedId / hoveredId / position / paused / version / radio ...
    sim.actionsFor(a) / stepsFor(id, a) / validate(id, params, a) / transmit(id, params, a)
    sim.dispatchAst(ast) / undo() / select(id) / hover(id) / centerOn(id) ...
  `useSim(selector)` re-renders on every store emit (~10 Hz while running).
*/
export { sim, useSim } from '@/components/atc/simStore'
