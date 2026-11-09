"""Run the shipped S1 voice model the way the browser does and record, for every example, its proposal and the
per-token signals a verifier can use (ml/verify/RESULTS.md).

    python3 ml/verify/gen.py --in ml/verify/out/val.in.jsonl --out ml/verify/out/val.gen.jsonl [--hidden]

Weights: public/models/<...>/model.bin dequantized exactly like src/lib/voice/s1.ts (int8 row-wise), so the tokens
are the browser's. Decoding: greedy, first tokens constrained to the callsigns in the state or " SAY AGAIN" (s1.ts).

Per example (input row needs ctx, said = the tidied transcript; optional force = a line to teacher-force instead of
generating, used for hard negatives):
  line, tokens            the proposal
  conf                    the shipped confidence: product over the constrained steps of p(arg-max | allowed), temp T
  cs_margin               min over constrained steps of log p1 - log p2 among the allowed tokens (free, trie margin)
  p_say                   p(" SAY" | allowed) at the first step
  ins_min_p, ins_lp       min prob / summed log prob of the instruction tokens under the full softmax (incl. <eos>)
  dig_min_p, dig_margin   min prob / min log-margin over digit tokens; rwy_min_p over runway letters L/R/C
  cs_lh, cs_lh_margin     the callsign search (--decode score, the default; s1.ts decodeScored): log P(" CS" + word
                          boundary) of the chosen callsign, and its margin over the runner-up (capped); n_search steps
  s1_p, s1_margin         System One style: log P(" CS" | prompt) for EVERY callsign by teacher forcing, softmaxed
                          (s1_p = prob of the chosen one, s1_margin = top-1 minus best other log prob). Costs one extra
                          batched forward here; in the browser ~N_callsigns x 3 token steps.
  hidden (--hidden)       final-norm hidden state at <cmd> and at the last token (predicting <eos>), for a trunk head
"""
import argparse, json, math, re, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer")); sys.path.insert(0, str(ROOT / "ml/data"))
import compat  # noqa: F401,E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from augment import stt_normalise  # noqa: E402
from decode import callsign_search, boundary_ids  # noqa: E402

NORM = 1      # must match S1Model.lengthNorm in src/lib/voice/s1.ts
FILLER_RE = re.compile(r"\b(uh+|um+|erm|er|ah+|hmm+)\b", re.I)


def tidy(raw: str) -> str:
    """src/lib/voice/understand.ts tidyTranscript (the parts that survive sttNormalise)."""
    return re.sub(r"\s+", " ", FILLER_RE.sub(" ", raw)).strip()


def load_web(model_dir: Path):
    meta = json.load(open(model_dir / "model.json")); bin_ = (model_dir / "model.bin").read_bytes()
    sd = {}
    for t in meta["tensors"]:
        n = int(np.prod(t["shape"]))
        if t["dtype"] == "f16":
            w = np.frombuffer(bin_, dtype=np.float16, count=n, offset=t["offset"]).astype(np.float32)
        else:
            q = np.frombuffer(bin_, dtype=np.int8, count=n, offset=t["offset"]).astype(np.float32)
            sc = np.frombuffer(bin_, dtype=np.float32, count=t["shape"][0], offset=t["scale_offset"])
            w = (q.reshape(t["shape"][0], -1) * sc[:, None]).reshape(-1)
        sd[t["name"]] = torch.from_numpy(w.reshape(t["shape"]).copy())
    m = GPT(Config(**meta["config"])); m.load_state_dict(sd); m.eval()
    return m, BPE([tuple(x) for x in meta["merges"]]), float(meta.get("temperature") or 1.0)


def fwd(m, idx, caches, start):
    """GPT.forward, but also returns the final-norm hidden states (B, T, d)."""
    T = idx.shape[1]
    cos, sin = m.cos[start:start + T], m.sin[start:start + T]
    x = m.emb(idx)
    for i, b in enumerate(m.blocks):
        x = b(x, cos, sin, caches[i])
    h = m.norm(x)
    return h, h @ m.emb.weight.T


