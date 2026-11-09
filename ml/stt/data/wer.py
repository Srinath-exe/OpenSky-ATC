"""Word error rate on the shared transcript style (textnorm.norm on both sides)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import norm


def edits(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return d[len(b)]


def wer(ref: str, hyp: str) -> float:
    r, h = norm(ref).split(), norm(hyp or "").split()
    return edits(r, h) / max(1, len(r))


DIGW = {w: str(i) for i, w in enumerate("zero one two three four five six seven eight nine".split())}
TEEN = {w: str(10 + i) for i, w in enumerate("ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split())}
TENS = {w: str(i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}


def fold(text: str) -> list:
    """Numbers digit by digit, however they were written or grouped ("nineteen" = "19" = 1 9, "five thousand" = 5000,
    "six thirty seven" = 637), "point" = "decimal": the scoring of public/voice/wer.js."""
    w = norm(text).split(); out = []; i = 0
    while i < len(w):
        t = w[i]
        if t == "thousand": out += ["0"] * 3
        elif t == "hundred": out += ["0"] * 2
        elif t in DIGW: out.append(DIGW[t])
        elif t in TEEN: out += list(TEEN[t])
        elif t in TENS:
            n = w[i + 1] if i + 1 < len(w) else None
            if n in DIGW and n != "zero": out += [TENS[t], DIGW[n]]; i += 1
            else: out += [TENS[t], "0"]
        elif t == "point": out.append("decimal")
        else: out.append(t)
        i += 1
    return out


def wer_num(ref: str, hyp: str) -> float:
    r, h = fold(ref), fold(hyp or "")
    return edits(r, h) / max(1, len(r))
