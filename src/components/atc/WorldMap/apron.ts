/*
  Apron detail for the procedural world: stand markings (lead-in, stop bar, envelope, number), jet bridges from the
  terminal piers to the gates, static ground equipment, and the floating taxiway / runway name labels.
  three.js frame: x = east, y = up, z = -north (metres).
*/
import * as THREE from 'three';
import type { World } from './world';
import type { OsmAirport, OsmStand } from '@/lib/osmAirport';
import { PALETTE, apronMaterial, mergeGeometries, plateGeometry, ribbon, textAtlas, toV3, type Fade } from './terrain';

/** Parked-aircraft envelope per ICAO stand code (wingspan × length, m). */
const ENVELOPE: Record<string, [number, number]> = { A: [15, 13], B: [24, 24], C: [36, 40], D: [52, 56], E: [65, 70], F: [80, 76] };

/** forward / left unit vectors of a true heading, in the three frame */
function basis(headingDeg: number): { f: THREE.Vector3; l: THREE.Vector3 } {
  const h = headingDeg * Math.PI / 180;
  return { f: new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)), l: new THREE.Vector3(-Math.cos(h), 0, -Math.sin(h)) };
}

/** Stand markings: yellow lead-in + T stop bar, a faint white envelope around the parked aircraft, the number plate. */
export function buildStands(world: World, air: OsmAirport, base: number, fades: Fade[]): THREE.Group {
  const g = new THREE.Group(); g.name = 'stands';
  const leadPos: number[] = []; const envPos: number[] = []; const barGeos: THREE.BufferGeometry[] = []; const padGeos: THREE.BufferGeometry[] = [];
  // number plates: one atlas texture + one merged mesh for the whole airport (not a mesh and a texture per stand)
  const plateAtlas = textAtlas(air.stands.map(st => st.ref).filter((r): r is string => !!r)); const plateGeos: THREE.BufferGeometry[] = [];
  // stands drawn closer together than their code's wingspan (OSM spacing) get a narrower envelope so the boxes never overlap
  const stopsXY = air.stands.map(st => world.toLocal(st.lng, st.lat));
  const nearestM = (i: number) => { let d = Infinity; for (let j = 0; j < stopsXY.length; j++) if (j !== i) d = Math.min(d, Math.hypot(stopsXY[i].x - stopsXY[j].x, stopsXY[i].y - stopsXY[j].y)); return d; };
  for (const [i, st] of air.stands.entries()) {
    const pts = st.leadInPts.map(p => world.toLocal(p.lng, p.lat));
    for (let i = 1; i < pts.length; i++) {
      const a = toV3(pts[i - 1].x, pts[i - 1].y, base + 0.72), b = toV3(pts[i].x, pts[i].y, base + 0.72); leadPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const sp = world.toLocal(st.lng, st.lat); const stop = toV3(sp.x, sp.y, base + 0.74);
    const { f, l } = basis(st.headingIn);
    // T stop bar across the lead-in at the nose-wheel stop
    barGeos.push(ribbon(stop.clone().addScaledVector(l, -2.5), stop.clone().addScaledVector(l, 2.5), 0.5));
    // envelope: nose 4 m ahead of the stop, tail one length behind; drawn as a thin outline
    const [span0, len] = ENVELOPE[st.size] ?? ENVELOPE.C;
    const half = Math.max(8, Math.min(span0 / 2 + 2, nearestM(i) / 2 - 1.5));
    const nose = stop.clone().addScaledVector(f, 4).setY(base + 0.7), tail = stop.clone().addScaledVector(f, -(len - 2)).setY(base + 0.7);
    const c = [nose.clone().addScaledVector(l, half), nose.clone().addScaledVector(l, -half), tail.clone().addScaledVector(l, -half), tail.clone().addScaledVector(l, half)];
    for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; envPos.push(a.x, a.y, a.z, b.x, b.y, b.z); }
    // concrete pad under the envelope: gate areas read as paved even where OSM has no apron polygon (sits just below
    // the real apron slab, so it only shows where that is missing)
    padGeos.push(ribbon(nose.clone().addScaledVector(f, 4).setY(base + 0.55), tail.clone().addScaledVector(f, -4).setY(base + 0.55), half * 2 + 6));
    if (!st.ref) continue;
    // the number sits ahead of the nose, on the lead-in, so a parked aircraft never covers it
    plateGeos.push(plateGeometry(plateAtlas, st.ref, 9, 4.5, stop.clone().addScaledVector(f, 10).setY(base + 0.76), st.headingIn));
  }
  // the terminal surroundings are paved: a ~110 m buffer around every terminal outline (discs at the vertices, wide
  // ribbons along the edges, one flat mesh so the overlaps are invisible)
  const disc = new THREE.CircleGeometry(110, 24); disc.rotateX(-Math.PI / 2);
  for (const b of air.buildings) {
    if (b.kind !== 'terminal') continue;
    const poly = b.polygon.map(p => { const q = world.toLocal(p.lng, p.lat); return toV3(q.x, q.y, base + 0.55); });
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const d = disc.clone(); d.translate(a.x, a.y, a.z); const pos = d.getAttribute('position'); const uv = new Float32Array(pos.count * 2);
      for (let k = 0; k < pos.count; k++) { uv[k * 2] = pos.getX(k); uv[k * 2 + 1] = pos.getZ(k); } d.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); padGeos.push(d);
      if (a.distanceTo(c) > 1) padGeos.push(ribbon(a, c, 220));
    }
  }
  if (padGeos.length) { const pm = new THREE.Mesh(mergeGeometries(padGeos), apronMaterial()); pm.renderOrder = 0; g.add(pm); }
  const leadGeo = new THREE.BufferGeometry(); leadGeo.setAttribute('position', new THREE.Float32BufferAttribute(leadPos, 3));
  const leadMat = new THREE.LineBasicMaterial({ color: PALETTE.taxiLine, transparent: true, opacity: 0.75 });
  g.add(new THREE.LineSegments(leadGeo, leadMat)); fades.push({ mat: leadMat, base: 0.75, near: 600, far: 1500 });
  const envGeo = new THREE.BufferGeometry(); envGeo.setAttribute('position', new THREE.Float32BufferAttribute(envPos, 3));
  const envMat = new THREE.LineBasicMaterial({ color: 0xe8e8e4, transparent: true, opacity: 0.28 });
  g.add(new THREE.LineSegments(envGeo, envMat)); fades.push({ mat: envMat, base: 0.28, near: 350, far: 900 });
  if (barGeos.length) { const bm = new THREE.MeshBasicMaterial({ color: PALETTE.taxiLine, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }); const m = new THREE.Mesh(mergeGeometries(barGeos), bm); m.renderOrder = 3; g.add(m); fades.push({ mat: bm, base: 0.9, near: 400, far: 1100 }); }
  if (plateGeos.length) {
    const pm = new THREE.MeshBasicMaterial({ map: plateAtlas.texture, transparent: true, depthWrite: false, opacity: 0.9 });
    const plates = new THREE.Mesh(mergeGeometries(plateGeos), pm); plates.renderOrder = 4; g.add(plates);
    fades.push({ mat: pm, base: 0.9, near: 350, far: 1000 });
  }
  return g;
}

