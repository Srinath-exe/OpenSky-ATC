"""Decoding for the masked diffusion LM: start from an all-[MASK] answer canvas and denoise it in S steps.

Each step: one forward pass predicts a token (and a confidence = its probability) at EVERY still-masked position; the
most confident ones are committed and the rest stay masked for the next step. That is LLaDA's "low-confidence
remasking": a prediction that was not confident enough is thrown away (remasked) and predicted again next step, now
conditioned on the tokens committed so far. S = 1 commits everything from one pass (fully parallel); S = L commits one
token per pass (as many passes as an AR model, but in any order).

Two schedules:
  fixed S       commit ceil(remaining / steps_left) tokens per step                       (LLaDA)
  threshold     commit every position with p > tau, at least one per step; S varies         (Fast-dLLM)
`eos_fill`: once <eos> is committed at position j, positions after j are <eos> too (as in every training canvas).

Callsign constraints (an AR model can walk a trie left to right; diffusion has no left-to-right order):
  none    plain argmax
  first   at answer position 0 only the first token of a callsign in the state (or " SAY") is allowed
  span    enumerate the callsigns in the state: score each one's tokens under the step-1 predictions (plus a word
          boundary after it) and commit the best one before anything else. Exact over a small finite set.
  snap    (post-hoc, in evaluate.py) replace a callsign that is not in the state by the nearest one in it

Prompt caching (bidirectional attention makes this an approximation, see bench.py):
  exact   re-run prompt + canvas every step
  prompt  keep the prompt's keys/values from step 1 and run only the canvas afterwards        (Fast-dLLM prefix cache)
  ctx     game state encoded alone while the player talks; at release only transcript + canvas run
"""
import math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dlm  # noqa: F401,E402  (puts ml/s1 on the path, imports compat before torch)
import torch  # noqa: E402


class Vocab:
    """Token-id facts the decoder needs, computed once per tokenizer."""
    def __init__(self, tok, mask_id: int):
        self.tok, self.mask_id = tok, mask_id
        self.eos, self.pad = tok.special["<eos>"], tok.special["<pad>"]
        V = mask_id + 1
        self.ban = torch.zeros(V, dtype=torch.bool)
        for s in ("<pad>", "<bos>", "<ctx>", "<said>", "<cmd>"):
            self.ban[tok.special[s]] = True
        self.ban[mask_id] = True
        self.boundary = torch.zeros(V, dtype=torch.bool)            # tokens that start a new word, or end the line
        for i in range(tok.size):
            b = tok.vocab.get(i, b"")
            self.boundary[i] = b[:1] == b" "
        self.boundary[self.eos] = True
        self.say = tok.encode(" SAY AGAIN")

    def candidates(self, callsigns):
        return [(self.tok.encode(" " + cs), False) for cs in callsigns] + [(self.say, True)]


def callsigns_of(ctx: str):
    return [l.split()[0] for l in ctx.split("\n")[1:] if l.strip()]


def _span_pick(logp, cands, vb: Vocab, L):
    """logp: (L, V) log-probs of one canvas. Best candidate under sum log p(token_j) + log p(boundary after it)."""
    best, best_s = None, -1e30
    pb = torch.logsumexp(logp.masked_fill(~vb.boundary, -1e30), -1)        # (L,) log P(word boundary at j)
    for seq, is_say in cands:
        m = len(seq)
        if m >= L:
            continue
        s = float(logp[torch.arange(m), torch.tensor(seq)].sum()) + float(logp[m, vb.eos] if is_say else pb[m])
        if s > best_s:
            best, best_s = (seq, is_say), s
    return best


def _commit(row_tokens, committed, conf, pred, steps_left, tau, vb: Vocab, L):
    """Commit tokens of one canvas in place. row_tokens: (L,) long, committed: (L,) bool, conf/pred: (L,)."""
    rem = (~committed).nonzero().flatten()
    if len(rem) == 0:
        return []
    c = conf[rem]
    if tau is not None:
        pick = rem[c.exp() > tau]
        if len(pick) == 0:
            pick = rem[c.argmax()][None]
    else:
        k = math.ceil(len(rem) / max(1, steps_left))
        pick = rem[c.topk(min(k, len(rem))).indices]
    row_tokens[pick] = pred[pick]; committed[pick] = True
    return pick.tolist()


def _eos_fill(row_tokens, committed, vb: Vocab):
    e = ((row_tokens == vb.eos) & committed).nonzero().flatten()
    if len(e):
        j = int(e.min())
        row_tokens[j + 1:] = vb.eos; committed[j + 1:] = True


def _scores(logits, vb: Vocab, first_allowed=None, pos0_open=None):
    lg = logits.float().masked_fill(vb.ban, float("-inf"))
    if first_allowed is not None:
        for r, allowed in enumerate(first_allowed):
            if pos0_open[r]:
                keep = torch.full_like(lg[r, 0], float("-inf")); keep[allowed] = 0; lg[r, 0] = lg[r, 0] + keep
    logp = torch.log_softmax(lg, -1)
    conf, pred = logp.max(-1)
    return logp, conf, pred


def _out(row_tokens, vb: Vocab):
    t = row_tokens.tolist()
    return t[:t.index(vb.eos)] if vb.eos in t else t


