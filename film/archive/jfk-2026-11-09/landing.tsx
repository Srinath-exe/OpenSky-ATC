// OpenATC landing film: JFK at dusk, from the radar scope down the ILS to the gate and back up to the scope.
// Every value is a function of the frame (scene.js); the page scrubs these frames with the scroll.
import React from "react";
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from "raea";
import { Canvas3D, Entity, Instances, Model, ShaderMesh } from "raea/3d";
import { Transform, Quat } from "raea/transform";
import { Camera3d } from "raea/camera";
import { AmbientLight, DirectionalLight, PointLight } from "raea/light";
import { Mesh3d, Sphere, Cuboid, BufferMesh } from "raea/mesh";
import { StandardMaterial } from "raea/pbr";
import { Bloom, Grade, ToneMapping } from "raea/post_process";
import { LinearRgba, Srgba } from "raea/color";
import J from "./jfk.json";
import { makeScene, W, H, FPS, N, clamp, smooth, lerp } from "./scene.js";

const S = makeScene(J as any);
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);
type V3 = [number, number, number];

// ---------------- ground: one shader over the whole region ----------------
const GROUND = /* wgsl */ `
fn h2(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn line(d: f32, w: f32) -> f32 { return 1.0 - smoothstep(0.0, w, abs(d)); }
fn shade(in: VertexOutput) -> vec4<f32> {
  let p = in.world_position.xz;
  let cam = view.world_position;
  let dist = length(in.world_position.xyz - cam);
  // region: water, coast, roads
  let ruv = (p - u_rmin()) / (u_rmax() - u_rmin());
  let rg = textureSample(tex_rg, samp_rg, ruv);
  let water = rg.r;
  let fwW = max(fwidth(water), 0.002);
  let coast = 1.0 - smoothstep(0.0, fwW * 1.6, abs(water - 0.5));
  let mag = length(fwidth(ruv)) * 2048.0;          // region texels per pixel: < 0.5 means magnified (blurry)
  var c = mix(vec3<f32>(0.010, 0.011, 0.014), vec3<f32>(0.0015, 0.004, 0.010), smoothstep(0.3, 0.7, water));
  // dusk sky reflected on the water, brighter toward the sunset (west-north-west)
  let toP = normalize(in.world_position.xyz - cam);
  let sunDir = normalize(vec2<f32>(-0.93, -0.36));
  let refl = pow(max(0.0, dot(normalize(toP.xz), sunDir)), 6.0) * (1.0 - abs(toP.y));
  c += smoothstep(0.3, 0.7, water) * refl * vec3<f32>(0.05, 0.02, 0.012);
  c += coast * vec3<f32>(0.05, 0.32, 0.42) * (0.35 + 0.65 * u_scope());
  let city = u_city() * smoothstep(0.25, 0.9, mag);
  let fieldFade = smoothstep(260.0, 420.0, max(abs(p.x - 0.0), abs(p.y + 0.0)));
  c += rg.b * vec3<f32>(1.0, 0.5, 0.18) * 0.42 * city * (0.25 + 0.75 * fieldFade);
  c += rg.a * vec3<f32>(0.9, 0.55, 0.3) * 0.10 * city * fieldFade;
  // airport field (hi-res near, lo-res far)
  let fuv = (p + vec2<f32>(u_half())) / (2.0 * u_half());
  let inF = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
  let tpp = length(fwidth(fuv)) * 4096.0;
  let far = smoothstep(1.6, 4.0, tpp);
  var a = textureSample(tex_fa, samp_fa, fuv);
  let b = textureSample(tex_fb, samp_fb, fuv);
  let lo = textureSample(tex_fl, samp_fl, fuv);
  a = mix(a, lo, far);
  let rev = u_reveal() * 1.12;
  let lit = smoothstep(a.a - 0.035, a.a, rev);
  let front = exp(-abs(rev - a.a) * 38.0) * step(a.a, rev + 0.06);
  // pavement and runways
  c = mix(c, vec3<f32>(0.030, 0.029, 0.030), clamp(a.b * 2.2, 0.0, 1.0) * inF);
  c = mix(c, vec3<f32>(0.020, 0.021, 0.024), a.g * inF);
  c += b.r * (1.0 - far) * vec3<f32>(0.32, 0.33, 0.36) * inF * (0.35 + 0.65 * lit);
  // apron flood light pools, warm
  c += a.b * vec3<f32>(0.20, 0.10, 0.035) * 0.75 * inF * lit * (1.0 - a.g) * (0.5 + 0.5 * smoothstep(600.0, 80.0, length(p - u_twr())));
  // taxiway centrelines, green; the reveal wave runs white along the network
  let tl = mix(smoothstep(0.30, 0.85, a.r), a.r, far) * inF;
  let rib = u_ribbon();
  c += tl * vec3<f32>(0.06, 0.95, 0.38) * lit * (1.0 + far * 0.8) * (1.0 - rib);
  c += lo.r * inF * vec3<f32>(0.02, 0.24, 0.10) * rib * smoothstep(0.04, 0.35, tpp);
  c += tl * vec3<f32>(1.6, 1.9, 1.7) * front * 2.5;
  c += a.b * inF * front * vec3<f32>(0.25, 0.6, 0.45) * 0.6;
  // stop bars red, lead-in lines yellow
  c += b.g * (1.0 - far) * vec3<f32>(2.4, 0.12, 0.08) * inF * lit;
  c += b.a * (1.0 - far) * vec3<f32>(0.55, 0.42, 0.06) * inF * lit;
  // ---- radar scope ----
  let sc = u_scope();
  let ctr = vec2<f32>(0.0, 0.0);
  let rr = length(p - ctr);
  let fw = max(fwidth(rr), 0.5);
  let ringP = abs(fract(rr / 926.0 + 0.5) - 0.5) * 926.0;
  let rings = line(ringP, fw * 1.4) * step(rr, 4630.0);
  let ang = atan2(p.x - ctr.x, -(p.y - ctr.y));
  let spokeP = abs(fract(ang / 0.5235988 + 0.5) - 0.5) * 0.5235988 * rr;
  let spokes = line(spokeP, fw * 1.1) * smoothstep(300.0, 600.0, rr) * step(rr, 4630.0);
  var dlt = u_sweep() - ang; dlt = dlt - floor(dlt / 6.2831853) * 6.2831853;
  let sweep = exp(-dlt * 2.2) * step(rr, 4630.0) * smoothstep(40.0, 200.0, rr);
  let phos = vec3<f32>(0.20, 1.0, 0.55);
  let sw = u_sweepk();
  c += sc * (rings * 0.42 + spokes * 0.08) * phos;
  c += sw * exp(-dlt * 6.0) * step(rr, 4630.0) * smoothstep(40.0, 200.0, rr) * phos * 0.06;
  c += sw * line(dlt * rr, fw * 1.6) * phos * 0.7 * step(rr, 4630.0);
  // final approach course: flowing dashes into 31R, and the localiser feather
  let rel = p - u_thr();
  let along = dot(rel, u_crs());
  let across = dot(rel, vec2<f32>(-u_crs().y, u_crs().x));
  let fc = u_course();
  let fwa = max(fwidth(across), 0.3);
  let onCourse = line(across, fwa * 1.6) * step(0.0, along) * step(along, 2800.0);
  let dash = step(0.45, fract((along + u_flow()) / 46.0));
  c += fc * onCourse * dash * vec3<f32>(0.25, 0.85, 1.6);
  let fe = line(abs(across) - along * 0.035, fwa * 1.4) * step(60.0, along) * step(along, 2800.0);
  c += fc * fe * vec3<f32>(0.06, 0.25, 0.4);
  // radio: a ring rolling out from the tower
  let wv = u_wave();
  if (wv >= 0.0) {
    let tr = length(p - u_twr());
    let R1 = wv * 1400.0; let R2 = max(0.0, wv - 0.45) * 1400.0;
    let fwt = max(fwidth(tr), 0.4);
    c += line(tr - R1, fwt * 3.0 + 2.0) * vec3<f32>(1.6, 0.9, 0.3) * (1.0 - wv);
    c += line(tr - R2, fwt * 3.0 + 2.0) * vec3<f32>(0.3, 0.9, 1.6) * (1.0 - wv) * step(0.45, wv);
  }
  // sectors: tower 5 NM, approach 13 NM
  let sx = u_sectors();
  let s1 = line(rr - 926.0, fw * 2.2);
  let s2 = line(rr - 2408.0, fw * 2.2);
  c += sx * (s1 * vec3<f32>(1.8, 0.75, 0.25) + s2 * vec3<f32>(0.3, 0.9, 1.8));
  c += sx * (step(rr, 926.0) * vec3<f32>(0.022, 0.009, 0.002) + step(926.0, rr) * step(rr, 2408.0) * vec3<f32>(0.002, 0.006, 0.016));
  // distance haze toward the horizon colour
  let haze = 1.0 - exp(-max(0.0, dist - 1200.0) / 4200.0);
  c = mix(c, vec3<f32>(0.020, 0.016, 0.030), haze * 0.8);
  return vec4<f32>(c, 1.0);
}`;

