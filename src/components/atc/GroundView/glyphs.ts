// ============================================================
//  Canvas versions of the design-system custom glyphs (src/design/icons.tsx):
//  the same 24-viewBox path data, stroked at a constant 1.5 px like the SVG
//  originals (non-scaling stroke), so the map and the panels draw one family.
// ============================================================
import type { VehicleType } from '@/lib/sim/types';

type PathSet = { paths: string[]; circles?: Array<[number, number, number]> };

/** Path data copied verbatim from icons.tsx (FireTruck / FollowMeCar / Tug / Ambulance / Fuel / Deice / AircraftTop). */
const GLYPH_PATHS: Record<'arff' | 'followme' | 'tug' | 'ambulance' | 'fuel' | 'deice' | 'aircraft' | 'ops', PathSet> = {
  arff: {
    paths: ['M2.5 9.5h11v7h-11z', 'M13.5 11.5h4.2l3.8 3v2h-8z', 'M4 9.5V7h8v2.5', 'M9 5.5h5.5l2.5 2', 'M5 12h2M9 12h2'],
    circles: [[6, 17.5, 1.8], [17, 17.5, 1.8]],
  },
  followme: {
    paths: ['M3 13.5l1.6-4.2A1.5 1.5 0 0 1 6 8.3h9.5a1.5 1.5 0 0 1 1.4 1l1.6 4.2H21v3.2h-1.5', 'M3 13.5v3.2h1.5M7.5 16.7h9', 'M8 8.3V5.5h6v2.8', 'M4.5 11.5h13'],
    circles: [[6, 17, 1.8], [18, 17, 1.8]],
  },
  tug: {
    paths: ['M3.5 15V10.5h6l1.5-3h4V15', 'M3.5 15h11.5', 'M15 12h6.5', 'M20 10.5v3', 'M5.5 10.5V8.5h3'],
    circles: [[6.5, 16.8, 1.8], [12.5, 16.8, 1.8]],
  },
  ambulance: {
    paths: ['M2.5 8.5h11v8h-11z', 'M13.5 10.5h4l3.5 3.2v2.8h-7.5z', 'M8 10.5v4M6 12.5h4', 'M6.5 8.5V6.5h4v2'],
    circles: [[6, 17.3, 1.8], [17, 17.3, 1.8]],
  },
  fuel: {
    paths: ['M2.5 9h12a3.5 3.5 0 0 1 0 7h-12a3.5 3.5 0 0 1 0-7z', 'M14.5 11.5h3.5l3 2.5v2h-6.5', 'M6 9V6.5h4', 'M8.5 12.5h1'],
    circles: [[6, 17.3, 1.8], [17, 17.3, 1.8]],
  },
  deice: {
    paths: ['M2.5 11.5h9v5h-9z', 'M11.5 13h4l2.5 2v1.5h-6.5', 'M7 11.5L13 5h5', 'M18 5l1.5-1.5M18 5l1.5 1.5M18 5h2.5', 'M20.5 8.5v1M22 10.5v1M19 10.5v1'],
    circles: [[5.5, 17.3, 1.8], [15.5, 17.3, 1.8]],
  },
  aircraft: {
    paths: ['M12 2.5c.9 0 1.5 1.2 1.5 3v4.2l8 4.3v2l-8-2v4.2l2.2 1.6v1.5L12 20.5l-3.7.8v-1.5l2.2-1.6V14l-8 2v-2l8-4.3V5.5c0-1.8.6-3 1.5-3z'],
  },
  // Ops / inspection / sweeper / bird control share the car body with a roof beacon.
  ops: {
    paths: ['M3 13.5l1.6-4.2A1.5 1.5 0 0 1 6 8.3h9.5a1.5 1.5 0 0 1 1.4 1l1.6 4.2H21v3.2h-1.5', 'M3 13.5v3.2h1.5M7.5 16.7h9', 'M10.5 8.3V6h3v2.3', 'M4.5 11.5h13'],
    circles: [[6, 17, 1.8], [18, 17, 1.8]],
  },
};

const cache = new Map<string, { paths: Path2D[]; circles: Array<[number, number, number]> }>();

function glyphFor(kind: keyof typeof GLYPH_PATHS) {
  let g = cache.get(kind);
  if (!g) {
    const src = GLYPH_PATHS[kind];
    g = { paths: src.paths.map(d => new Path2D(d)), circles: src.circles ?? [] };
    cache.set(kind, g);
  }
  return g;
}

export function glyphKindFor(type: VehicleType): keyof typeof GLYPH_PATHS {
  switch (type) {
    case 'arff': return 'arff';
    case 'followme': return 'followme';
    case 'tug': return 'tug';
    case 'ambulance': return 'ambulance';
    case 'fuel': return 'fuel';
    case 'deice': return 'deice';
    default: return 'ops';
  }
}

/**
 * Stroke a glyph centred at (0,0) with `size` px box; ctx must already be translated.
 * Stroke stays 1.5 px regardless of scale (like vector-effect: non-scaling-stroke).
 */
export function drawGlyph(ctx: CanvasRenderingContext2D, kind: keyof typeof GLYPH_PATHS, size: number, color: string, rotateDeg = 0): void {
  const g = glyphFor(kind);
  const s = size / 24;
  ctx.save();
  if (rotateDeg) ctx.rotate((rotateDeg * Math.PI) / 180);
  ctx.translate(-size / 2, -size / 2);
  ctx.scale(s, s);
  ctx.lineWidth = 1.5 / s;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  for (const p of g.paths) ctx.stroke(p);
  for (const [cx, cy, r] of g.circles) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}

/** Filled version (the aircraft chevron / plane symbol). */
export function fillGlyph(ctx: CanvasRenderingContext2D, kind: keyof typeof GLYPH_PATHS, size: number, color: string, rotateDeg = 0): void {
  const g = glyphFor(kind);
  const s = size / 24;
  ctx.save();
  if (rotateDeg) ctx.rotate((rotateDeg * Math.PI) / 180);
  ctx.translate(-size / 2, -size / 2);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  for (const p of g.paths) ctx.fill(p);
  ctx.restore();
}
