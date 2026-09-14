'use client'
/*
  WorldMap — the procedural 3D airport map (every airport with baked world data, all six today). Terrain, water, roads, buildings and the airport are generated
  from baked data (scripts/bake_world.py) and shaded live; the sim's traffic is placed on the surface. Tilted game camera
  (drag = pan, right-drag / Alt-drag = orbit, wheel = zoom), depth-of-field + vignette grade, hover / click selection wired
  to the store like the 2D ground view.
*/
import * as React from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { TiltShiftPass } from './dof';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import styles from './WorldMap.module.css';
import { sim, useSim } from '../simStore';
import type { AircraftState } from '@/lib/sim/types';
import { isAirborne } from '@/lib/sim/aircraft';
import { loadWorld, type World } from './world';
import { NOSE_WHEEL, genericLights, instantiate, lightsOf, loadAircraftModel, setModelNight, tint, type LightSpec } from './models';
import { PALETTE, applyFades, buildAirport, buildBuildings, buildRoads, buildTerrain, setSurfaceNight, toV3, type BuildingsHandle, type Fade, type NightHandle } from './terrain';
import { buildGse, buildJetBridges, buildLabels, buildStands, type LabelHandle } from './apron';
import { applySky, buildClouds, buildRain, buildSky, lightingFor, sunPosition, weatherLook, type TimeMode } from './sky';
import { AdaptiveResolution, PRESETS, detectTier, getGraphicsPref, presetFor, publishDetected, subscribeGraphics, type QualityPreset } from './quality';
import { IconButton, Segmented, Icon, Tooltip } from '@/design';
import { requestOpenAction } from '@/game/CommandPanel/bus';
import { stageLabel } from '@/lib/sim/stage';

const FT = 0.3048;
const CLOUD_TINT = new THREE.Color('#d8dbe0');
const GRADE = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.55 }, uSat: { value: 0.82 }, uLift: { value: 0.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette, uSat, uLift; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      vec2 q = vUv - 0.5; float v = 1.0 - smoothstep(0.35, 0.95, dot(q, q) * 2.4) * uVignette;
      c.rgb = c.rgb * v + uLift;
      gl_FragColor = c;
    }`,
};

interface Cam { target: THREE.Vector3; dist: number; yaw: number; pitch: number; distGoal: number }
interface Marker { mesh: THREE.Mesh; id: number; label: HTMLDivElement; shadow: THREE.Mesh; stem: THREE.Line; model: THREE.Group | null; modelWanted: boolean; tinted: string; lights: THREE.Points; lightSpec: LightSpec | null }

function aircraftGeometry(): THREE.BufferGeometry {
  // unit-length airliner silhouette in the XZ plane, nose toward -z (north); scaled per aircraft.
  // Shape space: +y = nose (rotateX(-90°) maps shape y to -z, the same mapping the terrain uses for north).
  const s = new THREE.Shape();
  const pts: [number, number][] = [[0, 0.5], [0.06, 0.42], [0.06, 0.12], [0.5, -0.12], [0.5, -0.18], [0.07, -0.1], [0.06, -0.34], [0.22, -0.44], [0.22, -0.48], [0.02, -0.46], [0, -0.5],
    [-0.02, -0.46], [-0.22, -0.48], [-0.22, -0.44], [-0.06, -0.34], [-0.07, -0.1], [-0.5, -0.18], [-0.5, -0.12], [-0.06, 0.12], [-0.06, 0.42]];
  s.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);        // shape y -> -z (nose north)
  g.translate(0, 0, 0.5 - NOSE_WHEEL);   // origin at the nose wheel, like the models
  return g;
}

/** Aircraft lights: additive glowing points with a per-point size in pixels (nav / beacon / strobe / landing / taxi). */
const LIGHT_ORDER = ['tipL', 'tipR', 'tail', 'beaconTop', 'beaconBot', 'nose', 'landL', 'landR'] as const;
const lightMaterial = new THREE.ShaderMaterial({
  uniforms: { uOpacity: { value: 1 }, uPixelRatio: { value: 1 } },
  vertexShader: `attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uPixelRatio;
    void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uPixelRatio; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vColor; uniform float uOpacity;
    void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); float core = 1.0 - smoothstep(0.0, 0.32, d); gl_FragColor = vec4(vColor + vec3(0.5) * core, (a * a * 0.7 + core) * uOpacity); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
function makeLights(): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length * 3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length), 1));
  const p = new THREE.Points(g, lightMaterial); p.frustumCulled = false; p.renderOrder = 30;
  return p;
}
function setLightPositions(p: THREE.Points, spec: LightSpec): void {
  const arr = p.geometry.getAttribute('position').array as Float32Array;
  LIGHT_ORDER.forEach((k, i) => { const v = spec[k]; arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; });
  p.geometry.getAttribute('position').needsUpdate = true;
}