const SKY = /* wgsl */ `
fn shade(in: VertexOutput) -> vec4<f32> {
  let d = normalize(in.world_position.xyz - view.world_position);
  let e = d.y;
  let sunDir = normalize(vec3<f32>(-0.93, 0.0, -0.36));
  let toward = max(0.0, dot(normalize(vec3<f32>(d.x, 0.0, d.z)), sunDir));
  var c = mix(vec3<f32>(0.020, 0.016, 0.030), vec3<f32>(0.0012, 0.0018, 0.0050), smoothstep(-0.01, 0.30, e));
  c += vec3<f32>(0.22, 0.095, 0.035) * pow(toward, 6.0) * exp(-max(e, 0.0) * 30.0);
  c += vec3<f32>(0.035, 0.015, 0.03) * pow(toward, 2.0) * exp(-max(e, 0.0) * 9.0);
  return vec4<f32>(c, 1.0);
}`;

// soft additive beam (landing lights), radio shells, sector walls
const BEAM = /* wgsl */ `
fn shade(in: VertexOutput) -> vec4<f32> {
  let v = normalize(view.world_position - in.world_position.xyz);
  let n = normalize(in.world_normal);
  let edge = pow(abs(dot(v, n)), 2.0);
  let dd = length(in.world_position.xyz - u_apex());
  let fall = exp(-dd / u_len()) * (1.0 - smoothstep(0.55, 0.95, dd / 26.0));
  let side = 1.0 - smoothstep(0.6, 0.9, abs(dot(n, u_axis())));
  let a = edge * fall * side * u_gain();
  return vec4<f32>(u_col().rgb * a, a);
}`;
const SHELL = /* wgsl */ `
fn shade(in: VertexOutput) -> vec4<f32> {
  let v = normalize(view.world_position - in.world_position.xyz);
  let n = normalize(in.world_normal);
  let rim = pow(1.0 - abs(dot(v, n)), 7.0);
  let a = rim * u_gain();
  return vec4<f32>(u_col().rgb * a, a);
}`;
const WALL = /* wgsl */ `
fn shade(in: VertexOutput) -> vec4<f32> {
  let y = in.world_position.y;
  let k = exp(-y / u_hgt()) * (0.35 + 0.65 * exp(-y / (u_hgt() * 0.08)));
  let band = 0.5 + 0.5 * sin(y * 0.22 - u_t() * 3.0);
  let cap = 1.0 - step(0.5, abs(in.world_normal.y));
  let a = k * u_gain() * (0.75 + 0.25 * band) * cap;
  return vec4<f32>(u_col().rgb * a, a);
}`;

