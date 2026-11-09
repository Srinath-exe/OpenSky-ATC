/*
  S1 in the browser: the tiny transformer, run by hand in TypeScript (docs/spec/11-VOICE-MODEL.md L1, ml/README.md 10).

  No runtime, no WebGPU needed: ~2 M parameters (2 MB int8 on the wire, dequantized to Float32Array at load).
  Everything mirrors ml/s1/model.py + decode.py + tokenizer/bpe.py exactly, so the browser produces the same tokens:
    tokenizer   byte-level BPE (same pre-tokenizer regex, same merge ranks, same specials)
    forward     embeddings -> N x (RMSNorm, causal attention with RoPE, RMSNorm, SwiGLU) -> RMSNorm -> tied logits
    KV cache    preallocated per layer; prefill(state) once, then complete(transcript) reuses it (prefix caching):
                the game state is prefilled while the player is still talking, so release -> answer is ~tens of ms
    callsign    chosen by its full likelihood: every callsign in the state (or SAY AGAIN) is scored by the sum of its
                token log-probs + log P(word boundary), by an exact best-first search over the callsign trie that
                branches the KV cache per prefix (ml/s1/CALLSIGN_SCORING.md); callsignMode = 'trie' keeps the first
                decoder (greedy, one token at a time, constrained to the trie)
    decoding    the rest of the line greedily
    confidence  product of the (temperature-scaled) probabilities of the callsign tokens among the allowed ones
    signals     per-token evidence for the verifier (margins, lowest probabilities), a side channel of the same decode
  Pure module, no DOM: runs in a Web Worker (s1.worker.ts) and in the Node parity test.
*/

export interface S1Meta {
  format: string;
  config: { vocab: number; d: number; layers: number; heads: number; max_len: number; ffn_mult: number };
  quant: string; temperature: number; specials: string[]; merges: [number, number][];
  tensors: { name: string; shape: number[]; offset: number; dtype: 'f16' | 'i8'; bytes: number; scale_offset?: number }[];
}

// ---------- tokenizer ----------
const PRETOK = /\n| ?[A-Za-z]+| ?\d| ?[^\sA-Za-z\d]+|\s+(?!\S)|\s+/g;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Tokenizer {
  readonly special: Record<string, number> = {};
  private rank = new Map<number, number>();
  private vocab: Uint8Array[] = [];
  private cache = new Map<string, number[]>();
  private base: number;
  constructor(specials: string[], merges: [number, number][]) {
    for (let i = 0; i < 256; i++) this.vocab[i] = Uint8Array.of(i);
    specials.forEach((s, i) => { this.special[s] = 256 + i; this.vocab[256 + i] = enc.encode(s); });
    this.base = 256 + specials.length;
    merges.forEach(([a, b], i) => {
      this.rank.set(a * 65536 + b, i);
      const va = this.vocab[a], vb = this.vocab[b], v = new Uint8Array(va.length + vb.length); v.set(va); v.set(vb, va.length);
      this.vocab[this.base + i] = v;
    });
  }
  private chunk(c: string): number[] {
    const hit = this.cache.get(c); if (hit) return hit;
    let ids = Array.from(enc.encode(c));
    while (ids.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < ids.length - 1; i++) { const r = this.rank.get(ids[i] * 65536 + ids[i + 1]); if (r !== undefined && r < bestRank) { bestRank = r; best = i; } }
      if (best < 0) break;
      ids = [...ids.slice(0, best), this.base + bestRank, ...ids.slice(best + 2)];
    }
    this.cache.set(c, ids); return ids;
  }
  encode(text: string): number[] {
    const out: number[] = [];
    for (const part of text.split(/(<pad>|<bos>|<eos>|<ctx>|<said>|<cmd>)/)) {
      if (!part) continue;
      if (part in this.special) { out.push(this.special[part]); continue; }
      for (const m of part.matchAll(PRETOK)) out.push(...this.chunk(m[0]));
    }
    return out;
  }
  decode(ids: number[]): string {
    const parts = ids.map(i => this.vocab[i]); const n = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(n); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    return dec.decode(buf);
  }
}