/** Nearest point on any terminal outline to p (three frame), or null when none is within maxM. */
function nearestTerminalPoint(polys: THREE.Vector3[][], p: THREE.Vector3, maxM: number): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null, bd = maxM;
  const ab = new THREE.Vector3(), ap = new THREE.Vector3(), q = new THREE.Vector3();
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    ab.subVectors(b, a); ap.subVectors(p, a);
    const t = Math.max(0, Math.min(1, ab.lengthSq() > 0 ? ap.dot(ab) / ab.lengthSq() : 0));
    q.copy(a).addScaledVector(ab, t);
    const d = q.distanceTo(p);
    if (d < bd) { bd = d; best = q.clone(); }
  }
  return best;
}

/** Jet bridges: a rotunda at the pier, a raised tunnel to the aircraft's forward-left door, a cab and a support leg. */
export function buildJetBridges(world: World, air: OsmAirport, base: number): THREE.Object3D | null {
  const polys = air.buildings.filter(b => b.kind === 'terminal').map(b => b.polygon.map(p => { const q = world.toLocal(p.lng, p.lat); return toV3(q.x, q.y, base); }));
  if (!polys.length) return null;
  const geos: THREE.BufferGeometry[] = []; const colors: number[] = [];
  const tunnel = new THREE.Color('#c9cbc7'), cab = new THREE.Color('#a4a7a3'), leg = new THREE.Color('#6c6e6b'), glass = new THREE.Color('#5c6670');
  const box = (cx: THREE.Vector3, dir: THREE.Vector3, len: number, w: number, h: number, yBottom: number, col: THREE.Color) => {
    const geo = new THREE.BoxGeometry(w, h, len).toNonIndexed();   // non-indexed so the colour array lines up after the merge
    geo.rotateY(Math.atan2(dir.x, dir.z)); geo.translate(cx.x, yBottom + h / 2, cx.z);
    const n = geo.getAttribute('position').count; for (let i = 0; i < n; i++) colors.push(col.r, col.g, col.b);
    geos.push(geo);
  };
  let count = 0;
  for (const st of air.stands) {
    if (st.type === 'remote' || st.closed) continue;
    const sp = world.toLocal(st.lng, st.lat); const stop = toV3(sp.x, sp.y, base);
    const { f, l } = basis(st.headingIn);
    const [, len] = ENVELOPE[st.size] ?? ENVELOPE.C;
    // forward-left door: ~12 % of the length behind the nose, half a fuselage width out
    const door = stop.clone().addScaledVector(f, 4 - len * 0.12).addScaledVector(l, 2.6);
    const pier = nearestTerminalPoint(polys, door, 95);
    if (!pier) continue;
    const span = door.clone().sub(pier); let L = span.length(); if (L < 0.5) continue;
    const dir = span.clone().normalize();
    // a stop line drawn right at the pier still gets a short bridge: the rotunda then sits inside the building
    if (L < 12) { pier.copy(door).addScaledVector(dir, -12); L = 12; }
    const rot = new THREE.CylinderGeometry(2.4, 2.4, 6.2, 12).toNonIndexed(); rot.translate(pier.x + dir.x * 1.5, base + 3.1, pier.z + dir.z * 1.5);
    { const n = rot.getAttribute('position').count; for (let i = 0; i < n; i++) colors.push(cab.r, cab.g, cab.b); geos.push(rot); }
    const t0 = pier.clone().addScaledVector(dir, 3), t1 = door.clone().addScaledVector(dir, -3.2);
    const mid = t0.clone().add(t1).multiplyScalar(0.5);
    box(mid, dir, t0.distanceTo(t1), 3.2, 2.9, base + 3.6, tunnel);
    box(mid, dir, t0.distanceTo(t1) - 1.5, 3.3, 0.9, base + 4.5, glass);   // window band
    box(door.clone().addScaledVector(dir, -1.6), dir, 3.6, 3.6, 3.3, base + 3.4, cab);
    box(door.clone().addScaledVector(dir, -4.5), dir, 0.9, 0.9, 3.6, base, leg);
    box(door.clone().addScaledVector(dir, -4.5), dir, 2.2, 3.2, 0.3, base + 0.1, leg);   // wheel bogie
    if (++count > 600) break;
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos); merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true })); mesh.name = 'jetbridges';
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), new THREE.LineBasicMaterial({ color: 0x0b0b0c, transparent: true, opacity: 0.3 })));
  return mesh;
}

