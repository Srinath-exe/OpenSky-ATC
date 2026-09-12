// ============================================================
//  Canvas palette — every colour the overlay paints is a design token read from
//  :root (01 A8 "canvas renderers read colours with getComputedStyle"). No literal
//  colours live in the ground view.
// ============================================================

const TOKENS = {
  text1: '--text-1',
  text2: '--text-2',
  text3: '--text-3',
  text4: '--text-4',
  text5: '--text-5',
  bg0: '--bg-0',
  bg2: '--bg-2',
  bg3: '--bg-3',
  bg4: '--bg-4',
  w04: '--w-04',
  w06: '--w-06',
  w08: '--w-08',
  w10: '--w-10',
  w12: '--w-12',
  w14: '--w-14',
  w18: '--w-18',
  w25: '--w-25',
  w35: '--w-35',
  w45: '--w-45',
  w55: '--w-55',
  w70: '--w-70',
  w85: '--w-85',
  orange: '--orange',
  orangeDeep: '--orange-deep',
  orange40: '--orange-40',
  orange60: '--orange-60',
  orange90: '--orange-90',
  orangeTint04: '--orange-tint-04',
  orangeTint08: '--orange-tint-08',
  orangeTint16: '--orange-tint-16',
  orangeTint30: '--orange-tint-30',
  orangeBorder: '--orange-border',
  red: '--red',
  red40: '--red-40',
  red85: '--red-85',
  redTint: '--red-tint',
  redTint12: '--red-tint-12',
  redTint24: '--red-tint-24',
  redBorder: '--red-border',
  redBorder25: '--red-border-25',
  redBorder55: '--red-border-55',
  green: '--green',
  greenDim: '--green-dim',
  lime: '--lime-marker',
  lime50: '--lime-50',
  limeFeather: '--lime-feather',
  blueMarker: '--blue-marker',
  dataBlock: '--data-block',
  tagBg: '--tag-bg',
  puckFill: '--puck-fill',
  puckRing: '--puck-ring',
  pinFill: '--map-pin-fill',
  pinGlyph: '--map-pin-glyph',
  pinMutedFill: '--map-pin-muted-fill',
  pinMutedGlyph: '--map-pin-muted-glyph',
  glassFill: '--glass-fill',
  glassFillStrong: '--glass-fill-strong',
  glassBorder: '--glass-border',
  glassBorderLit: '--glass-border-lit',
  chartGrid: '--chart-grid',
  tick: '--tick',
  tickLit: '--tick-lit',
} as const;

export type CanvasPalette = Record<keyof typeof TOKENS, string> & { font: string };

let cached: CanvasPalette | null = null;

/** Resolve all canvas tokens once (call again after a theme change; the product is dark-only). */
export function readCanvasPalette(force = false): CanvasPalette {
  if (cached && !force) return cached;
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const out = {} as CanvasPalette;
  for (const k of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) {
    const v = cs ? cs.getPropertyValue(TOKENS[k]).trim() : '';
    out[k] = v || 'transparent';
  }
  const font = cs ? cs.getPropertyValue('--font').trim() : '';
  out.font = font || 'sans-serif';
  cached = out;
  return out;
}

/** Canvas font shorthand from the design scale: weight + px + family. */
export function fontOf(p: CanvasPalette, weight: 300 | 400 | 500, px: number): string {
  return `${weight} ${px}px ${p.font}`;
}
