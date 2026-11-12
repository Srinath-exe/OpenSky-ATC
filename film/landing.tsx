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
import { makeScene, W, H, FPS, N, SUB, clamp, smooth, lerp, LEN, SPAN, WB } from "./scene.js";
import { AIRPORTS } from "./airports.js";
const APT = AIRPORTS[(J as any).icao || "KJFK"];

const S = makeScene(J as any);
const ST: any = (J as any).story;
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);
type V3 = [number, number, number];

// ---------------- ground: one shader over the whole region ----------------
const GROUND = /* wgsl */ `
fn h2(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn line(d: f32, w: f32) -> f32 { return 1.0 - smoothstep(0.0, w, abs(d)); }
fn vnoise(x: vec2<f32>) -> f32 {
  let i = floor(x); let f = fract(x); let k = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2<f32>(1.0, 0.0)), k.x), mix(h2(i + vec2<f32>(0.0, 1.0)), h2(i + vec2<f32>(1.0, 1.0)), k.x), k.y);
}
// coverage of [a, b] at x, box-filtered over w (thin bands fade instead of flickering)
fn band(x: f32, a: f32, b: f32, w: f32) -> f32 { return clamp(min(x - a, b - x) / w + 0.5, 0.0, 1.0) * clamp((b - a) / w, 0.0, 1.0); }
// a light point: o is the world offset from the light, inv maps it to pixels, r its radius in pixels
fn spot(o: vec2<f32>, inv: mat2x2<f32>, r: f32) -> f32 { let q = inv * o; return exp(-dot(q, q) / (r * r)); }
// the nearest of a row of lights along a runway (local along/across sa, ta): its glow and its own place along
fn rowS(sa: f32, ta: f32, s0: f32, s1: f32, sp: f32, t0: f32, u: vec2<f32>, n: vec2<f32>, inv: mat2x2<f32>, r: f32) -> vec2<f32> {
  let k = clamp(round((sa - s0) / sp), 0.0, floor((s1 - s0) / sp + 0.001)); let sl = s0 + k * sp;
  return vec2<f32>(spot(u * (sa - sl) + n * (ta - t0), inv, r), sl);
}
// the nearest of a row of lights across a runway at sx, from t0 toward t1 every sp (sp signed)
fn rowT(sa: f32, ta: f32, t0: f32, t1: f32, sp: f32, sx: f32, u: vec2<f32>, n: vec2<f32>, inv: mat2x2<f32>, r: f32) -> f32 {
  let k = clamp(round((ta - t0) / sp), 0.0, floor((t1 - t0) / sp + 0.001)); let tl = t0 + k * sp;
  return spot(u * (sa - sx) + n * (ta - tl), inv, r);
}
struct Rw { surf: vec4<f32>, glow: vec3<f32> };
// runway i's (half width, flags, designator cell, lights on), unpacked
fn rwB(i: i32) -> vec4<f32> {
  let pc = u_rcell()[i];
  return vec4<f32>(floor(pc / 8.0) / 1000.0, select(0.0, 3.0, abs(u_k4().z - f32(i)) < 0.5), pc % 8.0, u_ron()[i]);
}
// one runway, A = (start x, z, end x, z) in the direction it is used, B = (half width, flags 1 TDZ + 2 ALSF-2, the start's
// designator cell, lights on): its pavement, markings and designators, and its lights, coloured as a pilot sees them
fn runway(p: vec2<f32>, cp: vec3<f32>, dx: vec2<f32>, dy: vec2<f32>, inv: mat2x2<f32>, wpp: f32, dist: f32, A: vec4<f32>, B: vec4<f32>, light: vec3<f32>, rab: f32) -> Rw {
  var o: Rw; o.surf = vec4<f32>(0.0); o.glow = vec3<f32>(0.0);
  let dv = A.zw - A.xy; let L = length(dv);
  if (L < 1.0) { return o; }
  let u = dv / L; let n = vec2<f32>(-u.y, u.x);
  let q = p - A.xy; let sa = dot(q, u); let ta = dot(q, n);
  let hw = B.x;
  let mg = 8.0 * wpp + 0.5;
  if (sa < -78.0 - mg || sa > L + 1.0 + mg || abs(ta) > hw + 1.6 + mg) { return o; }
  let ws = max(abs(dot(dx, u)) + abs(dot(dy, u)), 1e-4); let wt = max(abs(dot(dx, n)) + abs(dot(dy, n)), 1e-4);
  let inRw = band(sa, 0.0, L, ws) * band(ta, -hw, hw, wt);
  if (inRw > 0.0) {
    let fromA = sa < L * 0.5;
    let se = select(L - sa, sa, fromA); let te = select(-ta, ta, fromA); let at = abs(te);
    var paint = 0.0;
    let m = fract((sa - 11.0) / 6.1) * 6.1;
    paint = max(paint, band(ta, -0.046, 0.046, wt) * band(m, 0.0, 3.66, ws) * step(11.0, se));
    paint = max(paint, band(abs(ta), hw - 0.12, hw - 0.03, wt));
    let kk = clamp(round((at - 0.26) / 0.35), 0.0, 7.0); let cc = 0.26 + 0.35 * kk;
    paint = max(paint, band(at, cc - 0.0875, cc + 0.0875, wt) * band(se, 0.6, 5.2, ws));
    paint = max(paint, band(at, 1.1, 2.0, wt) * band(se, 31.1, 35.7, ws));
    let gi = round(se / 15.24);
    var nb = 0.0;
    if (gi == 1.0) { nb = 3.0; } else if (gi == 3.0 || gi == 4.0) { nb = 2.0; } else if (gi == 5.0 || gi == 6.0) { nb = 1.0; }
    let g0 = gi * 15.24;
    let bk = clamp(round((at - 1.19) / 0.33), 0.0, max(nb - 1.0, 0.0)); let bc = 1.19 + 0.33 * bk;
    paint = max(paint, step(0.5, nb) * band(at, bc - 0.09, bc + 0.09, wt) * band(se, g0, g0 + 2.29, ws));
    let cy = (se - 5.8) / 4.4; let cx = 0.5 + te / 3.0;
    if (cy > 0.0 && cy < 1.0 && cx > 0.0 && cx < 1.0) {
      let ci = select(B.z + 1.0 - 2.0 * (B.z % 2.0), B.z, fromA);
      let d = (textureSampleLevel(tex_rg, samp_rg, vec2<f32>((ci + cx) / 8.0, (1.0 - cy) * 376.0 / 2048.0), 0.0).g - 0.5) * 0.5;
      paint = max(paint, clamp(d / max(wt, 0.004) + 0.5, 0.0, 1.0));
    }
    let fine = 1.0 - smoothstep(0.03, 0.15, wt);
    let wear = vnoise(vec2<f32>(sa * 0.11, ta * 1.3));
    let rub = band(abs(ta), 0.2, 0.9, 0.25) * band(se, 9.0, 95.0, 6.0) * (0.55 + 0.45 * vnoise(vec2<f32>(sa * 0.6, ta * 5.0))) * fine;
    var alb = vec3<f32>(0.060, 0.061, 0.064) * (0.88 + 0.24 * wear * fine) * (1.0 - 0.5 * rub);
    alb = mix(alb, vec3<f32>(0.66, 0.66, 0.64), paint * 0.94 * (1.0 - 0.35 * rub));
    o.surf = vec4<f32>(alb * light, inRw);
  }
  // ---- lights ----
  let on = B.w;
  if (on <= 0.001) { return o; }
  let hv = normalize(p - cp.xz + vec2<f32>(1e-4, 0.0));
  let al = dot(hv, u);
  let r0 = clamp(0.05 / wpp, 1.05, 3.0);
  var g = vec3<f32>(0.0);
  let warm = vec3<f32>(1.0, 0.82, 0.55); let amber = vec3<f32>(1.0, 0.58, 0.12); let red = vec3<f32>(1.0, 0.09, 0.04); let grn = vec3<f32>(0.12, 1.0, 0.36);
  let ed = rowS(sa, ta, 0.0, L, 6.0, select(-(hw + 0.15), hw + 0.15, ta > 0.0), u, n, inv, r0);
  g += ed.x * select(warm, amber, select(ed.y, L - ed.y, al > 0.0) < 61.0) * 7.0;
  let cl = rowS(sa, ta, 1.5, L - 1.5, 1.5, 0.06, u, n, inv, r0 * 0.8);
  let toE = select(cl.y, L - cl.y, al > 0.0);
  let odd = (round(cl.y / 1.5) % 2.0) > 0.5;
  let clc = select(select(vec3<f32>(1.0, 0.9, 0.74), red, odd && toE < 91.4), red, toE < 30.5);
  g += cl.x * clc * 4.0 * smoothstep(0.1, 0.45, abs(al));
  let th0 = rowT(sa, ta, -hw, hw, 0.3, 0.0, u, n, inv, r0 * 0.9);
  let th1 = rowT(sa, ta, -hw, hw, 0.3, L, u, n, inv, r0 * 0.9);
  g += th0 * select(red, grn, al > 0.0) * 6.0 + th1 * select(grn, red, al > 0.0) * 6.0;
  let flags = B.y;
  if ((flags % 2.0) > 0.5 && sa > 0.0 && sa < 95.0) {
    let tsel = clamp(round((abs(ta) - 1.1) / 0.15), 0.0, 2.0) * 0.15 + 1.1;
    let tz = rowS(sa, ta, 3.05, 91.44, 3.05, sign(ta) * tsel, u, n, inv, r0 * 0.75);
    g += tz.x * vec3<f32>(1.0, 0.92, 0.8) * 3.5 * smoothstep(0.0, 0.35, al);
  }
  if (flags >= 2.0 && sa < 1.0) {
    let face = smoothstep(-0.1, 0.5, al);
    let ka = clamp(round(-sa / 3.05), 1.0, 24.0);
    let tn = clamp(round(ta / 0.105), -2.0, 2.0) * 0.105;
    var w = spot(u * (sa + ka * 3.05) + n * (ta - tn), inv, r0);
    w = max(w, rowT(sa, ta, -1.5, 1.5, 0.15, -30.48, u, n, inv, r0));
    let sg = select(-1.0, 1.0, ta > 0.0);
    w = max(w, rowT(sa, ta, sg * 0.45, sg * 0.97, sg * 0.105, -15.24, u, n, inv, r0));
    let kr = clamp(round(-sa / 3.05), 1.0, 9.0); let tr = sg * (clamp(round((abs(ta) - 1.1) / 0.15), 0.0, 2.0) * 0.15 + 1.1);
    let rr = spot(u * (sa + kr * 3.05) + n * (ta - tr), inv, r0 * 0.9);
    let kf = clamp(round(-sa / 3.05), 10.0, 24.0); let kn = 24.0 - rab * 15.0;
    let fl = spot(u * (sa + kf * 3.05 - 0.45) + n * ta, inv, r0 * 1.7) * exp(-(kf - kn) * (kf - kn) / 0.5);
    g += (vec3<f32>(1.0, 0.9, 0.74) * w * 6.5 + red * rr * 5.0 + vec3<f32>(0.85, 0.92, 1.0) * fl * 30.0) * face;
  }
  o.glow = g * on * mix(1.0, 0.45, smoothstep(60.0, 1800.0, dist));
  return o;
}
fn shade(in: VertexOutput) -> vec4<f32> {
  let p = in.world_position.xz;
  let dpx = dpdx(p); let dpy = dpdy(p);
  let det = dpx.x * dpy.y - dpy.x * dpx.y;
  let sdet = select(det, 1e-9, abs(det) < 1e-9);
  let inv = mat2x2<f32>(vec2<f32>(dpy.y, -dpx.y) / sdet, vec2<f32>(-dpy.x, dpx.x) / sdet);
  let wpp = sqrt(abs(det));
  let cam = view.world_position;
  let dist = length(in.world_position.xyz - cam);
  // region: water, coast, roads
  let ruv = (p - u_reg().xy) / (u_reg().zw - u_reg().xy);
  let inR = step(0.0, ruv.x) * step(ruv.x, 1.0) * step(0.0, ruv.y) * step(ruv.y, 1.0);
  let rg = textureSample(tex_rg, samp_rg, clamp(ruv, vec2<f32>(0.001), vec2<f32>(0.999))) * inR;
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
  c += coast * vec3<f32>(0.05, 0.32, 0.42) * (0.35 + 0.65 * u_k0().y) * (0.15 + 0.85 * u_k4().w);
  let city = u_k2().y * smoothstep(0.25, 0.9, mag);
  let fieldFade = smoothstep(260.0, 420.0, max(abs(p.x - 0.0), abs(p.y + 0.0)));
  c += rg.b * vec3<f32>(1.0, 0.5, 0.18) * 0.42 * city * (0.25 + 0.75 * fieldFade);
  c += rg.a * vec3<f32>(0.9, 0.55, 0.3) * 0.10 * city * fieldFade;
  // airport field (hi-res near, lo-res far)
  let fuv = (p + vec2<f32>(u_k2().z)) / (2.0 * u_k2().z);
  let inF = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
  let tpp = length(fwidth(fuv)) * 4096.0;
  let far = smoothstep(1.6, 4.0, tpp);
  let a0 = textureSample(tex_fa, samp_fa, fuv);
  let b = textureSample(tex_fb, samp_fb, fuv);
  let lo = textureSample(tex_fl, samp_fl, fuv);
  let a = mix(a0, lo, far);
  let rev = u_k0().x * 1.12;
  let lit = smoothstep(a.a - 0.035, a.a, rev);
  let front = exp(-abs(rev - a.a) * 38.0) * step(a.a, rev + 0.06);
  let rib = u_k1().z;
  // light on the ground: the night, the apron floods, the landing lights of the hero and of the departure
  let fl = b.b * inF * lit * u_k3().x;
  var light = vec3<f32>(0.34, 0.35, 0.40) + vec3<f32>(1.0, 0.87, 0.70) * fl * 2.9;
  let L1 = u_ll1(); let r1 = p - L1.xy; let a1 = dot(r1, L1.zw); let t1 = abs(dot(r1, vec2<f32>(-L1.w, L1.z)));
  light += vec3<f32>(1.0, 0.94, 0.84) * u_k3().y * smoothstep(0.5, 5.0, a1) * exp(-a1 / 42.0) * exp(-pow(t1 / (0.7 + a1 * 0.17), 2.0)) * 5.0;
  let L2 = u_ll2(); let r2 = p - L2.xy; let a2 = dot(r2, L2.zw); let t2 = abs(dot(r2, vec2<f32>(-L2.w, L2.z)));
  light += vec3<f32>(1.0, 0.94, 0.84) * u_k3().z * smoothstep(0.5, 5.0, a2) * exp(-a2 / 42.0) * exp(-pow(t2 / (0.7 + a2 * 0.17), 2.0)) * 5.0;
  // pavement: concrete, the aprons a little lighter; crisp edges from the distance field near, the soft mask far
  let dP = (b.r - 0.5) * 32.0; let dA = (a0.g - 0.5) * 32.0;
  let pav = mix(clamp(dP / max(fwidth(dP), 0.02) + 0.5, 0.0, 1.0), clamp(a.b * 2.2, 0.0, 1.0), far) * inF;
  let apr = clamp(dA / max(fwidth(dA), 0.02) + 0.5, 0.0, 1.0) * (1.0 - far) * inF;
  let gn = vnoise(p * 0.21) * 0.6 + vnoise(p * 0.9) * 0.4;
  let albP = mix(vec3<f32>(0.074, 0.076, 0.080), vec3<f32>(0.100, 0.101, 0.103), apr) * (0.85 + 0.3 * gn * (1.0 - far));
  c = mix(c, albP * light, pav);
  c += (1.0 - pav) * inF * vec3<f32>(0.016, 0.018, 0.012) * (light - vec3<f32>(0.34, 0.35, 0.40));
  // paint: taxiway centrelines, holding positions, stand lead-ins (thin ribbons take over close up)
  let paintY = vec3<f32>(0.50, 0.38, 0.08);
  let tl = mix(smoothstep(0.55, 0.92, a.r), a.r, far) * inF;
  let mapK = u_k4().w;
  c += tl * mix(paintY * light * 0.55 * (1.0 - rib), vec3<f32>(0.26, 0.31, 0.37) * 1.8, far * mapK) * lit * mix(1.0, 0.35, far * (1.0 - mapK));
  c += b.g * (1.0 - far) * paintY * light * 0.5 * inF * lit * (1.0 - rib);
  c += b.a * (1.0 - far) * paintY * light * 0.45 * inF * lit * (1.0 - rib);
  c += tl * vec3<f32>(1.7, 1.8, 2.0) * front * 2.0;
  c += a.b * inF * front * vec3<f32>(0.25, 0.6, 0.45) * 0.6;
  // runways: pavement, markings and lights, analytic so they stay sharp at any distance
  let cp = view.world_position;
  var glowL = vec3<f32>(0.0);
  let RW0 = runway(p, cp, dpx, dpy, inv, wpp, dist, u_r0a(), rwB(0), light, u_k2().w);
  c = mix(c, RW0.surf.rgb, RW0.surf.a * inF); glowL += RW0.glow;
  let RW1 = runway(p, cp, dpx, dpy, inv, wpp, dist, u_r1a(), rwB(1), light, u_k2().w);
  c = mix(c, RW1.surf.rgb, RW1.surf.a * inF); glowL += RW1.glow;
  let RW2 = runway(p, cp, dpx, dpy, inv, wpp, dist, u_r2a(), rwB(2), light, u_k2().w);
  c = mix(c, RW2.surf.rgb, RW2.surf.a * inF); glowL += RW2.glow;
  let RW3 = runway(p, cp, dpx, dpy, inv, wpp, dist, u_r3a(), rwB(3), light, u_k2().w);
  c = mix(c, RW3.surf.rgb, RW3.surf.a * inF); glowL += RW3.glow;
  // the departure's stop bar: red in-pavement lights across the taxiway until it is cleared on
  let BA = u_bar(); let bv = BA.zw - BA.xy; let bl = length(bv);
  if (u_k3().w > 0.001 && bl > 0.1) {
    let ub = bv / bl; let kb = clamp(round(dot(p - BA.xy, ub) / 0.3), 0.0, floor(bl / 0.3));
    glowL += vec3<f32>(1.0, 0.07, 0.03) * spot(p - BA.xy - ub * kb * 0.3, inv, clamp(0.05 / wpp, 1.05, 3.0)) * 7.0 * u_k3().w;
  }
  c += glowL * inF;
  // ---- radar scope ----
  let sc = u_k0().y;
  let ctr = vec2<f32>(0.0, 0.0);
  let rr = length(p - ctr);
  let fw = max(fwidth(rr), 0.5);
  let ringP = abs(fract(rr / 926.0 + 0.5) - 0.5) * 926.0;
  let rings = line(ringP, fw * 1.4) * step(rr, 4630.0);
  let ang = atan2(p.x - ctr.x, -(p.y - ctr.y));
  let spokeP = abs(fract(ang / 0.5235988 + 0.5) - 0.5) * 0.5235988 * rr;
  let spokes = line(spokeP, fw * 1.1) * smoothstep(300.0, 600.0, rr) * step(rr, 4630.0);
  var dlt = u_k0().z - ang; dlt = dlt - floor(dlt / 6.2831853) * 6.2831853;
  let sweep = exp(-dlt * 2.2) * step(rr, 4630.0) * smoothstep(40.0, 200.0, rr);
  let phos = vec3<f32>(0.20, 1.0, 0.55);
  let sw = u_k0().w;
  c += sc * (rings * 0.42 + spokes * 0.08) * phos;
  c += sw * exp(-dlt * 6.0) * step(rr, 4630.0) * smoothstep(40.0, 200.0, rr) * phos * 0.06;
  c += sw * line(dlt * rr, fw * 1.6) * phos * 0.7 * step(rr, 4630.0);
  // final approach course: flowing dashes into 31R, and the localiser feather
  let rel = p - u_tc().xy;
  let along = dot(rel, u_tc().zw);
  let across = dot(rel, vec2<f32>(-u_tc().zw.y, u_tc().zw.x));
  let fc = u_k1().x;
  let fwa = max(fwidth(across), 0.3);
  let onCourse = line(across, fwa * 1.6) * step(0.0, along) * step(along, 2800.0);
  let dash = step(0.45, fract((along + u_k1().y) / 46.0));
  c += fc * onCourse * dash * vec3<f32>(0.25, 0.85, 1.6);
  let fe = line(abs(across) - along * 0.035, fwa * 1.4) * step(60.0, along) * step(along, 2800.0);
  c += fc * fe * vec3<f32>(0.06, 0.25, 0.4);
  // radio: a ring rolling out from the tower
  let wv = u_k1().w;
  if (wv >= 0.0) {
    let tr = length(p - u_k4().xy);
    let R1 = wv * 1400.0; let R2 = max(0.0, wv - 0.45) * 1400.0;
    let fwt = max(fwidth(tr), 0.4);
    c += line(tr - R1, fwt * 3.0 + 2.0) * vec3<f32>(1.6, 0.9, 0.3) * (1.0 - wv);
    c += line(tr - R2, fwt * 3.0 + 2.0) * vec3<f32>(0.3, 0.9, 1.6) * (1.0 - wv) * step(0.45, wv);
  }
  // sectors: tower 5 NM, approach 13 NM
  let sx = u_k2().x;
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
// runways for the ground shader: each from the end it is used from (the arrival's and departure's, and their parallels)
const RWU = (() => {
  const mid = (r: any) => Math.hypot((r.a[0] + r.b[0]) / 2 - J.tower[0], (r.a[1] + r.b[1]) / 2 - J.tower[1]);
  const order = [...(J.runways as any[])].sort((p, q) => mid(p) - mid(q)).map((r) => r.ref);
  const dirs = [S.dl, S.dd];
  return (J.runways as any[]).slice(0, 4).map((r, i) => {
    const ab = [r.b[0] - r.a[0], r.b[1] - r.a[1]]; const l = Math.hypot(ab[0], ab[1]);
    let fromA = true;
    if (r.ref === J.arr.ref) fromA = J.arr.end === "a"; else if (r.ref === J.dep.ref) fromA = J.dep.end === "a";
    else { const best = dirs.reduce((m, d) => (Math.abs(d[0] * ab[0] + d[1] * ab[1]) / l > Math.abs(m[0] * ab[0] + m[1] * ab[1]) / l ? d : m)); fromA = best[0] * ab[0] + best[1] * ab[1] > 0; }
    const st = fromA ? r.a : r.b, en = fromA ? r.b : r.a;
    return { A: [st[0], st[1], en[0], en[1]], hw: r.width / 2, flags: r.ref === J.arr.ref ? 3 : 0, cell: i * 2 + (fromA ? 0 : 1), on: 0.18 + order.indexOf(r.ref) * 0.2 };
  });
})();
// PAPI, left of 31R, 300 m in
const PAPI = (() => { const { THR, dl } = S; const nx = dl[1], nz = -dl[0]; const base = [THR.x + dl[0] * 30, THR.z + dl[1] * 30]; return [0, 1, 2, 3].map((i) => [base[0] + nx * (3.3 + i * 0.9), 0.2, base[1] + nz * (3.3 + i * 0.9)] as V3); })();
function ribbon(lines: number[][][], w: number, y: number) {
  const pos: number[] = [], idx: number[] = [];
  for (const l of lines) for (let i = 0; i < l.length - 1; i++) {
    const [x0, z0] = l[i], [x1, z1] = l[i + 1]; const L = Math.hypot(x1 - x0, z1 - z0); if (L < 1e-4) continue;
    const nx = (-(z1 - z0) / L) * w, nz = ((x1 - x0) / L) * w; const b = pos.length / 3;
    pos.push(x0 + nx, y, z0 + nz, x0 - nx, y, z0 - nz, x1 + nx, y, z1 + nz, x1 - nx, y, z1 - nz);
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  return { pos, idx };
}
const RIBBON = ribbon(J.taxi_lines as number[][][], 0.022, 0.03);
const LEADS = ribbon((J.stands as any[]).filter((s) => s.lead && s.lead.length > 1).map((s) => s.lead), 0.02, 0.035);
// a light size for the view: about 1.4 px at the distance the camera looks at, in steps so instanced sets can be swapped
const tierOf = (cam: any) => { const sv = Math.hypot(cam.eye[0] - cam.tgt[0], cam.eye[1] - cam.tgt[1], cam.eye[2] - cam.tgt[2]) * Math.tan((cam.fov * Math.PI) / 360); return clamp(Math.round(Math.log(Math.max(sv, 1)) / Math.log(1.45)), 0, 16); };
const tierR = (t: number, k = 1) => Math.max(0.03, (2.9 * Math.pow(1.45, t)) / 1080) * k;
const at3 = (l: number[][], y: number) => l.map((p) => ({ position: [p[0], y, p[1]] as V3 }));
const TL_BLUE = at3(J.tl_blue, 0.06), TL_GREEN = at3(J.tl_green, 0.02);
const MASTS = J.masts as number[][];
const MAST_HEAD = at3(MASTS, 2.6);
// the cleared routes' centreline lights, every 15 m, in groups of three so they can come on and go out as the controller and
// the aircraft move along (follow the greens)
function routeLights(I: any) {
  const out: { s: number; p: number[] }[] = [];
  for (let s = 0.4; s < I.L - 0.2; s += 1.5) {
    let i = 1; while (i < I.cum.length - 1 && I.cum[i] < s) i++;
    const t = (s - I.cum[i - 1]) / (I.cum[i] - I.cum[i - 1] || 1); const a = I.pts[i - 1], b = I.pts[i];
    out.push({ s, p: [a[0] + (b[0] - a[0]) * t, b[1] * t + a[1] * (1 - t)] });
  }
  const groups: { s0: number; s1: number; at: any[] }[] = [];
  for (let g = 0; g < out.length; g += 3) { const part = out.slice(g, g + 3); groups.push({ s0: part[0].s, s1: part[part.length - 1].s, at: at3(part.map((q) => q.p), 0.05) }); }
  return groups;
}
const RLIGHTS = S.INSTR.map((I: any) => ({ who: I.who, I, groups: routeLights(I) }));
function RouteLights({ f, tier }: { f: number; tier: number }) {
  return (
    <>
      {RLIGHTS.map(({ who, I, groups }: any) => {
        const g = S.greens(I, f);
        if (!g || g.to <= g.from) return null;
        return groups.map((q: any, i: number) => (q.s1 >= g.from && q.s0 <= g.to ? (
          <Instances key={`${who}${i}t${tier}`} name={`gr-${who}${i}t${tier}`} at={q.at}><Sphere radius={tierR(tier, 1.9)} /><StandardMaterial base_color="#000000" emissive={glow("#22ff66", 16)} /></Instances>
        ) : null));
      })}
    </>
  );
}
// terminals' glazing: panes along each facade, three brightnesses
const FACADE = (() => {
  const sets = [{ pos: [] as number[], idx: [] as number[] }, { pos: [] as number[], idx: [] as number[] }, { pos: [] as number[], idx: [] as number[] }];
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const b of J.buildings as any[]) {
    if (b.kind !== "terminal") continue;
    const P = b.poly as number[][];
    for (let i = 0; i < P.length; i++) {
      const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; const L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.3) continue;
      const ux = (x1 - x0) / L, uz = (z1 - z0) / L, ox = -uz * 0.04, oz = ux * 0.04;
      const n = Math.max(1, Math.round(L / 0.55));
      for (let k = 0; k < n; k++) {
        const t0 = (k / n) * L + 0.04, t1 = ((k + 1) / n) * L - 0.04; if (t1 <= t0) continue;
        for (const [y0, y1, lvl] of [[0.42, 0.95, 0], [1.15, 1.6, 1]] as number[][]) {
          const r = rnd(); const set = sets[lvl === 0 ? (r < 0.6 ? 0 : r < 0.9 ? 1 : 2) : (r < 0.25 ? 1 : 2)];
          const bb = set.pos.length / 3;
          set.pos.push(x0 + ux * t0 + ox, y0, z0 + uz * t0 + oz, x0 + ux * t1 + ox, y0, z0 + uz * t1 + oz, x0 + ux * t0 + ox, y1, z0 + uz * t0 + oz, x0 + ux * t1 + ox, y1, z0 + uz * t1 + oz);
          set.idx.push(bb, bb + 1, bb + 2, bb + 1, bb + 3, bb + 2);
        }
      }
    }
  }
  return sets;
})();

// parked fleet: chosen in scene.js, clear of everything that moves; the model centre sits 0.38 of its length behind the
// nose wheel on the stop mark
const PARK = (() => {
  const out: Record<string, any[]> = { A320: [], B738: [], B77W: [], A359: [], A388: [], B744: [] };
  for (const p of S.PARK as any[]) {
    const back = 0.38 * LEN[p.type]; const fx = Math.sin(p.hdg), fz = -Math.cos(p.hdg);
    out[p.type].push({ position: [p.x - fx * back, 0, p.z - fz * back], rotation: [0, -p.hdg, 0], scale: [0.1, 0.1, 0.1] });
  }
  return out;
})();

// jet bridges: at every contact stand with an aircraft on it (and the story's stands), a rotunda at the terminal's facade
// and a tunnel out to the aircraft's forward left door, on a wheeled leg; remote stands (no facade near) get none
const BRIDGES = (() => {
  const polys = (J.buildings as any[]).filter((b) => b.poly.length > 2).map((b) => b.poly as [number, number][]);
  const nearest = (x: number, z: number) => {
    let best: [number, number, number] = [1e9, 0, 0];
    for (const P of polys) for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length]; const dx = b[0] - a[0], dz = b[1] - a[1]; const L2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / L2, 0, 1); const qx = a[0] + dx * t, qz = a[1] + dz * t; const d = Math.hypot(x - qx, z - qz);
      if (d < best[0]) best = [d, qx, qz];
    }
    return best;
  };
  const tunnel: any[] = [], cab: any[] = [], rot: any[] = [], leg: any[] = [];
  const add = (x: number, z: number, hdg: number, type: string) => {
    const fx = Math.sin(hdg), fz = -Math.cos(hdg), lx = fz, lz = -fx;            // forward, and the port side
    const wide = (LEN as any)[type] > 5; const sill = wide ? 0.5 : 0.34; const half = wide ? 0.3 : 0.2;
    const D: [number, number] = [x + lx * (half + 0.1) + fx * (wide ? -0.25 : 0), z + lz * (half + 0.1) + fz * (wide ? -0.25 : 0)];
    const [d, rx, rz] = nearest(D[0] + lx * 1.6 + fx * 1.2, D[1] + lz * 1.6 + fz * 1.2);
    if (d > 3.8) return;
    const vx = D[0] - rx, vz = D[1] - rz, L = Math.hypot(vx, vz); if (L < 0.7 || L > 5.5) return;
    const yaw = Math.atan2(-vz, vx), h = sill + 0.12, ux = vx / L, uz = vz / L;
    tunnel.push({ position: [rx + vx * 0.47, h, rz + vz * 0.47], rotation: [0, yaw, 0], scale: [L * 0.9, 0.28, 0.27] });
    cab.push({ position: [D[0] - ux * 0.2, h, D[1] - uz * 0.2], rotation: [0, yaw, 0], scale: [0.4, 0.34, 0.4] });
    rot.push({ position: [rx + ux * 0.2, (h + 0.2) / 2, rz + uz * 0.2], scale: [0.36, h + 0.2, 0.36] });
    leg.push({ position: [rx + vx * 0.7, (h - 0.14) / 2, rz + vz * 0.7], rotation: [0, yaw, 0], scale: [0.07, h - 0.14, 0.3] });
  };
  for (const p of S.PARK as any[]) add(p.x, p.z, p.hdg, p.type);
  const byRef = new Map((J.stands as any[]).map((st) => [st.ref, st]));
  const story = S.story as any;
  for (const [ref, type] of [[story.hero.stand, "A359"], [story.dep.stand, "B744"], ...(story.others || []).map((o: any) => [o.stand, "A320"])] as [string, string][]) {
    const st = byRef.get(ref); if (st) add(st.p[0], st.p[1], st.hdg, type);
  }
  return { tunnel, cab, rot, leg };
})();

// Manhattan: the skyline on the horizon, north-west
const CITY = (() => {
  const KX = 111320 * Math.cos((J.lat0 * Math.PI) / 180), KY = 110574;
  const toU = (lat: number, lon: number): [number, number] => [((lon - J.lon0) * KX) / 10, (-(lat - J.lat0) * KY) / 10];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sets: Record<string, any[]> = { warm: [], cool: [], dim: [] };
  const zone = (lat: number, lon: number, a: number, b: number, n: number, hmax: number, deg: number) => {
    const [cx, cz] = toU(lat, lon); const rot = (deg * Math.PI) / 180;
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
  for (const z of APT.city) zone(z[0], z[1], z[2], z[3], z[4], z[5], z[6]);
  const marks = APT.landmarks.map((m: number[]) => [...toU(m[0], m[1]), m[2], m[3]]);
  return { sets, marks };
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

// ---------------- the final approach ----------------
const GATE_NM = [6, 5, 4, 3.5, 3, 2.5, 2, 1.75, 1.5, 1.25, 1, 0.8, 0.6, 0.45, 0.3];
const GATES = GATE_NM.map((d) => {
  const { THR, o, GS, NM } = S; const along = d * NM;
  return { d, x: THR.x + o[0] * along, z: THR.z + o[1] * along, y: along * GS + 1.5, yaw: Math.atan2(-o[0], -o[1]) };
});
const SMOKE = /* wgsl */ `
fn shade(in: VertexOutput) -> vec4<f32> {
  let v = normalize(view.world_position - in.world_position.xyz);
  let n = normalize(in.world_normal);
  let a = pow(abs(dot(v, n)), 1.8) * u_gain();
  return vec4<f32>(vec3<f32>(0.62, 0.63, 0.68), a);
}`;
function FinalApproach({ f, hero, cam }: { f: number; hero: any; cam: any }) {
  if (f < 112 || f > 230) return null;
  const { THR, o, NM } = S;
  const hd = hero ? ((hero.x - THR.x) * o[0] + (hero.z - THR.z) * o[1]) / NM : 99;   // the hero's distance out, NM
  const show = smooth(112, 132, f) * (1 - smooth(212, 224, f));
  const gates = GATES.map((g, i) => {
    const ahead = smooth(-0.15, 0.25, hd - g.d);                       // gone once flown through
    const k = show * ahead * (0.35 + 0.65 * (1 - smooth(0, 3, hd - g.d)));
    if (k < 0.02) return null;
    const w = 5.0, h = 2.5, th = 0.16;
    const E = glow("#3ad0ff", 7 * k);
    return (
      <Entity key={`g${i}`} transform={Transform.fromXyz(g.x, g.y, g.z).withRotation(Quat.fromEuler("YXZ", g.yaw, 0, 0))}>
        <Mesh3d name={`gate${i}t`} transform={Transform.fromXyz(0, h, 0)}><Cuboid half_size={[w, th, th]} /><StandardMaterial base_color="#000000" emissive={E} /></Mesh3d>
        <Mesh3d name={`gate${i}b`} transform={Transform.fromXyz(0, -h, 0)}><Cuboid half_size={[w, th, th]} /><StandardMaterial base_color="#000000" emissive={E} /></Mesh3d>
        <Mesh3d name={`gate${i}l`} transform={Transform.fromXyz(-w, 0, 0)}><Cuboid half_size={[th, h, th]} /><StandardMaterial base_color="#000000" emissive={E} /></Mesh3d>
        <Mesh3d name={`gate${i}r`} transform={Transform.fromXyz(w, 0, 0)}><Cuboid half_size={[th, h, th]} /><StandardMaterial base_color="#000000" emissive={E} /></Mesh3d>
      </Entity>
    );
  });
  // wake vortices: two counter-rotating spirals off the wingtips, from where the hero was a moment ago
  const vort: any[] = [];
  if (hero && hero.y > 0.4 && f > 150 && f < 201) {
    const T = S.storyT(f); const sp = SPAN[hero.type] / 2;
    for (let k = 1; k <= 28; k++) {
      const p = S.stateAt(S.hero, T - k * 0.32); if (!p || p.y < 0.3) continue;
      const fwd = [Math.sin(p.hdg), 0, -Math.cos(p.hdg)], right = [Math.cos(p.hdg), 0, Math.sin(p.hdg)];
      const back = 0.38 * LENG[hero.type] + 1.2; const r = 0.12 + k * 0.022; const fade = (1 - k / 29) * smooth(150, 160, f);
      for (const side of [-1, 1]) {
        const a = k * 0.85 * side;
        const x = p.x - fwd[0] * back + right[0] * (side * sp + Math.cos(a) * r), z = p.z - fwd[2] * back + right[2] * (side * sp + Math.cos(a) * r), y = p.y + 0.28 + Math.sin(a) * r - k * 0.012;
        vort.push(<Mesh3d key={`v${side}${k}`} name={`vx${side}${k}`} transform={Transform.fromXyz(x, y, z).withScale(0.055)}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow("#cfeaff", 3.5 * fade)} /></Mesh3d>);
      }
    }
  }
  // tyre smoke where the mains touched
  const puffs: any[] = [];
  const td = S.heroAt(200.4);
  if (td && f >= 199.5 && f < 228) {
    const age = (S.storyT(f) - S.storyT(199.5));
    const fwd = [Math.sin(td.hdg), 0, -Math.cos(td.hdg)], right = [Math.cos(td.hdg), 0, Math.sin(td.hdg)];
    const back = 0.38 * LENG[td.type] + 0.4;
    for (const side of [-1, 1]) for (let j = 0; j < 3; j++) {
      const a = Math.max(0, age - j * 0.35); if (a <= 0) continue;
      const r = 0.25 + a * 0.55, g = 0.55 * (1 - smooth(0, 6, a));
      if (g < 0.01) continue;
      puffs.push(<ShaderMesh key={`p${side}${j}`} name={`puff${side}${j}`} shape={{ primitive: "Sphere", radius: 1 }} position={[td.x - fwd[0] * (back + j * 0.6) + right[0] * side * 0.45, 0.15 + r * 0.6, td.z - fwd[2] * (back + j * 0.6) + right[2] * side * 0.45]} scale={r} wgsl={SMOKE} alpha="blend" uniforms={{ gain: g }} />);
    }
  }
  return <>{gates}{puffs}</>;
}

// ---------------- moving aircraft ----------------
const LENG: Record<string, number> = LEN;
const pxLen = (s: any, cam: any) => { const d = Math.hypot(cam.eye[0] - s.x, cam.eye[1] - s.y, cam.eye[2] - s.z); return (LENG[s.type] / d) / ((cam.fov * Math.PI) / 180) * H; };
// the body frame: origin on the ground under the main gear (the pivot for heading, pitch and roll), -z forward. The model's
// own origin is mid-fuselage, 0.38 of its length behind the nose wheel
const WBG: Record<string, number> = WB;
const modelOff = (s: any) => 0.38 * LENG[s.type] - WBG[s.type];
function bodyDir(s: any, v: V3): V3 {   // Ry(-hdg) Rx(pitch) Rz(-bank), as Quat.fromEuler("YXZ", ...)
  const cb = Math.cos(-s.bank), sb = Math.sin(-s.bank); const x1 = v[0] * cb - v[1] * sb, y1 = v[0] * sb + v[1] * cb, z1 = v[2];
  const cp = Math.cos(s.pitch), spn = Math.sin(s.pitch); const y2 = y1 * cp - z1 * spn, z2 = y1 * spn + z1 * cp;
  const ch = Math.cos(-s.hdg), sh = Math.sin(-s.hdg); return [x1 * ch + z2 * sh, y2, -x1 * sh + z2 * ch];
}
const bodyPt = (s: any, v: V3): V3 => { const d = bodyDir(s, v); return [s.mx + d[0], s.y + 0.02 + d[1], s.mz + d[2]]; };
function Aircraft({ s, f, camEye, px, fovDeg }: { s: any; f: number; camEye: number[]; px: number; fovDeg: number }) {
  const q = Quat.fromEuler("YXZ", -s.hdg, s.pitch, -s.bank);
  const t = Transform.fromXyz(s.mx, s.y + 0.02, s.mz).withRotation(q);
  const sp = SPAN[s.type] / 2, ln = LENG[s.type];
  // the tug ahead of the nose wheel, turned with it
  const tugD = 0.12 * ln + 0.42, nwZ = -0.38 * ln;
  const tugAt = (h: number): V3 => [tugD * Math.sin(s.tugA || 0), h, nwZ - tugD * Math.cos(s.tugA || 0)];
  const tugQ = Quat.fromEuler("YXZ", -(s.tugA || 0), 0, 0);
  const dist = Math.hypot(camEye[0] - s.x, camEye[1] - s.y, camEye[2] - s.z);
  const near = smooth(2.5, 7, px);
  const blink = (period: number, phase: number, on = 1) => ((f + phase) % period) < on;
  const strobe = blink(9, (s.id.length * 3) % 9) ? 1 : 0;
  const beacon = blink(12, (s.id.length * 5) % 12, 2) ? 1 : 0.06;
  const landing = s.kind === "arr" ? (s.ft < 9000 ? 1 : 0) : s.leg === 2 ? (s.ft < 9000 ? 1 : 0) : 0;
  const minR = dist * 0.00075 * (fovDeg / 40);
  const L = (name: string, p: V3, hex: string, k: number, r: number) => (
    <Mesh3d name={`${s.id}-${name}`} transform={Transform.fromXyz(p[0], p[1], p[2]).withScale(r < 0.001 ? 0.0001 : Math.max(r, minR))}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(hex, Math.max(0, k))} /></Mesh3d>
  );
  const lk = px > 1.2;
  const nl = Math.max(near, smooth(1.2, 3, px));
  return (
    <Entity transform={t}><Entity transform={Transform.fromXyz(0, 0, modelOff(s))}>
      {near > 0.01 ? (s.gold ? (
        <Model name={`m-${s.id}`} src={staticFile(`${s.type}.glb`)} scale={0.1}>
          {["skin_000", "skin_001", "skin_002", "skin_003", "DefaultWhite_002", "DefaultWhite_014", "Material_001"].map((m) => <StandardMaterial key={m} material={m} base_color="#e0b860" metallic={0.45} perceptual_roughness={0.32} emissive={glow("#c8963c", 0.32)} />)}
        </Model>
      ) : <Model name={`m-${s.id}`} src={staticFile(`${s.type}.glb`)} scale={0.1} />) : null}
      {s.tug ? (
        <>
          <Mesh3d name={`${s.id}-tug`} transform={Transform.fromXyz(...tugAt(0.12)).withRotation(tugQ)}><Cuboid half_size={[0.14, 0.09, 0.26]} /><StandardMaterial base_color="#d8b43a" perceptual_roughness={0.6} emissive={glow("#d8b43a", 0.25)} /></Mesh3d>
          <Mesh3d name={`${s.id}-tugb`} transform={Transform.fromXyz(...tugAt(0.25))}><Sphere radius={0.05} /><StandardMaterial base_color="#000000" emissive={glow("#ffae1a", (f % 4) < 2 ? 30 : 3)} /></Mesh3d>
        </>
      ) : null}
      {lk ? L("navL", [-sp, 0.28, 0.05], "#ff2a1a", 12 * nl, 0.028) : null}
      {lk ? L("navR", [sp, 0.28, 0.05], "#1aff5a", 12 * nl, 0.028) : null}
      {lk ? L("tail", [0, 0.9, ln * 0.5], "#ffffff", 6 * nl, 0.025) : null}
      {lk ? L("strL", [-sp - 0.02, 0.28, 0.07], "#ffffff", 60 * strobe * nl, 0.035 * strobe + 0.0001) : null}
      {lk ? L("strR", [sp + 0.02, 0.28, 0.07], "#ffffff", 60 * strobe * nl, 0.035 * strobe + 0.0001) : null}
      {lk ? L("bcn", [0, ln * 0.09 + 0.55, 0], "#ff1a10", 30 * beacon * nl, 0.03) : null}
      {lk && landing ? L("llL", [-0.55, 0.32, -ln * 0.22], "#fff4e0", 40 * nl, 0.04) : null}
      {lk && landing ? L("llR", [0.55, 0.32, -ln * 0.22], "#fff4e0", 40 * nl, 0.04) : null}
    </Entity></Entity>
  );
}

// the landing-light beam: a long cone from the nose, forward and a little down
function Beam({ s, gain }: { s: any; gain: number }) {
  const ln = LENG[s.type];
  const dir = bodyDir(s, [0, -Math.sin(0.07), -Math.cos(0.07)]);
  const apex = bodyPt(s, [0, 0.32, -0.22 * ln + modelOff(s)]);   // between the wing-root landing lights
  const H = 26; const mid: V3 = [apex[0] + dir[0] * H / 2, apex[1] + dir[1] * H / 2, apex[2] + dir[2] * H / 2];
  // cone primitive points +y with its apex at +H/2: turn +y onto -dir
  const yaw = Math.atan2(-dir[0], -dir[2]);
  const tilt = Math.acos(clamp(-dir[1], -1, 1));
  const q = Quat.fromEuler("YXZ", yaw, tilt, 0);
  return (
    <Entity transform={Transform.fromXyz(...mid).withRotation(q)}>
      <ShaderMesh name={`beamm-${s.id}`} shape={{ primitive: "Cone", radius: 4.2, height: H }} wgsl={BEAM} alpha="add" doubleSided
        uniforms={{ apex, axis: dir, len: 7, gain: gain * 0.07, col: [1.0, 0.92, 0.8, 1] }} />
    </Entity>
  );
}

function FilmAt({ f }: { f: number }) {
  const cam = S.camera(f);
  const k = S.knobs(f);
  const ac = S.aircraftAt(f);
  const camH = cam.eye[1];
  const ribbon = k.reveal > 0.95 && camH < 70;          // close up: thin painted lines as meshes
  const closeK = 1 - smooth(140, 520, camH);            // close views: show the small lights
  const r = J.region;
  const flow = (f * 6) % 46;
  const heroS = S.heroAt(f);
  const depS = S.depAt(f);
  const tier = tierOf(cam);
  const showT = k.reveal > 0.55 && camH < 700;
  // landing lights on the ground: the hero from the approach to the exit, the departure on its take-off
  // the pool ahead of the nose wheel: landing lights at speed, the dimmer taxi light while taxiing
  const llOf = (s: any, on: boolean) => (s && on ? { p: [s.x, s.z, Math.sin(s.hdg), -Math.cos(s.hdg)], k: clamp(1 - s.y / 16) * smooth(0.5, 4, s.kt) * (0.4 + 0.6 * smooth(25, 60, s.kt)) } : { p: [0, 0, 1, 0], k: 0 });
  const ll1 = llOf(heroS, f > 140 && f < 266);
  const ll2 = llOf(depS, !!depS && depS.leg >= 1);
  const G = S.greens(S.INSTR[1], f);
  const H = S.HOLD;

  const shell = f >= 362 && f < 412 ? (f - 362) / 50 : -1;
  const twr: V3 = [S.tower.x, 9.2, S.tower.z];
  return (
    <AbsoluteFill style={{ background: "#07080d" }}>
      <Canvas3D>
        <Camera3d transform={Transform.fromXyz(cam.eye[0], cam.eye[1], cam.eye[2]).lookingAt(cam.tgt as V3)} projection={{ Perspective: { fov: (cam.fov * Math.PI) / 180, near: 0.4, far: 30000 } }} />
        <ToneMapping mode="aces" exposure={0.3} />
        <Bloom intensity={0.3} threshold={0.75} />
        <Grade vignette={{ intensity: 0.32, radius: 0.8, smoothness: 0.6 }} saturation={1.08} />
        <AmbientLight brightness={55} color="#7f8fb8" />
        <DirectionalLight transform={Transform.fromXyz(-930, 240, -360).lookingAt([0, 0, 0])} illuminance={500} color="#ffb490" />
        <DirectionalLight transform={Transform.fromXyz(400, 800, 600).lookingAt([0, 0, 0])} illuminance={420} color="#8aa6ff" />
        {heroS && f > 200 && f < 330 ? <PointLight transform={Transform.fromXyz(...bodyPt(heroS, [0, 7, modelOff(heroS)]))} intensity={1.6e6} range={40} color="#c9d6ff" /> : null}
        {depS && f > 266 && f < 430 ? <PointLight transform={Transform.fromXyz(...bodyPt(depS, [0, 9, modelOff(depS)]))} intensity={2.4e6} range={45} color="#d6e0ff" /> : null}

        <ShaderMesh name="sky" shape={{ primitive: "Sphere", radius: 14000 }} position={[cam.eye[0], 0, cam.eye[2]]} wgsl={SKY} doubleSided />
        <ShaderMesh name="ground" shape={{ primitive: "Rectangle", half_size: [(r.maxX - r.minX) / 2 + 3000, (r.maxZ - r.minZ) / 2 + 3000] }}
          position={[(r.maxX + r.minX) / 2, 0, (r.maxZ + r.minZ) / 2]} rotation={[-Math.PI / 2, 0, 0]} wgsl={GROUND}
          uniforms={{ reg: [r.minX, r.minZ, r.maxX, r.maxZ], tc: [S.THR.x, S.THR.z, S.o[0], S.o[1]],
            k0: [k.reveal, clamp(k.scope), k.sweep, k.sweepk], k1: [k.course * smooth(160, 420, camH), flow, ribbon ? 1 : 0, k.wave],
            k2: [k.sectors, k.city * (0.3 + 0.7 * smooth(60, 320, camH)), J.field.half, (f % 4) / 4], k3: [smooth(0.5, 0.9, k.reveal), ll1.k, ll2.k, G && G.bar ? 1 : 0],
            k4: [S.tower.x, S.tower.z, RWU.findIndex((q) => q.flags === 3), smooth(150, 600, camH)],
            r0a: RWU[0].A, r1a: RWU[1].A, r2a: RWU[2].A, r3a: RWU[3].A,
            rcell: RWU.map((q) => q.cell + 8 * Math.floor(q.hw * 1000)), ron: RWU.map((q) => smooth(q.on - 0.03, q.on + 0.03, k.reveal)),
            ll1: ll1.p, ll2: ll2.p, bar: H ? [H.c[0] - H.n[0] * 1.15, H.c[1] - H.n[1] * 1.15, H.c[0] + H.n[0] * 1.15, H.c[1] + H.n[1] * 1.15] : [0, 0, 0, 0] }}
          textures={{ fa: staticFile("fieldA.png"), fb: staticFile("fieldB.png"), fl: staticFile("fieldLo.png"), rg: staticFile("region.png") }} />

        {/* close up: painted taxiway centrelines and stand lead-in lines */}
        {ribbon ? <Mesh3d name="taxi-ribbon"><BufferMesh positions={RIBBON.pos} indices={RIBBON.idx} /><StandardMaterial base_color="#000000" emissive={glow("#c9a032", 0.32)} double_sided /></Mesh3d> : null}
        {ribbon ? <Mesh3d name="lead-ribbon"><BufferMesh positions={LEADS.pos} indices={LEADS.idx} /><StandardMaterial base_color="#000000" emissive={glow("#d6aa34", 0.5)} double_sided /></Mesh3d> : null}
        {/* taxiway lights: blue edges, dim green centrelines; the cleared routes' greens bright */}
        {showT ? <Instances name={`tlb${tier}`} at={TL_BLUE}><Sphere radius={tierR(tier)} /><StandardMaterial base_color="#000000" emissive={glow("#1f43ff", 7)} /></Instances> : null}
        {showT ? <Instances name={`tlg${tier}`} at={TL_GREEN}><Sphere radius={tierR(tier, 0.7)} /><StandardMaterial base_color="#000000" emissive={glow("#20d860", 1.1)} /></Instances> : null}
        <RouteLights f={f} tier={tier} />
        {/* apron flood light masts */}
        {k.reveal > 0.5 ? <Instances name={`mast${tier}`} at={MAST_HEAD}><Sphere radius={tierR(tier, 1.6)} /><StandardMaterial base_color="#000000" emissive={glow("#ffd9a6", 9)} /></Instances> : null}
        {k.reveal > 0.5 && camH < 200 ? <Instances name="mast-pole" at={MASTS.map((m) => ({ position: [m[0], 1.3, m[1]] as V3 }))}><Cuboid half_size={[0.025, 1.3, 0.025]} /><StandardMaterial base_color="#3a3d44" perceptual_roughness={0.7} /></Instances> : null}
        {PAPI.map((p, i) => {
          const above = heroS ? heroS.y - (Math.hypot(heroS.x - S.THR.x, heroS.z - S.THR.z) - 30) * S.GS : 0;
          const white = i < 2 ? true : above > (i === 2 ? -0.2 : 0.2) ? true : false;
          return <Mesh3d key={`papi${i}`} name={`papi${i}`} transform={Transform.fromXyz(p[0], p[1], p[2]).withScale(Math.max(0.035, Math.hypot(cam.eye[0] - p[0], cam.eye[1] - p[1], cam.eye[2] - p[2]) * 0.0009 * (cam.fov / 40)))}><Sphere radius={1} /><StandardMaterial base_color="#000000" emissive={glow(white ? "#ffffff" : "#ff2a1a", 14 * k.reveal * closeK + 0.01)} /></Mesh3d>;
        })}

        {camH < 260 && k.reveal > 0.6 ? FLOODS.map((q, i) => <PointLight key={`fl${i}`} transform={Transform.fromXyz(q[0], 6, q[1])} intensity={9e6} range={45} color="#ffb877" />) : null}
        {/* terminals and hangars */}
        {BLD.map((b) => (
          <Mesh3d key={`b${b.i}`} name={`bld${b.i}`} shape={b.solid}><StandardMaterial base_color={b.kind === "terminal" ? "#3b4250" : "#2c313a"} perceptual_roughness={0.8} emissive={glow("#9fb4ff", 0.02)} /></Mesh3d>
        ))}
        {k.reveal > 0.45 ? FACADE.map((q, i) => (q.idx.length ? <Mesh3d key={`fa${i}`} name={`facade${i}`}><BufferMesh positions={q.pos} indices={q.idx} /><StandardMaterial base_color="#000000" emissive={glow(["#ffd7a0", "#ffe9c8", "#b9d4ff"][i], [2.2, 1.2, 0.45][i])} double_sided /></Mesh3d> : null)) : null}
        {/* jet bridges */}
        {BRIDGES.tunnel.length ? <Instances name="jb-tunnel" at={BRIDGES.tunnel}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#8d939c" perceptual_roughness={0.55} emissive={glow("#ffe2b8", 0.035)} /></Instances> : null}
        {BRIDGES.cab.length ? <Instances name="jb-cab" at={BRIDGES.cab}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#6f757e" perceptual_roughness={0.6} emissive={glow("#ffd7a0", 0.12)} /></Instances> : null}
        {BRIDGES.rot.length ? <Instances name="jb-rot" at={BRIDGES.rot}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#5d636c" perceptual_roughness={0.7} /></Instances> : null}
        {BRIDGES.leg.length ? <Instances name="jb-leg" at={BRIDGES.leg}><Cuboid half_size={[0.5, 0.5, 0.5]} /><StandardMaterial base_color="#3a3e45" perceptual_roughness={0.7} /></Instances> : null}
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

        <FinalApproach f={f} hero={heroS} cam={cam} />
        {/* the controller's routes */}

        {/* traffic */}
        {ac.map((s) => <Aircraft key={s.id} s={s} f={f} camEye={cam.eye} px={pxLen(s, cam)} fovDeg={cam.fov} />)}
        {ac.filter((s) => s.y > 0.5).map((s) => {
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

function Film() { return <FilmAt f={useCurrentFrame() / SUB} />; }
// a contact sheet of chosen frames, without working out every frame before them
const PROBE = [240, 268, 300, 340, 352, 360]; const _OLD = [160, 176, 186, 196, 206, 216, 226, 345, 390, 400, 452, 479];
function Probe() { return <FilmAt f={PROBE[Math.min(PROBE.length - 1, useCurrentFrame())]} />; }
registerRoot(() => (
  <>
    <Composition id="landing" component={Film} width={W} height={H} fps={FPS} durationInFrames={N * SUB} />
    <Composition id="probe" component={Probe} width={W / 2} height={H / 2} fps={FPS} durationInFrames={PROBE.length} />
  </>
));
