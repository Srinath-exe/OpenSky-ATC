"""A masked diffusion language model (MDLM / LLaDA style) built from the S1 blocks (ml/README.md module 8).

What changes from the autoregressive S1 model (ml/s1/model.py), and nothing else:
  * attention is BIDIRECTIONAL: no causal mask, every position sees every other one (pads are masked out as keys)
  * one extra token, [MASK] (id = tokenizer size), meaning "this answer position is not decided yet"
  * the answer is a fixed canvas of L positions: the command-line tokens, then <eos> repeated to the end

Forward (noising) process: pick t in (0, 1) and replace each answer token by [MASK] independently with probability t.
t = 0 is the clean answer, t = 1 is all masks. The prompt (game state + transcript) is never masked.
Reverse (denoising) process: the network sees the partly masked canvas and predicts the clean token at every masked
position at once. Decoding runs that from t = 1 (all masks) down to 0 in S steps, committing some tokens each step.

Prediction position ("shift", as Dream-7B does when it adapts an AR model): the clean token of answer position j is
read from the output at position j-1, exactly where an AR model would predict it. For a random init this is just a
convention; for an AR init it means the output head starts with the meaning it already has.

Parameter names are identical to ml/s1/model.py, so an AR checkpoint loads straight in (only the embedding gains a row).
"""
import math, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "s1"))
import compat  # noqa: F401,E402  (Python 3.11rc shim, before torch)
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from model import Config, RMSNorm, SwiGLU, rope_tables, apply_rope  # noqa: E402  (ml/s1/model.py)


class BiAttention(nn.Module):
    """Self-attention without the causal mask. `past` = (k, v) of earlier positions to attend to (a prompt cache)."""
    def __init__(self, c: Config):
        super().__init__()
        self.h, self.dh = c.heads, c.d // c.heads
        self.qkv = nn.Linear(c.d, 3 * c.d, bias=False)
        self.out = nn.Linear(c.d, c.d, bias=False)

    def forward(self, x, cos, sin, mask=None, past=None, keep=None):
        B, T, _ = x.shape
        q, k, v = self.qkv(x).view(B, T, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)
        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
        if keep is not None:
            keep.append((k, v))
        if past is not None:
            k = torch.cat([past[0], k], dim=2); v = torch.cat([past[1], v], dim=2)
        y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)        # mask: (B, 1, 1, Tk) True = may attend
        return self.out(y.transpose(1, 2).reshape(B, T, -1))


class Block(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        self.n1, self.att, self.n2, self.ffn = RMSNorm(c.d), BiAttention(c), RMSNorm(c.d), SwiGLU(c)

    def forward(self, x, cos, sin, mask=None, past=None, keep=None):
        x = x + self.att(self.n1(x), cos, sin, mask, past, keep)
        return x + self.ffn(self.n2(x))


class DLM(nn.Module):
    def __init__(self, c: Config):
        super().__init__()
        self.c = c
        self.mask_id = c.vocab - 1                       # the last row of the embedding is [MASK]
        self.emb = nn.Embedding(c.vocab, c.d)
        self.blocks = nn.ModuleList(Block(c) for _ in range(c.layers))
        self.norm = RMSNorm(c.d)
        cos, sin = rope_tables(c.d // c.heads, c.max_len)
        self.register_buffer("cos", cos, persistent=False); self.register_buffer("sin", sin, persistent=False)
        self.apply(self._init)
        for b in self.blocks:
            nn.init.normal_(b.att.out.weight, std=0.02 / math.sqrt(2 * c.layers)); nn.init.normal_(b.ffn.down.weight, std=0.02 / math.sqrt(2 * c.layers))

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)

    def params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def hidden(self, idx, start=0, key_mask=None, past=None, keep=None):
        """idx (B, T) at positions start..start+T-1. key_mask (B, Tk) bool over [past + idx] keys. past: per-layer (k, v).
        keep: a list that receives each layer's (k, v) for idx (to build a cache). Returns final-norm hidden (B, T, d)."""
        T = idx.shape[1]
        cos, sin = self.cos[start:start + T], self.sin[start:start + T]
        mask = None if key_mask is None else key_mask[:, None, None, :]
        x = self.emb(idx)
        for i, b in enumerate(self.blocks):
            kv = [] if keep is not None else None
            x = b(x, cos, sin, mask, None if past is None else past[i], kv)
            if keep is not None:
                keep.append(kv[0])
        return self.norm(x)

    def logits(self, h):
        return h @ self.emb.weight.T

    @classmethod
    def from_ar(cls, ar_state: dict, c: Config):
        """AR -> diffusion adaptation: copy every weight; the new [MASK] embedding row starts at the mean embedding."""
        m = cls(c)
        sd = dict(ar_state)
        e = sd["emb.weight"]
        sd["emb.weight"] = torch.cat([e, e.mean(0, keepdim=True)], 0)
        missing, unexpected = m.load_state_dict(sd, strict=False)
        assert not unexpected and all(k in ("cos", "sin") for k in missing), (missing, unexpected)
        return m
