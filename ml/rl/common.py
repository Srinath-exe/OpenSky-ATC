"""Shared pieces for the RL experiments (ml/rl): model loading, the fixed eval sets, the engine reward process,
group sampling with the KV cache, and log-probs of sampled completions.

Every run (GRPO variants, SFT control, baseline) uses exactly these functions, so the numbers are comparable.
"""
import json, os, random, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer")); sys.path.insert(0, str(ROOT / "ml/data"))
import compat  # noqa: F401,E402  (Python 3.11rc shim, before torch)
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import CallsignTrie  # noqa: E402
from train import encode_file, norm_line  # noqa: E402
from augment import stt_normalise  # noqa: E402

START = ROOT / "ml/gpu/results/s1-2m-11ap-swap"
DS = ROOT / "ml/data/out4/ds"
TOK = ROOT / "ml/tokenizer/atc.json"
MAX_LEN = 448


def threads(n=3):
    os.environ.setdefault("OMP_NUM_THREADS", str(n)); torch.set_num_threads(n)


def load_model(run=START, state=None):
    cfg = json.load(open(Path(run) / "config.json"))
    m = GPT(Config(**cfg["model"]))
    m.load_state_dict(state if state is not None else torch.load(Path(run) / "model.pt", map_location="cpu"))
    m.eval()
    return m, cfg


def callsigns(ctx: str) -> list[str]:
    return [l.split()[0] for l in ctx.split("\n")[1:] if l.strip()]


def encode_ex(tok, ex, max_len=MAX_LEN):
    """Same prompt/target encoding and context truncation as ml/s1/train.py encode_file, for one record."""
    tgt = tok.encode(" " + ex["line"]) + [tok.special["<eos>"]]
    said = tok.encode("<said> " + ex["said"] + "<cmd>")
    ctx_lines = ex["ctx"].split("\n")
    while True:
        ctx = tok.encode("<ctx>" + "\n".join(ctx_lines))
        if len(ctx) + len(said) + len(tgt) <= max_len or len(ctx_lines) <= 2:
            break
        ctx_lines = ctx_lines[:-1]
    return ctx + said, tgt, ex


# ---------------------------------------------------------------- fixed eval sets
def eval_sets(tok, n=1000):
    """val and Sydney exactly as ml/s1/train.py picks them (first 2000 rows, shuffled with Random(0), first n), so the
    start checkpoint reproduces its eval.json; plus the 1,000 real-recogniser transcripts (5 recognisers x 200 clips)."""
    val = encode_file(tok, DS / "val.jsonl", MAX_LEN, 2000)
    test = encode_file(tok, DS / "test_airport.jsonl", MAX_LEN, 2000)
    rng = random.Random(0); rng.shuffle(val); rng.shuffle(test)
    d = ROOT / "ml/gpu/results/stt"
    clips = {c["i"]: c for c in json.load(open(d / "clips.json"))}
    stt = []
    for f in sorted(d.glob("*.json")):
        if f.name in ("clips.json", "scores.json"):
            continue
        res = json.load(open(f))
        for r in res["rows"]:
            c = clips[r["i"]]
            ex = {"ctx": c["ctx"], "said": stt_normalise(r["heard"]), "line": c["line"], "kind": "?", "src": "stt:" + res["model"], "icao": "?"}
            stt.append(encode_ex(tok, ex))
    if n < len(stt):                                       # a fixed stratified subset (all recognisers) for in-training evals
        stt = [stt[i] for i in sorted(random.Random(0).sample(range(len(stt)), n))]
    return {"val": val[:n], "sydney": test[:n], "stt": stt}


# ---------------------------------------------------------------- engine process
class Engine:
    """The game's own parser + phraseology in a long-lived node process (ml/rl/reward_server.ts), JSON lines."""

    def __init__(self):
        js = ROOT / "ml/rl/.build/ml/rl/reward_server.js"
        if not js.exists():
            raise SystemExit("compile first: ml/rl/build.sh")
        self.p = subprocess.Popen(["node", str(js)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.n = 0; self.cache = {}

    def parse(self, items):
        """items: [(ctx, line)] -> [{ok, cs, kinds, ast, words, err}]. Memoised (the same line recurs inside a group)."""
        todo = [(c, l) for c, l in items if (c, l) not in self.cache]
        todo = list(dict.fromkeys(todo))
        if todo:
            self.n += 1
            self.p.stdin.write(json.dumps({"id": self.n, "items": [{"ctx": c, "line": l} for c, l in todo]}) + "\n"); self.p.stdin.flush()
            out = json.loads(self.p.stdout.readline())["out"]
            if len(self.cache) > 200_000:
                self.cache.clear()
            for k, o in zip(todo, out):
                self.cache[k] = o
        return [self.cache[k] for k in items]

    def cpu_s(self):
        try:
            f = open(f"/proc/{self.p.pid}/stat").read().split(")")[-1].split()
            return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")
        except Exception:
            return 0.0

    def close(self):
        self.p.kill()


# ---------------------------------------------------------------- batched greedy eval (same decode as decode.generate)
def _expand(caches, b):
    return [{"k": c["k"].expand(b, -1, -1, -1), "v": c["v"].expand(b, -1, -1, -1)} for c in caches]


def mask_row(logits_row, allowed):
    m = torch.full_like(logits_row, float("-inf")); m[list(allowed)] = 0
    return logits_row + m


@torch.no_grad()
def greedy(model, tok, prompt, ctx, max_new=48, constrain=True):
    """Greedy, callsign-constrained: identical to decode.generate (kept here so eval and sampling share one code path)."""
    eos = tok.special["<eos>"]
    trie = CallsignTrie(tok, callsigns(ctx)) if constrain else None
    caches = model.new_cache()
    logits = model(torch.tensor([prompt]), caches, start=0)[0, -1]
    pos, out, on = len(prompt), [], trie is not None
    for _ in range(max_new):
        if on:
            a = trie.allowed(out)
            if a is None:
                on = False
            else:
                logits = mask_row(logits, a)
        nxt = int(logits.argmax())
        if nxt == eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]]), caches, start=pos)[0, -1]; pos += 1
    return out


