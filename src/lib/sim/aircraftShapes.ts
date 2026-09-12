// ============================================================
//  Parametric aircraft silhouettes (top-down).
//
//  Each ICAO type's footprint is generated from its real wingspan & length
//  (aircraftDB) plus a small per-family table (engine count/placement, wing
//  sweep, fuselage width, tail). Output is a set of polygons in METRES with the
//  nose pointing up (−y), centred on the aircraft. The same geometry is used to
//  (a) render on the canvas at true scale and (b) export public/aircraft/*.svg.
// ============================================================
import { AIRCRAFT_DB, AircraftPerformance, getPerformance } from './aircraftDB';

type Family = 'light' | 'narrow' | 'wide' | 'quad' | 'fighter' | 'cargo' | 'vip';
interface FamilyMeta { family: Family; engines: number; mount: 'wing' | 'tail' | 'nose'; sweepDeg: number; fuselageW: number; }

// per-type family metadata (fuselageW in metres)
const META: Record<string, FamilyMeta> = {
  C172: { family: 'light', engines: 1, mount: 'nose', sweepDeg: 1, fuselageW: 1.3 },
  PA28: { family: 'light', engines: 1, mount: 'nose', sweepDeg: 1, fuselageW: 1.3 },
  B738: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.8 },
  A320: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.95 },
  A20N: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.95 },
  B38M: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.8 },
  E190: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 23, fuselageW: 3.0 },
  E175: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 23, fuselageW: 3.0 },
  CRJ9: { family: 'narrow', engines: 2, mount: 'tail', sweepDeg: 25, fuselageW: 2.7 },
  A321: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.95 },
  B752: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 25, fuselageW: 3.8 },
  DH8D: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 3, fuselageW: 2.7 },
  AT76: { family: 'narrow', engines: 2, mount: 'wing', sweepDeg: 2, fuselageW: 2.9 },
  B763: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 31, fuselageW: 5.0 },
  MD11: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 35, fuselageW: 6.0 },
  A346: { family: 'quad', engines: 4, mount: 'wing', sweepDeg: 30, fuselageW: 5.64 },
  B744: { family: 'quad', engines: 4, mount: 'wing', sweepDeg: 37, fuselageW: 6.5 },
  B77W: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 31, fuselageW: 6.2 },
  A359: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 31, fuselageW: 5.96 },
  A333: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 30, fuselageW: 5.64 },
  B789: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 32, fuselageW: 5.77 },
  B788: { family: 'wide', engines: 2, mount: 'wing', sweepDeg: 32, fuselageW: 5.77 },
  A388: { family: 'quad', engines: 4, mount: 'wing', sweepDeg: 30, fuselageW: 7.1 },
  B748: { family: 'quad', engines: 4, mount: 'wing', sweepDeg: 31, fuselageW: 6.5 },
  C17:  { family: 'cargo', engines: 4, mount: 'wing', sweepDeg: 25, fuselageW: 6.8 },
  VC25: { family: 'vip', engines: 4, mount: 'wing', sweepDeg: 31, fuselageW: 6.5 },
  F18:  { family: 'fighter', engines: 2, mount: 'tail', sweepDeg: 40, fuselageW: 2.4 },
  F35:  { family: 'fighter', engines: 1, mount: 'tail', sweepDeg: 42, fuselageW: 2.2 },
};
const DEFAULT_META: FamilyMeta = META.B738;

export type Pt = [number, number];
export interface ShapePart { pts: Pt[]; role: 'body' | 'engine'; }
export interface AircraftShape { parts: ShapePart[]; spanM: number; lengthM: number; icao: string; }

function meta(icao: string): FamilyMeta { return META[icao] ?? DEFAULT_META; }

// swept trapezoid wing for one side (sign = +1 right / -1 left)
function wing(sign: number, span: number, bodyHalf: number, yRoot: number, rootChord: number, tipChord: number, sweepDeg: number): Pt[] {
  const tip = (span / 2) * sign;
  const root = bodyHalf * 0.85 * sign;
  const sweep = Math.tan(sweepDeg * Math.PI / 180) * (Math.abs(tip) - Math.abs(root));
  const leRoot = yRoot - rootChord * 0.5;
  const leTip = leRoot + sweep;
  return [
    [root, leRoot],
    [tip, leTip],
    [tip, leTip + tipChord],
    [root, leRoot + rootChord],
  ];
}

function nacelle(cx: number, cy: number, len: number, wid: number): Pt[] {
  const hl = len / 2, hw = wid / 2;
  return [[cx - hw, cy - hl], [cx + hw, cy - hl], [cx + hw, cy + hl], [cx - hw, cy + hl]];
}

