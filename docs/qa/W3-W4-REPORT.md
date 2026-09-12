# Waves 3–4 report — E2E suite and fix round

## Gates (final)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `bash scripts/test-sim.sh` (headless engine/systems/commands/integration) | 868 / 868 |
| `bash scripts/e2e.sh` (Playwright, 13 spec files, 3 workers) | **258 / 258 passed, 0 flaky, 0 skipped**, 7.2 min |
| `npx next build` | clean |

## E2E suite (`tests/e2e/`)
10 home · 20 settings · 30 ground · 40 tower · 50 approach · 60 emergency · 65 alerts · 70 strips · 75 comm log · 78 nav/shell · 80 persistence · 85 errors · 90 map · smoke — every test drives the real UI (strips → panel → pickers → TRANSMIT, typed commands, map/radar clicks) in deterministic test mode and asserts engine truth **and** the DOM. `bash scripts/e2e.sh smoke` for the 2-minute subset.

## Product bugs found by the suite and fixed (33)
Engine: rollout exit never vacated · exit picker listed all 36 taxiways (no `exits` ctx) · give-way / behind-landing pickers empty (`nearbyAircraft`) · taxiway hold-short unreleasable by clicks · pre-cleared crossing could not be re-armed · cancel line-up crawled 3.5 km to a high-speed exit · MSAW dead (no centre / floor) · false WAKE alert for head-on traffic · DISREGARD still read back · wrong readbacks inaudible (digit vs spoken) · MAYDAY cancel kept 7700 · bare `HOLD` airborne mis-parsed · ATIS "runway change" line at 00:00 · OSM stand ids shown as `S626510130` · opposite-end arrival false warning · departure vanished from tower bays after vacating · no exit default on final.
UI: alert ACK / vehicle recall not re-rendering (in-place mutation) · SSR hydration mismatch with stored high score / settings · invalid persisted settings broke boot · ScrollArea setState-in-render · comm-log history vs autocomplete · nav tabs `aria-pressed` at boot · onboarding tip swallowed Esc · strip-bay arrow keys lost focus to the panel · strip E box for "next exit" · Shift+1..6 camera slots · Esc over map popovers paused the game · edge arrow hidden under panels · duplicate React keys on resolved alerts · radar drag inertia during the drag · ATIS chip clipping with 4 ends · score popover anchoring · alert stack / vehicles panel overlap · radar restricted-area / ILS label clutter.
New: tower runway status bars with wake-turbulence countdown (`runway-bar-{rwy}`, `wake-timer-{rwy}`).