// ---------------- static placements ----------------
const rw = (ref: string) => J.runways.find((r: any) => r.ref === ref)!;
function runwayLights() {
  const ON: Record<string, number> = { "13L/31R": 0.18, "04L/22R": 0.42, "13R/31L": 0.6, "04R/22L": 0.78 };
  return (J.runways as any[]).map((r) => {
    const edge: any[] = [], green: any[] = [], red: any[] = [], cl: any[] = [], tdz: any[] = [];
    const [ax, az] = r.a, [bx, bz] = r.b; const L = Math.hypot(bx - ax, bz - az); const ux = (bx - ax) / L, uz = (bz - az) / L; const nx = -uz, nz = ux; const w = r.width / 2 + 0.3;
    for (let s = 0; s <= L + 0.01; s += 6) for (const k of [-1, 1]) edge.push({ position: [ax + ux * s + nx * k * w, 0.12, az + uz * s + nz * k * w] });
    for (let k = -w; k <= w; k += 0.9) { green.push({ position: [bx + nx * k, 0.12, bz + nz * k] }); green.push({ position: [ax + nx * k, 0.12, az + nz * k] }); }
    for (let k = -w; k <= w; k += 0.9) { red.push({ position: [ax - ux * 0.6 + nx * k, 0.12, az - uz * 0.6 + nz * k] }); red.push({ position: [bx + ux * 0.6 + nx * k, 0.12, bz + uz * 0.6 + nz * k] }); }
    if (r.ref === "13L/31R" || r.ref === "13R/31L") {
      for (let s = 1.5; s < L; s += 1.5) cl.push({ position: [bx - ux * s, 0.08, bz - uz * s] });
      if (r.ref === "13L/31R") for (let s = 3; s < 90; s += 3) for (const k of [-1, 1]) for (const j of [0.55, 0.8, 1.05]) tdz.push({ position: [bx - ux * s + nx * k * j, 0.08, bz - uz * s + nz * k * j] });
    }
    return { edge, green, red, cl, tdz, on: ON[r.ref] ?? 0.5 };
  });
}
const RL = runwayLights();
// 31R approach lighting (ALSF-2): bars every 100 ft to 2400 ft, the 1000 ft crossbar, red side rows, and the sequenced flashers
const ALS = (() => {
  const { THR, o } = S; const nx = -o[1], nz = o[0]; const bars: any[] = [], reds: any[] = [], flash: V3[] = [];
  for (let d = 3.05; d <= 73.2; d += 3.05) for (const k of [-0.2, -0.1, 0, 0.1, 0.2]) bars.push({ position: [THR.x + o[0] * d + nx * k, 0.25 + d * 0.004, THR.z + o[1] * d + nz * k] });
  for (let k = -1.5; k <= 1.5; k += 0.15) bars.push({ position: [THR.x + o[0] * 30.5 + nx * k, 0.3, THR.z + o[1] * 30.5 + nz * k] });
  for (let d = 3.05; d <= 27.5; d += 3.05) for (const s of [-1, 1]) for (const k of [0.75, 0.85, 0.95]) reds.push({ position: [THR.x + o[0] * d + nx * s * k, 0.22, THR.z + o[1] * d + nz * s * k] });
  for (let d = 73.2; d >= 30.5; d -= 3.05) flash.push([THR.x + o[0] * d, 0.6 + d * 0.004, THR.z + o[1] * d]);
  return { bars, reds, flash };
})();
// PAPI, left of 31R, 300 m in
const PAPI = (() => { const { THR, dl } = S; const nx = dl[1], nz = -dl[0]; const base = [THR.x + dl[0] * 30, THR.z + dl[1] * 30]; return [0, 1, 2, 3].map((i) => [base[0] + nx * (3.3 + i * 0.9), 0.2, base[1] + nz * (3.3 + i * 0.9)] as V3); })();
const RIBBON = (() => {
  const pos: number[] = [], idx: number[] = []; const w = 0.11;
  for (const l of J.taxi_lines as number[][][]) for (let i = 0; i < l.length - 1; i++) {
    const [x0, z0] = l[i], [x1, z1] = l[i + 1]; const L = Math.hypot(x1 - x0, z1 - z0); if (L < 1e-4) continue;
    const nx = (-(z1 - z0) / L) * w, nz = ((x1 - x0) / L) * w; const b = pos.length / 3;
    pos.push(x0 + nx, 0.05, z0 + nz, x0 - nx, 0.05, z0 - nz, x1 + nx, 0.05, z1 + nz, x1 - nx, 0.05, z1 - nz);
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  return { pos, idx };
})();
const EDGE_T = (J.taxi_edge as number[][]).map((p) => ({ position: [p[0], 0.1, p[1]] as V3 }));

// parked fleet: greedy spacing, nose-wheel on the stand mark
const BUSY = new Set<string>([...J.dep_routes.map((r: any) => r.stand), ...J.arr_routes.map((r: any) => r.stand)]);
const PARK = (() => {
  const out: Record<string, any[]> = { A320: [], B738: [], B77W: [], A359: [] }; const placed: number[][] = [];
  const LEN: Record<string, number> = { A320: 3.76, B738: 3.95, B77W: 7.39, A359: 6.68 };
  let i = 0;
  for (const s of J.stands as any[]) {
    i++; if (BUSY.has(s.ref)) continue;
    const near = placed.reduce((m, q) => Math.min(m, Math.hypot(q[0] - s.p[0], q[1] - s.p[1])), 1e9);
    const h = (Math.sin(i * 12.9898) * 43758.5453) % 1; const hh = Math.abs(h);
    if (near < 4.6 || hh < 0.22) continue;
    const type = near > 7.2 && hh > 0.72 ? (hh > 0.86 ? "B77W" : "A359") : hh > 0.5 ? "B738" : "A320";
    const back = (0.5 - 0.12) * LEN[type];
    const fx = Math.sin(s.hdg), fz = -Math.cos(s.hdg);
    out[type].push({ position: [s.p[0] - fx * back, 0, s.p[1] - fz * back], rotation: [0, -s.hdg, 0], scale: [0.1, 0.1, 0.1] });
    placed.push(s.p);
  }
  return out;
})();

// Manhattan: the skyline on the horizon, north-west
const CITY = (() => {
  const KX = 111320 * Math.cos((J.lat0 * Math.PI) / 180), KY = 110574;
  const toU = (lat: number, lon: number): [number, number] => [((lon - J.lon0) * KX) / 10, (-(lat - J.lat0) * KY) / 10];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sets: Record<string, any[]> = { warm: [], cool: [], dim: [] };
  const zone = (lat: number, lon: number, a: number, b: number, n: number, hmax: number) => {
    const [cx, cz] = toU(lat, lon); const rot = (29 * Math.PI) / 180;
    for (let k = 0; k < n; k++) {
      const u = (rnd() * 2 - 1) * a, v = (rnd() * 2 - 1) * b; if ((u / a) ** 2 + (v / b) ** 2 > 1) continue;
      const x = cx + u * Math.cos(rot) + v * Math.sin(rot), z = cz - u * Math.sin(rot) + v * Math.cos(rot);
      const core = 1 - Math.hypot(u / a, v / b);
      const hgt = 4 + Math.pow(rnd(), 2.2) * hmax * (0.35 + 0.65 * core);
      const w = 1.8 + rnd() * 2.6, d = 1.8 + rnd() * 2.6;
      const set = rnd() < 0.5 ? "warm" : rnd() < 0.6 ? "cool" : "dim";
      sets[set].push({ position: [x, hgt / 2, z], rotation: [0, rot + (rnd() - 0.5) * 0.1, 0], scale: [w, hgt, d] });
    }
  };
  zone(40.7549, -73.9840, 28, 95, 420, 34);   // midtown
  zone(40.7095, -74.0105, 22, 32, 220, 30);   // downtown
  zone(40.6930, -73.9850, 40, 30, 120, 12);   // downtown Brooklyn
  zone(40.7470, -73.9440, 25, 22, 90, 16);    // Long Island City
  const one = toU(40.7130, -74.0132), esb = toU(40.7484, -73.9857);
  return { sets, one, esb };
})();

// flood lights over the aprons: the terminals' centres
const FLOODS = (J.buildings as any[]).filter((b) => b.kind === "terminal" && b.area > 60).slice(0, 8).map((b) => { const n = b.poly.length; return [b.poly.reduce((a: number, q: number[]) => a + q[0], 0) / n, b.poly.reduce((a: number, q: number[]) => a + q[1], 0) / n]; });
// buildings: terminals and hangars as extrusions (raw triangle meshes)
import { manifold, crossSection } from "raea/3d";
const BLD = (J.buildings as any[]).map((b, i) => {
  const cs = crossSection.polygon(b.poly.map((q: number[]) => [q[0], -q[1]]));
  const solid = cs.extrude(b.h).rotate(-90, 0, 0);
  return { solid, i, kind: b.kind };
});

// ---------------- moving aircraft ----------------
const SPAN: Record<string, number> = { A320: 3.4, B738: 3.58, B77W: 6.48, A359: 6.48 };
const LENG: Record<string, number> = { A320: 3.76, B738: 3.95, B77W: 7.39, A359: 6.68 };
const pxLen = (s: any, cam: any) => { const d = Math.hypot(cam.eye[0] - s.x, cam.eye[1] - s.y, cam.eye[2] - s.z); return (LENG[s.type] / d) / ((cam.fov * Math.PI) / 180) * 900; };
function Aircraft({ s, f, camEye, px, fovDeg }: { s: any; f: number; camEye: number[]; px: number; fovDeg: number }) {
  const q = Quat.fromEuler("YXZ", -s.hdg, s.pitch, -s.bank);
  const t = Transform.fromXyz(s.x, s.y + 0.02, s.z).withRotation(q);
  const sp = SPAN[s.type] / 2, ln = LENG[s.type];
  const dist = Math.hypot(camEye[0] - s.x, camEye[1] - s.y, camEye[2] - s.z);
  const near = smooth(2.5, 7, px);
  const blink = (period: number, phase: number, on = 1) => ((f + phase) % period) < on;
  const strobe = blink(9, (s.id.length * 3) % 9) ? 1 : 0;
  const beacon = blink(12, (s.id.length * 5) % 12, 2) ? 1 : 0.06;
  const landing = s.kind === "arr" ? (s.ft < 9000 ? 1 : 0) : s.leg === 2 ? (s.ft < 9000 ? 1 : 0) : 0;
  const minR = dist * 0.0011 * (fovDeg / 40);
  const L = (name: string, p: V3, hex: string, k: number, r: number) => (
    <Mesh3d name={`${s.id}-${name}`} transform={Transform.fromXyz(p[0], p[1], p[2]).withScale(r < 0.001 ? 0.0001 : Math.max(r, minR))}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(hex, Math.max(0, k))} /></Mesh3d>
  );
  const lk = px > 1.2;
  const nl = Math.max(near, smooth(1.2, 3, px));
  return (
    <Entity transform={t}>
      {near > 0.01 ? <Model name={`m-${s.id}`} src={staticFile(`${s.type}.glb`)} scale={0.1} /> : null}
      {lk ? L("navL", [-sp, 0.28, 0.05], "#ff2a1a", 9 * nl, 0.09) : null}
      {lk ? L("navR", [sp, 0.28, 0.05], "#1aff5a", 9 * nl, 0.09) : null}
      {lk ? L("tail", [0, 0.9, ln * 0.5], "#ffffff", 4 * nl, 0.07) : null}
      {lk ? L("strL", [-sp - 0.02, 0.28, 0.07], "#ffffff", 40 * strobe * nl, 0.12 * strobe + 0.0001) : null}
      {lk ? L("strR", [sp + 0.02, 0.28, 0.07], "#ffffff", 40 * strobe * nl, 0.12 * strobe + 0.0001) : null}
      {lk ? L("bcn", [0, ln * 0.09 + 0.55, 0], "#ff1a10", 26 * beacon * nl, 0.1) : null}
      {lk && landing ? L("llL", [-0.55, 0.32, -ln * 0.22], "#fff4e0", 30 * nl, 0.11) : null}
      {lk && landing ? L("llR", [0.55, 0.32, -ln * 0.22], "#fff4e0", 30 * nl, 0.11) : null}
    </Entity>
  );
}