@torch.no_grad()
def evaluate(model, tok, rows, n=None, keep=False):
    """exact + callsign accuracy with constrained greedy decoding; keep=True also returns per-row predictions."""
    model.eval()
    rows = rows[:n] if n else rows
    hit = cs = 0; preds = []
    t0 = time.perf_counter()
    for prompt, tgt, ex in rows:
        pred = norm_line(tok.decode(greedy(model, tok, prompt, ex["ctx"])))
        gold = norm_line(ex["line"])
        hit += pred == gold; cs += pred.split()[:1] == gold.split()[:1]
        if keep:
            preds.append(pred)
    k = max(1, len(rows))
    r = {"exact": round(hit / k, 4), "callsign": round(cs / k, 4), "n": len(rows), "s": round(time.perf_counter() - t0, 1)}
    return (r, preds) if keep else r


# ---------------------------------------------------------------- group sampling (GRPO rollouts)
@torch.no_grad()
def sample_group(model, tok, prompt, ctx, k=8, temp=1.0, max_new=40, constrain=True):
    """k completions of one prompt in one batch: the prompt is prefilled ONCE, its KV cache is shared by all k rows.
    Returns completions (token lists incl. <eos>), the constraint masks used at each step (so the update can apply the
    same renormalised distribution), and the mean per-token entropy of the sampling distribution."""
    eos = tok.special["<eos>"]
    trie = CallsignTrie(tok, callsigns(ctx)) if constrain else None
    caches = model.new_cache()
    last = model(torch.tensor([prompt]), caches, start=0)[:, -1]                    # (1, V)
    caches = [{"k": c["k"].expand(k, -1, -1, -1).contiguous(), "v": c["v"].expand(k, -1, -1, -1).contiguous()} for c in caches]
    logits = last.expand(k, -1).clone()
    outs = [[] for _ in range(k)]; masks = [[] for _ in range(k)]; on = [trie is not None] * k; done = [False] * k
    ent, ent_n = 0.0, 0
    pos = len(prompt)
    for step in range(max_new):
        for b in range(k):
            a = None
            if on[b] and not done[b]:
                a = trie.allowed([t for t in outs[b]])
                if a is None:
                    on[b] = False
                else:
                    logits[b] = mask_row(logits[b], a)
            masks[b].append(a)
        lp = torch.log_softmax(logits / temp, -1)
        p = lp.exp()
        nxt = torch.multinomial(p, 1)[:, 0]
        e = -(p * torch.where(p > 0, lp, torch.zeros_like(lp))).sum(-1)
        for b in range(k):
            if done[b]:
                continue
            ent += float(e[b]); ent_n += 1
            t = int(nxt[b]); outs[b].append(t)
            if t == eos:
                done[b] = True
        if all(done):
            break
        logits = model(nxt[:, None], caches, start=pos)[:, -1].clone(); pos += 1
    for b in range(k):
        masks[b] = masks[b][:len(outs[b])]
    return outs, masks, ent / max(1, ent_n)


def completion_logprobs(model, prompt, outs, masks, temp=1.0):
    """Per-token log-probs of each completion under `model` (grad flows if enabled). The prompt is run once (B=1) and
    its keys/values are broadcast to the k completions, so a group costs ~ one prompt + k short continuations.
    Returns (k, L) log-probs and a (k, L) float mask of real (non-pad) positions."""
    k = len(outs); L = max(len(o) for o in outs); V = model.c.vocab
    caches = model.new_cache()
    last = model(torch.tensor([prompt]), caches, start=0)[:, -1:]                   # (1, 1, V): predicts token 0
    ids = torch.zeros((k, L), dtype=torch.long); valid = torch.zeros((k, L))
    for b, o in enumerate(outs):
        ids[b, :len(o)] = torch.tensor(o); valid[b, :len(o)] = 1
    if L > 1:
        ex = [{"k": c["k"].expand(k, -1, -1, -1), "v": c["v"].expand(k, -1, -1, -1)} for c in caches]
        rest = model(ids[:, :L - 1], ex, start=len(prompt))                         # (k, L-1, V): predict tokens 1..L-1
        logits = torch.cat([last.expand(k, -1, -1), rest], 1)
    else:
        logits = last.expand(k, -1, -1)
    cm = torch.zeros((k, L, V), dtype=torch.bool)                                    # True = masked out by the trie
    for b in range(k):
        for t, a in enumerate(masks[b]):
            if a is not None:
                cm[b, t] = True; cm[b, t, list(a)] = False
    logits = (logits / temp).masked_fill(cm, float("-inf"))
    lp = torch.log_softmax(logits, -1).gather(-1, ids[:, :, None])[:, :, 0]
    return lp * valid, valid


def proc_cpu_s():
    t = os.times(); return t.user + t.system