@torch.no_grad()
def denoise(model, vb: Vocab, prompts, L, S, callsigns=None, constraint="none", tau=None, eos_fill=True, trace=False):
    """Batched decoding with full recompute every step (exact). prompts: list of token lists; callsigns: list of lists.
    Returns (outputs, nfe per row, trace of row 0 or None)."""
    B = len(prompts)
    T = max(len(p) for p in prompts) + L
    x = torch.full((B, T), vb.pad, dtype=torch.long); km = torch.zeros(B, T, dtype=torch.bool)
    for b, p in enumerate(prompts):
        off = T - L - len(p)
        x[b, off:T - L] = torch.tensor(p); km[b, off:] = True
    x[:, T - L:] = vb.mask_id
    canvas = x[:, T - L:]                                    # a view: writes go into x
    committed = torch.zeros(B, L, dtype=torch.bool)
    cands = [vb.candidates(cs) for cs in callsigns] if callsigns is not None else None
    first = [list({s[0] for s, _ in c}) for c in cands] if constraint == "first" else None
    nfe = [0] * B
    steps = L if tau is not None else S
    tr = [] if trace else None
    for s in range(steps):
        act = [b for b in range(B) if not bool(committed[b].all())]
        if not act:
            break
        ai = torch.tensor(act)
        h = model.hidden(x[ai], key_mask=None if B == 1 else km[ai])
        logp, conf, pred = _scores(model.logits(h[:, T - L - 1:T - 1]), vb,
                                   [first[b] for b in act] if first else None, [not bool(committed[b, 0]) for b in act])
        for i, b in enumerate(act):
            nfe[b] += 1
            newly = []
            if s == 0 and constraint == "span":
                seq, is_say = _span_pick(logp[i], cands[b], vb, L)
                m = len(seq)
                canvas[b, :m] = torch.tensor(seq); committed[b, :m] = True; newly += list(range(m))
                if is_say:
                    canvas[b, m] = vb.eos; committed[b, m] = True
            newly += _commit(canvas[b], committed[b], conf[i], pred[i], steps - s, tau, vb, L)
            if eos_fill:
                _eos_fill(canvas[b], committed[b], vb)
            if trace and b == 0:
                tr.append({"committed": sorted(newly), "canvas": [None if not bool(committed[0, j]) else int(canvas[0, j]) for j in range(L)],
                           "conf": [round(float(conf[i, j].exp()), 3) for j in range(L)]})
    return [_out(canvas[b], vb) for b in range(B)], nfe, tr


@torch.no_grad()
def prefill_ctx(model, ctx_ids):
    """Encode the game state alone (while the player is still talking). Returns per-layer (k, v)."""
    keep = []
    model.hidden(torch.tensor([ctx_ids]), keep=keep)
    return keep


@torch.no_grad()
def denoise_cached(model, vb: Vocab, prompt, L, S, callsigns=None, constraint="none", tau=None, mode="prompt", ctx_kv=None, n_ctx=0, eos_fill=True):
    """One example, with a prompt cache. mode 'prompt': step 1 runs prompt + canvas, later steps only the canvas (and
    the last prompt token, whose output predicts canvas position 0). mode 'ctx': ctx_kv (from prefill_ctx over the first
    n_ctx prompt tokens) is reused; step 1 runs transcript + canvas."""
    P = len(prompt)
    x = torch.tensor([prompt + [vb.mask_id] * L])
    committed = torch.zeros(L, dtype=torch.bool)
    canvas = x[0, P:]
    cands = vb.candidates(callsigns) if callsigns is not None else None
    first = [list({s[0] for s, _ in cands})] if constraint == "first" else None
    steps = L if tau is not None else S
    cache, nfe = None, 0
    for s in range(steps):
        if bool(committed.all()):
            break
        if s == 0:
            keep = []
            if mode == "ctx":
                h = model.hidden(x[:, n_ctx:], start=n_ctx, past=ctx_kv, keep=keep)
                cache = [(torch.cat([ck, k[:, :, :P - 1 - n_ctx]], 2), torch.cat([cv, v[:, :, :P - 1 - n_ctx]], 2)) for (ck, cv), (k, v) in zip(ctx_kv, keep)]
                lg = h[:, P - 1 - n_ctx:P - 1 - n_ctx + L]
            else:
                h = model.hidden(x, keep=keep)
                cache = [(k[:, :, :P - 1], v[:, :, :P - 1]) for k, v in keep]
                lg = h[:, P - 1:P - 1 + L]
        else:
            h = model.hidden(x[:, P - 1:], start=P - 1, past=cache)
            lg = h[:, :L]
        nfe += 1
        logp, conf, pred = _scores(model.logits(lg), vb, first, [not bool(committed[0])])
        if s == 0 and constraint == "span":
            seq, is_say = _span_pick(logp[0], cands, vb, L)
            m = len(seq); canvas[:m] = torch.tensor(seq); committed[:m] = True
            if is_say:
                canvas[m] = vb.eos; committed[m] = True
        _commit(canvas, committed, conf[0], pred[0], steps - s, tau, vb, L)
        if eos_fill:
            _eos_fill(canvas, committed, vb)
    return _out(canvas, vb), nfe