// the landing-light beam: a long cone from the nose, forward and a little down
function Beam({ s, gain }: { s: any; gain: number }) {
  const fwd: V3 = [Math.sin(s.hdg), 0, -Math.cos(s.hdg)];
  const pitch = s.pitch - 0.07;
  const dir: V3 = [fwd[0] * Math.cos(pitch), Math.sin(pitch), fwd[2] * Math.cos(pitch)];
  const ln = LENG[s.type];
  const apex: V3 = [s.x + fwd[0] * ln * 0.3, s.y + 0.3, s.z + fwd[2] * ln * 0.3];
  const H = 26; const mid: V3 = [apex[0] + dir[0] * H / 2, apex[1] + dir[1] * H / 2, apex[2] + dir[2] * H / 2];
  // cone primitive points +y with its apex at +H/2: turn +y onto -dir
  const yaw = Math.atan2(-dir[0], -dir[2]);
  const tilt = Math.acos(clamp(-dir[1], -1, 1));
  const q = Quat.fromEuler("YXZ", yaw, tilt, 0);
  return (
    <Entity transform={Transform.fromXyz(...mid).withRotation(q)}>
      <ShaderMesh name={`beamm-${s.id}`} shape={{ primitive: "Cone", radius: 4.2, height: H }} wgsl={BEAM} alpha="add" doubleSided
        uniforms={{ apex, axis: dir, len: 7, gain: gain * 0.32, col: [1.0, 0.92, 0.8, 1] }} />
    </Entity>
  );
}

