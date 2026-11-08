"""Surface-form augmentation: exporter records -> (ctx, said, line) training examples.

Module 1 of ml/README.md. The exporter gives the clean engine phrase for every command; players and speech-to-text
produce something messier. This script samples that mess, so the model learns to map it back to the command line:

  * phrasing: ICAO or FAA variant, optional words dropped ("and maintain", "runway", "degrees", ...)
  * numbers as a speech recogniser writes them: words ("two seven zero"), digits ("270"), grouped ("two seventy")
  * ICAO pronunciations normalised the way STT writes them (tree -> three, niner -> nine, fife -> five)
  * callsign forms: full telephony, or flight number only when that is unique on frequency
  * disfluencies ("uh", "um", restarts) and ASR-style word noise (homophones, a dropped or doubled word)
  * negatives: unknown callsign or a cut-off transmission -> target "SAY AGAIN"

Splits are by SESSION (airport + seed), never by row: rows of one session share aircraft and context, so a random
split would leak. One airport is held out entirely as an unseen-airport test.

    python3 ml/data/augment.py ml/data/out/*.jsonl --out ml/data/out/ds --per 4 --holdout YSSY --val-seed 4
"""
import argparse, json, random, re
from pathlib import Path

ONES = "zero one two three four five six seven eight nine".split()
TEENS = "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
WORD_VAL = {w: i for i, w in enumerate(ONES)} | {"oh": 0, "niner": 9, "tree": 3, "fife": 5, "fower": 4} | {w: 10 + i for i, w in enumerate(TEENS)}
ICAO_TO_STT = {"tree": "three", "niner": "nine", "fife": "five", "fower": "four", "wun": "one", "tousand": "thousand"}
OPTIONAL = ["and maintain", "runway", "degrees", "knots", "feet", "proceed", "approved", "to", "fly", "the", "please", "of"]
HOMOPHONES = {"four": ["for"], "two": ["to", "too"], "right": ["write"], "eight": ["ate"], "one": ["won"], "for": ["four"], "to": ["two"]}
FILLERS = ["uh", "um", "ah", "er"]
CRITICAL = {"left", "right", "center", "centre", "not", "no", "negative", "hold", "short", "cleared", "cross", "climb", "descend", "land", "takeoff", "around", "cancel", "unable", "behind"}


