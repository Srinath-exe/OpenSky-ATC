"""Three reward functions, all computed by the game engine (ml/rl/reward_server.ts parses every sampled line).

  exact     1 if the line equals the label (normalised as in evaluation), else 0. Sparse: a group of 8 that is all
            wrong or all right carries no signal.
  shaped    partial credit from the parsed command (AST) against the label's AST:
            0.1 parses + 0.4 right aircraft + 0.2 right command kind(s) + 0.3 right values (1 if the ASTs match,
            otherwise the share of matching leaf fields). SAY AGAIN: 1 iff the label is SAY AGAIN.
  verifier  NO label. The engine checks the line against what was said:
            0 if it does not parse (an aircraft not in the state does not parse);
            else 0.2 + 0.4 * callsign heard in the transcript + 0.4 * F1 between the engine's own spoken rendering of
            the command (phraseology.transmission) and the transcript (content words; numbers count double;
            FL70 = 7000; the addressed callsign removed from both).
            SAY AGAIN scores 0.7 when no aircraft on frequency is heard, or nothing but a callsign was said; else 0.
            This is the one that could train on unlabelled real speech.
"""
import json, re
from common import norm_line, stt_normalise
from augment import words_to_digits, ICAO_TO_STT

STOP = {"and", "maintain", "to", "the", "of", "please", "uh", "um", "ah", "er", "fly", "degrees", "knots", "feet", "proceed", "approved", "runway",
        "then", "via", "for", "at", "a", "i", "is", "on", "with", "flight", "level", "turn", "climb", "descend", "reduce", "increase", "speed"}
# "climb"/"descend" carry no information the altitude number does not; "turn" is implied by "heading"; keep heading/speed words
STOP -= {"speed"}
FILLERS = {"uh", "um", "ah", "er"}


def toks(s: str) -> list[str]:
    w = [ICAO_TO_STT.get(x, x) for x in stt_normalise(s).split() if x not in FILLERS]
    w = words_to_digits(w)
    out = []
    i = 0
    while i < len(w):
        x = w[i]
        if x.isdigit() and i + 1 < len(w) and w[i + 1] == "thousand":
            n = int(x) * 1000; i += 2
            if i + 1 < len(w) and w[i].isdigit() and w[i + 1] == "hundred":
                n += int(w[i]) * 100; i += 2
            out.append(str(n)); continue
        if x.isdigit() and i + 1 < len(w) and w[i + 1] == "hundred":
            out.append(str(int(x) * 100)); i += 2; continue
        if x.isdigit() and i > 0 and w[i - 1] == "level" and len(x) <= 3:
            out.append(str(int(x) * 100)); i += 1; continue                        # flight level 70 == 7000
        out.append(x); i += 1
    return out


def canon(t: str) -> str:
    return str(int(t)) if t.isdigit() else t


def ctx_aircraft(ctx: str):
    """{callsign: (airline words, flight id)} from the state text: 'AFR701 air france 701 ARR ...'."""
    res = {}
    for l in ctx.split("\n")[1:]:
        p = l.split()
        if len(p) < 3:
            continue
        cs = p[0]
        m = re.match(r"^([A-Z]+?)(\d+[A-Z]{0,2})$", cs)
        fid = m.group(2).lower() if m else cs.lower()
        try:
            j = p.index(fid, 1)
        except ValueError:
            j = None
        words = [w.lower() for w in p[1:j]] if j else []
        res[cs] = (words, fid)
    return res


def _digit_runs(t: list[str]) -> set[str]:
    runs, cur = set(), ""
    for x in t + [""]:
        if x.isdigit():
            cur += x; runs.add(x)
        else:
            if cur:
                runs.add(cur)
            cur = ""
    return runs


def callsign_heard(cs: str, acs: dict, t: list[str]) -> float:
    if cs not in acs:
        return 0.0
    words, fid = acs[cs]
    digits = re.match(r"^(\d+)", fid).group(1) if re.match(r"^\d", fid) else fid
    runs = _digit_runs(t)
    num = digits in runs or fid in t
    tset = set(t)
    air = bool(words) and all(w in tset for w in words)
    unique = sum(1 for _, (_, f) in acs.items() if f == fid) == 1
    if num and (air or unique):
        return 1.0
    if num or (air and any(digits.startswith(r) or r.startswith(digits) for r in runs if len(r) >= 2)):
        return 0.5
    return 0.0


