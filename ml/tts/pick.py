"""The 60 benchmark lines (ml/tts/RESULTS.md) from the exported pilot lines (ml/tts/lines.sh, then `lines.sh normalize`).

    python3 ml/tts/pick.py   ->  ml/tts/data/bench60.jsonl

32 readbacks, 16 pilot requests, 12 status lines (handoffs, holding short, vacated, rolling...: the engine's terse lines,
which need the ATC normaliser most). At most one line per phrase pattern, the six airports in turn, ICAO and FAA mixed.
"""
import json, random, re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
rows = [json.loads(l) for l in open(ROOT / "ml/tts/data/lines_all.jsonl")]
QUOTA = {"readback": 32, "request": 16, "status": 12}


def group(t):
    return "readback" if t.startswith("readback") else "request" if t == "request" else "status"


def pattern(r):
    """The phrase without names (capitalised words: units, telephony, phonetic letters) and numbers: one line per pattern."""
    nums = r"(zero|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner|ten|eleven|twelve|\w+teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(-\w+)?"
    words = [w.strip(",.").lower() for w in r["spoken"].split() if not w[0].isupper() and not re.fullmatch(nums, w.strip(",."), flags=re.I)]
    return " ".join(words[:4])


rng = random.Random(7)
rng.shuffle(rows)
by = defaultdict(lambda: defaultdict(list))
for r in rows:
    by[group(r["type"])][r["icao"]].append(r)
out = []
for g, n in QUOTA.items():
    seen, picked = set(), []
    airports = sorted(by[g])
    while len(picked) < n and any(by[g][a] for a in airports):
        for a in airports:
            while by[g][a]:
                r = by[g][a].pop()
                k = pattern(r)
                if k in seen:
                    continue
                seen.add(k); picked.append(r); break
            if len(picked) == n:
                break
    out += picked
for i, r in enumerate(out):
    r["bench_id"] = i
(ROOT / "ml/tts/data/bench60.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out))
print(len(out), {g: sum(group(r["type"]) == g for r in out) for g in QUOTA}, {v: sum(r["variant"] == v for r in out) for v in ("ICAO", "FAA")})
for r in out:
    print(f'{r["bench_id"]:2d} {r["icao"]} {r["type"][:12]:12s} {r["spoken"]}')