def stt_normalise(s: str) -> str:
    """What both training and inference apply to a transcript: lower case, no punctuation (keep 118.5), single spaces."""
    s = s.lower().replace("’", "'")
    s = re.sub(r"(\w)-(\w)", r"\1 \2", s)          # sixty-five -> sixty five
    s = re.sub(r"[^\w\s.]", " ", s)
    s = re.sub(r"\.(?!\d)", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def words_to_digits(words: list[str]) -> list[str]:
    """Join spoken number runs into digit strings: 'eight sixty five' -> '865', 'two seven zero' -> '270'."""
    out, run, i = [], "", 0
    while i < len(words):
        w = words[i]
        if w in TENS:
            nxt = words[i + 1] if i + 1 < len(words) else ""
            if nxt in WORD_VAL and 0 < WORD_VAL[nxt] < 10:
                run += str(TENS[w] + WORD_VAL[nxt]); i += 2; continue
            run += str(TENS[w]); i += 1; continue
        if w in WORD_VAL:
            run += str(WORD_VAL[w]); i += 1; continue
        if run:
            out.append(run); run = ""
        out.append(w); i += 1
    if run:
        out.append(run)
    return out


def realise(rec: dict, rng: random.Random) -> str:
    """One noisy transcript of a record."""
    say = rec["say"]
    phrase = say.get("FAA") if (rng.random() < 0.5 and "FAA" in say) else say.get("ICAO") or say.get("FAA")
    # the engine phrase opens with the callsign: "Delta seventy-six, fly heading ..."
    head, _, rest = phrase.partition(",")
    airline, flight = " ".join(rec["name"].split()[:-1]), rec["name"].split()[-1].upper()
    unique = sum(1 for l in rec["ctx"].splitlines()[1:] if re.sub(r"^[A-Z]+", "", l.split()[0]) == flight) == 1
    if airline and unique and rng.random() < 0.12:
        h = stt_normalise(head)
        if h.startswith(airline):
            head = h[len(airline):]                          # flight number only: "seventy six, fly heading ..."
    s = stt_normalise(head + " , " + rest)
    words = [ICAO_TO_STT.get(w, w) if rng.random() < 0.85 else w for w in s.split()]
    s = " ".join(words)
    # optional words dropped
    for w in OPTIONAL:
        if rng.random() < 0.25:
            s = re.sub(rf"\b{w}\b", " ", s)
    words = s.split()
    # number style as a recogniser writes it
    r = rng.random()
    if r < 0.45:
        words = words_to_digits(words)
        if rng.random() < 0.6:                              # "4 thousand" -> "4000", "1 thousand 5 hundred" -> "1500"
            words = " ".join(words).replace(" thousand 5 hundred", "500").split()
            words = re.sub(r"\b(\d+) thousand\b", lambda m: str(int(m.group(1)) * 1000), " ".join(words)).split()
    # disfluencies and word noise
    noisy = []
    for i, w in enumerate(words):
        if i > 0 and rng.random() < 0.04:
            noisy.append(rng.choice(FILLERS))
        x = rng.random()
        critical = w in CRITICAL or w in WORD_VAL or w in TENS or w.isdigit() or w in rec["name"].split()
        if x < 0.02 and i > 1 and not critical:
            continue                                        # dropped word (never one that carries the meaning)
        if x < 0.035 and w in HOMOPHONES:
            w = rng.choice(HOMOPHONES[w])
        noisy.append(w)
        if rng.random() < 0.008:
            noisy.append(w)                                 # doubled word
    if rng.random() < 0.04 and len(noisy) > 3:              # restart: "delta four two delta four twenty one ..."
        k = rng.randint(1, 3); noisy = noisy[:k] + noisy
    return " ".join(noisy)


# --- callsign-swap augmentation: teach every airline name in the game, whatever airports the data came from ---
def _telephony_table():
    src = (Path(__file__).resolve().parents[2] / "src/lib/sim/phraseology.ts").read_text()
    i = src.index("export const AIRLINE_TELEPHONY"); j = src.index("};", i)
    return dict(re.findall(r"([A-Z]{3}):\s*'([^']+)'", src[i:j]))


TEL = None


def swap_airlines(rec: dict, rng: random.Random) -> dict | None:
    """Map each airline on frequency to another one (consistently in ctx, say, name and line). None if nothing to swap."""
    global TEL
    TEL = TEL or _telephony_table()
    lines = rec["ctx"].split("\n")
    present = sorted({m.group(1) for l in lines[1:] for m in [re.match(r"^([A-Z]{3})\d", l)] if m and m.group(1) in TEL})
    if not present:
        return None
    pool = [k for k in TEL if k not in present]
    rng.shuffle(pool)
    mp = {old: pool[i] for i, old in enumerate(present) if i < len(pool)}
    def cs(t):    # DAL76 -> XYZ76 for every callsign token
        return re.sub(r"\b([A-Z]{3})(\d+[A-Z]{0,2})\b", lambda m: (mp.get(m.group(1), m.group(1)) + m.group(2)), t)
    def tel(t):   # spoken airline names, any case
        for old, new in mp.items():
            t = re.sub(rf"\b{re.escape(TEL[old])}\b", TEL[new], t, flags=re.I)
        return t
    new_lines = [lines[0]]
    for l in lines[1:]:
        m = re.match(r"^([A-Z]{3})(\d+[A-Z]{0,2}) (.+?) (ARR|DEP) (.*)$", l)
        if m and m.group(1) in mp:
            new_lines.append(f"{mp[m.group(1)]}{m.group(2)} {TEL[mp[m.group(1)]].lower()} {m.group(2).lower()} {m.group(4)} {m.group(5)}")
        else:
            new_lines.append(cs(l))
    out = dict(rec)
    out["ctx"] = "\n".join(new_lines); out["line"] = cs(rec["line"])
    out["say"] = {k: tel(cs(v)) for k, v in rec["say"].items()}
    old_icao = rec["cs"][:3]
    out["name"] = f"{TEL[mp[old_icao]].lower()} {rec['name'].split()[-1]}" if old_icao in mp else rec["name"]
    return out


def negative(rec: dict, rng: random.Random) -> str | None:
    """A transcript that must produce SAY AGAIN: a callsign that is not in the context, or the callsign alone."""
    phrase = rec["say"].get("FAA") or rec["say"].get("ICAO")
    head, _, rest = phrase.partition(",")
    if rng.random() < 0.5 and rest.strip():
        num = rng.randint(1, 999)
        if any(re.sub(r"^[A-Z]+", "", l.split()[0]) == str(num) for l in rec["ctx"].splitlines()[1:]):
            return None
        fake = f"{rng.choice(['delta', 'united', 'speedbird', 'jetblue', 'american', 'lufthansa', 'emirates', 'qantas'])} {num}"
        return stt_normalise(fake + " , " + rest)
    return stt_normalise(head) if rng.random() < 0.7 else stt_normalise(head + " , " + " ".join(rest.split()[:1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", default="ml/data/out/ds")
    ap.add_argument("--per", type=int, default=4, help="noisy transcripts per record")
    ap.add_argument("--neg", type=float, default=0.06, help="share of SAY AGAIN negatives")
    ap.add_argument("--holdout", default="YSSY", help="airport kept out of training entirely")
    ap.add_argument("--val-seed", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--swap", type=float, default=0.0, help="extra training example with airlines swapped, with this probability")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    files = {k: open(out / f"{k}.jsonl", "w") for k in ("train", "val", "test_airport")}
    counts = {k: 0 for k in files}
    for path in a.inputs:
        for line in open(path):
            rec = json.loads(line)
            split = "test_airport" if rec["icao"] == a.holdout else "val" if rec["seed"] == a.val_seed else "train"
            n = a.per if split == "train" else 1
            seen = set()
            for _ in range(n):
                said = realise(rec, rng)
                if said in seen:
                    continue
                seen.add(said)
                ex = {"ctx": rec["ctx"], "said": said, "line": rec["line"], "kind": rec["kind"], "src": rec["src"], "icao": rec["icao"]}
                files[split].write(json.dumps(ex) + "\n"); counts[split] += 1
            if split == "train" and a.swap and rng.random() < a.swap:
                sw = swap_airlines(rec, rng)
                if sw:
                    said = realise(sw, rng)
                    files[split].write(json.dumps({"ctx": sw["ctx"], "said": said, "line": sw["line"], "kind": rec["kind"], "src": rec["src"] + "+swap", "icao": rec["icao"]}) + "\n"); counts[split] += 1
            if rng.random() < a.neg:
                said = negative(rec, rng)
                if said:
                    ex = {"ctx": rec["ctx"], "said": said, "line": "SAY AGAIN", "kind": "sayAgain", "src": "neg", "icao": rec["icao"]}
                    files[split].write(json.dumps(ex) + "\n"); counts[split] += 1
    for f in files.values():
        f.close()
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
