"""Build the verifier's example sets (ml/verify/out/<set>.in.jsonl): rows {id, set, ctx, said, line, kind, icao, force?}.

Reporting sets (never used for fitting):
  val      ml/data/out4/ds/val.jsonl, the S1 validation transcripts (sessions with seed 4, 11 airports)
  syd      ml/data/out4/ds/test_airport.jsonl, Sydney: an airport S1 never saw
  stt      real recogniser outputs: 200 Kokoro-spoken val commands x 5 recognisers (ml/gpu/results/stt)
  noisy    fresh, heavier-noise transcripts of val-session records (STT-style damage, see heavy())
Fitting sets (train sessions only: seed != 4, never YSSY):
  trainA   the generator's own training transcripts (a sample of out4 train.jsonl)
  trainB   fresh transcripts of train records, half ordinary noise, half heavy
  hardneg  trainB/trainA rows with the gold line perturbed (other callsign in the state, a digit, runway side,
           turn direction, a dropped part), teacher-forced through the generator: the "System One" negatives

    python3 ml/verify/make_sets.py
"""
import argparse, json, random, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/data"))
from augment import realise, stt_normalise, words_to_digits  # noqa: E402

OUT = ROOT / "ml/verify/out"
RAW = sorted((ROOT / "ml/data/out2").glob("*.jsonl")) + sorted((ROOT / "ml/data/out3").glob("*.jsonl"))
DIGIT_CONFUSE = {"one": ["nine", "won", "one"], "two": ["to", "three", "too"], "three": ["tree", "two", "free"], "four": ["for", "five", "fore"],
                 "five": ["nine", "four", "fife"], "six": ["sixty", "fix", "sex"], "seven": ["eleven", "seventy"], "eight": ["eighty", "a", "ate"],
                 "nine": ["five", "nine", "nein"], "zero": ["euro", "hero", "oh"]}
NAME_CONFUSE = ["speed bird", "speedboard", "delta", "united", "jet blue", "air friends", "luft hansa", "emirate", "quantus", "sky", "the"]
COMMON = ["the", "a", "and", "okay", "so", "uh", "to", "is", "that"]


def heavy(rec, rng):
    """An ordinary noisy transcript (augment.realise), then the damage real recognisers do (ml/gpu/results/stt):
    a misheard airline name, one misheard digit, a lost word that matters, merged numbers, a cut-off tail."""
    words = realise(rec, rng).split()
    name = rec["name"].split()
    r = rng.random()
    if r < 0.25 and len(name) > 1:            # airline name misheard or dropped
        k = len(name) - 1
        if words[:k] == name[:k]:
            words = (rng.choice(NAME_CONFUSE).split() if rng.random() < 0.6 else []) + words[k:]
    if rng.random() < 0.18:                   # one digit misheard
        idx = [i for i, w in enumerate(words) if w in DIGIT_CONFUSE or w.isdigit()]
        if idx:
            i = rng.choice(idx); w = words[i]
            if w.isdigit():
                j = rng.randrange(len(w)); words[i] = w[:j] + str(rng.randrange(10)) + w[j + 1:]
            else:
                words[i] = rng.choice(DIGIT_CONFUSE[w])
    if rng.random() < 0.06 and len(words) > 3:   # a meaningful word lost
        i = rng.randrange(1, len(words)); words = words[:i] + words[i + 1:]
    if rng.random() < 0.06:                    # a word inserted
        i = rng.randrange(len(words) + 1); words = words[:i] + [rng.choice(COMMON)] + words[i:]
    if rng.random() < 0.05 and len(words) > 4:    # cut off
        words = words[: rng.randrange(3, len(words))]
    if rng.random() < 0.3:
        words = words_to_digits(words)
    return " ".join(words)


