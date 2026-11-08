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
