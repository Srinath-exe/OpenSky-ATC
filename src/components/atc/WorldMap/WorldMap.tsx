'use client'
/*
  WorldMap — the procedural 3D airport map (KSFO first). Terrain, water, roads, buildings and the airport are generated
  from baked data (scripts/bake_world.py) and shaded live; the sim's traffic is placed on the surface. Tilted game camera
  (drag = pan, right-drag / Alt-drag = orbit, wheel = zoom), depth-of-field + vignette grade, hover / click selection wired
  to the store like the 2D ground view.
*/
import * as React from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import styles from './WorldMap.module.css';
import { sim, useSim } from '../simStore';
import type { AircraftState } from '@/lib/sim/types';
import { isAirborne } from '@/lib/sim/aircraft';
import { loadWorld, type World } from './world';
import { instantiate, loadAircraftModel, tint } from './models';
import { PALETTE, applyFades, buildAirport, buildBuildings, buildRoads, buildTerrain, toV3, type Fade } from './terrain';

const FT = 0.3048;
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

interface Cam { target: THREE.Vector3; dist: number; yaw: number; pitch: number }
interface Marker { mesh: THREE.Mesh; id: number; label: HTMLDivElement; shadow: THREE.Mesh; stem: THREE.Line; model: THREE.Group | null; modelWanted: boolean; tinted: string }

function aircraftGeometry(): THREE.BufferGeometry {
  // unit-length airliner silhouette in the XZ plane, nose toward -z (north); scaled per aircraft
  const s = new THREE.Shape();
  const pts: [number, number][] = [[0, -0.5], [0.06, -0.42], [0.06, -0.12], [0.5, 0.12], [0.5, 0.18], [0.07, 0.1], [0.06, 0.34], [0.22, 0.44], [0.22, 0.48], [0.02, 0.46], [0, 0.5],
    [-0.02, 0.46], [-0.22, 0.48], [-0.22, 0.44], [-0.06, 0.34], [-0.07, 0.1], [-0.5, 0.18], [-0.5, 0.12], [-0.06, -0.12], [-0.06, -0.42]];
  s.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);        // shape y -> -z (nose north)
  return g;
}