function FilmAt({ f }: { f: number }) {
  const cam = S.camera(f);
  const k = S.knobs(f);
  const ac = S.aircraftAt(f);
  const camH = cam.eye[1];
  const ribbon = k.reveal > 0.95 && camH < 420;
  const closeK = 1 - smooth(140, 520, camH);            // close views: show the small lights
  const r = J.region;
  const flow = (f * 6) % 46;
  // rabbit: one comet down the flashers every 6 frames
  const ph = ((f % 6) / 6) * (ALS.flash.length + 4) - 2;
  const heroS = S.heroAt(f);
  const shell = f >= 362 && f < 412 ? (f - 362) / 50 : -1;
  const twr: V3 = [S.tower.x, 9.2, S.tower.z];
  return (
    <AbsoluteFill style={{ background: "#07080d" }}>
      <Canvas3D>
        <Camera3d transform={Transform.fromXyz(cam.eye[0], cam.eye[1], cam.eye[2]).lookingAt(cam.tgt as V3)} projection={{ Perspective: { fov: (cam.fov * Math.PI) / 180, near: 0.4, far: 30000 } }} />
        <ToneMapping mode="aces" exposure={0.3} />
        <Bloom intensity={0.5} threshold={0.6} />
        <Grade vignette={{ intensity: 0.32, radius: 0.8, smoothness: 0.6 }} saturation={1.08} />
        <AmbientLight brightness={55} color="#7f8fb8" />
        <DirectionalLight transform={Transform.fromXyz(-930, 240, -360).lookingAt([0, 0, 0])} illuminance={500} color="#ffb490" />
        <DirectionalLight transform={Transform.fromXyz(400, 800, 600).lookingAt([0, 0, 0])} illuminance={420} color="#8aa6ff" />
        {heroS && f > 200 && f < 330 ? <PointLight transform={Transform.fromXyz(heroS.x + 6, heroS.y + 8, heroS.z + 4)} intensity={2.5e6} range={60} color="#c9d6ff" /> : null}

        <ShaderMesh name="sky" shape={{ primitive: "Sphere", radius: 14000 }} position={[cam.eye[0], 0, cam.eye[2]]} wgsl={SKY} doubleSided />
        <ShaderMesh name="ground" shape={{ primitive: "Rectangle", half_size: [(r.maxX - r.minX) / 2 + 3000, (r.maxZ - r.minZ) / 2 + 3000] }}
          position={[(r.maxX + r.minX) / 2, 0, (r.maxZ + r.minZ) / 2]} rotation={[-Math.PI / 2, 0, 0]} wgsl={GROUND}
          uniforms={{ rmin: [r.minX, r.minZ], rmax: [r.maxX, r.maxZ], half: J.field.half, reveal: k.reveal, scope: clamp(k.scope), sweep: k.sweep, sweepk: k.sweepk,
            course: k.course * smooth(160, 420, camH), flow, ribbon: ribbon ? 1 : 0, thr: [S.THR.x, S.THR.z], crs: [S.o[0], S.o[1]], wave: k.wave, twr: [S.tower.x, S.tower.z], sectors: k.sectors, city: k.city * (0.3 + 0.7 * smooth(60, 320, camH)) }}
          textures={{ fa: staticFile("fieldA.png"), fb: staticFile("fieldB.png"), fl: staticFile("fieldLo.png"), rg: staticFile("region.png") }} />

        {/* runway and approach lighting: each runway snaps on as the reveal wave reaches it */}
        {RL.map((r, i) => (k.reveal > r.on ? (
          <React.Fragment key={`rwl${i}`}>
            <Instances name={`rw-edge${i}`} at={r.edge}><Sphere radius={0.06} /><StandardMaterial base_color="#000000" emissive={glow("#fff1d6", 12)} /></Instances>
            <Instances name={`rw-green${i}`} at={r.green}><Sphere radius={0.07} /><StandardMaterial base_color="#000000" emissive={glow("#29ff7a", 12)} /></Instances>
            <Instances name={`rw-red${i}`} at={r.red}><Sphere radius={0.07} /><StandardMaterial base_color="#000000" emissive={glow("#ff2a1a", 12)} /></Instances>
            {r.cl.length ? <Instances name={`rw-cl${i}`} at={r.cl}><Sphere radius={0.04} /><StandardMaterial base_color="#000000" emissive={glow("#ffffff", 8)} /></Instances> : null}
            {r.tdz.length && camH < 260 ? <Instances name={`rw-tdz${i}`} at={r.tdz}><Sphere radius={0.04} /><StandardMaterial base_color="#000000" emissive={glow("#ffffff", 9)} /></Instances> : null}
          </React.Fragment>
        ) : null))}
        {ribbon ? <Mesh3d name="taxi-ribbon"><BufferMesh positions={RIBBON.pos} indices={RIBBON.idx} /><StandardMaterial base_color="#000000" emissive={glow("#2dff8c", 2.0)} double_sided /></Mesh3d> : null}
        {k.reveal > 0.55 && camH < 320 ? <Instances name="tw-edge" at={EDGE_T}><Sphere radius={0.045} /><StandardMaterial base_color="#000000" emissive={glow("#3d6bff", 14)} /></Instances> : null}
        {k.reveal > 0.2 ? <Instances name="als" at={ALS.bars}><Sphere radius={0.055} /><StandardMaterial base_color="#000000" emissive={glow("#fff3dc", 13)} /></Instances> : null}
        {k.reveal > 0.2 ? <Instances name="als-red" at={ALS.reds}><Sphere radius={0.05} /><StandardMaterial base_color="#000000" emissive={glow("#ff2010", 12)} /></Instances> : null}
        {ALS.flash.map((p, i) => {
          const b = Math.exp(-((i - ph) ** 2) / 1.4) * k.reveal;
          return <Mesh3d key={`rab${i}`} name={`rab${i}`} transform={Transform.fromXyz(p[0], p[1], p[2]).withScale(0.06 + 0.14 * b)}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow("#e8f0ff", 0.2 + 60 * b)} /></Mesh3d>;
        })}
        {PAPI.map((p, i) => {
          const above = heroS ? heroS.y - (Math.hypot(heroS.x - S.THR.x, heroS.z - S.THR.z) - 30) * S.GS : 0;
          const white = i < 2 ? true : above > (i === 2 ? -0.2 : 0.2) ? true : false;
          return <Mesh3d key={`papi${i}`} name={`papi${i}`} transform={Transform.fromXyz(p[0], p[1], p[2])}><Sphere radius={0.09} /><StandardMaterial base_color="#000000" emissive={glow(white ? "#ffffff" : "#ff2a1a", 14 * k.reveal * closeK + 0.01)} /></Mesh3d>;
        })}

        {camH < 260 && k.reveal > 0.6 ? FLOODS.map((q, i) => <PointLight key={`fl${i}`} transform={Transform.fromXyz(q[0], 6, q[1])} intensity={9e6} range={45} color="#ffb877" />) : null}
        {/* terminals and hangars */}
        {BLD.map((b) => (
          <Mesh3d key={`b${b.i}`} name={`bld${b.i}`} shape={b.solid}><StandardMaterial base_color={b.kind === "terminal" ? "#3b4250" : "#2c313a"} perceptual_roughness={0.8} emissive={glow("#9fb4ff", 0.02)} /></Mesh3d>
        ))}
        {/* the control tower */}
        <Entity transform={Transform.fromXyz(S.tower.x, 0, S.tower.z)}>
          <Mesh3d name="tw-shaft" transform={Transform.fromXyz(0, 4.3, 0)}><Cuboid half_size={[0.55, 4.3, 0.55]} /><StandardMaterial base_color="#c9ccd2" perceptual_roughness={0.6} /></Mesh3d>
          <Mesh3d name="tw-cab" transform={Transform.fromXyz(0, 9.1, 0).withRotation(Quat.fromEuler("YXZ", Math.PI / 8, 0, 0))}><Cuboid half_size={[1.25, 0.5, 1.25]} /><StandardMaterial base_color="#0a1a1a" emissive={glow("#62ffd7", 1.6)} perceptual_roughness={0.2} /></Mesh3d>
          <Mesh3d name="tw-roof" transform={Transform.fromXyz(0, 9.7, 0).withRotation(Quat.fromEuler("YXZ", Math.PI / 8, 0, 0))}><Cuboid half_size={[1.45, 0.1, 1.45]} /><StandardMaterial base_color="#d9dbe0" /></Mesh3d>
          <Mesh3d name="tw-mast" transform={Transform.fromXyz(0, 10.6, 0)}><Cuboid half_size={[0.05, 0.8, 0.05]} /><StandardMaterial base_color="#888888" /></Mesh3d>
          <Mesh3d name="tw-bcn" transform={Transform.fromXyz(0, 11.45, 0)}><Sphere radius={0.12} /><StandardMaterial base_color="#000000" emissive={glow("#ff1a10", f % 14 < 3 ? 40 : 2)} /></Mesh3d>
        </Entity>

        {/* parked fleet */}
        {Object.entries(PARK).map(([type, at]) => (at.length ? <Instances key={`park-${type}`} name={`park-${type}`} src={staticFile(`${type}.glb`)} at={at} /> : null))}

        {/* the skyline */}
        <Instances name="city-warm" at={CITY.sets.warm}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#05060a" emissive={glow("#ffb36b", 0.55)} /></Instances>
        <Instances name="city-cool" at={CITY.sets.cool}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#05060a" emissive={glow("#bcd2ff", 0.45)} /></Instances>
        <Instances name="city-dim" at={CITY.sets.dim}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#05060a" emissive={glow("#ffd9a8", 0.18)} /></Instances>
        <Mesh3d name="one-wtc" transform={Transform.fromXyz(CITY.one[0], 27, CITY.one[1])}><Cuboid half_size={[2.2, 27, 2.2]} /><StandardMaterial base_color="#05060a" emissive={glow("#cfe0ff", 0.8)} /></Mesh3d>
        <Mesh3d name="one-wtc-spire" transform={Transform.fromXyz(CITY.one[0], 58, CITY.one[1])}><Sphere radius={0.8} /><StandardMaterial base_color="#000" emissive={glow("#ffffff", 25)} /></Mesh3d>
        <Mesh3d name="esb" transform={Transform.fromXyz(CITY.esb[0], 22, CITY.esb[1])}><Cuboid half_size={[2.4, 22, 2.4]} /><StandardMaterial base_color="#05060a" emissive={glow("#ffd27a", 0.7)} /></Mesh3d>
        <Mesh3d name="esb-top" transform={Transform.fromXyz(CITY.esb[0], 46, CITY.esb[1])}><Cuboid half_size={[0.9, 2.2, 0.9]} /><StandardMaterial base_color="#000" emissive={glow("#ffb347", 14)} /></Mesh3d>

        {/* traffic */}
        {ac.map((s) => <Aircraft key={s.id} s={s} f={f} camEye={cam.eye} px={pxLen(s, cam)} fovDeg={cam.fov} />)}
        {ac.filter((s) => s.y > 0.5 || s.kind === "arr").map((s) => {
          const d = Math.hypot(cam.eye[0] - s.x, cam.eye[1] - s.y, cam.eye[2] - s.z);
          const far = 1 - smooth(9, 18, pxLen(s, cam));
          const scope = camH > 900;
          const col = s.kind === "arr" ? "#5cffb0" : "#ffb35c";
          const r = d * (scope ? 0.0034 : 0.0024) * (cam.fov / 40);
          return far > 0.01 ? <Mesh3d key={`blip-${s.id}`} name={`blip-${s.id}`} transform={Transform.fromXyz(s.x, s.y, s.z).withScale(r * far)}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(col, scope ? 7 : 10)} /></Mesh3d> : null;
        })}
        {S.AC.flatMap((acd) => {
          const tr = S.trailAt(acd, f);
          return tr.map((p: any, i: number) => {
            const d = Math.hypot(cam.eye[0] - p.x, cam.eye[1] - p.y, cam.eye[2] - p.z);
            const fade = (1 - i / (tr.length + 1)) * smooth(200, 700, d) * smooth(160, 320, camH);
            const col = acd.kind === "arr" ? "#5cffb0" : "#ffb35c";
            return fade > 0.02 ? <Mesh3d key={`tr-${acd.id}-${i}`} name={`tr-${acd.id}-${i}`} transform={Transform.fromXyz(p.x, p.y, p.z).withScale(d * 0.0017 * fade * (cam.fov / 40))}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(col, 4 * fade)} /></Mesh3d> : null;
          });
        })}
        {ac.filter((s) => (s.kind === "arr" && s.ft < 9000 && s.ft > 0 || (s.kind === "arr" && s.leg === 0 && s.kt > 40)) || (s.kind === "dep" && s.leg === 2)).map((s) => {
          const d = Math.hypot(cam.eye[0] - s.x, cam.eye[1] - s.y, cam.eye[2] - s.z);
          const g = smooth(3, 9, pxLen(s, cam));
          return g > 0.02 ? <Beam key={`beam-${s.id}`} s={s} gain={g} /> : null;
        })}

        {camH > 120 && f < 236 ? ac.filter((s) => s.y > 2).map((s) => {
          const d = Math.hypot(cam.eye[0] - s.x, cam.eye[1] - s.y, cam.eye[2] - s.z);
          const w = d * 0.0007 * (cam.fov / 40); const col = s.kind === "arr" ? "#5cffb0" : "#ffb35c";
          const kk = smooth(120, 260, camH) * (1 - smooth(1500, 2600, camH));
          return kk > 0.02 ? (
            <React.Fragment key={`stalk-${s.id}`}>
              <Mesh3d name={`stalk-${s.id}`} transform={Transform.fromXyz(s.x, s.y / 2, s.z).withScale([w, s.y / 2, w])}><Cuboid half_size={[1, 1, 1]} /><StandardMaterial base_color="#000000" emissive={glow(col, 1.6 * kk)} /></Mesh3d>
              <Mesh3d name={`foot-${s.id}`} transform={Transform.fromXyz(s.x, 0.2, s.z).withScale([w * 5, 0.05, w * 5])}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(col, 3 * kk)} /></Mesh3d>
            </React.Fragment>
          ) : null;
        }) : null}
        {/* sectors: tower and approach airspace walls */}
        {k.sectors > 0.01 ? (
          <>
            <ShaderMesh name="sec-twr" shape={{ primitive: "Cylinder", radius: 926, half_height: 60 }} position={[0, 60, 0]} wgsl={WALL} alpha="add" doubleSided uniforms={{ hgt: 40, gain: 0.10 * k.sectors, col: [1.0, 0.55, 0.2, 1], t: f * 0.1 }} />
            <ShaderMesh name="sec-app" shape={{ primitive: "Cylinder", radius: 2408, half_height: 180 }} position={[0, 180, 0]} wgsl={WALL} alpha="add" doubleSided uniforms={{ hgt: 120, gain: 0.07 * k.sectors, col: [0.25, 0.65, 1.0, 1], t: f * 0.1 }} />
          </>
        ) : null}
      </Canvas3D>
    </AbsoluteFill>
  );
}

function Film() { return <FilmAt f={useCurrentFrame()} />; }
// a contact sheet of chosen frames, without working out every frame before them
const PROBE = [160, 176, 186, 196, 206, 216, 226, 345, 390, 400, 452, 479];
function Probe() { return <FilmAt f={PROBE[Math.min(PROBE.length - 1, useCurrentFrame())]} />; }
registerRoot(() => (
  <>
    <Composition id="landing" component={Film} width={W} height={H} fps={FPS} durationInFrames={N} />
    <Composition id="probe" component={Probe} width={W / 2} height={H / 2} fps={FPS} durationInFrames={PROBE.length} />
  </>
));