/** Same as ml/data/augment.py stt_normalise(): what both training and inference apply to a transcript. */
export function sttNormalise(s: string): string {
  return s.toLowerCase().replace(/’/g, "'").replace(/(\w)-(\w)/g, '$1 $2').replace(/[^\w\s.]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- model ----------
function f16(h: number): number {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

interface Layer { n1: Float32Array; qkv: Float32Array; out: Float32Array; n2: Float32Array; gate: Float32Array; up: Float32Array; down: Float32Array; k: Float32Array; v: Float32Array }

/** Per-token evidence from the decode, for the verifier (src/lib/voice/verify.ts; same definitions as ml/verify/gen.py).
 *  Read-only side channel: computing it never changes which token is chosen. */
export interface Signals {
  csMargin: number;      // min over constrained steps of (logit chosen - best other allowed logit) / T (20 if never a choice)
  pSay: number;          // p(" SAY" | allowed tokens) at the first step
  csMinFull: number;     // min full-vocabulary probability of the constrained (callsign) tokens
  insMinP: number;       // min full-vocabulary probability of the instruction tokens, <eos> included
  insLp: number;         // their summed log probability
  insMinMargin: number;  // min log-prob margin chosen vs runner-up over the instruction tokens
  digMinP: number; digMargin: number;   // the same two over digit tokens only
  rwyMinP: number;       // min probability of a runway-side letter L / R / C
  eosP: number;          // probability of the final token (normally <eos>)
  nTok: number;
  csLh: number;          // log P(" CS" + word boundary) of the chosen callsign ('score' mode; NaN in 'trie' mode)
  csLhMargin: number;    // chosen minus runner-up score (per token with lengthNorm), capped at marginCap (NaN in 'trie' mode)
  nSearch: number;       // model steps the callsign search took (0 in 'trie' mode)
}

/** 'score': callsign by full likelihood (best-first, exact). 'trie': greedy through the callsign trie (the first decoder). */
export type CallsignMode = 'score' | 'trie';

export interface Completion { line: string; tokens: number[]; confidence: number; ms: number; sayAgain: boolean; signals: Signals }

export class S1Model {
  readonly tok: Tokenizer;
  readonly d: number; readonly H: number; readonly dh: number; readonly hid: number; readonly V: number; readonly maxLen: number; readonly T: number;
  private emb: Float32Array; private normW: Float32Array; private layers: Layer[];
  private cos: Float32Array; private sin: Float32Array;
  private pos = 0; private prefixLen = 0; private prefixIds: number[] = [];
  // scratch buffers
  private x: Float32Array; private h: Float32Array; private qkvB: Float32Array; private att: Float32Array; private o: Float32Array; private g: Float32Array; private u: Float32Array; private sc: Float32Array; private logits: Float32Array;

  constructor(meta: S1Meta, bin: ArrayBuffer) {
    const c = meta.config;
    this.d = c.d; this.H = c.heads; this.dh = c.d / c.heads; this.V = c.vocab; this.maxLen = c.max_len; this.T = meta.temperature || 1;
    this.hid = Math.ceil(Math.floor(c.ffn_mult * c.d) / 64) * 64;
    this.tok = new Tokenizer(meta.specials, meta.merges);
    const W = new Map<string, Float32Array>();
    for (const t of meta.tensors) {
      const n = t.shape.reduce((a, b) => a * b, 1), out = new Float32Array(n);
      if (t.dtype === 'f16') { const v = new Uint16Array(bin, t.offset, n); for (let i = 0; i < n; i++) out[i] = f16(v[i]); }
      else {
        const q = new Int8Array(bin, t.offset, n), rows = t.shape[0], cols = n / rows, sc = new Float32Array(bin, t.scale_offset!, rows);
        for (let r = 0; r < rows; r++) for (let j = 0; j < cols; j++) out[r * cols + j] = q[r * cols + j] * sc[r];
      }
      W.set(t.name, out);
    }
    const get = (k: string) => { const w = W.get(k); if (!w) throw new Error(`missing tensor ${k}`); return w; };
    this.emb = get('emb.weight'); this.normW = get('norm.w');
    this.layers = Array.from({ length: c.layers }, (_, i) => ({
      n1: get(`blocks.${i}.n1.w`), qkv: get(`blocks.${i}.att.qkv.weight`), out: get(`blocks.${i}.att.out.weight`), n2: get(`blocks.${i}.n2.w`),
      gate: get(`blocks.${i}.ffn.gate.weight`), up: get(`blocks.${i}.ffn.up.weight`), down: get(`blocks.${i}.ffn.down.weight`),
      k: new Float32Array(this.maxLen * this.d), v: new Float32Array(this.maxLen * this.d),
    }));
    const half = this.dh / 2; this.cos = new Float32Array(this.maxLen * half); this.sin = new Float32Array(this.maxLen * half);
    for (let p = 0; p < this.maxLen; p++) for (let j = 0; j < half; j++) { const a = p / 10000 ** ((2 * j) / this.dh); this.cos[p * half + j] = Math.cos(a); this.sin[p * half + j] = Math.sin(a); }
    this.x = new Float32Array(this.d); this.h = new Float32Array(this.d); this.qkvB = new Float32Array(3 * this.d); this.att = new Float32Array(this.d); this.o = new Float32Array(this.d);
    this.g = new Float32Array(this.hid); this.u = new Float32Array(this.hid); this.sc = new Float32Array(this.maxLen); this.logits = new Float32Array(this.V);
  }

  static async load(baseUrl: string, fetcher: typeof fetch = fetch): Promise<S1Model> {
    const [meta, bin] = await Promise.all([fetcher(`${baseUrl}/model.json`).then(r => r.json()), fetcher(`${baseUrl}/model.bin`).then(r => r.arrayBuffer())]);
    return new S1Model(meta as S1Meta, bin);
  }

  private matvec(W: Float32Array, x: Float32Array, out: Float32Array, rows: number, cols: number) {
    for (let r = 0; r < rows; r++) { let s = 0; const o = r * cols; for (let j = 0; j < cols; j++) s += W[o + j] * x[j]; out[r] = s; }
  }
  private rms(x: Float32Array, w: Float32Array, out: Float32Array) {
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const k = 1 / Math.sqrt(s / x.length + 1e-6); for (let i = 0; i < x.length; i++) out[i] = x[i] * k * w[i];
  }
  private rope(v: Float32Array, base: number, p: number) {
    const half = this.dh / 2, c = this.cos, s = this.sin, o = p * half;
    for (let hh = 0; hh < this.H; hh++) {
      const b = base + hh * this.dh;
      for (let j = 0; j < half; j++) { const x1 = v[b + 2 * j], x2 = v[b + 2 * j + 1], cc = c[o + j], ss = s[o + j]; v[b + 2 * j] = x1 * cc - x2 * ss; v[b + 2 * j + 1] = x1 * ss + x2 * cc; }
    }
  }

  /** Feed one token at the current position; fills this.logits when `wantLogits`. */
  private step(token: number, wantLogits: boolean) {
    const { d, H, dh, hid, x, h, qkvB, att, o, g, u, sc } = this; const p = this.pos;
    if (p >= this.maxLen) throw new Error('sequence too long');
    x.set(this.emb.subarray(token * d, token * d + d));
    const scale = 1 / Math.sqrt(dh);
    for (const L of this.layers) {
      this.rms(x, L.n1, h);
      this.matvec(L.qkv, h, qkvB, 3 * d, d);
      this.rope(qkvB, 0, p); this.rope(qkvB, d, p);
      L.k.set(qkvB.subarray(d, 2 * d), p * d); L.v.set(qkvB.subarray(2 * d, 3 * d), p * d);
      for (let hh = 0; hh < H; hh++) {
        const qo = hh * dh; let mx = -Infinity;
        for (let t = 0; t <= p; t++) { let s = 0; const ko = t * d + qo; for (let j = 0; j < dh; j++) s += qkvB[qo + j] * L.k[ko + j]; s *= scale; sc[t] = s; if (s > mx) mx = s; }
        let sum = 0; for (let t = 0; t <= p; t++) { sc[t] = Math.exp(sc[t] - mx); sum += sc[t]; }
        for (let j = 0; j < dh; j++) att[qo + j] = 0;
        for (let t = 0; t <= p; t++) { const w = sc[t] / sum, vo = t * d + qo; for (let j = 0; j < dh; j++) att[qo + j] += w * L.v[vo + j]; }
      }
      this.matvec(L.out, att, o, d, d); for (let i = 0; i < d; i++) x[i] += o[i];
      this.rms(x, L.n2, h);
      this.matvec(L.gate, h, g, hid, d); this.matvec(L.up, h, u, hid, d);
      for (let i = 0; i < hid; i++) { const gi = g[i]; g[i] = (gi / (1 + Math.exp(-gi))) * u[i]; }
      this.matvec(L.down, g, o, d, hid); for (let i = 0; i < d; i++) x[i] += o[i];
    }
    this.pos = p + 1;
    if (wantLogits) { this.rms(x, this.normW, h); this.matvec(this.emb, h, this.logits, this.V, d); }
  }

  /** Prefill "<ctx>{state}" and keep its KV cache; later complete() calls start from here. Returns the ms it took. */
  prefill(ctx: string): number {
    const t0 = now();
    const ids = this.tok.encode(`<ctx>${ctx}`);
    let k = 0;   // reuse the longest common prefix with what is already cached (the state changes a little each second)
    if (this.prefixLen) while (k < ids.length && k < this.prefixLen && ids[k] === this.prefixIds[k]) k++;
    this.pos = k;
    for (let i = k; i < ids.length; i++) this.step(ids[i], false);
    this.prefixIds = ids; this.prefixLen = ids.length;
    return now() - t0;
  }

  /** How the callsign is chosen (see CallsignMode); 'score' unless set. */
  callsignMode: CallsignMode = 'score';
  /** Length-normalised score: (log-prob + boundary) / (tokens + 1) instead of the sum (ml/s1/CALLSIGN_SCORING.md). */
  lengthNorm = true;
  /** The search goes on for the runner-up until nothing left can come within this many nats (per token with lengthNorm);
   *  csLhMargin is capped here. */
  marginCap = 8; marginCapNorm = 2;
  /** At most this many model steps go to finding the runner-up; when they run out, csLhMargin is the best minus the
   *  highest bound still in the queue (a lower bound on the true margin), so the extra latency stays bounded. */
  marginSteps = 4;
  /** Safety bound: a search that needs more steps than this (a very long, very unsure state) falls back to the trie. */
  searchMax = 48;

  /** Transcript -> command line; the first tokens spell one of `callsigns` (or SAY AGAIN). Uses the prefilled state. */
  complete(said: string, callsigns: string[], maxNew = 48, mode: CallsignMode = this.callsignMode): Completion {
    const t0 = now();
    this.pos = this.prefixLen;
    const ids = this.tok.encode(`<said> ${sttNormalise(said)}<cmd>`);
    for (let i = 0; i < ids.length; i++) this.step(ids[i], i === ids.length - 1);
    const seqs = [...callsigns.map(c => this.tok.encode(` ${c}`)), this.tok.encode(' SAY AGAIN')];
    let longest = 0; for (const s of seqs) longest = Math.max(longest, s.length);
    const P = this.pos;
    let r = mode === 'score' && P + longest < this.maxLen ? this.decodeScored(seqs, maxNew) : null;
    if (!r) { if (this.pos !== P) { this.pos = P; this.logits.set(this.nodeLg[0]); } r = this.decodeTrie(seqs, maxNew); }
    const line = this.tok.decode(r.out).trim();
    return { line, tokens: r.out, confidence: r.conf, ms: now() - t0, sayAgain: /^SAY AGAIN$/i.test(line), signals: r.sg };
  }

  /** The first decoder: greedy, each callsign token the arg-max among the trie's allowed next tokens. */
  private decodeTrie(seqs: number[][], maxNew: number): { out: number[]; conf: number; sg: Signals } {
    const eos = this.tok.special['<eos>'];
    const out: number[] = []; let constrained = true; let conf = 1;
    const say0 = seqs[seqs.length - 1][0];
    const sg: Signals = { csMargin: Infinity, pSay: 0, csMinFull: 1, insMinP: 1, insLp: 0, insMinMargin: Infinity, digMinP: 1, digMargin: Infinity, rwyMinP: 1, eosP: 0, nTok: 0, csLh: NaN, csLhMargin: NaN, nSearch: 0 };
    let nIns = 0;
    for (let n = 0; n < maxNew; n++) {
      const L = this.logits;
      let next = -1;
      if (constrained) {
        const allowed = new Set<number>(); let complete = false;
        for (const s of seqs) { if (s.length >= out.length && out.every((t, i) => s[i] === t)) { if (s.length === out.length) complete = true; else allowed.add(s[out.length]); } }
        if (complete || !allowed.size) constrained = false;
        else {
          let mx = -Infinity; for (const a of allowed) if (L[a] > mx) { mx = L[a]; next = a; }
          let z = 0; for (const a of allowed) z += Math.exp((L[a] - mx) / this.T);
          conf *= 1 / z;   // probability of the arg-max among the allowed tokens, temperature-scaled
          if (n === 0 && allowed.has(say0)) sg.pSay = Math.exp((L[say0] - mx) / this.T) / z;
          let second = -Infinity; for (const a of allowed) if (a !== next && L[a] > second) second = L[a];
          if (second > -Infinity) sg.csMargin = Math.min(sg.csMargin, (mx - second) / this.T);
          sg.csMinFull = Math.min(sg.csMinFull, Math.exp(L[next] - this.logSumExp(L)));
        }
      }
      if (next < 0) {
        let mx = -Infinity, second = -Infinity;
        for (let i = 0; i < this.V; i++) { const v = L[i]; if (v > mx) { second = mx; mx = v; next = i; } else if (v > second) second = v; }
        const lp = mx - this.logSumExp(L), p = Math.exp(lp), margin = mx - second, kind = this.tokenKind(next);
        sg.insMinP = Math.min(sg.insMinP, p); sg.insLp += lp; sg.insMinMargin = Math.min(sg.insMinMargin, margin); sg.eosP = p; nIns++;
        if (kind === 1) { sg.digMinP = Math.min(sg.digMinP, p); sg.digMargin = Math.min(sg.digMargin, margin); }
        else if (kind === 2) sg.rwyMinP = Math.min(sg.rwyMinP, p);
      }
      if (next === eos) break;
      out.push(next);
      if (this.pos >= this.maxLen) break;
      this.step(next, true);
    }
    if (sg.csMargin === Infinity) sg.csMargin = 20;
    if (sg.insMinMargin === Infinity) sg.insMinMargin = 20;
    if (sg.digMargin === Infinity) sg.digMargin = 20;
    if (!nIns) sg.eosP = 0;
    sg.nTok = out.length;
    return { out, conf, sg };
  }

  // per searched trie node: its keys/values in every layer (layers x [k d, v d]) and the logits after it
  private nodeKV: Float32Array[] = []; private nodeLg: Float32Array[] = [];
  private bound: number[] | null = null;
  /** Tokens that end a callsign: anything starting with a space or newline, or <eos> (ml/s1/decode.py boundary_ids). */
  private boundary(): number[] {
    if (!this.bound) {
      const b: number[] = []; const eos = this.tok.special['<eos>'];
      for (let i = 0; i < this.V; i++) { const s = this.tok.decode([i]); if (i === eos || s[0] === ' ' || s[0] === '\n') b.push(i); }
      this.bound = b;
    }
    return this.bound;
  }

  /**
   * Callsign by full likelihood, then the rest greedily (ml/s1/decode.py callsign_search + generate_scored, same order).
   * score(candidate) = sum of its token log-probs + log P(word boundary after it). A prefix's score bounds every
   * candidate below it (log-probs <= 0), so best-first over the trie pops the arg-max first: exactly what scoring every
   * callsign gives, for about the steps of the greedy trie. Each popped prefix is one step(); the KV cache is branched
   * by saving each node's keys/values and copying its ancestors' back into positions P.. before stepping it.
   */
  private decodeScored(seqs: number[][], maxNew: number): { out: number[]; conf: number; sg: Signals } | null {
    const P = this.pos, d = this.d, nl = this.layers.length, V = this.V, T = this.T, eos = this.tok.special['<eos>'];
    // the trie: node 0 = root; children in candidate order
    const tok = [-1], par = [-1], dep = [-1], kids: number[][] = [[]], full = [-1], lmax = [0];
    seqs.forEach((s, si) => {
      let cur = 0; lmax[0] = Math.max(lmax[0], s.length);
      for (const t of s) {
        let nx = -1; for (const c of kids[cur]) if (tok[c] === t) { nx = c; break; }
        if (nx < 0) { nx = tok.length; tok.push(t); par.push(cur); dep.push(dep[cur] + 1); kids.push([]); full.push(-1); lmax.push(0); kids[cur].push(nx); }
        cur = nx; lmax[cur] = Math.max(lmax[cur], s.length);
      }
      if (full[cur] < 0) full[cur] = si;
    });
    // priority: the score itself, or with lengthNorm the A* bound lp / (longest candidate below + 1) (lp <= 0)
    const norm = this.lengthNorm;
    const pri = (lp: number, n: number) => (norm ? lp / (lmax[n] + 1) : lp);
    const slot = new Int32Array(tok.length).fill(-1);
    const lg0 = this.slotLogits(0); lg0.set(this.logits);
    let used = 1;                                      // logits slot 0 = at <cmd>; node slots from 1
    const lgOf = (n: number) => (n === 0 ? lg0 : this.nodeLg[slot[n]]);
    // max-queue as a plain array (tens of entries): ties go to the first pushed, as heapq with a counter does
    const qp: number[] = [], qs: number[] = [], qk: number[] = [], qn: number[] = [];   // priority, log-prob, kind, node
    const push = (p: number, sc: number, kind: number, n: number) => { qp.push(p); qs.push(sc); qk.push(kind); qn.push(n); };
    const lse0 = this.logSumExp(lg0);
    for (const c of kids[0]) { const sc = lg0[tok[c]] - lse0; push(pri(sc, c), sc, 0, c); }
    const bnd = this.boundary(), cap = norm ? this.marginCapNorm : this.marginCap;
    let best = NaN, bestLp = NaN, bestN = -1, margin = cap, steps = 0, extra = 0;
    while (qp.length) {
      let j = 0; for (let i = 1; i < qp.length; i++) if (qp[i] > qp[j]) j = i;
      const pr = qp[j], sc = qs[j], kind = qk[j], n = qn[j]; qp.splice(j, 1); qs.splice(j, 1); qk.splice(j, 1); qn.splice(j, 1);
      if (kind === 1) { if (bestN < 0) { best = pr; bestLp = sc; bestN = n; continue; } margin = Math.min(best - pr, cap); break; }
      if (bestN >= 0 && pr < best - cap) break;
      if (bestN >= 0 && extra++ >= this.marginSteps) { margin = Math.min(best - pr, cap); break; }
      if (bestN < 0 && steps >= this.searchMax) return null;   // complete() falls back to the trie from <cmd>
      this.loadPath(par[n], P, dep, par, slot);
      this.pos = P + dep[n]; this.step(tok[n], true); steps++;
      const s = used++; slot[n] = s; const kv = this.slotKV(s), L = this.slotLogits(s); L.set(this.logits);
      const o = (P + dep[n]) * d;
      for (let l = 0; l < nl; l++) { kv.set(this.layers[l].k.subarray(o, o + d), 2 * l * d); kv.set(this.layers[l].v.subarray(o, o + d), (2 * l + 1) * d); }
      const lse = this.logSumExp(L);
      if (full[n] >= 0) {
        let mb = -Infinity; for (const b of bnd) if (L[b] > mb) mb = L[b];
        let zb = 0; for (const b of bnd) zb += Math.exp(L[b] - mb);
        const done = sc + mb + Math.log(zb) - lse;
        push(norm ? done / (dep[n] + 2) : done, done, 1, n);
      }
      for (const c of kids[n]) { const s2 = sc + L[tok[c]] - lse; push(pri(s2, c), s2, 0, c); }
    }
    // the winner's path: its keys/values back at P.., its logits, and the old per-step signals along it
    const path: number[] = []; for (let n = bestN; n > 0; n = par[n]) path.unshift(n);
    this.loadPath(bestN, P, dep, par, slot); this.pos = P + path.length; this.logits.set(lgOf(bestN));
    const sg: Signals = { csMargin: Infinity, pSay: 0, csMinFull: 1, insMinP: 1, insLp: 0, insMinMargin: Infinity, digMinP: 1, digMargin: Infinity, rwyMinP: 1, eosP: 0, nTok: 0,
      csLh: bestLp, csLhMargin: margin, nSearch: steps };
    const say0 = seqs[seqs.length - 1][0];
    let conf = 1;
    for (const n of path) {
      const L = lgOf(par[n]), c = tok[n], al = kids[par[n]];
      let mx = -Infinity; for (const a of al) if (L[tok[a]] > mx) mx = L[tok[a]];
      let z = 0; for (const a of al) z += Math.exp((L[tok[a]] - mx) / T);
      conf *= Math.exp((L[c] - mx) / T) / z;
      if (par[n] === 0 && al.some(a => tok[a] === say0)) sg.pSay = Math.exp((L[say0] - mx) / T) / z;
      let second = -Infinity; for (const a of al) if (tok[a] !== c && L[tok[a]] > second) second = L[tok[a]];
      if (second > -Infinity) sg.csMargin = Math.min(sg.csMargin, (L[c] - second) / T);
      sg.csMinFull = Math.min(sg.csMinFull, Math.exp(L[c] - this.logSumExp(L)));
    }
    const out = path.map(n => tok[n]);
    let nIns = 0;
    for (let n = out.length; n < maxNew; n++) {
      const L = this.logits;
      let mx = -Infinity, second = -Infinity, top = -1;
      for (let i = 0; i < V; i++) { const v = L[i]; if (v > mx) { second = mx; mx = v; top = i; } else if (v > second) second = v; }
      let next = top;
      if (n === path.length) {     // right after the callsign: a word boundary (the callsign is complete)
        let mb = -Infinity; for (const b of bnd) if (L[b] > mb) { mb = L[b]; next = b; }
      }
      const lp = L[next] - this.logSumExp(L), p = Math.exp(lp), margin2 = next === top ? mx - second : L[next] - mx, kind = this.tokenKind(next);
      sg.insMinP = Math.min(sg.insMinP, p); sg.insLp += lp; sg.insMinMargin = Math.min(sg.insMinMargin, margin2); sg.eosP = p; nIns++;
      if (kind === 1) { sg.digMinP = Math.min(sg.digMinP, p); sg.digMargin = Math.min(sg.digMargin, margin2); }
      else if (kind === 2) sg.rwyMinP = Math.min(sg.rwyMinP, p);
      if (next === eos) break;
      out.push(next);
      if (this.pos >= this.maxLen) break;
      this.step(next, true);
    }
    if (sg.csMargin === Infinity) sg.csMargin = 20;
    if (sg.insMinMargin === Infinity) sg.insMinMargin = 20;
    if (sg.digMargin === Infinity) sg.digMargin = 20;
    if (!nIns) sg.eosP = 0;
    sg.nTok = out.length;
    return { out, conf, sg };
  }

  /** Copy the saved keys/values of node n and its ancestors back into the cache at positions P + depth. */
  private loadPath(n: number, P: number, dep: number[], par: number[], slot: Int32Array) {
    const d = this.d;
    for (; n > 0; n = par[n]) {
      const kv = this.nodeKV[slot[n]], o = (P + dep[n]) * d;
      this.layers.forEach((L, l) => { L.k.set(kv.subarray(2 * l * d, (2 * l + 1) * d), o); L.v.set(kv.subarray((2 * l + 1) * d, (2 * l + 2) * d), o); });
    }
  }
  private slotKV(s: number): Float32Array { while (this.nodeKV.length <= s) this.nodeKV.push(new Float32Array(2 * this.layers.length * this.d)); return this.nodeKV[s]; }
  private slotLogits(s: number): Float32Array { while (this.nodeLg.length <= s) this.nodeLg.push(new Float32Array(this.V)); return this.nodeLg[s]; }

  private logSumExp(L: Float32Array): number {
    let mx = -Infinity; for (let i = 0; i < this.V; i++) if (L[i] > mx) mx = L[i];
    let z = 0; for (let i = 0; i < this.V; i++) z += Math.exp(L[i] - mx);
    return mx + Math.log(z);
  }

  private kinds: Uint8Array | null = null;
  /** 1 = digit token, 2 = runway-side letter (L/R/C), 0 = other. */
  private tokenKind(t: number): number {
    if (!this.kinds) {
      this.kinds = new Uint8Array(this.V);
      for (let i = 0; i < this.V; i++) { const s = this.tok.decode([i]); this.kinds[i] = /^\d+$/.test(s.trim()) ? 1 : s === 'L' || s === 'R' || s === 'C' ? 2 : 0; }
    }
    return this.kinds[t];
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
