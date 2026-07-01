#!/usr/bin/env node
// Generate one SVG per aircraft type from the parametric silhouette geometry.
// Output: public/aircraft/<ICAO>.svg  +  an index.html gallery.
// Run:  npx tsx scripts/gen_aircraft_svgs.mjs   (tsx so it can import the TS module)
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ALL_TYPES, shapeToSVG, getShape } from '../src/lib/sim/aircraftShapes.ts';
import { AIRCRAFT_DB } from '../src/lib/sim/aircraftDB.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'aircraft');
mkdirSync(outDir, { recursive: true });

const cards = [];
for (const icao of ALL_TYPES) {
  const svg = shapeToSVG(icao);
  writeFileSync(join(outDir, `${icao}.svg`), svg);
  const p = AIRCRAFT_DB[icao];
  const s = getShape(icao);
  cards.push(`<figure><div class="box">${svg}</div><figcaption><b>${icao}</b><br>${p.modelName}<br><span>${s.spanM}m span · ${s.lengthM}m</span></figcaption></figure>`);
  console.log(`  ${icao.padEnd(5)} → ${icao}.svg  (${p.modelName})`);
}

const html = `<!doctype html><meta charset=utf8><title>SkyControl Aircraft Types</title>
<style>body{background:#070d18;color:#cdddf2;font-family:ui-monospace,monospace;margin:0;padding:24px}
h1{letter-spacing:3px;font-size:16px;color:#fbbf24}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;margin-top:18px}
figure{margin:0;background:rgba(7,13,24,.86);border:1px solid rgba(30,56,96,.55);border-radius:11px;padding:12px;text-align:center}
.box{height:90px;display:flex;align-items:center;justify-content:center}
.box svg{max-width:100%;max-height:90px}
figcaption{font-size:11px;line-height:1.5;margin-top:8px}figcaption span{color:#5f7da6;font-size:9px}</style>
<h1>◆ SKYCONTROL — AIRCRAFT TYPES (${ALL_TYPES.length})</h1>
<div class=grid>${cards.join('')}</div>`;
writeFileSync(join(outDir, 'index.html'), html);
console.log(`\n✅ ${ALL_TYPES.length} SVGs + gallery → ${outDir}`);