def copy_cache(c):
    return [dict(x) for x in c]


class Runner:
    def __init__(self, m, tok, T, decode="score", norm=False):
        self.m, self.tok, self.T = m, tok, T
        self.decode, self.norm = decode, norm
        self.cap = 2.0 if norm else 8.0   # s1.ts marginCapNorm / marginCap
        self.bound = boundary_ids(tok)
        self.eos = tok.special["<eos>"]
        self.ctx_key, self.ctx_cache, self.ctx_len = None, None, 0
        strs = [tok.decode([i]) for i in range(tok.size)]
        self.is_digit = np.array([s.strip().isdigit() for s in strs])
        self.is_rwy = np.array([s in ("L", "R", "C") for s in strs])
        self.say_tok = tok.encode(" SAY AGAIN")

    @torch.no_grad()
    def prefill(self, ctx):
        if ctx == self.ctx_key:
            return
        ids = self.tok.encode("<ctx>" + ctx)
        caches = self.m.new_cache()
        fwd(self.m, torch.tensor([ids]), caches, 0)
        self.ctx_key, self.ctx_cache, self.ctx_len = ctx, caches, len(ids)

    @torch.no_grad()
    def run(self, ctx, said, callsigns, force=None, hidden=False, s1=True):
        tok, T = self.tok, self.T
        self.prefill(ctx)
        caches = copy_cache(self.ctx_cache)
        sids = tok.encode("<said> " + stt_normalise(said) + "<cmd>")
        h, lg = fwd(self.m, torch.tensor([sids]), caches, self.ctx_len)
        pos = self.ctx_len + len(sids)
        h_cmd = h[0, -1].clone(); logits = lg[0, -1]
        cache_cmd = copy_cache(caches); pos_cmd = pos; lp_cmd = F.log_softmax(logits.float(), -1)
        seqs = [tok.encode(" " + c) for c in callsigns] + [self.say_tok]
        forced = tok.encode(" " + force) if force is not None else None
        if forced is None and self.decode == "score" and pos + max(len(s) for s in seqs) < self.m.c.max_len:
            r = self.run_scored(seqs, logits, cache_cmd, pos_cmd, h_cmd)
            if r is None:
                r = self.run_trie(seqs, logits, caches, pos, h_cmd, forced)
        else:
            r = self.run_trie(seqs, logits, caches, pos, h_cmd, forced)
        line = r["line"]
        if s1:
            r.update(self.s1_scores(cache_cmd, pos_cmd, lp_cmd, seqs=seqs, chosen=line.split(" ")[0] if line else "", callsigns=callsigns,
                                    forced=forced))
        if hidden:
            r["_h"] = np.concatenate([h_cmd.numpy(), r.pop("_h_last").numpy()]).astype(np.float16)
        else:
            r.pop("_h_last")
        return r

    def _signals(self, out, conf, cs_margin, p_say, cs_full, ins):
        r = {"line": self.tok.decode(out).strip(), "n_tok": len(out), "conf": conf, "cs_margin": (cs_margin if cs_margin < math.inf else 20.0),
             "p_say": p_say if p_say is not None else 0.0, "cs_min_full": min(cs_full) if cs_full else 1.0}
        ip = [x[0] for x in ins]
        r["ins_min_p"] = min(ip) if ip else 1.0
        r["ins_lp"] = sum(math.log(max(p, 1e-12)) for p in ip)
        r["ins_min_margin"] = min((x[1] for x in ins), default=20.0)
        dg = [x for x in ins if x[2]]; rw = [x for x in ins if x[3]]
        r["dig_min_p"] = min((x[0] for x in dg), default=1.0); r["dig_margin"] = min((x[1] for x in dg), default=20.0)
        r["rwy_min_p"] = min((x[0] for x in rw), default=1.0)
        r["eos_p"] = ip[-1] if ins else 0.0
        return r

    def _ins(self, lp, nxt):
        lpn = float(lp[nxt]); top2 = torch.topk(lp, 2)
        other = float(top2.values[1]) if int(top2.indices[0]) == nxt else float(top2.values[0])
        return (math.exp(lpn), lpn - other, bool(self.is_digit[nxt]), bool(self.is_rwy[nxt]))

    @torch.no_grad()
    def run_scored(self, seqs, logits, cache_cmd, pos_cmd, h_cmd):
        """Callsign by full likelihood (decode.callsign_search, as s1.ts decodeScored), then the rest greedily; the first
        token after the callsign must be a word boundary. The old signals are taken along the chosen callsign's path."""
        T = self.T

        def step(state, token, off):
            c = copy_cache(state[0] if state is not None else cache_cmd)
            h, lg = fwd(self.m, torch.tensor([[token]]), c, pos_cmd + off)
            return lg[0, -1], (c, h[0, -1])

        sr = callsign_search(logits, seqs, step, self.bound, self.cap, self.norm)
        if sr is None:                                 # search too long: s1.ts falls back to the trie (signals as trie)
            return None
        out = list(seqs[sr["pick"]])
        conf, cs_margin, p_say, cs_full = 1.0, math.inf, None, []
        for k, (lg, t) in enumerate(sr["path"]):
            al = sorted({s[k] for s in seqs if len(s) > k and s[:k] == out[:k]})
            la = lg[al].float() / T; pa = torch.softmax(la, 0); j = al.index(t)
            conf *= float(pa[j])
            if k == 0 and self.say_tok[0] in al:
                p_say = float(pa[al.index(self.say_tok[0])])
            if len(al) > 1:
                cs_margin = min(cs_margin, float(la[j] - torch.cat([la[:j], la[j + 1:]]).max()))
            cs_full.append(float(F.log_softmax(lg.float(), -1)[t].exp()))
        caches, h_last = sr["state"]
        logits = sr["logits"].float(); pos = pos_cmd + len(out)
        ins = []
        for n in range(len(out), 48):
            lp = F.log_softmax(logits.float(), -1)
            if n == len(seqs[sr["pick"]]):            # right after the callsign: a word boundary
                nxt = self.bound[int(torch.argmax(logits[self.bound]))]
            else:
                nxt = int(torch.argmax(logits))
            ins.append(self._ins(lp, nxt))
            if nxt == self.eos:
                break
            out.append(nxt)
            if pos >= self.m.c.max_len:
                break
            h, lg = fwd(self.m, torch.tensor([[nxt]]), caches, pos)
            pos += 1; logits = lg[0, -1]; h_last = h[0, -1]
        r = self._signals(out, conf, cs_margin, p_say, cs_full, ins)
        r.update({"cs_lh": sr["best"], "cs_lh_margin": sr["margin"], "n_search": sr["nodes"], "_h_last": h_last})
        return r

    @torch.no_grad()
    def run_trie(self, seqs, logits, caches, pos, h_cmd, forced):
        """The first decoder (s1.ts decodeTrie), or teacher forcing `forced`."""
        tok, T = self.tok, self.T
        out, constrained, conf = [], True, 1.0
        cs_margin, p_say = math.inf, None
        cs_full = []           # full-softmax probs of the constrained tokens
        ins = []               # (prob, logmargin, is_digit, is_rwy) for instruction tokens (incl. the final <eos>)
        h_last = h_cmd
        maxn = 48 if forced is None else len(forced) + 1
        for n in range(maxn):
            lp = F.log_softmax(logits.float(), -1)
            nxt = -1
            if constrained:
                allowed, complete = set(), False
                for s in seqs:
                    if len(s) >= len(out) and s[:len(out)] == out:
                        if len(s) == len(out):
                            complete = True
                        else:
                            allowed.add(s[len(out)])
                if complete or not allowed:
                    constrained = False
                else:
                    al = sorted(allowed); la = logits[al].float() / T
                    pa = torch.softmax(la, 0)
                    j = int(torch.argmax(logits[al])) if forced is None else (al.index(forced[n]) if forced[n] in allowed else -1)
                    if j < 0:          # forced line leaves the trie (callsign not in the state): treat as unconstrained
                        constrained = False
                    else:
                        nxt = al[j]; conf *= float(pa[j])
                        if n == 0 and self.say_tok[0] in allowed:
                            p_say = float(pa[al.index(self.say_tok[0])])
                        if len(al) > 1:
                            others = torch.cat([la[:j], la[j + 1:]])
                            cs_margin = min(cs_margin, float(la[j] - others.max()))
                        cs_full.append(float(lp[nxt].exp()))
            if nxt < 0:
                if forced is None:
                    nxt = int(torch.argmax(logits))
                else:
                    nxt = forced[n] if n < len(forced) else self.eos
                lpn = float(lp[nxt]); top2 = torch.topk(lp, 2)
                other = float(top2.values[1]) if int(top2.indices[0]) == nxt else float(top2.values[0])
                ins.append((math.exp(lpn), lpn - other, bool(self.is_digit[nxt]), bool(self.is_rwy[nxt])))
            if nxt == self.eos:
                break
            out.append(nxt)
            if pos >= self.m.c.max_len:
                break
            h, lg = fwd(self.m, torch.tensor([[nxt]]), caches, pos)
            pos += 1; logits = lg[0, -1]; h_last = h[0, -1]
        r = self._signals(out, conf, cs_margin, p_say, cs_full, ins)
        r.update({"cs_lh": None, "cs_lh_margin": None, "n_search": 0, "_h_last": h_last})   # s1.ts: NaN (JSON has none)
        return r

    @torch.no_grad()
    def s1_scores(self, cache, pos, first, seqs, chosen, callsigns, forced=None):
        """log P(" CS" | prompt) for every callsign (and SAY AGAIN), batched teacher forcing from the <cmd> cache.
        `first` = log-probs at <cmd> (they predict each sequence's first token). For a teacher-forced line (hard
        negatives) with the score decoder, also cs_lh / cs_lh_margin of the forced callsign (boundary included; it may
        lose to another candidate, so the margin can be negative; a callsign not in the state gets -cap)."""
        B = len(seqs); L = max(len(s) for s in seqs)
        pad = [s + [0] * (L - len(s)) for s in seqs]
        caches = [{"k": c["k"].expand(B, -1, -1, -1), "v": c["v"].expand(B, -1, -1, -1)} for c in cache]
        _, lg = fwd(self.m, torch.tensor(pad), caches, pos)        # lg[:, t] predicts token t+1
        lp = F.log_softmax(lg.float(), -1)
        scores = []
        for b, s in enumerate(seqs):
            v = float(first[s[0]]) + sum(float(lp[b, t - 1, s[t]]) for t in range(1, len(s)))
            scores.append(v)
        extra = {}
        if forced is not None and self.decode == "score":
            bi = torch.tensor(self.bound)
            fullsc = [v + float(torch.logsumexp(lp[b, len(s) - 1, bi], 0)) for b, (s, v) in enumerate(zip(seqs, scores))]   # lp[b, L-1]: after the last token
            if self.norm:
                fullsc = [v / (len(s) + 1) for s, v in zip(seqs, fullsc)]
            hit = [i for i, s in enumerate(seqs) if forced[:len(s)] == s and (len(forced) == len(s) or forced[len(s)] in set(self.bound))]
            if hit:
                i = max(hit, key=lambda k: len(seqs[k]))
                other = max([v for k, v in enumerate(fullsc) if k != i], default=fullsc[i] - self.cap)
                extra = {"cs_lh": fullsc[i] * ((len(seqs[i]) + 1) if self.norm else 1), "cs_lh_margin": max(-self.cap, min(self.cap, fullsc[i] - other))}
            else:
                extra = {"cs_lh": min(fullsc) - 5.0, "cs_lh_margin": -self.cap}
        sc = torch.tensor(scores[:-1]) if len(scores) > 1 else torch.tensor([0.0])
        p = torch.softmax(sc, 0)
        top = int(torch.argmax(sc))
        j = callsigns.index(chosen) if chosen in callsigns else -1
        srt = sorted(scores[:-1], reverse=True)
        mine = scores[j] if j >= 0 else scores[-1]
        best_other = max([v for i, v in enumerate(scores[:-1]) if i != j], default=-50.0)
        return {"s1_p": float(p[j]) if j >= 0 else 0.0, "s1_margin": mine - best_other, "s1_top_is_chosen": int(top == j),
                "s1_say_lp": scores[-1], "s1_gap12": (srt[0] - srt[1]) if len(srt) > 1 else 20.0, **extra}

    @torch.no_grad()
    def run_row(self, ex, hidden=False, s1=True):
        cs = [l.split()[0] for l in ex["ctx"].split("\n")[1:] if l.strip()]
        # the browser feeds the model understand()'s tidied transcript (fillers out), then sttNormalise
        return self.run(ex["ctx"], tidy(ex["said"]), cs, force=ex.get("force"), hidden=hidden, s1=s1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(ROOT / "public/models/s1/2m-swap-v1"))
    ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=0); ap.add_argument("--hidden", action="store_true"); ap.add_argument("--no-s1", action="store_true")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--decode", choices=["score", "trie"], default="score", help="callsign by full likelihood (s1.ts default) or the greedy trie")
    ap.add_argument("--norm", type=int, default=NORM, help="1 = length-normalised callsign score (s1.ts lengthNorm)")
    ap.add_argument("--patch-fillers", action="store_true", help="redo only the rows whose transcript has a filler, in an existing --out")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    m, tok, T = load_web(Path(a.model))
    R = Runner(m, tok, T, a.decode, bool(a.norm))
    rows = [json.loads(l) for l in open(a.inp)]
    if a.n:
        rows = rows[: a.n]
    t0 = time.time(); H = []
    if a.patch_fillers:
        old = [json.loads(l) for l in open(a.out)]
        hp = a.out.replace(".jsonl", ".h.npy"); Hs = np.load(hp)
        idx = [i for i, ex in enumerate(rows[: len(old)]) if FILLER_RE.search(ex["said"])]
        for n, i in enumerate(idx):
            r = R.run_row(rows[i], hidden=True, s1=not a.no_s1)
            Hs[i] = r.pop("_h"); old[i] = {"id": rows[i].get("id", i), **r}
            if n % 500 == 0:
                print(json.dumps({"patched": n, "of": len(idx), "s": round(time.time() - t0, 1)}), flush=True)
        with open(a.out, "w") as f:
            for r in old:
                f.write(json.dumps(r) + "\n")
        np.save(hp, Hs)
        print(json.dumps({"done": len(idx), "patched": True, "s": round(time.time() - t0, 1)}))
        return
    with open(a.out, "w") as f:
        for i, ex in enumerate(rows):
            r = R.run_row(ex, hidden=a.hidden, s1=not a.no_s1)
            if a.hidden:
                H.append(r.pop("_h"))
            f.write(json.dumps({"id": ex.get("id", i), **r}) + "\n")
            if i % 500 == 0:
                print(json.dumps({"i": i, "n": len(rows), "s": round(time.time() - t0, 1)}), flush=True)
    if a.hidden:
        np.save(a.out.replace(".jsonl", ".h.npy"), np.stack(H))
    print(json.dumps({"done": len(rows), "s": round(time.time() - t0, 1), "out": a.out}))


if __name__ == "__main__":
    main()
