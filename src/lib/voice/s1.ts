/*
  S1 in the browser: the tiny transformer, run by hand in TypeScript (docs/spec/11-VOICE-MODEL.md L1, ml/README.md 10).

  No runtime, no WebGPU needed: ~2 M parameters (2 MB int8 on the wire, dequantized to Float32Array at load).
  Everything mirrors ml/s1/model.py + decode.py + tokenizer/bpe.py exactly, so the browser produces the same tokens:
    tokenizer   byte-level BPE (same pre-tokenizer regex, same merge ranks, same specials)
    forward     embeddings -> N x (RMSNorm, causal attention with RoPE, RMSNorm, SwiGLU) -> RMSNorm -> tied logits
    KV cache    preallocated per layer; prefill(state) once, then complete(transcript) reuses it (prefix caching):
                the game state is prefilled while the player is still talking, so release -> answer is ~tens of ms
    decoding    greedy; the first tokens are constrained to the callsigns in the game state (or SAY AGAIN)
    confidence  product of the (temperature-scaled) probabilities of the constrained callsign tokens
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

export interface Completion { line: string; tokens: number[]; confidence: number; ms: number; sayAgain: boolean }

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

  /** Transcript -> command line, constrained to `callsigns` for the first tokens. Uses the prefilled state. */
  complete(said: string, callsigns: string[], maxNew = 48): Completion {
    const t0 = now();
    this.pos = this.prefixLen;
    const ids = this.tok.encode(`<said> ${sttNormalise(said)}<cmd>`);
    for (let i = 0; i < ids.length; i++) this.step(ids[i], i === ids.length - 1);
    const eos = this.tok.special['<eos>'];
    const seqs = [...callsigns.map(c => this.tok.encode(` ${c}`)), this.tok.encode(' SAY AGAIN')];
    const out: number[] = []; let constrained = true; let conf = 1;
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
        }
      }
      if (next < 0) { let mx = -Infinity; for (let i = 0; i < this.V; i++) if (L[i] > mx) { mx = L[i]; next = i; } }
      if (next === eos) break;
      out.push(next);
      if (this.pos >= this.maxLen) break;
      this.step(next, true);
    }
    const line = this.tok.decode(out).trim();
    return { line, tokens: out, confidence: conf, ms: now() - t0, sayAgain: /^SAY AGAIN$/i.test(line) };
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
