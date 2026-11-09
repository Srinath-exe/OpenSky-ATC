"""Decoding for the S1 model: greedy generation with the KV cache, prefix caching, and callsign-constrained decoding.

    prompt  = <ctx> game state <said> transcript <cmd>
    output  =  CALLSIGN instruction ... <eos>      (or " SAY AGAIN<eos>")

Constrained decoding: the first tokens of the output must spell a callsign that is in the game state (or SAY AGAIN).
At each of those steps every other token's logit is set to -inf, so the model cannot invent an aircraft, however unsure
it is. It is the same idea as JSON-schema / grammar decoding in llguidance or XGrammar, applied to one field.
"""
import time

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import compat  # noqa: F401  (Python 3.11rc shim, before torch)
import torch


def prompt_text(ctx: str, said: str) -> str:
    return f"<ctx>{ctx}<said> {said}<cmd>"


class CallsignTrie:
    def __init__(self, tok, callsigns: list[str], extra=(" SAY AGAIN",)):
        self.seqs = [tok.encode(" " + cs) for cs in callsigns] + [tok.encode(e) for e in extra]

    def allowed(self, out: list[int]):
        """Token ids allowed next, or None when the output already spells a complete entry (no more constraint)."""
        n = len(out)
        nxt, complete = set(), False
        for s in self.seqs:
            if s[:n] == out:
                if len(s) == n:
                    complete = True
                else:
                    nxt.add(s[n])
        if complete or not nxt:
            return None
        return nxt


@torch.no_grad()
def generate(model, tok, prompt_ids: list[int], max_new: int = 48, prefix=None, trie: CallsignTrie | None = None):
    """Greedy decode. `prefix` = (cache, n) from prefill(): its first n prompt tokens are already in the cache."""
    eos = tok.special["<eos>"]
    dev = next(model.parameters()).device
    if prefix is not None:
        cache_src, n0 = prefix
        caches = [dict(c) for c in cache_src]          # shallow copy: torch.cat makes new tensors, the prefix stays intact
    else:
        caches, n0 = model.new_cache(), 0
    logits = model(torch.tensor([prompt_ids[n0:]], device=dev), caches, start=n0)[0, -1]
    pos, out, constrained = len(prompt_ids), [], trie is not None
    for _ in range(max_new):
        if constrained:
            allowed = trie.allowed(out)
            if allowed is None:
                constrained = False
            else:
                mask = torch.full_like(logits, float("-inf")); mask[list(allowed)] = 0; logits = logits + mask
        nxt = int(logits.argmax())
        if nxt == eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]], device=dev), caches, start=pos)[0, -1]
        pos += 1
    return out


def boundary_ids(tok) -> list[int]:
    """Tokens that end a callsign: anything starting with a space or newline, or <eos> ("UAL12" then " C", not "3")."""
    ids = [i for i in range(tok.size) if (s := tok.decode([i])) and s[0] in " \n"]
    return sorted(set(ids + [tok.special["<eos>"]]))