def perturb(row, rng):
    """A wrong line close to the gold one (or None)."""
    line = row["line"]
    if line == "SAY AGAIN":
        return None
    cs, _, rest = line.partition(" ")
    others = [l.split()[0] for l in row["ctx"].split("\n")[1:] if l.strip() and l.split()[0] != cs]
    kinds = ["cs", "digit", "rwy", "dir", "drop"]
    rng.shuffle(kinds)
    for k in kinds:
        if k == "cs" and others:
            num = re.sub(r"^[A-Z]+", "", cs)
            near = [o for o in others if o[:3] == cs[:3] or re.sub(r"^[A-Z]+", "", o)[-1:] == num[-1:]]
            return rng.choice(near or others) + " " + rest
        if k == "digit":
            m = list(re.finditer(r"\d+", rest))
            if m:
                g = rng.choice(m); s = g.group(0); j = rng.randrange(len(s))
                d = str((int(s[j]) + rng.choice([1, 2, 3, 5, 7, 9])) % 10)
                new = s[:j] + d + s[j + 1:]
                if re.search(r"heading", rest, re.I) and not (1 <= int(new) <= 360):
                    continue
                return cs + " " + rest[:g.start()] + new + rest[g.end():]
        if k == "rwy":
            m = re.search(r"\b(\d{1,2})([LRC])\b", rest)
            if m:
                o = {"L": "R", "R": "L", "C": rng.choice("LR")}[m.group(2)]
                return cs + " " + rest[:m.start()] + m.group(1) + o + rest[m.end():]
        if k == "dir":
            if re.search(r"\b(left|right)\b", rest, re.I):
                return cs + " " + re.sub(r"\b(left|right)\b", lambda x: {"left": "right", "right": "left", "Left": "Right", "Right": "Left", "LEFT": "RIGHT", "RIGHT": "LEFT"}[x.group(1)], rest, count=1)
        if k == "drop" and ", " in rest:
            parts = rest.split(", "); parts.pop(rng.randrange(len(parts)))
            return cs + " " + ", ".join(parts)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trainA", type=int, default=16000); ap.add_argument("--trainB", type=int, default=16000)
    ap.add_argument("--trainB-keep", type=int, default=8000, help="rows of trainB written (all of them still seed hardneg); CPU budget")
    ap.add_argument("--noisy", type=int, default=4000); ap.add_argument("--hardneg", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    OUT.mkdir(parents=True, exist_ok=True)
    keep = ("ctx", "said", "line", "kind", "icao")

    def write(name, rows):
        with open(OUT / f"{name}.in.jsonl", "w") as f:
            for i, r in enumerate(rows):
                f.write(json.dumps({"id": i, "set": name, **{k: r[k] for k in keep}, **({"force": r["force"]} if "force" in r else {}),
                                    **({"rec": r["rec"]} if "rec" in r else {})}) + "\n")
        print(name, len(rows))

    ds = ROOT / "ml/data/out4/ds"
    write("val", [json.loads(l) for l in open(ds / "val.jsonl")])
    write("syd", [json.loads(l) for l in open(ds / "test_airport.jsonl")])
    sttd = ROOT / "ml/gpu/results/stt"
    clips = {c["i"]: c for c in json.load(open(sttd / "clips.json"))}
    stt = []
    for f in sorted(sttd.glob("*.json")):
        if f.name in ("clips.json", "scores.json"):
            continue
        res = json.load(open(f))
        for r in res["rows"]:
            c = clips[r["i"]]
            stt.append({"ctx": c["ctx"], "said": r["heard"], "line": c["line"], "kind": c["kind"], "icao": "EGLL?", "rec": res["model"]})
    write("stt", stt)
    recs = [json.loads(l) for p in RAW for l in open(p)]
    val_recs = [r for r in recs if r["icao"] != "YSSY" and r["seed"] == 4]
    tr_recs = [r for r in recs if r["icao"] != "YSSY" and r["seed"] != 4]
    rng.shuffle(val_recs); rng.shuffle(tr_recs)
    noisy = [{"ctx": r["ctx"], "said": heavy(r, rng), "line": r["line"], "kind": r["kind"], "icao": r["icao"]} for r in val_recs[: a.noisy]]
    write("noisy", noisy)
    train = [json.loads(l) for l in open(ds / "train.jsonl")]
    rng.shuffle(train)
    trainA = [r for r in train if "+swap" not in r["src"]][: a.trainA]
    write("trainA", trainA)
    trainB = []
    for i, r in enumerate(tr_recs[: a.trainB]):
        trainB.append({"ctx": r["ctx"], "said": heavy(r, rng) if i % 2 else realise(r, rng), "line": r["line"], "kind": r["kind"], "icao": r["icao"]})
    write("trainB", trainB[: a.trainB_keep])
    hn = []
    pool = trainB + trainA
    rng.shuffle(pool)
    for r in pool:
        p = perturb(r, rng)
        if p:
            hn.append({**r, "force": p})
        if len(hn) >= a.hardneg:
            break
    write("hardneg", hn)


if __name__ == "__main__":
    main()
