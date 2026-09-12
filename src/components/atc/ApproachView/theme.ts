// ============================================================
//  Radar palette — every colour the canvas paints is a design token read from
//  the cascade at mount (01 A8 / design README "Map overlays"). No literals here.
// ============================================================

export interface RadarTheme {
  /** Resolved font-family list (DM Sans + fallbacks) usable in ctx.font. */
  font: string;
  bg: string;
  bg2: string;
  bg3: string;
  bg4: string;
  text1: string;
  text2: string;
  text3: string;
  text4: string;
  text5: string;
  w04: string;
  w05: string;
  w06: string;
  w08: string;
  w10: string;
  w12: string;
  w14: string;
  w18: string;
  w25: string;
  w35: string;
  w45: string;
  w55: string;
  w70: string;
  orange: string;
  orange40: string;
  orange60: string;
  orangeTint08: string;
  orangeTint20: string;
  orangeBorder: string;
  red: string;
  red40: string;
  red85: string;
  redTint: string;
  redTint08: string;
  redBorder25: string;
  redBorder55: string;
  green: string;
  lime: string;
  lime50: string;
  limeFeather: string;
  blue: string;
  dataBlock: string;
  handedBlock: string;
}

const TOKENS: Record<Exclude<keyof RadarTheme, 'font'>, string> = {
  bg: '--bg-0', bg2: '--bg-2', bg3: '--bg-3', bg4: '--bg-4',
  text1: '--text-1', text2: '--text-2', text3: '--text-3', text4: '--text-4', text5: '--text-5',
  w04: '--w-04', w05: '--w-05', w06: '--w-06', w08: '--w-08', w10: '--w-10', w12: '--w-12', w14: '--w-14', w18: '--w-18',
  w25: '--w-25', w35: '--w-35', w45: '--w-45', w55: '--w-55', w70: '--w-70',
  orange: '--orange', orange40: '--orange-40', orange60: '--orange-60', orangeTint08: '--orange-tint-08', orangeTint20: '--orange-tint-20', orangeBorder: '--orange-border',
  red: '--red', red40: '--red-40', red85: '--red-85', redTint: '--red-tint', redTint08: '--red-tint-08', redBorder25: '--red-border-25', redBorder55: '--red-border-55',
  green: '--green', lime: '--lime-marker', lime50: '--lime-50', limeFeather: '--lime-feather', blue: '--blue-marker',
  dataBlock: '--data-block', handedBlock: '--tag-bg',
};

/** Read the palette from the element's computed style. Missing tokens fall back to `currentColor` (never a literal). */
export function readTheme(el: HTMLElement): RadarTheme {
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name).trim() || 'currentColor';
  const out = { font: cs.fontFamily || 'sans-serif' } as RadarTheme;
  for (const key of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) out[key] = get(TOKENS[key]);
  return out;
}

/** Font shorthand helpers (01 §2.2 scale: label-xs 11 / micro 10 / body-s 13). */
export const font = (t: RadarTheme, px: number, weight: 300 | 400 | 500 = 400) => `${weight} ${px}px/1 ${t.font}`;