export function WorldMap({ standalone = false }: { standalone?: boolean }) {
  const host = React.useRef<HTMLDivElement>(null);
  const labels = React.useRef<HTMLDivElement>(null);
  const icao = useSim((s) => s.icao);
  const hasEngine = useSim((s) => !!s.engine);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [tip, setTip] = React.useState<{ lines: string[] } | null>(null);
  const tipEl = React.useRef<HTMLDivElement>(null); const tipKey = React.useRef('');
  const statsEl = React.useRef<HTMLDivElement>(null);
  const [showStats] = React.useState(() => typeof window !== 'undefined' && /[?&]stats=1/.test(window.location.search));
  const [timeMode, setTimeMode] = React.useState<TimeMode>(() => { try { return (localStorage.getItem('skycontrol_world_time') as TimeMode) || 'auto'; } catch { return 'auto'; } });
  const [showLabels, setShowLabels] = React.useState(true);
  const [following, setFollowing] = React.useState(false);
  const [menu, setMenu] = React.useState<{ x: number; y: number; id: number; callsign: string; rows: { id: string; label: string; hotkey: string | null }[] } | null>(null);
  const selectedId = useSim((s) => s.selectedId);
  const ctl = React.useRef<{ zoom: (f: number) => void; reset: () => void; follow: (on: boolean) => void; centre: () => void } | null>(null);
  const timeRef = React.useRef<TimeMode>(timeMode); timeRef.current = timeMode;
  const labelsRef = React.useRef(true); labelsRef.current = showLabels;
  const setFollowRef = React.useRef(setFollowing); setFollowRef.current = setFollowing;
  const pickTime = (m: string) => { setTimeMode(m as TimeMode); try { localStorage.setItem('skycontrol_world_time', m); } catch { /* private mode */ } };

  React.useEffect(() => {
    const el = host.current; const e = sim.engine;
    if (!el || !e || !icao) return;
    let disposed = false;
    // lite: test mode / software GL — the low preset with an even smaller mesh (the look is unchanged, only the cost)
    const lite = /[?&]lite=1/.test(window.location.search) || (sim.testMode && !/[?&]nolite=1/.test(window.location.search));
    // no MSAA on the canvas: everything is drawn through the post-processing chain (FXAA there on the higher tiers)
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setClearColor(PALETTE.bg);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = false;   // reset once per frame (the stats then cover every pass)
    el.appendChild(renderer.domElement);
    // ── quality: tier from the device, the player's pin on top, adaptive render scale within the tier ──
    const detected = detectTier(renderer.getContext()); publishDetected(detected);
    let preset: QualityPreset = lite ? { ...PRESETS.low, terrainSegments: 192, fpsCap: 0 } : presetFor(getGraphicsPref(), detected.tier);
    const adaptive = new AdaptiveResolution(Math.min(window.devicePixelRatio || 1, preset.dprMax), Math.min(window.devicePixelRatio || 1, preset.dprMin));
    const retarget = () => { const cap = preset.fpsCap ? 1000 / preset.fpsCap : 0; adaptive.targetMs = cap ? cap * 1.2 : 22; adaptive.upMs = cap ? cap + 1.5 : 17.5; };
    retarget();
    const applyDpr = () => { renderer.setPixelRatio(adaptive.dpr); composer.setPixelRatio(adaptive.dpr); const r = renderer.getSize(new THREE.Vector2()); fxaa.uniforms.resolution.value.set(1 / (r.x * adaptive.dpr), 1 / (r.y * adaptive.dpr)); };
    const stats = { frames: 0, renderMs: 0, jsMs: 0, at: performance.now(), fps: 0, ms: 0, js: 0 };
    el.parentElement?.setAttribute('data-quality', preset.tier);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.bg);
    scene.fog = new THREE.Fog(PALETTE.bg, 9000, 32000);   // rescaled with the camera distance every frame (terrain shader mirrors it)
    const camera = new THREE.PerspectiveCamera(48, 1, 20, 80000);
    const cam: Cam = { target: new THREE.Vector3(0, 0, 0), dist: 5200, yaw: -0.35, pitch: 0.95, distGoal: 5200 };
    const hemiLight = new THREE.HemisphereLight(0xbfc7d1, 0x1a1c1a, 0.9); scene.add(hemiLight);
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.2); sun.position.set(-5000, 6000, 5000); scene.add(sun);

    // the render target carries a depth texture so the depth-of-field pass can read the main pass's depth
    const size0 = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size0.x), Math.max(1, size0.y), { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(Math.max(1, size0.x), Math.max(1, size0.y), THREE.UnsignedIntType) });
    const composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    // Depth of field as a background effect only (dof.ts): the airfield is always sharp, the blur ramps in beyond it
    // (far terrain, the bay, the horizon) by WORLD position, so the airport is sharp and everything around it soft from
    // any camera angle, including the city on the near side of the field - a tilt-shift look independent of the zoom.
    const bokeh = new TiltShiftPass(camera);
    const fieldCentre = new THREE.Vector3(0, 0, 0);
    bokeh.enabled = preset.bokeh; composer.addPass(bokeh);
    const fxaa = new ShaderPass(FXAAShader); fxaa.enabled = preset.fxaa; composer.addPass(fxaa);
    const grade = new ShaderPass(GRADE); composer.addPass(grade);
    composer.addPass(new OutputPass());
    applyDpr();

    const markers = new Map<number, Marker>();
    const acGeo = aircraftGeometry();
    const matPlane = new THREE.MeshLambertMaterial({ color: 0xf2f2ef, emissive: 0x202020 });
    const matSel = new THREE.MeshLambertMaterial({ color: PALETTE.orange, emissive: 0x3a2008 });
    const matGhost = new THREE.MeshLambertMaterial({ color: 0x9a9c9a, emissive: 0x151515 });
    const traffic = new THREE.Group(); scene.add(traffic);
    const sky = buildSky(); scene.add(sky.mesh);
    const clouds = buildClouds(60000); clouds.mesh.visible = false; scene.add(clouds.mesh);
    let rain = buildRain(preset.rain); scene.add(rain.points);
    const nightHandles: NightHandle[] = [];
    let buildingMat: THREE.MeshLambertMaterial | null = null;
    let buildings: BuildingsHandle | null = null;
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });   // aircraft-shaped (acGeo), per-marker opacity
    const stemMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
    const decor = new THREE.Group(); scene.add(decor);
    // smooth camera moves (centre-on / locate) and the world's pan limits
    let camGoal: THREE.Vector3 | null = null;
    const clampTarget = () => { if (!world) return; const ex = world.extent; cam.target.x = Math.min(ex.maxX - 1500, Math.max(ex.minX + 1500, cam.target.x)); cam.target.z = Math.min(-ex.minY - 1500, Math.max(-ex.maxY + 1500, cam.target.z)); };
    // ground vehicles: small boxes, ARFF red / ambulance white / others grey, with a beacon when active
    const vehGeo = new THREE.BoxGeometry(2.6, 2.4, 7);
    const vehMats: Record<string, THREE.MeshLambertMaterial> = {
      arff: new THREE.MeshLambertMaterial({ color: 0xd42a1f, emissive: 0x3a0a08 }), ambulance: new THREE.MeshLambertMaterial({ color: 0xf0f0ec, emissive: 0x202020 }),
      other: new THREE.MeshLambertMaterial({ color: 0xc9b23a, emissive: 0x2a2408 }),
    };
    const vehicles = new Map<string, { mesh: THREE.Mesh; label: HTMLDivElement }>();
    const vehGroup = new THREE.Group(); scene.add(vehGroup);
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2), 0, Math.sin(i / 64 * Math.PI * 2)))),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.85 }));
    ring.computeLineDistances(); ring.visible = false; scene.add(ring);
    const hoverRing = new THREE.LineLoop(ring.geometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })); hoverRing.visible = false; scene.add(hoverRing);
    // heading vectors (1 minute ahead) for airborne traffic, like the radar
    const vecGeo = new THREE.BufferGeometry(); vecGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 64), 3)); vecGeo.setDrawRange(0, 0);
    const vecLines = new THREE.LineSegments(vecGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })); vecLines.frustumCulled = false; scene.add(vecLines);
    const vehRouteGeo = new THREE.BufferGeometry(); vehRouteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 2000), 3)); vehRouteGeo.setDrawRange(0, 0);
    const vehRoutes = new THREE.LineSegments(vehRouteGeo, new THREE.LineBasicMaterial({ color: PALETTE.orange, transparent: true, opacity: 0.7 })); vehRoutes.frustumCulled = false; scene.add(vehRoutes);
    const routeMat = new LineMaterial({ color: 0xffffff, linewidth: 3, transparent: true, opacity: 0.9, dashed: false });
    let route: Line2 | null = null;
    let terrainUniforms: Record<string, THREE.IUniform> | null = null;
    let terrainMesh: THREE.Mesh | null = null;
    let roads: THREE.Group | null = null;
    let world: World | null = null;
    let mapLabels: LabelHandle | null = null;
    let nightAmtRef = 0;                       // last frame's night amount (the lighting block runs after the traffic sync)
    let fieldR = 3000;                         // airfield radius (m): the depth-of-field focus keeps everything inside it sharp
    const nightMats: THREE.MeshLambertMaterial[] = [];   // jet bridges / ground equipment: lifted at night (apron floodlights)
    const fades: Fade[] = [];
    const raycaster = new THREE.Raycaster();

    const airCenter = { lat: e.air.center.lat, lng: e.air.center.lng };
    loadWorld(icao, airCenter.lat, airCenter.lng).then((w) => {
      if (disposed) return;
      world = w;
      const field = [...e.air.nodes.values()].map(nd => w.toLocal(nd.lng, nd.lat));
      w.flatten(field, 120);
      const t = buildTerrain(w, preset.terrainSegments); terrainUniforms = t.uniforms; terrainMesh = t.mesh; scene.add(t.mesh);
      w.landTex.anisotropy = Math.min(preset.anisotropy, renderer.capabilities.getMaxAnisotropy());
      roads = buildRoads(w, fades, { step: preset.roadStep, minor: preset.minorRoads }); scene.add(roads);
      const bl = buildBuildings(w, e.air, preset.buildings); buildingMat = bl.material; buildings = bl; scene.add(bl.mesh); scene.add(bl.shadows); bl.shadows.visible = preset.buildingShadows;
      const ap = buildAirport(w, e.air, fades, nightHandles); scene.add(ap);
      const base = ap.userData.base as number;
      scene.add(buildStands(w, e.air, base, fades));
      const jb = buildJetBridges(w, e.air, base); if (jb) { scene.add(jb); nightMats.push((jb as THREE.Mesh).material as THREE.MeshLambertMaterial); }
      const gse = buildGse(w, e.air, base); if (gse) { scene.add(gse); nightMats.push((gse as THREE.Mesh).material as THREE.MeshLambertMaterial); }
      fieldR = Math.min(6000, Math.max(1500, Math.max(...field.map(p => Math.hypot(p.x, p.y))) + 300));
      mapLabels = buildLabels(w, e.air, base); scene.add(mapLabels.group);
      cam.target.set(0, w.heightAt(0, 0), 0); fieldCentre.set(0, w.heightAt(0, 0), 0);
      setStatus('ready');
    }).catch((err) => { console.error(err); setStatus('error'); });

    // ── live quality changes (Settings → Graphics): passes, render scale, model distance, rain, terrain density ──
    const applyPreset = (next: QualityPreset) => {
      const prev = preset; preset = next;
      bokeh.enabled = next.bokeh; fxaa.enabled = next.fxaa;
      adaptive.setRange(Math.min(window.devicePixelRatio || 1, next.dprMax), Math.min(window.devicePixelRatio || 1, next.dprMin)); retarget(); applyDpr();
      if (world && terrainMesh && next.terrainSegments !== prev.terrainSegments) {
        scene.remove(terrainMesh); terrainMesh.geometry.dispose(); (terrainMesh.material as THREE.Material).dispose();
        const t = buildTerrain(world, next.terrainSegments); terrainUniforms = t.uniforms; terrainMesh = t.mesh; scene.add(t.mesh);
      }
      if (world) world.landTex.anisotropy = Math.min(next.anisotropy, renderer.capabilities.getMaxAnisotropy());
      if (world && buildings && (next.buildings !== prev.buildings || next.buildingShadows !== prev.buildingShadows)) {
        scene.remove(buildings.mesh); scene.remove(buildings.shadows); buildings.mesh.geometry.dispose(); buildings.material.dispose(); (buildings.shadows.material as THREE.Material).dispose();
        const bl = buildBuildings(world, e.air, next.buildings); buildingMat = bl.material; buildings = bl; scene.add(bl.mesh); scene.add(bl.shadows); bl.shadows.visible = next.buildingShadows;
      }
      if (world && roads && (next.roadStep !== prev.roadStep || next.minorRoads !== prev.minorRoads)) {
        scene.remove(roads); roads.traverse((o) => { const m = o as THREE.LineSegments; if (m.geometry) m.geometry.dispose(); if (m.material) { const idx = fades.findIndex(f => f.mat === m.material); if (idx >= 0) fades.splice(idx, 1); (m.material as THREE.Material).dispose(); } });
        roads = buildRoads(world, fades, { step: next.roadStep, minor: next.minorRoads }); scene.add(roads);
      }
      if (next.rain !== prev.rain) { scene.remove(rain.points); rain.points.geometry.dispose(); rain = buildRain(next.rain); scene.add(rain.points); }
      el.parentElement?.setAttribute('data-quality', next.tier);
    };
    const unsubGraphics = lite ? () => {} : subscribeGraphics(() => { const next = presetFor(getGraphicsPref(), detected.tier); if (next.tier !== preset.tier) applyPreset(next); });

    // ── camera ──
    const applyCamera = () => {
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      camera.position.set(cam.target.x + cam.dist * cp * Math.sin(cam.yaw), cam.target.y + cam.dist * sp, cam.target.z + cam.dist * cp * Math.cos(cam.yaw));
      camera.lookAt(cam.target);
      camera.near = Math.max(5, cam.dist * 0.01); camera.far = Math.max(60000, cam.dist * 12); camera.updateProjectionMatrix();
    };
    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
      routeMat.resolution.set(w, h); fxaa.uniforms.resolution.value.set(1 / (w * adaptive.dpr), 1 / (h * adaptive.dpr));
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(el);

    // ground point under a screen position (ray vs the height field, iterative)
    const groundAt = (sx: number, sy: number): THREE.Vector3 | null => {
      const r = el.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1), camera);
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      if (d.y >= -0.02) return null;
      // intersect the plane at the camera target's height, then re-evaluate the terrain height there (2 fixed-point
      // steps are enough: the field is levelled and the far terrain is gentle relative to the ray's slant)
      let h = cam.target.y; const p = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        const t = (h - o.y) / d.y; if (t <= 0) return null;
        p.copy(o).addScaledVector(d, t);
        if (!world) break;
        const nh = world.heightAt(p.x, -p.z); if (Math.abs(nh - h) < 0.5) { h = nh; break; } h = nh;
      }
      p.y = h; return p;
    };
    // screen-space pick: nearest aircraft whose projected footprint (or an 18 px halo) covers the pointer. No triangle
    // raycasts against the models, so hovering stays cheap with 40 detailed aircraft on screen.
    const pickV = new THREE.Vector3();
    const pick = (sx: number, sy: number): number | null => {
      const r = el.getBoundingClientRect();
      const px = sx - r.left, py = sy - r.top;
      let best: number | null = null, bd = Infinity;
      for (const m of markers.values()) {
        pickV.copy(m.mesh.position).project(camera); if (pickV.z > 1) continue;
        const mx = (pickV.x + 1) / 2 * r.width, my = (1 - pickV.y) / 2 * r.height;
        const d = Math.hypot(mx - px, my - py);
        const radius = Math.max(18, m.mesh.scale.z * 0.55 * r.height / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(1, camera.position.distanceTo(m.mesh.position))));
        if (d < radius && d < bd) { bd = d; best = m.id; }
      }
      return best;
    };

    // ── pointer ──
    let drag: { mode: 'pan' | 'orbit'; x: number; y: number; moved: boolean; start: THREE.Vector3 | null } | null = null;
    // touch: one finger pans, two fingers pinch (zoom about the midpoint), twist (orbit) and drag up / down (tilt)
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; angle: number; midY: number; camDist: number } | null = null;
    const pinchState = () => { const [a, b] = [...pointers.values()]; return { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 }; };
    const onDown = (ev: PointerEvent) => {
      el.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const p = pinchState(); pinch = { dist: p.dist, angle: p.angle, midY: p.midY, camDist: cam.distGoal };
        const g = groundAt(p.midX, p.midY); zoomAnchor = g ? { sx: p.midX, sy: p.midY, ground: g } : null;
        drag = null; if (follow) setFollowRef.current(false); follow = false; camGoal = null;
        return;
      }
      if (pointers.size > 2) return;
      const orbit = ev.button === 2 || ev.altKey || ev.ctrlKey;
      drag = { mode: orbit ? 'orbit' : 'pan', x: ev.clientX, y: ev.clientY, moved: false, start: orbit ? null : groundAt(ev.clientX, ev.clientY) };
    };
    const onMove = (ev: PointerEvent) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pointers.size >= 2) {
        const p = pinchState();
        cam.distGoal = Math.min(38000, Math.max(90, pinch.camDist * pinch.dist / Math.max(1, p.dist)));
        if (zoomAnchor) { zoomAnchor.sx = p.midX; zoomAnchor.sy = p.midY; }
        let da = p.angle - pinch.angle; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        cam.yaw -= da; cam.pitch = Math.min(1.45, Math.max(0.3, cam.pitch + (p.midY - pinch.midY) * 0.004));
        pinch.angle = p.angle; pinch.midY = p.midY;
        return;
      }
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.mode === 'orbit') { cam.yaw -= dx * 0.005; cam.pitch = Math.min(1.45, Math.max(0.3, cam.pitch + dy * 0.004)); drag.x = ev.clientX; drag.y = ev.clientY; }
        else if (drag.start) { const g = groundAt(ev.clientX, ev.clientY); if (g) { cam.target.x += drag.start.x - g.x; cam.target.z += drag.start.z - g.z; } }
        if (follow) setFollowRef.current(false); follow = false; camGoal = null;
        return;
      }
      if (ev.pointerType === 'touch') return;
      const id = pick(ev.clientX, ev.clientY);
      if (id !== sim.hoveredId) sim.hover(id);
      if (id != null) {
        const a = e.byId(id); const r = el.getBoundingClientRect();
        if (a) {
          const st = (() => { try { return stageLabel(sim.stageOf(a)).long; } catch { return ''; } })();
          const rwy = a.plan.runway ?? a.assignedRunway; const l2 = isAirborne(a) ? `${Math.round(a.altitude / 100) * 100} ft · ${Math.round(a.speed)} kt · hdg ${String(Math.round(a.heading)).padStart(3, '0')}` : `${Math.round(a.speed)} kt · hdg ${String(Math.round(a.heading)).padStart(3, '0')}`;
          const lines = [`${a.callsign} · ${a.perf.icaoCode}/${a.perf.weightClass}`, `${st}${rwy ? ` · RWY ${rwy}` : ''}${a.plan.gateRef ? ` · stand ${a.plan.gateRef}` : ''}`, l2];
          const key = lines.join('\n');
          if (tipKey.current !== key) { tipKey.current = key; setTip({ lines }); }
          if (tipEl.current) tipEl.current.style.transform = `translate(${ev.clientX - r.left + 14}px, ${ev.clientY - r.top + 16}px)`;
        }
        el.style.cursor = 'pointer';
      } else { if (tipKey.current) { tipKey.current = ''; setTip(null); } el.style.cursor = drag ? 'grabbing' : 'grab'; }
    };
    const onUp = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pinch) {
        // the pinch ends when a finger lifts; the one still down carries on as a pan from where it is
        if (pointers.size < 2) { pinch = null; zoomAnchor = null; const rest = [...pointers.values()][0]; drag = rest ? { mode: 'pan', x: rest.x, y: rest.y, moved: true, start: groundAt(rest.x, rest.y) } : null; }
        return;
      }
      if (drag && !drag.moved && ev.button === 0) { const id = pick(ev.clientX, ev.clientY); sim.select(id); setMenu(null); if (id != null && follow) { follow = false; setFollowRef.current(false); } }
      if (drag && !drag.moved && ev.button === 2) {
        const id = pick(ev.clientX, ev.clientY); const a = id != null ? e.byId(id) : null;
        if (a) {
          sim.select(a.id);
          let rows: { id: string; label: string; hotkey: string | null }[] = [];
          try { rows = sim.actionsFor(a).filter(x => x.state === 'enabled').slice(0, 7).map(x => ({ id: x.id, label: x.label, hotkey: x.hotkey })); } catch { rows = []; }
          const r = el.getBoundingClientRect();
          setMenu({ x: ev.clientX - r.left, y: ev.clientY - r.top, id: a.id, callsign: a.callsign, rows });
        } else setMenu(null);
      }
      drag = null;
    };
    const onCancel = (ev: PointerEvent) => { pointers.delete(ev.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) drag = null; };
    // wheel: the zoom goal moves at once, the distance eases toward it each frame (zoomAnchor keeps the ground point
    // under the pointer fixed while it does)
    let zoomAnchor: { sx: number; sy: number; ground: THREE.Vector3 } | null = null;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const g = groundAt(ev.clientX, ev.clientY);
      cam.distGoal = Math.min(38000, Math.max(90, cam.distGoal * Math.exp(ev.deltaY * 0.0012)));
      zoomAnchor = g ? { sx: ev.clientX, sy: ev.clientY, ground: g } : null;
    };
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === 'INPUT') return;
      if (ev.key === 'Home') { cam.target.set(0, world?.heightAt(0, 0) ?? 0, 0); cam.dist = cam.distGoal = 5200; cam.yaw = -0.35; cam.pitch = 0.95; }
    };
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onCancel);
    el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', onKey);
    let follow = false;
    ctl.current = {
      zoom: (f) => { cam.distGoal = Math.min(38000, Math.max(90, cam.distGoal * f)); zoomAnchor = null; },
      reset: () => { cam.target.set(0, world?.heightAt(0, 0) ?? 0, 0); cam.dist = cam.distGoal = 5200; cam.yaw = -0.35; cam.pitch = 0.95; camGoal = null; zoomAnchor = null; follow = false; setFollowRef.current(false); },
      follow: (on) => { follow = on && sim.selectedId != null; setFollowRef.current(follow); },
      centre: () => { const a = sim.selectedId != null ? sim.engine?.byId(sim.selectedId) : null; if (a) camGoal = new THREE.Vector3(a.pos.x, world?.heightAt(a.pos.x, a.pos.y) ?? 0, -a.pos.y); },
    };
    // camera hook for headless screenshots / debugging: window.__worldCam(yaw?, pitch?, dist?)
    (window as unknown as { __worldCam?: (y: number | null, p: number | null, d?: number | null) => void }).__worldCam = (y, p, d) => { if (y != null) cam.yaw = y; if (p != null) cam.pitch = Math.min(1.45, Math.max(0.3, p)); if (d != null) cam.dist = cam.distGoal = d; };
    // projector for the test API / centre-on
    const unregister = sim.registerProjector('ground',
      (xy) => { const v = toV3(xy.x, xy.y, world?.heightAt(xy.x, xy.y) ?? 0).project(camera); const r = el.getBoundingClientRect(); return v.z > 1 ? null : { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height }; },
      (xy) => { camGoal = new THREE.Vector3(xy.x, world?.heightAt(xy.x, xy.y) ?? 0, -xy.y); },
      () => ({ lng: 0, lat: 0, zoom: Math.log2(40000 / cam.dist) + 10 }) as never,
      { size: () => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; } } as never);

    // ── frame loop ──
    let raf = 0; const clock = new THREE.Clock();
    const tmp = new THREE.Vector3();
    const frustum = new THREE.Frustum(); const frustumM = new THREE.Matrix4(); const sphere = new THREE.Sphere();
    let lastRender = 0; let lastCamKey = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const now = performance.now();
      // frame-rate cap (low tier) and a 10 fps idle rate while the sim is paused and the camera rests: the picture
      // cannot change, so the GPU (and the battery) rest too
      const camKey = `${cam.target.x.toFixed(1)},${cam.target.z.toFixed(1)},${cam.dist.toFixed(1)},${cam.yaw.toFixed(3)},${cam.pitch.toFixed(3)},${sim.selectedId},${sim.hoveredId},${sim.version}`;
      const resting = sim.paused && camKey === lastCamKey && !camGoal && Math.abs(cam.distGoal - cam.dist) < 0.5;
      const minGap = resting ? 100 : preset.fpsCap ? 1000 / preset.fpsCap - 2 : 0;
      if (minGap && now - lastRender < minGap) { clock.getDelta(); return; }
      lastCamKey = camKey;
      const dt = clock.getDelta();
      const eng = sim.engine; if (!eng) return;
      const t0 = now; renderer.info.reset();
      const rect = el.getBoundingClientRect();   // once per frame (layout read)
      frustumM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(frustumM);
      // traffic sync
      const live = new Set<number>();
      for (const a of eng.aircraft) {
        live.add(a.id);
        let m = markers.get(a.id);
        if (!m) {
          const mesh = new THREE.Mesh(acGeo, matPlane); mesh.userData.id = a.id;
          const label = document.createElement('div'); label.className = styles.label; labels.current?.appendChild(label);
          const shadow = new THREE.Mesh(acGeo, shadowMat.clone()); shadow.renderOrder = 5; decor.add(shadow);
          const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), stemMat); decor.add(stem);
          const lights = makeLights(); setLightPositions(lights, genericLights(a.perf.lengthMeters, a.perf.wingspanMeters)); traffic.add(lights);
          m = { mesh, id: a.id, label, shadow, stem, model: null, modelWanted: false, tinted: '', lights, lightSpec: null }; markers.set(a.id, m); traffic.add(mesh);
        }
        const air = isAirborne(a);
        const ground = world ? world.heightAt(a.pos.x, a.pos.y) : 0;
        const h = air ? Math.max(a.altitude * FT, ground + 2) : ground + 1.2;
        m.mesh.position.set(a.pos.x, h, -a.pos.y);
        const len = a.perf.lengthMeters, span = a.perf.wingspanMeters;
        const scale = Math.max(1, cam.dist / 2600);            // keep symbols legible when zoomed out
        m.mesh.scale.set(span * scale, 1, len * scale);
        m.mesh.rotation.y = -a.heading * Math.PI / 180;
        // ground shadow: the silhouette, flat on the surface, slightly larger and fainter with height; a thin stem from an
        // airborne aircraft down to the ground
        const useModel = !!m.model && cam.dist < preset.modelDist;
        // off-screen aircraft cost nothing: the model meshes skip three's per-mesh culling (up to 200 parts on one
        // airframe), so one sphere test per aircraft decides the whole set
        sphere.center.copy(m.mesh.position); sphere.radius = Math.max(len, span) * Math.max(1, cam.dist / 2600) * 1.2 + 40;
        const onScreen = frustum.intersectsSphere(sphere);
        const shScale = useModel ? 1 : scale;
        m.shadow.position.set(a.pos.x, ground + 0.4, -a.pos.y); m.shadow.rotation.y = m.mesh.rotation.y;
        const sh = air ? Math.max(0.8, 1 + (h - ground) / 600) : 1.04;
        m.shadow.scale.set(span * shScale * sh, 0.01, len * shScale * sh);
        (m.shadow.material as THREE.MeshBasicMaterial).opacity = (air ? Math.max(0.04, 0.28 - (h - ground) / 6000) : 0.32) * (0.35 + 0.65 * (1 - nightAmtRef));
        if (air) { m.stem.position.set(a.pos.x, ground, -a.pos.y); m.stem.scale.y = Math.max(1, h - ground); }
        m.mesh.material = a.id === sim.selectedId ? matSel : a.onFrequency === sim.position || sim.position === 'ground' ? matPlane : matGhost;
        // real model (lazy per type); the silhouette stays as the far-zoom symbol and the pick target
        if (!m.modelWanted) {
          m.modelWanted = true; const mk = m;
          loadAircraftModel(a.perf.icaoCode).then((mdl) => {
            if (!mdl || disposed || !markers.has(mk.id)) return;
            mk.model = instantiate(mdl, a.perf.lengthMeters, a.callsign); mk.model.userData.id = mk.id; traffic.add(mk.model);
            const spec = lightsOf(mdl, a.perf.lengthMeters); if (spec) { mk.lightSpec = spec; setLightPositions(mk.lights, spec); }
          });
        }
        m.mesh.visible = onScreen && !useModel; m.shadow.visible = onScreen; m.stem.visible = onScreen && air;
        if (m.model) {
          m.model.visible = onScreen && useModel;
          m.model.position.copy(m.mesh.position); m.model.rotation.y = m.mesh.rotation.y;
          const state = a.id === sim.selectedId ? 'sel' : a.id === sim.hoveredId ? 'hover' : '';
          if (state !== m.tinted) { tint(m.model, state === 'sel' ? PALETTE.orange : state === 'hover' ? new THREE.Color(0x404040) : null); m.tinted = state; }
        }
        // lights: nav (red / green / white) whenever not parked, red beacon blinking with the engines, wingtip strobes
        // on the runway and in the air, landing lights below 10 000 ft / on the roll, taxi light while moving on the ground
        {
          const L = m.lights; L.position.copy(m.mesh.position); L.rotation.y = m.mesh.rotation.y;
          const col = L.geometry.getAttribute('color').array as Float32Array, siz = L.geometry.getAttribute('size').array as Float32Array;
          const ph = a.phase; const t = clock.elapsedTime + a.id * 0.37;
          const active = ph !== 'parked' && ph !== 'arrived' && ph !== 'departed';
          const onRunway = ph === 'lineup' || ph === 'takeoff' || ph === 'landing' || ph === 'rollout';
          const beacon = active && (t % 1.2) < 0.32;
          const strobe = (air || onRunway) && ((t % 1.35) < 0.07 || ((t % 1.35) > 0.16 && (t % 1.35) < 0.23));
          const landing = onRunway || (air && a.altitude < 10000);
          const taxi = !air && active && a.speed > 0.5;
          // sizes in px (halo included): visible from a distance at night, faint by day
          const nightK = 0.4 + 0.6 * nightAmtRef;
          const set = (i: number, r: number, g: number, b: number, sz: number) => { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; siz[i] = sz * nightK; };
          const nav = active ? 1 : 0;
          set(0, 1, 0.12, 0.1, strobe ? 34 : 14 * nav); set(1, 0.2, 1, 0.3, strobe ? 34 : 14 * nav); set(2, 1, 1, 1, strobe ? 24 : 11 * nav);
          set(3, 1, 0.15, 0.1, beacon ? 20 : 0); set(4, 1, 0.15, 0.1, beacon ? 16 : 0);
          set(5, 1, 0.97, 0.9, taxi ? 18 : 0); set(6, 1, 0.98, 0.92, landing ? 26 : 0); set(7, 1, 0.98, 0.92, landing ? 26 : 0);
          L.geometry.getAttribute('color').needsUpdate = true; L.geometry.getAttribute('size').needsUpdate = true;
          L.visible = onScreen && (active || air);
        }
        // label
        tmp.copy(m.mesh.position).project(camera);
        const r = rect;
        if (tmp.z > 1 || tmp.x < -1.1 || tmp.x > 1.1 || tmp.y < -1.1 || tmp.y > 1.1) m.label.style.display = 'none';
        else {
          m.label.style.display = '';
          m.label.style.transform = `translate(${((tmp.x + 1) / 2 * r.width + 14).toFixed(1)}px, ${((1 - tmp.y) / 2 * r.height - 10).toFixed(1)}px)`;
          const alt = air ? `${String(Math.round(a.altitude / 100)).padStart(3, '0')} ${Math.round(a.speed)}` : `${Math.round(a.speed)} kt`;
          const txt = `${a.callsign} ${a.perf.icaoCode}\n${alt}`;
          if (m.label.dataset.txt !== txt) { m.label.dataset.txt = txt; m.label.innerHTML = `<b>${a.callsign}</b> <span>${a.perf.icaoCode}</span><br><em>${alt}</em>`; }
          if (!labelsRef.current && a.id !== sim.selectedId) m.label.style.display = 'none';
          m.label.dataset.selected = a.id === sim.selectedId ? 'true' : 'false';
          m.label.dataset.hover = a.id === sim.hoveredId ? 'true' : 'false';
        }
      }
      // heading vectors: 60 s of ground speed ahead of every airborne aircraft
      { const arr = vecGeo.getAttribute('position').array as Float32Array; let k = 0;
        for (const a of eng.aircraft) { if (!isAirborne(a) || k >= 64) continue; const m = markers.get(a.id); if (!m) continue;
          const d = a.speed * 0.5144 * 60; const hx = Math.sin(a.heading * Math.PI / 180) * d, hz = -Math.cos(a.heading * Math.PI / 180) * d;
          arr.set([m.mesh.position.x, m.mesh.position.y, m.mesh.position.z, m.mesh.position.x + hx, m.mesh.position.y, m.mesh.position.z + hz], k * 6); k++; }
        vecGeo.setDrawRange(0, k * 2); vecGeo.getAttribute('position').needsUpdate = true; }
      // hover ring
      const hov = sim.hoveredId != null && sim.hoveredId !== sim.selectedId ? markers.get(sim.hoveredId) : null;
      if (hov) { hoverRing.visible = true; hoverRing.position.copy(hov.mesh.position).setY(hov.mesh.position.y + 0.5); const hr = Math.max(50, cam.dist * 0.024); hoverRing.scale.set(hr, 1, hr); } else hoverRing.visible = false;
      for (const [id, m] of markers) if (!live.has(id)) { traffic.remove(m.mesh); if (m.model) traffic.remove(m.model); traffic.remove(m.lights); m.lights.geometry.dispose(); decor.remove(m.shadow); decor.remove(m.stem); m.stem.geometry.dispose(); m.label.remove(); markers.delete(id); }
      // vehicles (only when away from the station, so the map stays calm)
      const liveV = new Set<string>();
      let fleet: Array<{ id: string; type: string; state: string; pos: { x: number; y: number }; heading: number; path: { pts: { x: number; y: number }[] } | null }> = [];
      try { fleet = eng.fleet.list(); } catch { fleet = []; }
      for (const v of fleet) {
        if (v.state === 'standby') continue;
        liveV.add(v.id);
        let m = vehicles.get(v.id);
        if (!m) {
          const mesh = new THREE.Mesh(vehGeo, vehMats[v.type] ?? vehMats.other);
          const label = document.createElement('div'); label.className = styles.label; label.dataset.vehicle = 'true'; labels.current?.appendChild(label);
          m = { mesh, label }; vehicles.set(v.id, m); vehGroup.add(mesh);
        }
        const g = world ? world.heightAt(v.pos.x, v.pos.y) : 0;
        m.mesh.position.set(v.pos.x, g + 1.2, -v.pos.y); m.mesh.rotation.y = -v.heading * Math.PI / 180;
        const sc = Math.max(1, cam.dist / 1800); m.mesh.scale.set(sc, sc, sc);
        tmp.copy(m.mesh.position).project(camera); const r = rect;
        if (tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) m.label.style.display = 'none';
        else { m.label.style.display = ''; m.label.style.transform = `translate(${((tmp.x + 1) / 2 * r.width + 10).toFixed(1)}px, ${((1 - tmp.y) / 2 * r.height - 8).toFixed(1)}px)`; const t = `${v.id} · ${v.state.replace('_', ' ')}`; if (m.label.textContent !== t) m.label.textContent = t; }
      }
      for (const [id, m] of vehicles) if (!liveV.has(id)) { vehGroup.remove(m.mesh); m.label.remove(); vehicles.delete(id); }
      // vehicle routes (en route / returning) as thin orange lines on the ground
      { const arr = vehRouteGeo.getAttribute('position').array as Float32Array; let k = 0;
        for (const v of fleet as Array<{ state: string; path: { pts: { x: number; y: number }[] } | null }>) {
          if (!v.path || (v.state !== 'enroute' && v.state !== 'returning')) continue;
          const pts = v.path.pts; for (let i = 1; i < pts.length && k < 2000; i++) { const a = pts[i - 1], b = pts[i];
            arr.set([a.x, (world?.heightAt(a.x, a.y) ?? 0) + 0.9, -a.y, b.x, (world?.heightAt(b.x, b.y) ?? 0) + 0.9, -b.y], k * 6); k++; } }
        vehRouteGeo.setDrawRange(0, k * 2); vehRouteGeo.getAttribute('position').needsUpdate = true; }
      // selection ring + route + follow
      const sel = sim.selectedId != null ? eng.byId(sim.selectedId) : null;
      if (sel) {
        const m = markers.get(sel.id);
        if (m) { ring.visible = true; ring.position.copy(m.mesh.position).setY(m.mesh.position.y + 0.5); const rr = Math.max(60, cam.dist * 0.03); ring.scale.set(rr, 1, rr); ring.computeLineDistances(); (ring.material as THREE.LineDashedMaterial).dashSize = rr * 0.12; (ring.material as THREE.LineDashedMaterial).gapSize = rr * 0.08; }
        if (follow && m) { cam.target.x += (m.mesh.position.x - cam.target.x) * Math.min(1, dt * 4); cam.target.z += (m.mesh.position.z - cam.target.z) * Math.min(1, dt * 4); }
        const key = sel.path ? `${sel.id}:${sel.path.total}:${sel.path.pts.length}` : '';
        if (key !== (route?.userData.key ?? '')) {
          if (route) { scene.remove(route); route.geometry.dispose(); route = null; }
          if (sel.path && sel.path.pts.length > 1 && world) {
            const pts: number[] = []; for (const p of sel.path.pts) { const v = toV3(p.x, p.y, world.heightAt(p.x, p.y) + 1.5); pts.push(v.x, v.y, v.z); }
            const g = new LineGeometry(); g.setPositions(pts); route = new Line2(g, routeMat); route.userData.key = key; scene.add(route);
          }
        }
      } else { ring.visible = false; if (route) { scene.remove(route); route.geometry.dispose(); route = null; } }
      const fogNear = cam.dist * 2.4, fogFar = cam.dist * 7.5;   // haze well beyond the airfield (the horizon colour); weather pulls it in below
      (scene.fog as THREE.Fog).near = fogNear; (scene.fog as THREE.Fog).far = fogFar;
      // ── sun, sky, weather ──
      const wx = weatherLook((() => { try { return eng.wx(); } catch { return null; } })());
      const epoch = (sim.sessionStartedAt || Date.now()) + eng.time * 1000;
      const sp = sunPosition(epoch, airCenter.lat, airCenter.lng);
      const mode = timeRef.current;
      const elev = mode === 'day' ? 38 : mode === 'dusk' ? 1.5 : mode === 'night' ? -20 : sp.elevation;
      const L = lightingFor(elev, mode === 'auto' ? sp.azimuth : mode === 'dusk' ? 265 : 150);
      const cloudDim = 1 - wx.cloudCover * 0.45;
      sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity * cloudDim; sun.position.copy(L.sunDir).multiplyScalar(8000);
      hemiLight.color.copy(L.hemiSky); hemiLight.groundColor.copy(L.hemiGround); hemiLight.intensity = L.hemiIntensity;
      const horizon = applySky(sky.uniforms, L, wx.cloudCover); sky.mesh.position.copy(camera.position); sky.mesh.scale.setScalar(camera.far * 0.9);
      // fog = the sky's horizon colour, so the far terrain and the world's edge melt into the sky instead of going black
      scene.background = null; (scene.fog as THREE.Fog).color.copy(L.fog).lerp(horizon, 0.9);
      (sky.uniforms.uFog.value as THREE.Color).copy((scene.fog as THREE.Fog).color);
      const fogFar2 = Math.min(fogFar, wx.visM * 3.2 + cam.dist * 0.5);   // poor visibility pulls the fog in
      (scene.fog as THREE.Fog).near = Math.min(fogNear, fogFar2 * 0.4); (scene.fog as THREE.Fog).far = fogFar2;
      // the deck is only drawn while the camera is under it (from above it would veil the whole map); overcast still dims the sun
      const deckY = (world?.heightAt(0, 0) ?? 0) + wx.cloudBaseM;
      const under = 1 - THREE.MathUtils.smoothstep(camera.position.y, deckY - 400, deckY - 50);
      clouds.mesh.visible = wx.cloudCover > 0.05 && under > 0.01; clouds.mesh.position.set(cam.target.x, deckY, cam.target.z);
      clouds.uniforms.uTime.value += dt; clouds.uniforms.uCover.value = wx.cloudCover * under; clouds.uniforms.uDay.value = L.day; (clouds.uniforms.uTint.value as THREE.Color).copy(L.hemiSky).lerp(CLOUD_TINT, 0.5);
      rain.update(clock.elapsedTime, cam.target, Math.min(2500, cam.dist * 0.6), wx.precip === 'none' ? 0 : wx.precip === 'drizzle' ? 0.5 : 1);
      const nightAmt = 1 - L.day; nightAmtRef = nightAmt;
      for (const nh of nightHandles) nh.setNight(nightAmt);
      setModelNight(nightAmt); setSurfaceNight(nightAmt); lightMaterial.uniforms.uOpacity.value = 0.5 + 0.5 * nightAmt; lightMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      if (buildingMat) { buildingMat.emissive.setRGB(0.028 * nightAmt, 0.028 * nightAmt, 0.032 * nightAmt); (buildingMat.userData.uNight as THREE.IUniform | undefined)!.value = nightAmt; }
      for (const nm of nightMats) nm.emissive.setRGB(0.16 * nightAmt, 0.14 * nightAmt, 0.11 * nightAmt);
      buildings?.setSun(L.sunDir, L.day, wx.cloudCover);
      if (terrainUniforms) {
        terrainUniforms.uTime.value += dt; terrainUniforms.uCam.value.copy(camera.position);
        terrainUniforms.uFogNear.value = (scene.fog as THREE.Fog).near; terrainUniforms.uFogFar.value = (scene.fog as THREE.Fog).far; (terrainUniforms.uFog.value as THREE.Color).copy((scene.fog as THREE.Fog).color);
        (terrainUniforms.uLight.value as THREE.Vector3).copy(L.sunDir); (terrainUniforms.uSunColor.value as THREE.Color).copy(L.sunColor);
        terrainUniforms.uSunI.value = L.sunIntensity * cloudDim; terrainUniforms.uHemiI.value = L.hemiIntensity; terrainUniforms.uDay.value = L.day; terrainUniforms.uWet.value = wx.wet;
      }
      if (camGoal) { cam.target.lerp(camGoal, Math.min(1, dt * 5)); if (cam.target.distanceTo(camGoal) < 2) camGoal = null; }
      if (Math.abs(cam.distGoal - cam.dist) > 0.5) {
        cam.dist += (cam.distGoal - cam.dist) * Math.min(1, dt * 10);
        if (Math.abs(cam.distGoal - cam.dist) < 0.5) cam.dist = cam.distGoal;
        if (zoomAnchor) { applyCamera(); const after = groundAt(zoomAnchor.sx, zoomAnchor.sy); if (after) { cam.target.x += zoomAnchor.ground.x - after.x; cam.target.z += zoomAnchor.ground.z - after.z; } }
      } else zoomAnchor = null;
      clampTarget();
      applyCamera(); camera.updateMatrixWorld(); applyFades(fades, cam.dist);
      if (mapLabels) { mapLabels.update(camera, cam.dist, rect.height); if (!labelsRef.current) mapLabels.group.visible = false; }
      bokeh.uniforms.uField.value.set(fieldCentre.x, fieldCentre.z, fieldR);   // full blur 1.4 km past the field (uRamp)
      const t1 = performance.now();
      composer.render();
      lastRender = now;
      // render scale from the measured frame time (not while resting: those frames are throttled on purpose)
      if (!resting && !lite && adaptive.sample(now)) applyDpr();
      const t2 = performance.now();
      stats.frames++; stats.jsMs += t1 - t0; stats.renderMs += t2 - t1;
      if (t2 - stats.at > 1000) { const secs = (t2 - stats.at) / 1000; stats.fps = stats.frames / secs; stats.js = stats.jsMs / stats.frames; stats.ms = stats.renderMs / stats.frames; stats.frames = 0; stats.jsMs = 0; stats.renderMs = 0; stats.at = t2; if (statsEl.current) statsEl.current.textContent = `${stats.fps.toFixed(0)} fps · js ${stats.js.toFixed(1)} ms · draw ${stats.ms.toFixed(1)} ms · ${renderer.info.render.calls} calls · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris · ${adaptive.dpr.toFixed(2)}x · ${preset.tier}`; }
    };
    (window as unknown as { __worldSet?: (o: { bokeh?: boolean; fxaa?: boolean; dpr?: number }) => void }).__worldSet = (o) => { if (o.bokeh != null) bokeh.enabled = o.bokeh; if (o.fxaa != null) fxaa.enabled = o.fxaa; if (o.dpr != null) { adaptive.setRange(o.dpr, o.dpr); applyDpr(); } };
    (window as unknown as { __worldStats?: () => unknown }).__worldStats = () => ({ tier: preset.tier, detected: detected.tier, gpu: detected.device.gpu, dpr: adaptive.dpr, fps: stats.fps, jsMs: stats.js, drawMs: stats.ms, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, aircraft: markers.size, models: [...markers.values()].filter(m => m.model?.visible).length, modelMeshes: [...markers.values()].filter(m => m.model?.visible).map(m => { let n = 0; m.model!.traverse(o => { if ((o as THREE.Mesh).isMesh) n++; }); return `${m.model!.userData.type ?? '?'}:${n}`; }), bokeh: bokeh.enabled, fxaa: fxaa.enabled });
    applyCamera(); frame();

    return () => {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect(); unregister();
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel); el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      for (const m of markers.values()) m.label.remove();
      for (const m of vehicles.values()) m.label.remove();
      ctl.current = null; unsubGraphics();
      // free the GPU: every geometry / material / texture built for this airport, then the context itself (a browser
      // allows only a handful of live WebGL contexts - navigating between airports must not accumulate them)
      const seen = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
      const freeTex = (v: unknown) => { const t = v as THREE.Texture; if (t?.isTexture && !seen.has(t)) { seen.add(t); t.dispose(); } };
      const freeMat = (mat: THREE.Material) => {
        if (seen.has(mat)) return; seen.add(mat);
        for (const v of Object.values(mat as unknown as Record<string, unknown>)) freeTex(v);
        for (const u of Object.values((mat as THREE.ShaderMaterial).uniforms ?? {})) freeTex(u?.value);   // atlases / textures held by shader uniforms
        mat.dispose();
      };
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); } if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) freeMat(mat); });
      scene.clear();
      world?.heightTex.dispose(); world?.landTex.dispose(); world?.fieldTex.dispose();
      for (const pass of composer.passes) pass.dispose(); composer.dispose(); rt.dispose(); renderer.dispose(); renderer.forceContextLoss();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
    };
  }, [icao, hasEngine]);

  return (
    <div className={styles.root} data-testid="world-map" data-status={status} data-standalone={standalone ? 'true' : 'false'}>
      <div ref={host} className={styles.canvasHost} data-testid="world-canvas" />
      <div ref={labels} className={styles.labels} aria-hidden="true" />
      {showStats ? <div ref={statsEl} className={styles.stats} data-testid="world-stats" /> : null}
      {tip ? <div ref={tipEl} className={styles.tip} data-testid="map-tooltip">{tip.lines.map((l, i) => <div key={i} className={i === 0 ? styles.tipHead : styles.tipLine}>{l}</div>)}</div> : null}
      {menu ? (
        <div className={styles.menu} style={{ left: Math.min(menu.x, (host.current?.clientWidth ?? 800) - 240), top: Math.min(menu.y, (host.current?.clientHeight ?? 600) - 40 * (menu.rows.length + 1)) }} data-testid="world-quick-menu" role="menu" onPointerDown={(ev) => ev.stopPropagation()}>
          <div className={styles.menuHead}>{menu.callsign}</div>
          {menu.rows.length ? menu.rows.map((r) => (
            <button key={r.id} type="button" role="menuitem" className={styles.menuRow} data-testid={`ctx-${r.id}`} onClick={() => { requestOpenAction({ aircraftId: menu.id, actionId: r.id as never }); setMenu(null); }}>
              <span>{r.label}</span>{r.hotkey ? <kbd>{r.hotkey}</kbd> : null}
            </button>
          )) : <div className={styles.menuEmpty}>No actions available</div>}
        </div>
      ) : null}
      <WindChip />
      <div className={styles.toolbar} data-testid="world-toolbar" onPointerDown={(ev) => ev.stopPropagation()}>
        <Segmented ariaLabel="Time of day" small value={timeMode} onChange={pickTime} items={[{ id: 'auto', label: 'Auto', testId: 'world-time-auto' }, { id: 'day', label: 'Day', testId: 'world-time-day' }, { id: 'dusk', label: 'Dusk', testId: 'world-time-dusk' }, { id: 'night', label: 'Night', testId: 'world-time-night' }]} testId="world-time" />
        <div className={styles.toolCol}>
          <Tooltip content="Zoom in" placement="left"><IconButton size={44} variant="map" label="Zoom in" icon={<Icon name="plus" />} onClick={() => ctl.current?.zoom(0.6)} testId="world-zoom-in" /></Tooltip>
          <Tooltip content="Zoom out" placement="left"><IconButton size={44} variant="map" label="Zoom out" icon={<Icon name="minus" />} onClick={() => ctl.current?.zoom(1.6)} testId="world-zoom-out" /></Tooltip>
          <Tooltip content={following ? 'Follow off' : 'Follow selected aircraft'} placement="left"><IconButton size={44} variant="map" label="Follow selected" icon={<Icon name="locate-fixed" />} active={following} accentIcon={following} disabled={selectedId == null && !following} onClick={() => ctl.current?.follow(!following)} testId="world-follow" data-state={following ? 'on' : 'off'} /></Tooltip>
          <Tooltip content="Centre on selected" placement="left"><IconButton size={44} variant="map" label="Centre on selected" icon={<Icon name="crosshair" />} disabled={selectedId == null} onClick={() => ctl.current?.centre()} testId="world-centre" /></Tooltip>
          <Tooltip content={showLabels ? 'Hide labels' : 'Show labels'} placement="left"><IconButton size={44} variant="map" label="Labels" icon={<Icon name={showLabels ? 'eye' : 'eye-off'} />} active={showLabels} onClick={() => setShowLabels((v) => !v)} testId="world-labels" /></Tooltip>
          <Tooltip content="Reset view" placement="left"><IconButton size={44} variant="map" label="Reset view" icon={<Icon name="house" />} onClick={() => ctl.current?.reset()} testId="world-reset" /></Tooltip>
        </div>
      </div>
      {status !== 'ready' ? <div className={styles.status} data-testid="world-status">{status === 'error' ? 'World data unavailable' : 'Building the world…'}</div> : null}
      {standalone ? <div className={styles.hint}>drag · pan &nbsp; right-drag · orbit &nbsp; wheel · zoom &nbsp; Home · reset view</div> : null}
    </div>
  );
}

/** Wind + sim clock chip (top-left of the world view): direction arrow points where the wind blows TO, magnetic dir/kts as read on the ATIS. */
function WindChip() {
  const wind = useSim((s) => { try { const w = s.engine?.wx(); return w ? { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt, vis: w.visM, cloud: w.cloud, precip: w.precip } : null; } catch { return null; } }, []);
  const mag = useSim((s) => s.engine?.magVar ?? 0);
  if (!wind) return null;
  const dirMag = ((wind.dir - mag) % 360 + 360) % 360;
  return (
    <div className={styles.windChip} data-testid="world-wind">
      <span className={styles.windArrow} style={{ transform: `rotate(${wind.dir + 180}deg)` }} aria-hidden="true">↑</span>
      <span className={styles.windText}>{String(Math.round(dirMag)).padStart(3, '0')}° · {Math.round(wind.kts)}{wind.gust ? `G${Math.round(wind.gust)}` : ''} kt</span>
      <span className={styles.windMeta}>{wind.vis >= 10000 ? '10 km+' : `${(wind.vis / 1000).toFixed(1)} km`} · {wind.cloud}{wind.precip !== 'none' ? ` · ${wind.precip}` : ''}</span>
    </div>
  );
}
