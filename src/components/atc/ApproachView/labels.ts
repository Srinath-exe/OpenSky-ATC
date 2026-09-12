// ============================================================
//  Data-block placement (01 A10): anchored 45° up-right, leader 18 px from the
//  symbol edge, auto-flip up-left near the right edge, and de-overlap by trying
//  8 candidate angles. Re-positions ease over 200 ms and happen at most once
//  per 2 s per aircraft (A19).
// ============================================================

export const SYMBOL_R = 6;
export const LEADER_LEN = 18;
const COOLDOWN_MS = 2000;
const EASE_MS = 200;
const RIGHT_EDGE_FLIP = 60;

/** Unit direction of each candidate (screen coords, y down). */
const DIRS: Array<[number, number]> = [
  [0.7071, -0.7071], // 0 up-right (default)
  [-0.7071, -0.7071], // 1 up-left
  [0.7071, 0.7071], // 2 down-right
  [-0.7071, 0.7071], // 3 down-left
  [1, 0], // 4 right
  [-1, 0], // 5 left
  [0, -1], // 6 up
  [0, 1], // 7 down
];
const ORDER_RIGHT = [0, 2, 1, 3, 4, 6, 7, 5];
const ORDER_LEFT = [1, 3, 0, 2, 5, 6, 7, 4];

export interface BlockRequest { id: number; sx: number; sy: number; w: number; h: number; priority: number }
export interface BlockPlacement { x: number; y: number; ax: number; ay: number; dir: number }
interface Rect { x: number; y: number; w: number; h: number }

interface State { dir: number; since: number; from: { dx: number; dy: number } | null; to: { dx: number; dy: number }; animStart: number }

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const overlaps = (a: Rect, b: Rect, pad = 2) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

function originFor(dir: number, r: BlockRequest): { dx: number; dy: number; ax: number; ay: number } {
  const [ux, uy] = DIRS[dir];
  const ax = ux * (SYMBOL_R + LEADER_LEN), ay = uy * (SYMBOL_R + LEADER_LEN);
  let dx = ax, dy = ay;
  switch (dir) {
    case 0: dy -= r.h; break;
    case 1: dx -= r.w; dy -= r.h; break;
    case 2: break;
    case 3: dx -= r.w; break;
    case 4: dy -= r.h / 2; break;
    case 5: dx -= r.w; dy -= r.h / 2; break;
    case 6: dx -= r.w / 2; dy -= r.h; break;
    case 7: dx -= r.w / 2; break;
  }
  return { dx, dy, ax, ay };
}

export class LabelPlacer {
  private states = new Map<number, State>();

  place(reqs: BlockRequest[], width: number, now: number): Map<number, BlockPlacement> {
    const out = new Map<number, BlockPlacement>();
    const placed: Rect[] = [];
    // Every symbol is an obstacle for every block.
    const symbols: Rect[] = reqs.map(r => ({ x: r.sx - SYMBOL_R - 4, y: r.sy - SYMBOL_R - 4, w: (SYMBOL_R + 4) * 2, h: (SYMBOL_R + 4) * 2 }));
    const sorted = [...reqs].sort((a, b) => b.priority - a.priority);
    const seen = new Set<number>();

    for (const r of sorted) {
      seen.add(r.id);
      const nearRight = r.sx > width - RIGHT_EDGE_FLIP;
      const order = nearRight ? ORDER_LEFT : ORDER_RIGHT;
      let st = this.states.get(r.id);
      if (!st) { st = { dir: order[0], since: now - COOLDOWN_MS, from: null, to: originFor(order[0], r), animStart: -1 }; this.states.set(r.id, st); }

      const rectFor = (dir: number): Rect => { const o = originFor(dir, r); return { x: r.sx + o.dx, y: r.sy + o.dy, w: r.w, h: r.h }; };
      const clash = (rect: Rect) => placed.some(p => overlaps(p, rect)) || symbols.some((s, i) => reqs[i].id !== r.id && overlaps(s, rect, 0));

      let dir = st.dir;
      const current = rectFor(dir);
      const flipWanted = nearRight ? dir === 0 || dir === 2 || dir === 4 : false;
      if ((clash(current) || flipWanted) && now - st.since >= COOLDOWN_MS) {
        let best = dir, bestScore = Infinity;
        for (const cand of order) {
          const rect = rectFor(cand);
          let score = 0;
          for (const p of placed) if (overlaps(p, rect)) score += 10;
          symbols.forEach((s, i) => { if (reqs[i].id !== r.id && overlaps(s, rect, 0)) score += 6; });
          score += order.indexOf(cand) * 0.5; // prefer the default anchor
          if (score < bestScore) { bestScore = score; best = cand; }
          if (score === 0) break;
        }
        if (best !== dir) {
          const oldO = originFor(dir, r);
          st.from = { dx: oldO.dx, dy: oldO.dy };
          st.to = originFor(best, r);
          st.animStart = now;
          st.dir = best; st.since = now;
          dir = best;
        }
      }

      const o = originFor(dir, r);
      let dx = o.dx, dy = o.dy;
      if (st.from && st.animStart >= 0) {
        const t = Math.min(1, (now - st.animStart) / EASE_MS);
        const e = easeOut(t);
        dx = st.from.dx + (o.dx - st.from.dx) * e;
        dy = st.from.dy + (o.dy - st.from.dy) * e;
        if (t >= 1) { st.from = null; st.animStart = -1; }
      }
      const rect = { x: r.sx + dx, y: r.sy + dy, w: r.w, h: r.h };
      placed.push(rect);
      out.set(r.id, { x: rect.x, y: rect.y, ax: r.sx + o.ax, ay: r.sy + o.ay, dir });
    }
    for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
    return out;
  }
}