def strip_callsign(t: list[str], cs_words: list[str], fid: str) -> list[str]:
    digits = re.match(r"^(\d+)", fid).group(1) if re.match(r"^\d", fid) else fid
    drop = set(cs_words) | {digits, fid}
    return [x for x in t if x not in drop]


def content(t):
    return [canon(x) for x in t if x not in STOP]


def f1(a: list[str], b: list[str]) -> float:
    """Weighted multiset F1 (numbers weigh 2)."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    w = lambda x: 2.0 if x.isdigit() else 1.0
    inter = sum(min(ca[x], cb[x]) * w(x) for x in ca)
    pa, pb = sum(c * w(x) for x, c in ca.items()), sum(c * w(x) for x, c in cb.items())
    p, r = inter / pa, inter / pb
    return 0.0 if inter == 0 else 2 * p * r / (p + r)


def verifier(ex, line, parsed):
    """Label-free reward (see module doc). parsed = engine output for `line`."""
    said = toks(ex["said"]); acs = ctx_aircraft(ex["ctx"])
    if norm_line(line) == "SAY AGAIN":
        heard = {cs: callsign_heard(cs, acs, said) for cs in acs}
        best = max(heard, key=heard.get) if heard else None
        if not best or heard[best] == 0:
            return 0.7
        rest = content(strip_callsign(said, *acs[best]))
        return 0.7 if not rest else 0.0
    if not parsed["ok"] or not parsed["cs"]:
        return 0.0
    cs = parsed["cs"]
    h = callsign_heard(cs, acs, said)
    words, fid = acs.get(cs, ([], cs.lower()))
    rend = content(strip_callsign(toks(parsed["words"] or line), words, fid))
    heard = content(strip_callsign(said, words, fid))
    return 0.2 + 0.4 * h + 0.4 * f1(rend, heard)


def _leaves(x, path=""):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == "callsign":
                continue
            yield from _leaves(v, f"{path}.{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from _leaves(v, f"{path}[{i}]")
    else:
        yield (path, json.dumps(x))


def shaped(ex, line, parsed, gold):
    g_sa, p_sa = norm_line(ex["line"]) == "SAY AGAIN", norm_line(line) == "SAY AGAIN"
    if g_sa or p_sa:
        return float(g_sa and p_sa)
    if not gold["ok"]:
        return float(norm_line(line) == norm_line(ex["line"]))
    if not parsed["ok"]:
        return 0.0
    r = 0.1 + 0.4 * (parsed["cs"] == gold["cs"])
    pk, gk = parsed["kinds"], gold["kinds"]
    r += 0.2 * (1.0 if sorted(pk) == sorted(gk) else len(set(pk) & set(gk)) / len(set(pk) | set(gk)))
    if parsed["ast"] == gold["ast"]:
        r += 0.3
    else:
        a, b = set(_leaves(json.loads(parsed["ast"]))), set(_leaves(json.loads(gold["ast"])))
        r += 0.3 * (len(a & b) / max(1, len(a | b)))
    return r


def exact(ex, line, parsed=None, gold=None):
    return float(norm_line(line) == norm_line(ex["line"]))


def score(kind, engine, exs, lines):
    """Rewards for a flat list of (example, sampled line) pairs; one engine round trip for the whole batch."""
    parsed = engine.parse([(e["ctx"], l) for e, l in zip(exs, lines)])
    gold = engine.parse([(e["ctx"], e["line"]) for e in exs]) if kind == "shaped" else [None] * len(exs)
    if kind == "exact":
        r = [exact(e, l) for e, l in zip(exs, lines)]
    elif kind == "shaped":
        r = [shaped(e, l, p, g) for e, l, p, g in zip(exs, lines, parsed, gold)]
    elif kind == "verifier":
        r = [verifier(e, l, p) for e, l, p in zip(exs, lines, parsed)]
    else:
        raise ValueError(kind)
    return r, parsed