export function WorldMap({ standalone = false }: { standalone?: boolean }) {
  const host = React.useRef<HTMLDivElement>(null);
  const labels = React.useRef<HTMLDivElement>(null);
  const icao = useSim((s) => s.icao);
  const hasEngine = useSim((s) => !!s.engine);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [tip, setTip] = React.useState<{ x: number; y: number; text: string } | null>(null);

  React.useEffect(() => {
    const el = host.current; const e = sim.engine;
    if (!el || !e || !icao) return;
    let disposed = false;
    // lite: test mode / software GL — smaller mesh, no depth-of-field, 1x pixels (the look is unchanged, only the cost)
    const lite = sim.testMode || /[?&]lite=1/.test(window.location.search);
    const renderer = new THREE.WebGLRenderer({ antialias: !lite, powerPreference: 'high-performance' });
    renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(PALETTE.bg);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.bg);
    scene.fog = new THREE.Fog(PALETTE.bg, 9000, 32000);   // rescaled with the camera distance every frame (terrain shader mirrors it)
    const camera = new THREE.PerspectiveCamera(48, 1, 20, 80000);
    const cam: Cam = { target: new THREE.Vector3(0, 0, 0), dist: 5200, yaw: -0.35, pitch: 0.95 };
    scene.add(new THREE.HemisphereLight(0xbfc7d1, 0x1a1c1a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.2); sun.position.set(-5000, 6000, 5000); scene.add(sun);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bokeh = new BokehPass(scene, camera, { focus: 5200, aperture: 0.00002, maxblur: 0.008 });
    if (!lite) composer.addPass(bokeh);
    const grade = new ShaderPass(GRADE); composer.addPass(grade);
    composer.addPass(new OutputPass());

    const markers = new Map<number, Marker>();
    const acGeo = aircraftGeometry();
    const matPlane = new THREE.MeshLambertMaterial({ color: 0xf2f2ef, emissive: 0x202020 });
    const matSel = new THREE.MeshLambertMaterial({ color: PALETTE.orange, emissive: 0x3a2008 });
    const matGhost = new THREE.MeshLambertMaterial({ color: 0x9a9c9a, emissive: 0x151515 });
    const traffic = new THREE.Group(); scene.add(traffic);
    const shadowGeo = new THREE.CircleGeometry(0.5, 24); shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
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
    const routeMat = new LineMaterial({ color: 0xffffff, linewidth: 3, transparent: true, opacity: 0.9, dashed: false });
    let route: Line2 | null = null;
    let terrainUniforms: Record<string, THREE.IUniform> | null = null;
    let world: World | null = null;
    const fades: Fade[] = [];
    const raycaster = new THREE.Raycaster();

    const airCenter = { lat: e.air.center.lat, lng: e.air.center.lng };
    loadWorld(icao, airCenter.lat, airCenter.lng).then((w) => {
      if (disposed) return;
      world = w;
      const field = [...e.air.nodes.values()].map(nd => w.toLocal(nd.lng, nd.lat));
      w.flatten(field, 120);
      const t = buildTerrain(w, lite ? 192 : 512); terrainUniforms = t.uniforms; scene.add(t.mesh);
      scene.add(buildRoads(w, fades));
      scene.add(buildBuildings(w));
      scene.add(buildAirport(w, e.air, fades));
      cam.target.set(0, w.heightAt(0, 0), 0);
      setStatus('ready');
    }).catch((err) => { console.error(err); setStatus('error'); });

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
      routeMat.resolution.set(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(el);

    // ground point under a screen position (ray vs the height field, iterative)
    const groundAt = (sx: number, sy: number): THREE.Vector3 | null => {
      const r = el.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1), camera);
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      if (!world) { if (d.y >= 0) return null; return o.clone().addScaledVector(d, -o.y / d.y); }
      let t = 0; const step = 25;
      for (let i = 0; i < 4000; i++) {
        const p = o.clone().addScaledVector(d, t);
        const h = world.heightAt(p.x, -p.z);
        if (p.y <= h) { const q = o.clone().addScaledVector(d, Math.max(0, t - step / 2)); q.y = h; return q; }
        if (p.y > 3000 && d.y >= 0) return null;
        t += step * (1 + t / 4000);
      }
      return null;
    };
    const pick = (sx: number, sy: number): number | null => {
      const r = el.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1), camera);
      raycaster.params.Line = { threshold: 1 };
      const hits = raycaster.intersectObjects(traffic.children, true);
      for (const h of hits) { let o: THREE.Object3D | null = h.object; while (o && o.userData.id == null) o = o.parent; if (o && o.visible && o.userData.id != null) return o.userData.id as number; }
      // generous pick: nearest marker within 18 px
      let best: number | null = null, bd = 18;
      for (const m of markers.values()) {
        const v = m.mesh.position.clone().project(camera);
        const px = (v.x + 1) / 2 * r.width, py = (1 - v.y) / 2 * r.height;
        const d = Math.hypot(px - (sx - r.left), py - (sy - r.top));
        if (d < bd) { bd = d; best = m.id; }
      }
      return best;
    };

    // ── pointer ──
    let drag: { mode: 'pan' | 'orbit'; x: number; y: number; moved: boolean; start: THREE.Vector3 | null } | null = null;
    const onDown = (ev: PointerEvent) => {
      el.setPointerCapture(ev.pointerId);
      const orbit = ev.button === 2 || ev.altKey || ev.ctrlKey;
      drag = { mode: orbit ? 'orbit' : 'pan', x: ev.clientX, y: ev.clientY, moved: false, start: orbit ? null : groundAt(ev.clientX, ev.clientY) };
    };
    const onMove = (ev: PointerEvent) => {
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.mode === 'orbit') { cam.yaw -= dx * 0.005; cam.pitch = Math.min(1.45, Math.max(0.3, cam.pitch + dy * 0.004)); drag.x = ev.clientX; drag.y = ev.clientY; }
        else if (drag.start) { const g = groundAt(ev.clientX, ev.clientY); if (g) { cam.target.x += drag.start.x - g.x; cam.target.z += drag.start.z - g.z; } }
        follow = false; camGoal = null;
        return;
      }
      const id = pick(ev.clientX, ev.clientY);
      sim.hover(id);
      if (id != null) {
        const a = e.byId(id); const r = el.getBoundingClientRect();
        if (a) setTip({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: `${a.callsign} · ${a.perf.icaoCode}${isAirborne(a) ? ` · ${Math.round(a.altitude / 100) * 100} ft` : ` · ${Math.round(a.speed)} kt`}` });
        el.style.cursor = 'pointer';
      } else { setTip(null); el.style.cursor = drag ? 'grabbing' : 'grab'; }
    };
    const onUp = (ev: PointerEvent) => {
      if (drag && !drag.moved && ev.button === 0) { const id = pick(ev.clientX, ev.clientY); sim.select(id); if (id != null) follow = false; }
      drag = null;
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const before = groundAt(ev.clientX, ev.clientY);
      cam.dist = Math.min(38000, Math.max(250, cam.dist * Math.exp(ev.deltaY * 0.0012)));
      applyCamera();
      const after = groundAt(ev.clientX, ev.clientY);
      if (before && after) { cam.target.x += before.x - after.x; cam.target.z += before.z - after.z; }
    };
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === 'INPUT') return;
      if (ev.key === 'Home') { cam.target.set(0, world?.heightAt(0, 0) ?? 0, 0); cam.dist = 5200; cam.yaw = -0.35; cam.pitch = 0.95; }
    };
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', onKey);
    let follow = false;

    // projector for the test API / centre-on
    const unregister = sim.registerProjector('ground',
      (xy) => { const v = toV3(xy.x, xy.y, world?.heightAt(xy.x, xy.y) ?? 0).project(camera); const r = el.getBoundingClientRect(); return v.z > 1 ? null : { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height }; },
      (xy) => { camGoal = new THREE.Vector3(xy.x, world?.heightAt(xy.x, xy.y) ?? 0, -xy.y); },
      () => ({ lng: 0, lat: 0, zoom: Math.log2(40000 / cam.dist) + 10 }) as never,
      { size: () => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; } } as never);

    // ── frame loop ──
    let raf = 0; const clock = new THREE.Clock();
    const tmp = new THREE.Vector3();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = clock.getDelta();
      const eng = sim.engine; if (!eng) return;
      // traffic sync
      const live = new Set<number>();
      for (const a of eng.aircraft) {
        live.add(a.id);
        let m = markers.get(a.id);
        if (!m) {
          const mesh = new THREE.Mesh(acGeo, matPlane); mesh.userData.id = a.id;
          const label = document.createElement('div'); label.className = styles.label; labels.current?.appendChild(label);
          const shadow = new THREE.Mesh(shadowGeo, shadowMat); decor.add(shadow);
          const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), stemMat); decor.add(stem);
          m = { mesh, id: a.id, label, shadow, stem, model: null, modelWanted: false, tinted: '' }; markers.set(a.id, m); traffic.add(mesh);
        }
        const air = isAirborne(a);
        const ground = world ? world.heightAt(a.pos.x, a.pos.y) : 0;
        const h = air ? Math.max(a.altitude * FT, ground + 2) : ground + 1.2;
        m.mesh.position.set(a.pos.x, h, -a.pos.y);
        const len = a.perf.lengthMeters, span = a.perf.wingspanMeters;
        const scale = Math.max(1, cam.dist / 2600);            // keep symbols legible when zoomed out
        m.mesh.scale.set(span * scale, 1, len * scale);
        m.mesh.rotation.y = -a.heading * Math.PI / 180;
        // ground shadow (softens with height) + a thin stem from an airborne aircraft down to the ground
        m.shadow.position.set(a.pos.x, ground + 0.4, -a.pos.y);
        const sh = air ? Math.max(0.8, 1 + (h - ground) / 600) : 1.05;
        m.shadow.scale.set(span * scale * sh, 1, len * scale * sh);
        (m.shadow.material as THREE.MeshBasicMaterial).opacity = air ? Math.max(0.05, 0.3 - (h - ground) / 6000) : 0.35;
        m.stem.visible = air; if (air) { m.stem.position.set(a.pos.x, ground, -a.pos.y); m.stem.scale.y = Math.max(1, h - ground); }
        m.mesh.material = a.id === sim.selectedId ? matSel : a.onFrequency === sim.position || sim.position === 'ground' ? matPlane : matGhost;
        // real model (lazy per type); the silhouette stays as the far-zoom symbol and the pick target
        if (!m.modelWanted) {
          m.modelWanted = true; const mk = m;
          loadAircraftModel(a.perf.icaoCode).then((mdl) => { if (!mdl || disposed || !markers.has(mk.id)) return; mk.model = instantiate(mdl, a.perf.lengthMeters); mk.model.userData.id = mk.id; traffic.add(mk.model); });
        }
        if (m.model) {
          const useModel = cam.dist < 6500;
          m.model.visible = useModel; m.mesh.visible = !useModel;
          m.model.position.copy(m.mesh.position); m.model.rotation.y = m.mesh.rotation.y;
          const state = a.id === sim.selectedId ? 'sel' : a.id === sim.hoveredId ? 'hover' : '';
          if (state !== m.tinted) { tint(m.model, state === 'sel' ? PALETTE.orange : state === 'hover' ? new THREE.Color(0x404040) : null); m.tinted = state; }
        }
        // label
        tmp.copy(m.mesh.position).project(camera);
        const r = el.getBoundingClientRect();
        if (tmp.z > 1 || tmp.x < -1.1 || tmp.x > 1.1 || tmp.y < -1.1 || tmp.y > 1.1) m.label.style.display = 'none';
        else {
          m.label.style.display = '';
          m.label.style.transform = `translate(${((tmp.x + 1) / 2 * r.width + 14).toFixed(1)}px, ${((1 - tmp.y) / 2 * r.height - 10).toFixed(1)}px)`;
          const alt = air ? `${Math.round(a.altitude / 100)}` : `${Math.round(a.speed)}kt`;
          const txt = `${a.callsign} · ${a.perf.icaoCode} · ${alt}`;
          if (m.label.textContent !== txt) m.label.textContent = txt;
          m.label.dataset.selected = a.id === sim.selectedId ? 'true' : 'false';
          m.label.dataset.hover = a.id === sim.hoveredId ? 'true' : 'false';
        }
      }
      for (const [id, m] of markers) if (!live.has(id)) { traffic.remove(m.mesh); if (m.model) traffic.remove(m.model); decor.remove(m.shadow); decor.remove(m.stem); m.stem.geometry.dispose(); m.label.remove(); markers.delete(id); }
      // vehicles (only when away from the station, so the map stays calm)
      const liveV = new Set<string>();
      let fleet: Array<{ id: string; type: string; state: string; pos: { x: number; y: number }; heading: number }> = [];
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
        tmp.copy(m.mesh.position).project(camera); const r = el.getBoundingClientRect();
        if (tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) m.label.style.display = 'none';
        else { m.label.style.display = ''; m.label.style.transform = `translate(${((tmp.x + 1) / 2 * r.width + 10).toFixed(1)}px, ${((1 - tmp.y) / 2 * r.height - 8).toFixed(1)}px)`; const t = `${v.id} · ${v.state.replace('_', ' ')}`; if (m.label.textContent !== t) m.label.textContent = t; }
      }
      for (const [id, m] of vehicles) if (!liveV.has(id)) { vehGroup.remove(m.mesh); m.label.remove(); vehicles.delete(id); }
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
      const fogNear = cam.dist * 1.6, fogFar = cam.dist * 5.5;
      (scene.fog as THREE.Fog).near = fogNear; (scene.fog as THREE.Fog).far = fogFar;
      if (terrainUniforms) { terrainUniforms.uTime.value += dt; terrainUniforms.uCam.value.copy(camera.position); terrainUniforms.uFogNear.value = fogNear; terrainUniforms.uFogFar.value = fogFar; }
      if (camGoal) { cam.target.lerp(camGoal, Math.min(1, dt * 5)); if (cam.target.distanceTo(camGoal) < 2) camGoal = null; }
      clampTarget();
      applyCamera(); applyFades(fades, cam.dist);
      (bokeh.uniforms as Record<string, THREE.IUniform>).focus.value = cam.dist;
      (bokeh.uniforms as Record<string, THREE.IUniform>).maxblur.value = 0.006 + Math.min(0.006, cam.dist / 4e6);
      composer.render();
    };
    applyCamera(); frame();

    return () => {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect(); unregister();
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      for (const m of markers.values()) m.label.remove();
      for (const m of vehicles.values()) m.label.remove();
      renderer.dispose(); composer.dispose(); if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
      world?.heightTex.dispose(); world?.landTex.dispose();
    };
  }, [icao, hasEngine]);

  return (
    <div className={styles.root} data-testid="world-map" data-status={status} data-standalone={standalone ? 'true' : 'false'}>
      <div ref={host} className={styles.canvasHost} data-testid="world-canvas" />
      <div ref={labels} className={styles.labels} aria-hidden="true" />
      {tip ? <div className={styles.tip} style={{ transform: `translate(${tip.x + 14}px, ${tip.y + 16}px)` }} data-testid="map-tooltip">{tip.text}</div> : null}
      {status !== 'ready' ? <div className={styles.status} data-testid="world-status">{status === 'error' ? 'World data unavailable' : 'Building the world…'}</div> : null}
      {standalone ? <div className={styles.hint}>drag · pan &nbsp; right-drag · orbit &nbsp; wheel · zoom &nbsp; Home · reset view</div> : null}
    </div>
  );
}