/** Static ground equipment around the gates (belt loader + baggage carts on the right of the nose, a tug ahead). */
export function buildGse(world: World, air: OsmAirport, base: number): THREE.Object3D | null {
  const items: { p: THREE.Vector3; dir: THREE.Vector3; size: [number, number, number]; col: THREE.Color }[] = [];
  const yellow = new THREE.Color('#c9b23a'), grey = new THREE.Color('#8b8e8a'), dark = new THREE.Color('#3f4240'), white = new THREE.Color('#d8d9d5');
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (const st of air.stands) {
    if (st.type === 'remote' || st.closed) continue;
    const sp = world.toLocal(st.lng, st.lat); const stop = toV3(sp.x, sp.y, base);
    const { f, l } = basis(st.headingIn);
    const [span, len] = ENVELOPE[st.size] ?? ENVELOPE.C;
    const r = rnd();
    // belt loader at the forward hold (right side), carts behind it, a tug parked off the nose to the right
    items.push({ p: stop.clone().addScaledVector(f, 4 - len * 0.2).addScaledVector(l, -(span * 0.16 + 4)), dir: l, size: [6.5, 2.2, 2.4], col: yellow });
    items.push({ p: stop.clone().addScaledVector(f, 4 - len * 0.3).addScaledVector(l, -(span * 0.16 + 6)), dir: f, size: [3.2, 1.7, 1.6], col: grey });
    if (r > 0.35) items.push({ p: stop.clone().addScaledVector(f, 4 - len * 0.3 - 3.8).addScaledVector(l, -(span * 0.16 + 6)), dir: f, size: [3.2, 1.7, 1.6], col: grey });
    if (r > 0.6) items.push({ p: stop.clone().addScaledVector(f, 9).addScaledVector(l, -7), dir: f, size: [4.4, 1.6, 2.4], col: dark });
    if (st.type === 'gate' && r > 0.5) items.push({ p: stop.clone().addScaledVector(f, 4 - len * 0.55).addScaledVector(l, -(span * 0.16 + 5)), dir: f, size: [5.5, 2.6, 2.4], col: white });   // catering / fuel truck
  }
  if (!items.length) return null;
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  items.forEach((it, i) => {
    q.setFromAxisAngle(up, Math.atan2(it.dir.x, it.dir.z)); s.set(it.size[1], it.size[2], it.size[0]);
    m.compose(it.p, q, s); mesh.setMatrixAt(i, m); mesh.setColorAt(i, it.col);
  });
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = 'gse'; mesh.frustumCulled = false;
  return mesh;
}