def callsign_search(first_logits, seqs, step, bound, cap: float = 8.0, norm: bool = False, margin_steps: int = 4, search_max: int = 48):
    """Pick the callsign by its full likelihood (ml/s1/CALLSIGN_SCORING.md), exactly, by best-first search.

    score(cs) = sum of log P(token) over " CS" + log P(word boundary | " CS"), for every candidate in `seqs` (the
    callsigns of the state and " SAY AGAIN"). A prefix's score is an upper bound on every candidate below it (log-probs
    are <= 0), so the first complete candidate popped from a max-queue is the arg-max: the same answer as scoring all of
    them, for about the cost of the greedy trie. The search then goes on until the runner-up is found or nothing left
    can come within `cap` nats, for the margin signal.
    norm=True: the length-normalised score (lp + boundary) / (tokens + 1), searched with the admissible A* bound
    lp(prefix) / (longest candidate below it + 1) (lp <= 0, so a longer divisor only raises it); `cap` is then per token.
    At most `margin_steps` steps go to the runner-up; when they run out the margin is best minus the highest bound left
    in the queue (a lower bound on the true margin). s1.ts marginSteps. A search that needs more than `search_max` steps
    before it finds the best returns None: the caller falls back to the greedy trie (s1.ts searchMax).

    first_logits  logits at <cmd> (predicting the first callsign token)
    step(state, token, pos_offset) -> (logits, state)   feed `token` after the prefix whose model state is `state`
                  (None = the prompt), at prompt length + pos_offset
    Returns {pick, path: [(logits_before, token)], logits, state, best, margin, nodes}; src/lib/voice/s1.ts mirrors it.
    """
    import heapq
    full = {}
    for i, s in enumerate(seqs):
        full.setdefault(tuple(s), i)
    kids, lmax = {}, {}                                 # prefix -> next tokens, in candidate order (ties: first pushed wins)
    for s in seqs:
        for t in range(len(s) + 1):
            lmax[tuple(s[:t])] = max(lmax.get(tuple(s[:t]), 0), len(s))
        for t in range(len(s)):
            nxt = kids.setdefault(tuple(s[:t]), [])
            if s[t] not in nxt:
                nxt.append(s[t])
    bidx = torch.tensor(bound)
    node = {(): (first_logits.double(), None)}          # prefix -> (logits after it, model state)
    lse = {(): float(torch.logsumexp(node[()][0], 0))}
    q, n = [], 0

    def push(lp, kind, p):
        nonlocal n
        pr = (lp / (len(p) + 1) if kind == 1 else lp / (lmax[p] + 1)) if norm else lp
        heapq.heappush(q, (-pr, n, kind, p, lp)); n += 1

    for t in kids[()]:
        push(float(node[()][0][t]) - lse[()], 0, (t,))
    best = best_p = best_lp = None; margin = cap; steps = 0; extra = 0
    while q:
        neg, _, kind, p, sc = heapq.heappop(q); pr = -neg
        if kind == 1:                                   # a complete candidate, boundary included
            if best is None:
                best, best_p, best_lp = pr, p, sc
                continue
            margin = min(best - pr, cap)
            break
        if best is not None and pr < best - cap:
            break
        if best is not None:
            if extra >= margin_steps:
                margin = min(best - pr, cap)
                break
            extra += 1
        elif steps >= search_max:
            return None
        lg, st = step(node[p[:-1]][1], p[-1], len(p) - 1)
        lg = lg.double(); node[p] = (lg, st); lse[p] = float(torch.logsumexp(lg, 0)); steps += 1
        if p in full:
            push(sc + float(torch.logsumexp(lg[bidx], 0)) - lse[p], 1, p)
        for t in kids.get(p, []):
            push(sc + float(lg[t]) - lse[p], 0, p + (t,))
    path = [(node[best_p[:k]][0], best_p[k]) for k in range(len(best_p))]
    return {"pick": full[best_p], "path": path, "logits": node[best_p][0], "state": node[best_p][1], "best": best_lp,
            "margin": margin, "nodes": steps}


@torch.no_grad()
def generate_scored(model, tok, prompt_ids: list[int], callsigns: list[str], max_new: int = 48, prefix=None, cap: float | None = None,
                    bound=None, norm: bool = True):
    """Greedy decode with the callsign chosen by full likelihood (callsign_search), then the rest greedily; the first
    token after the callsign must be a word boundary. Returns (tokens, search info)."""
    eos = tok.special["<eos>"]
    dev = next(model.parameters()).device
    if prefix is not None:
        cache_src, n0 = prefix
        caches = [dict(c) for c in cache_src]
    else:
        caches, n0 = model.new_cache(), 0
    logits = model(torch.tensor([prompt_ids[n0:]], device=dev), caches, start=n0)[0, -1]
    P = len(prompt_ids)
    bound = bound if bound is not None else boundary_ids(tok)
    seqs = CallsignTrie(tok, callsigns).seqs

    def step(state, token, off):
        c = [dict(x) for x in (state if state is not None else caches)]   # torch.cat makes new tensors: parents stay intact
        return model(torch.tensor([[token]], device=dev), c, start=P + off)[0, -1], c

    r = callsign_search(logits, seqs, step, bound, cap if cap is not None else (2.0 if norm else 8.0), norm)
    if r is None:                                       # search too long: the greedy trie, as s1.ts does
        trie = CallsignTrie(tok, callsigns)
        return generate(model, tok, prompt_ids, max_new, prefix=prefix, trie=trie), {"best": None, "margin": None, "nodes": 0}
    out = list(seqs[r["pick"]]); caches = r["state"]; logits = r["logits"].float(); pos = P + len(out)
    bmask = torch.full_like(logits, float("-inf")); bmask[bound] = 0
    logits = logits + bmask
    for _ in range(max_new - len(out)):
        nxt = int(logits.argmax())
        if nxt == eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]], device=dev), caches, start=pos)[0, -1]
        pos += 1
    return out, r


@torch.no_grad()
def generate_no_cache(model, tok, prompt_ids: list[int], max_new: int = 48):
    """The naive way, for the benchmark: re-run the whole sequence for every new token."""
    eos = tok.special["<eos>"]
    dev = next(model.parameters()).device
    ids, out = list(prompt_ids), []
    for _ in range(max_new):
        nxt = int(model(torch.tensor([ids], device=dev))[0, -1].argmax())
        if nxt == eos:
            break
        out.append(nxt); ids.append(nxt)
    return out


@torch.no_grad()
def prefill(model, ids: list[int]):
    """Run a prefix once and keep its KV cache (the game-state context, shared by every utterance in that state)."""
    caches = model.new_cache()
    model(torch.tensor([ids], device=next(model.parameters()).device), caches, start=0)
    return caches, len(ids)


def timed(fn, *a, **k):
    t0 = time.perf_counter(); r = fn(*a, **k); return r, (time.perf_counter() - t0) * 1000
