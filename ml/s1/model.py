"""A small GPT-style transformer, written out in full (ml/README.md modules 3 and 4).

Same building blocks as Llama / Qwen, at toy scale so every line can be read:
  * token embedding (tied with the output layer, which saves V*d parameters)
  * N blocks of:  x = x + Attention(RMSNorm(x));  x = x + SwiGLU(RMSNorm(x))      ("pre-norm" residual stream)
  * RoPE: positions are encoded by ROTATING query/key vectors, so attention scores depend on relative distance
  * causal self-attention with an explicit KV cache for generation

KV cache, the key inference idea: when generating token t, the keys and values of tokens 0..t-1 do not change, so we
keep them per layer and only compute q/k/v for the new token. Without the cache every step re-runs the whole sequence
(O(T^2) work over a generation); with it each step is O(T). The cache for a shared prefix (here: the game-state
context) can be computed once and reused for many utterances. That is "prefix caching", which vLLM and SGLang do at
scale.
"""
import math
from dataclasses import dataclass, asdict

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import compat  # noqa: F401  (Python 3.11rc shim, before torch)
import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class Config:
    vocab: int = 2048
    d: int = 256          # model width
    layers: int = 6
    heads: int = 8
    max_len: int = 640
    ffn_mult: float = 8 / 3   # SwiGLU hidden = 8/3 d keeps params equal to a 4d GELU MLP
    dropout: float = 0.0

    def to_dict(self):
        return asdict(self)


class RMSNorm(nn.Module):
    """Scale by the root-mean-square of the features (no mean subtraction, no bias): cheaper than LayerNorm, same effect."""
    def __init__(self, d, eps=1e-6):
        super().__init__(); self.w = nn.Parameter(torch.ones(d)); self.eps = eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.w


def rope_tables(head_dim: int, max_len: int, base: float = 10000.0):
    inv = 1.0 / (base ** (torch.arange(0, head_dim, 2).float() / head_dim))
    ang = torch.outer(torch.arange(max_len).float(), inv)          # (T, head_dim/2): angle = position * frequency
    return ang.cos(), ang.sin()


def apply_rope(x, cos, sin):
    """Rotate each (even, odd) feature pair of q or k by its position's angle. x: (B, H, T, Dh)."""
    x1, x2 = x[..., 0::2], x[..., 1::2]
    return torch.stack((x1 * cos - x2 * sin, x1 * sin + x2 * cos), dim=-1).flatten(-2)


class Attention(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        self.h, self.dh = c.heads, c.d // c.heads
        self.qkv = nn.Linear(c.d, 3 * c.d, bias=False)
        self.out = nn.Linear(c.d, c.d, bias=False)

    def forward(self, x, cos, sin, cache=None):
        B, T, _ = x.shape
        q, k, v = self.qkv(x).view(B, T, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)   # each (B, H, T, Dh)
        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
        if cache is not None:                      # append this step's keys/values to what earlier steps left
            if cache.get("k") is not None:
                k = torch.cat([cache["k"], k], dim=2); v = torch.cat([cache["v"], v], dim=2)
            cache["k"], cache["v"] = k, v
        # queries are the last T positions; with a cache, keys run over the whole history (Tk >= T)
        Tk = k.shape[2]
        if T == 1:
            y = F.scaled_dot_product_attention(q, k, v)                       # one new token sees everything before it
        elif Tk == T:
            y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        else:                                                                 # chunk after a cached prefix
            mask = torch.ones(T, Tk, dtype=torch.bool, device=x.device).tril(diagonal=Tk - T)
            y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        return self.out(y.transpose(1, 2).reshape(B, T, -1))


class SwiGLU(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        hid = int(c.ffn_mult * c.d); hid = (hid + 63) // 64 * 64
        self.gate = nn.Linear(c.d, hid, bias=False); self.up = nn.Linear(c.d, hid, bias=False); self.down = nn.Linear(hid, c.d, bias=False)

    def forward(self, x):
        return self.down(F.silu(self.gate(x)) * self.up(x))


class Block(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        self.n1, self.att, self.n2, self.ffn = RMSNorm(c.d), Attention(c), RMSNorm(c.d), SwiGLU(c)
        self.drop = nn.Dropout(c.dropout)

    def forward(self, x, cos, sin, cache=None):
        x = x + self.drop(self.att(self.n1(x), cos, sin, cache))
        return x + self.drop(self.ffn(self.n2(x)))


class GPT(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        self.c = c
        self.emb = nn.Embedding(c.vocab, c.d)
        self.blocks = nn.ModuleList(Block(c) for _ in range(c.layers))
        self.norm = RMSNorm(c.d)
        cos, sin = rope_tables(c.d // c.heads, c.max_len)
        self.register_buffer("cos", cos, persistent=False); self.register_buffer("sin", sin, persistent=False)
        self.apply(self._init)
        for b in self.blocks:   # scale residual-branch outputs down with depth (GPT-2 trick) so the stream stays stable
            nn.init.normal_(b.att.out.weight, std=0.02 / math.sqrt(2 * c.layers)); nn.init.normal_(b.ffn.down.weight, std=0.02 / math.sqrt(2 * c.layers))

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)

    def params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(self, idx, caches=None, start: int = 0):
        """idx: (B, T) token ids starting at position `start`. caches: list of per-layer dicts (filled in place)."""
        T = idx.shape[1]
        cos, sin = self.cos[start:start + T], self.sin[start:start + T]
        x = self.emb(idx)
        for i, b in enumerate(self.blocks):
            x = b(x, cos, sin, None if caches is None else caches[i])
        return self.norm(x) @ self.emb.weight.T          # tied output projection -> logits (B, T, V)

    def new_cache(self):
        return [dict() for _ in self.blocks]