// ── floating name labels (taxiways, runway ends) ─────────────────────────────
export interface LabelHandle { group: THREE.Group; update(camera: THREE.Camera, dist: number, viewportH: number): void }


/** Draw one sign into a 2D context at (x, y); returns its width (height is SIGN_H). Yellow taxiway signs, dark runway designators. */
const SIGN_H = 80;
function signWidth(ctx: CanvasRenderingContext2D, text: string, kind: 'twy' | 'rwy'): number {
  ctx.font = `700 ${kind === 'twy' ? 58 : 50}px "DM Sans", "Helvetica Neue", Arial, sans-serif`;
  return Math.ceil(ctx.measureText(text).width + 44);
}
function drawSign(ctx: CanvasRenderingContext2D, text: string, kind: 'twy' | 'rwy', x: number, y: number, w: number): void {
  const h = SIGN_H, r = 16;
  ctx.font = `700 ${kind === 'twy' ? 58 : 50}px "DM Sans", "Helvetica Neue", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  ctx.fillStyle = kind === 'twy' ? '#f0c33c' : '#111214'; ctx.fill();
  if (kind === 'rwy') { ctx.lineWidth = 4; ctx.strokeStyle = '#e8e8e4'; ctx.stroke(); }
  ctx.fillStyle = kind === 'twy' ? '#111214' : '#f4f4f0'; ctx.fillText(text, x + w / 2, y + h / 2 + 2);
}

const SIGN_VERT = `
  attribute vec2 corner;      // -0.5..0.5 across, 0..1 up (the anchor is the bottom centre)
  attribute vec4 rect;        // atlas u0, v0, u1, v1
  attribute vec2 info;        // x: aspect (w / h), y: kind (0 taxiway, 1 runway) + rank * 8
  uniform float uK;           // world metres per pixel at unit distance (2 tan(fov/2) / viewport px)
  uniform float uStep;        // taxiway sign thinning: every uStep-th sign along a taxiway
  uniform vec3 uAlpha;        // x: taxiway signs, y: runway designators, z: short-stub taxiway signs
  varying vec2 vUv; varying float vAlpha;
  void main() {
    float kind = mod(info.y, 8.0); float rank = floor(info.y / 8.0);
    float a = kind < 0.5 ? (mod(rank, uStep) < 0.5 ? uAlpha.x : 0.0) : kind < 1.5 ? uAlpha.y : uAlpha.z;
    vAlpha = a;
    vUv = vec2(mix(rect.x, rect.z, corner.x + 0.5), mix(rect.y, rect.w, corner.y));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float h = length(mv.xyz) * uK * (kind < 1.5 && kind > 0.5 ? 24.0 : 22.0);   // 22 / 24 px tall on screen
    mv.xy += vec2(corner.x * h * info.x, corner.y * h);
    gl_Position = a < 0.01 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;   // invisible signs are clipped away
  }`;
const SIGN_FRAG = `
  uniform sampler2D uAtlas; varying vec2 vUv; varying float vAlpha;
  void main() { vec4 c = texture2D(uAtlas, vUv); gl_FragColor = vec4(c.rgb, c.a * vAlpha); if (gl_FragColor.a < 0.02) discard; }`;

/**
 * Taxiway names as yellow signs along every named taxiway (one per ~350 m of centreline, plus one near each end) and
 * runway designators at the thresholds; billboards kept at a constant screen size, hidden when zoomed far out.
 * Every sign lives in one texture atlas and one geometry: the whole set is a single draw call, billboarded, sized,
 * thinned and faded in the vertex shader.
 */
export function buildLabels(world: World, air: OsmAirport, base: number): LabelHandle {
  const group = new THREE.Group(); group.name = 'labels';
  const signs: { text: string; kind: 'twy' | 'rwy'; pos: THREE.Vector3; rank: number; stub: boolean }[] = [];
  let curStub = false;
  const add = (text: string, kind: 'twy' | 'rwy', pos: THREE.Vector3, rank = 0) => { signs.push({ text, kind, pos, rank, stub: kind === 'twy' && curStub }); };
  const xy = (id: string) => { const n = air.nodes.get(id)!; return world.toLocal(n.lng, n.lat); };
  // walk each taxiway's edges; drop a sign wherever the running length passes a multiple of 350 m, plus at the start
  for (const name of air.taxiwayNames) {
    const ids = air.taxiwayNodes.get(name); if (!ids || !ids.length) continue;
    const seen = new Set<string>(); const placed: THREE.Vector3[] = [];
    // short stubs (a named link of < 300 m - Dubai has a hundred of them) only get their sign close in
    { let total = 0; const s2 = new Set<string>();
      for (const id of ids) { const n = air.nodes.get(id); if (!n) continue; for (const e of n.edges) { if (e.type !== 'taxiway' || e.leadIn || e.taxiway !== name) continue; const key = n.id < e.to ? `${n.id}|${e.to}` : `${e.to}|${n.id}`; if (s2.has(key)) continue; s2.add(key); const a = xy(n.id), b = xy(e.to); total += Math.hypot(a.x - b.x, a.y - b.y); } }
      curStub = total < 300; }
    // rank = order along the taxiway; when zoomed out only every 2nd / 4th sign is shown (the first always is)
    const tryPlace = (p: THREE.Vector3) => { if (placed.some(q => q.distanceTo(p) < 300)) return; add(name, 'twy', p.clone().setY(base + 6), placed.length); placed.push(p); };
    for (const id of ids) {
      const n = air.nodes.get(id); if (!n) continue;
      for (const e of n.edges) {
        if (e.type !== 'taxiway' || e.leadIn || e.taxiway !== name) continue;
        const key = n.id < e.to ? `${n.id}|${e.to}` : `${e.to}|${n.id}`; if (seen.has(key)) continue; seen.add(key);
        const a = xy(n.id), b = xy(e.to); const va = toV3(a.x, a.y, base), vb = toV3(b.x, b.y, base);
        const L = va.distanceTo(vb); if (L < 40) continue;
        const steps = Math.max(1, Math.round(L / 350));
        for (let k = 1; k <= steps; k++) tryPlace(va.clone().lerp(vb, (k - 0.5) / steps));
      }
    }
    // short taxiways (all edges < 40 m, e.g. a single stub) still get one sign at their first node
    if (!placed.length) { const p = xy(ids[0]); add(name, 'twy', toV3(p.x, p.y, base + 6)); }
  }
  for (const r of air.runways) for (const end of r.ends) {
    const p = world.toLocal(end.lng, end.lat);
    add(end.name, 'rwy', toV3(p.x, p.y, base + 10));
  }
  const material = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: null }, uK: { value: 0.001 }, uStep: { value: 1 }, uAlpha: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: SIGN_VERT, fragmentShader: SIGN_FRAG, transparent: true, depthTest: false, depthWrite: false,
  });
  if (signs.length) {
    // atlas: one row per unique sign, packed left to right, wrapped at 2048 px
    const measure = document.createElement('canvas').getContext('2d')!;
    const unique = new Map<string, { w: number; x: number; y: number }>();
    let x = 0, y = 0; const ATLAS_W = 2048;
    for (const sg of signs) {
      const key = `${sg.kind}:${sg.text}`; if (unique.has(key)) continue;
      const w = signWidth(measure, sg.text, sg.kind);
      if (x + w > ATLAS_W) { x = 0; y += SIGN_H + 4; }
      unique.set(key, { w, x, y }); x += w + 4;
    }
    const atlasH = THREE.MathUtils.ceilPowerOfTwo(y + SIGN_H + 4);
    const c = document.createElement('canvas'); c.width = ATLAS_W; c.height = atlasH; const ctx = c.getContext('2d')!;
    for (const [key, u] of unique) { const [kind, ...rest] = key.split(':'); drawSign(ctx, rest.join(':'), kind as 'twy' | 'rwy', u.x, u.y, u.w); }
    const atlas = new THREE.CanvasTexture(c); atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 4; atlas.minFilter = THREE.LinearFilter; atlas.generateMipmaps = false;
    material.uniforms.uAtlas.value = atlas;
    const n = signs.length;
    const pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), rect = new Float32Array(n * 16), info = new Float32Array(n * 8); const index = new Uint32Array(n * 6);
    signs.forEach((sg, i) => {
      const u = unique.get(`${sg.kind}:${sg.text}`)!;
      const u0 = u.x / ATLAS_W, u1 = (u.x + u.w) / ATLAS_W, v1 = 1 - u.y / atlasH, v0 = 1 - (u.y + SIGN_H) / atlasH;   // canvas y grows down, texture v grows up
      const kindRank = (sg.kind === 'rwy' ? 1 : sg.stub ? 2 : 0) + sg.rank * 8, aspect = u.w / SIGN_H;
      const cs: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      for (let k = 0; k < 4; k++) {
        pos.set([sg.pos.x, sg.pos.y, sg.pos.z], (i * 4 + k) * 3); corner.set(cs[k], (i * 4 + k) * 2);
        rect.set([u0, v0, u1, v1], (i * 4 + k) * 4); info.set([aspect, kindRank], (i * 4 + k) * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('rect', new THREE.BufferAttribute(rect, 4)); geo.setAttribute('info', new THREE.BufferAttribute(info, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geo, material); mesh.frustumCulled = false; mesh.renderOrder = 20; group.add(mesh);
  }
  const update = (camera: THREE.Camera, dist: number, viewportH: number) => {
    // taxiway signs show from ~5 km in, runway names from ~14 km; both fade over the last stretch
    const twyA = 1 - THREE.MathUtils.smoothstep(dist, 3600, 5200), rwyA = 1 - THREE.MathUtils.smoothstep(dist, 11000, 15000), stubA = 1 - THREE.MathUtils.smoothstep(dist, 900, 1300);
    group.visible = rwyA > 0.01;
    const pxH = viewportH || 800;
    material.uniforms.uK.value = (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov ?? 48) * Math.PI / 360)) / pxH;   // world metres per pixel at unit distance
    material.uniforms.uStep.value = dist < 1500 ? 1 : dist < 2800 ? 2 : 4;
    (material.uniforms.uAlpha.value as THREE.Vector3).set(twyA * 0.95, rwyA * 0.95, stubA * 0.95);
  };
  return { group, update };
}
