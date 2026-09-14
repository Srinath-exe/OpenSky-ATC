# 08 — Performance: running on any device

The game has to run on a phone-class GPU as well as a gaming desktop. The sim engine is cheap (≈0.2 ms per 50 ms
step with 14 aircraft, headless benchmark); the cost is the 3D world map, the initial download and the DOM. This
document is the contract for keeping it that way.

## 1. Quality tiers (`src/components/atc/WorldMap/quality.ts`)

| tier | render scale cap | terrain mesh | depth of field | FXAA | detailed models within | rain | fps cap |
|---|---|---|---|---|---|---|---|
| high | 1.5× | 512² | yes | yes | 6.5 km | 1800 | display |
| medium | 1.0× | 384² | yes | yes | 4.5 km | 1000 | display |
| low | 1.0× | 256² | no | no | 2.5 km | 500 | 30 |

* `detectTier(gl)` reads the GPU string (`WEBGL_debug_renderer_info`), cores, `deviceMemory`, the pointer type and
  `saveData`: software / old mobile / old integrated GPUs → low; phones, tablets and integrated laptop GPUs → medium;
  discrete GPUs and Apple silicon → high.
* Settings → Graphics pins a tier (`skycontrol_graphics`, its own key — the Settings blob and its defaults are
  untouched). `?quality=low|medium|high|auto` overrides for one page load. A pin applies live: passes toggle, the
  terrain mesh and the rain are rebuilt in place, no reload.
* Test / lite mode (`?lite=1`, or `?test=1` without `?nolite=1`) is the low preset with a 192² mesh and no fps cap.

## 2. Adaptive render scale (`AdaptiveResolution`)

Every rendered frame's wall-clock interval feeds a 40-frame window. Slower than the target (22 ms; 40 ms on the
30-fps tier) → the render pixel ratio steps down by 0.1 (to the tier's floor: 0.75 / 0.6 / 0.5); a locked display
rate (< 17.5 ms) → it steps back up to the cap. Changes are rate-limited (45 / 90 frames) and gaps > 250 ms are
ignored. The map reports the current scale in `__worldStats().dpr` and the `?stats=1` overlay.

## 3. What the frame loop does not draw

* Frames are skipped while the tab is hidden; while the sim is paused and the camera rests the map redraws at 10 fps.
* One sphere test per aircraft decides the whole set (silhouette, model, lights, shadow, stem) — the model meshes
  skip three's per-mesh culling on purpose.
* Detailed models are drawn only inside the tier's model distance; beyond it the silhouette symbol is used.
* Draw-call batching: every taxiway / runway sign is one atlas-backed mesh (billboarded, sized and thinned in the
  vertex shader); stand numbers and runway designators are one atlas + one mesh each; floodlight pools are one mesh;
  model parts sharing a material (after the finish is unified) are merged (`mergeParts`, a 747 goes from 190 meshes
  to ~15).
* The depth-of-field pass (`dof.ts`) reads the main pass's depth texture instead of rendering the scene again, and
  blurs at quarter resolution (≈ 1/5 of the stock BokehPass).

## 4. Download

| file | before | after |
|---|---|---|
| `world/<ICAO>/land` | PNG 1.6–3.3 MB | WebP lossless, 5-bit channels 0.46–1.0 MB |
| `world/<ICAO>/height` | PNG 0.9–1.9 MB | WebP lossless, low 5 bits dropped (≤ 15 cm) 0.26–0.78 MB |
| `world/<ICAO>/vectors.json` | gzip on the fly (0.6 MB for KLAX) | unchanged |
| aircraft models | 0.2–1.4 MB each, gzip, lazy per type | unchanged |

`scripts/pack_world.py` derives the WebP files from the bake's PNGs (kept as the loader's fallback). World files and
models are served `Cache-Control: immutable` for a year under a version query (`WORLD_ASSET_VERSION` in
`worldList.ts`, `MODEL_VERSION` in `models.ts`) — bump when re-baking. The 3D map is its own chunk (`next/dynamic`):
the shell renders while three.js downloads, and `prefetchWorld()` starts the world files in parallel with it.

## 5. Input

Touch: one finger pans, two fingers pinch (zoom about the midpoint), twist (orbit) and drag up / down (tilt);
`touch-action: none` on the canvas. Hover picking is skipped for touch pointers.

## 6. Debugging

* `?stats=1` — fps, JS ms, draw ms, draw calls, triangles, render scale, tier overlay on the map.
* `window.__worldStats()` — the same as an object (+ detected tier, GPU string, visible models and their mesh counts).
* `window.__worldSet({ bokeh, fxaa, dpr })` — force passes / render scale for A/B measurements.
* `scratchpad/perf.cjs` (session scratch) measured the production build under SwiftShader: low tier 1.6 → 8.3 fps,
  high 1.8 → 3.2 fps, world download 3.7 MB → 1.25 MB, draw calls 145 → 97 at the default view.