export function buildShape(icao: string): AircraftShape {
  const perf: AircraftPerformance = getPerformance(icao);
  const m = meta(icao);
  const span = perf.wingspanMeters;
  const len = perf.lengthMeters;
  const bw = m.fuselageW;
  const bodyHalf = bw / 2;
  const noseY = -len / 2, tailY = len / 2;
  const parts: ShapePart[] = [];

  const isFighter = m.family === 'fighter';
  const isLight = m.family === 'light';

  // ── wings ──
  const wingYRoot = isFighter ? tailY - len * 0.32 : len * 0.04;
  const rootChord = isFighter ? len * 0.5 : len * (isLight ? 0.13 : 0.17);
  const tipChord = isFighter ? len * 0.06 : rootChord * 0.34;
  const sweep = m.sweepDeg;
  parts.push({ pts: wing(1, span, bodyHalf, wingYRoot, rootChord, tipChord, sweep), role: 'body' });
  parts.push({ pts: wing(-1, span, bodyHalf, wingYRoot, rootChord, tipChord, sweep), role: 'body' });

  // ── horizontal stabiliser ──
  const htSpan = span * (isFighter ? 0.55 : 0.36);
  const htChord = rootChord * (isFighter ? 0.5 : 0.55);
  const htY = tailY - htChord * 0.7;
  parts.push({ pts: wing(1, htSpan, bodyHalf * 0.7, htY, htChord, htChord * 0.4, sweep + 4), role: 'body' });
  parts.push({ pts: wing(-1, htSpan, bodyHalf * 0.7, htY, htChord, htChord * 0.4, sweep + 4), role: 'body' });

  // ── vertical fin (thin top-down sliver along centreline at tail) ──
  const finLen = len * 0.16, finW = bw * 0.5;
  parts.push({ pts: [[0, tailY - finLen], [finW * 0.5, tailY - finLen * 0.2], [0, tailY + len * 0.02], [-finW * 0.5, tailY - finLen * 0.2]], role: 'body' });

  // ── fuselage ──
  const nh = bodyHalf;
  parts.push({
    pts: [
      [0, noseY],
      [nh * 0.55, noseY + len * 0.10],
      [nh, noseY + len * 0.24],
      [nh, tailY - len * 0.22],
      [nh * 0.30, tailY - len * 0.04],
      [0, tailY],
      [-nh * 0.30, tailY - len * 0.04],
      [-nh, tailY - len * 0.22],
      [-nh, noseY + len * 0.24],
      [-nh * 0.55, noseY + len * 0.10],
    ],
    role: 'body',
  });

  // ── engines ──
  if (m.mount === 'wing') {
    const enLen = len * 0.10, enWid = bw * 0.33;
    const ey = wingYRoot - rootChord * 0.15;
    const sweepAt = (frac: number) => ey + Math.tan(sweep * Math.PI / 180) * (span / 2) * frac;
    const positions = m.engines === 4 ? [0.20, 0.37] : [0.33];
    for (const f of positions) {
      const ex = (span / 2) * f;
      parts.push({ pts: nacelle(ex, sweepAt(f) + enLen * 0.2, enLen, enWid), role: 'engine' });
      parts.push({ pts: nacelle(-ex, sweepAt(f) + enLen * 0.2, enLen, enWid), role: 'engine' });
    }
  } else if (m.mount === 'nose') {
    // light single: prop disc near nose
    const r = bw * 0.7;
    const cy = noseY + len * 0.04;
    const disc: Pt[] = [];
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; disc.push([Math.cos(a) * r, cy + Math.sin(a) * r * 0.5]); }
    parts.push({ pts: disc, role: 'engine' });
  } else {
    // fighter: twin exhausts at tail
    const enWid = bw * 0.34, enLen = len * 0.12;
    parts.push({ pts: nacelle(bw * 0.3, tailY - enLen * 0.4, enLen, enWid), role: 'engine' });
    if (m.engines === 2) parts.push({ pts: nacelle(-bw * 0.3, tailY - enLen * 0.4, enLen, enWid), role: 'engine' });
  }

  return { parts, spanM: span, lengthM: len, icao: perf.icaoCode };
}

// shape cache
const cache = new Map<string, AircraftShape>();
export function getShape(icao: string): AircraftShape {
  let s = cache.get(icao);
  if (!s) { s = buildShape(icao); cache.set(icao, s); }
  return s;
}

// ── canvas renderer — ctx already translated to plane & rotated to heading ──
// pxPerM scales metres→pixels. Body recoloured by state; engines darker.
export function drawShape(ctx: CanvasRenderingContext2D, shape: AircraftShape, pxPerM: number, body: string, engine: string) {
  ctx.save();
  ctx.scale(pxPerM, pxPerM);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.18, 0.9 / pxPerM); // ~constant 0.9px outline
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  for (const p of shape.parts) {
    if (p.role !== 'body') continue;
    poly(ctx, p.pts); ctx.fillStyle = body; ctx.fill(); ctx.stroke();
  }
  for (const p of shape.parts) {
    if (p.role !== 'engine') continue;
    poly(ctx, p.pts); ctx.fillStyle = engine; ctx.fill();
  }
  ctx.restore();
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// ── SVG export ──
export function shapeToSVG(icao: string, body = '#fbbf24', engine = '#241a02'): string {
  const s = getShape(icao);
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const p of s.parts) for (const [x, y] of p.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const pad = 2;
  const vb = `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`;
  const path = (pts: Pt[]) => 'M' + pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L') + ' Z';
  const bodyPaths = s.parts.filter(p => p.role === 'body').map(p => `<path d="${path(p.pts)}" fill="${body}" stroke="#000" stroke-opacity="0.5" stroke-width="0.4" stroke-linejoin="round"/>`).join('');
  const engPaths = s.parts.filter(p => p.role === 'engine').map(p => `<path d="${path(p.pts)}" fill="${engine}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="120" height="120"><g>${bodyPaths}${engPaths}</g></svg>`;
}

export const ALL_TYPES = Object.keys(AIRCRAFT_DB);
