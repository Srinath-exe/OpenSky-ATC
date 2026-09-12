// ============================================================
//  Seeded RNG — the ONLY source of randomness in the sim (05-TEST-STRATEGY §2.2)
//
//  Unseeded (production) it delegates to Math.random. Test mode calls
//  setSeed(n) once before the airport loads; from then on callsigns, types,
//  gates, runways, fixes, entry points, spawn intervals, weather, requests and
//  emergencies repeat exactly for a given seed. Never call Math.random in
//  src/lib/sim — use rng() / rnd() / ri() / rf() from here.
// ============================================================

let state = 0;
let seeded = false;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let impl: () => number = Math.random;

/** Seed the generator (deterministic from here on). */
export function setSeed(seed: number): void {
  state = seed;
  impl = mulberry32(seed);
  seeded = true;
}

/** Uniform [0, 1). */
export function rng(): number { return impl(); }

/** Random element of a non-empty array. */
export const rnd = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];

/** Random integer in [0, n). */
export const ri = (n: number) => Math.floor(rng() * n);

/** Random float in [lo, hi). */
export const rf = (lo: number, hi: number) => lo + rng() * (hi - lo);

/** Bernoulli trial with probability p. */
export const chance = (p: number) => rng() < p;

export const isSeeded = () => seeded;

/** The seed passed to setSeed (0 when unseeded). */
export const currentSeed = () => state;

/**
 * Independent sub-stream (03 §G2: one stream per subsystem so weather draws do
 * not perturb traffic). Derived deterministically from the master seed; when
 * unseeded it also falls back to Math.random.
 */
export function subStream(name: string): () => number {
  if (!seeded) return () => Math.random();
  let h = 2166136261 ^ state;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return mulberry32(h >>> 0);
}
