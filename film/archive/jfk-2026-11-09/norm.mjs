// Bake each aircraft GLB into: nose toward -z, +y up, wheels on y=0, centred on the fuselage middle, real length (m).
// needs @gltf-transform/core, extensions, functions 4.1.1 (npm i in film/ or globally)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
const [,, inp, out, lenM] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
const mul = (m, v) => [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12], m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13], m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]];
const pts = [];
scene.traverse((n) => { const mesh = n.getMesh(); if (!mesh) return; const W = n.getWorldMatrix();
  for (const p of mesh.listPrimitives()) { const a = p.getAttribute('POSITION'); const v = [0,0,0];
    for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); pts.push(mul(W, v)); } } });
const min = [0,1,2].map(k => Math.min(...pts.map(p => p[k]))), max = [0,1,2].map(k => Math.max(...pts.map(p => p[k])));
const ext = max.map((m, k) => m - min[k]); const ctr = max.map((m, k) => (m + min[k]) / 2);
const up = ext.indexOf(Math.min(...ext));
const sum = [0,0,0]; let n = 0;
for (const p of pts) if (p[up] > min[up] + ext[up] * 0.8) { n++; for (let k = 0; k < 3; k++) sum[k] += p[k] - ctr[k]; }
const rel = [0,1,2].map(k => k === up ? 0 : sum[k] / n / ext[k]);
const hz = [0,1,2].filter(k => k !== up);
let long = Math.abs(rel[hz[0]]) >= Math.abs(rel[hz[1]]) ? hz[0] : hz[1];
const noseSign = rel[long] > 0 ? -1 : 1;
const ax = (i, s) => { const v = [0,0,0]; v[i] = s; return v; };
const z = ax(long, -noseSign), y = ax(up, 1);
const x = [y[1]*z[2]-y[2]*z[1], y[2]*z[0]-y[0]*z[2], y[0]*z[1]-y[1]*z[0]];
const s = Number(lenM) / ext[long];
// new = s * R * (p - c'), R rows = x, y, z ; c' = centre with up axis at its min (wheels on 0)
const c = ctr.slice(); c[up] = min[up];
const R = [x, y, z];
const t = R.map(r => -s * (r[0]*c[0] + r[1]*c[1] + r[2]*c[2]));
const M = [s*x[0], s*y[0], s*z[0], 0, s*x[1], s*y[1], s*z[1], 0, s*x[2], s*y[2], s*z[2], 0, t[0], t[1], t[2], 1];
const root = doc.createNode('norm').setMatrix(M);
for (const ch of scene.listChildren()) { scene.removeChild(ch); root.addChild(ch); }
scene.addChild(root);
await io.write(out, doc);
console.log(inp.split('/').pop(), 'up', up, 'long', long, 'nose', noseSign, 'scale', s.toFixed(4), 'ext', ext.map(e => e.toFixed(1)).join(','));
