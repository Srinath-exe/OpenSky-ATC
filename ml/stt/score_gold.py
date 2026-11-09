"""Real-voice gold set (ml/stt/GOLD.md): fixed prompts -> the owner's recordings -> recognisers -> rules / rules + model.

Every number before this came from synthetic speech (espeak, Kokoro). This scores the same chain the game runs on a
real voice:

  prompts   build public/voice/gold-prompts.json: 100 seeded prompts (60 validation airports, 30 Sydney = the airport
            the model never saw, 10 "say it your own way" that show only the intended command)
  score     for every clip in ml/data/gold/: CPU recognisers (Whisper, Moonshine) + the browser's Web Speech transcript
            stored at recording time, then rules alone (L0) and the shipped chain (rules, else the S1 model, with the
            confidence gate; src/lib/voice/understand.ts run in node) -> scores.json + scores.md + the HTML report
  ceiling   the chain on the prompt text itself (a perfect recogniser): the most the set can score
  dryrun    the whole pipeline on Kokoro clips from the GPU bake-off, posted through the real API handler into a
            temp gold dir (proves recording format, storage, scoring and report before anything is recorded)

    ml/.venv/bin/python ml/stt/score_gold.py prompts
    ml/.venv/bin/python ml/stt/score_gold.py score                 # after recording
    ml/.venv/bin/python ml/stt/score_gold.py dryrun --n 30
    ml/.venv/bin/python ml/stt/score_gold.py ceiling

CPU only, 2 threads (the box is shared with the live server).
"""
import os
os.environ.setdefault("OMP_NUM_THREADS", "2"); os.environ.setdefault("MKL_NUM_THREADS", "2"); os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import argparse, collections, hashlib, json, random, re, shutil, subprocess, sys, tempfile, time, wave  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/data"))
import compat  # noqa: F401,E402  (Python 3.11rc shim, before torch)
from augment import stt_normalise, words_to_digits  # noqa: E402

PROMPTS = ROOT / "public/voice/gold-prompts.json"
GOLD = ROOT / "ml/data/gold"
MODEL = ROOT / "public/models/s1/2m-swap-v1"          # the int8 model the browser runs
DS = ROOT / "ml/data/out4/ds"
RAW = [ROOT / "ml/data/out2", ROOT / "ml/data/out3"]   # exporter records behind out4/ds (clean engine phrases)
KOKORO = ROOT / "ml/gpu/results/stt"                   # GPU bake-off clips (Kokoro-82M, 6 voices)
DRY = ROOT / "ml/stt/out/gold-dry"
CHAIN_OUT = ROOT / ".tmp/gold"
ASR_IDS = {
    "whisper-base.en": "openai/whisper-base.en", "whisper-small.en": "openai/whisper-small.en", "whisper-tiny.en": "openai/whisper-tiny.en",
    "moonshine-tiny": "UsefulSensors/moonshine-tiny", "moonshine-base": "UsefulSensors/moonshine-base",
}
DEFAULT_MODELS = "whisper-base.en,whisper-base.en+prompt,moonshine-tiny,moonshine-base"


# ───────────────────────────── prompt set ─────────────────────────────
def ctx_aircraft(ctx):
    """'AFR865 air france 865 ARR APP approach 9000ft h148 31L' -> {cs, name, kind, alt}."""
    out = {}
    for l in ctx.split("\n")[1:]:
        t = l.split()
        if not t:
            continue
        k = next((i for i, x in enumerate(t) if x in ("ARR", "DEP")), len(t))
        alt = next((int(x[:-2]) for x in t if re.fullmatch(r"\d+ft", x)), 0)
        out[t[0]] = {"name": " ".join(t[1:k]), "kind": t[k] if k < len(t) else "", "alt": alt}
    return out


def title_name(name):
    return " ".join(w.upper() if w in ("ups", "klm", "ana", "jal", "dhl") else w.capitalize() for w in name.split())


def intent_text(line, ctx):
    """The command in plain words, for the 'say it your own way' prompts: 'Air France 865: turn onto heading 138'."""
    cs, _, rest = line.partition(" ")
    ac = ctx_aircraft(ctx).get(cs, {"name": cs, "alt": 0})
    who = title_name(ac["name"]) if ac["name"] else cs
    m = re.fullmatch(r"Altitude (\d+)(, expedite)?", rest)
    if m:
        ft = int(m.group(1)); verb = "climb" if ft > ac["alt"] else "descend"
        what = f"{verb} to {ft:,} ft" + (", expedite" if m.group(2) else "")
    else:
        rules = [
            (r"Fly heading (\d+)", r"fly heading \1"), (r"Turn (left|right) heading (\d+)", r"turn \1 heading \2"),
            (r"Speed (\d+)", r"speed \1 knots"), (r"Contact (\w+)( when vacated)?", r"hand off to \1\2"),
            (r"Taxi RWY (\S+?)(?: via (.+?))?(?:, hold short (\S+))?", None), (r"Taxi stand (\S+?)(?: via (.+?))?(?:, hold short (\S+))?", None),
            (r"Cleared for takeoff (\S+)", r"cleared for takeoff, runway \1"), (r"Cleared to land (\S+)", r"cleared to land, runway \1"),
            (r"Cleared ILS (\S+), report established", r"cleared ILS approach runway \1, report established"),
            (r"Direct (\S+)", r"proceed direct \1"), (r"Hold short (\S+)", r"hold short of runway \1"),
        ]
        what = rest[:1].lower() + rest[1:]
        for pat, rep in rules:
            m = re.fullmatch(pat, rest)
            if not m:
                continue
            if rep is None:   # taxi
                dest = ("runway " if rest.startswith("Taxi RWY") else "stand ") + m.group(1)
                what = f"taxi to {dest}" + (f" via {m.group(2)}" if m.group(2) else "") + (f", hold short of runway {m.group(3)}" if m.group(3) else "")
            else:
                what = m.expand(rep)
            break
    return f"{who}: {what}"


def alloc(counts, total, power=0.5, min_count=1):
    """Slots per kind: at least one for every kind with enough rows, the rest by count**power (weights toward the
    common kinds without drowning the rare ones). Largest remainder."""
    kinds = sorted((k for k, c in counts.items() if c >= min_count), key=lambda k: -counts[k])
    while len(kinds) > total:
        kinds.pop()
    w = {k: counts[k] ** power for k in kinds}; s = sum(w.values())
    ideal = {k: total * w[k] / s for k in kinds}
    q = {k: max(1, int(ideal[k])) for k in kinds}
    while sum(q.values()) > total:   # too many minimum slots: take back from the most over-served
        k = max((k for k in kinds if q[k] > 1), key=lambda k: q[k] - ideal[k]); q[k] -= 1
    while sum(q.values()) < total:
        k = max(kinds, key=lambda k: ideal[k] - q[k]); q[k] += 1
    return q


def phrase(rec):
    """The engine's own sentence for a record: FAA wording at US airports, ICAO elsewhere."""
    variant = "FAA" if rec["icao"].startswith("K") else "ICAO"
    return rec["say"].get(variant) or rec["say"].get("FAA") or rec["say"].get("ICAO")


def build_prompts(seed=11, out=PROMPTS):
    rng = random.Random(seed)
    splits = {s: [json.loads(l) for l in open(DS / f"{s}.jsonl")] for s in ("val", "test_airport")}
    need = {(r["ctx"], r["line"]) for rows in splits.values() for r in rows if r["src"] != "neg"}
    raw = {}
    for d in RAW:
        for f in sorted(d.glob("*.jsonl")):
            for l in open(f):
                r = json.loads(l)
                if (r["ctx"], r["line"]) in need:
                    raw[(r["ctx"], r["line"])] = r
    # one meaning per prompt: drop phrases the rules read as a DIFFERENT command than the gold line (the engine says
    # "give way to the Qantas, then continue" for a single give-way; "cancel approach, turn left heading ..." where the
    # AI left the turn direction open) and gold lines that do not parse with the airport's own lists
    rows = [{"key": str(i), "heard": phrase(r), "ctx": k[0], "line": k[1], "icao": r["icao"]} for i, (k, r) in enumerate(raw.items())]
    keys = list(raw)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
        json.dump(rows, t)
    res = subprocess.run(["node", str(build_chain()), "rules", t.name], capture_output=True, text=True, cwd=ROOT, check=True)
    os.unlink(t.name)
    drop = {keys[int(x["key"])] for x in json.loads(res.stdout) if not x["gold_ok"] or (x["ok"] and not x["same"])}
    print(f"{len(drop)} of {len(raw)} candidate phrases dropped as ambiguous or unparseable")
    raw = {k: v for k, v in raw.items() if k not in drop}
    used_ctx, used_ap = set(), collections.Counter()

    def pool(rows, kinds=None):
        by = collections.defaultdict(list)
        for r in rows:
            if r["src"] == "neg" or (r["ctx"], r["line"]) not in raw or (kinds and r["kind"] not in kinds):
                continue
            by[r["kind"]].append(r)
        return by

    def pick(cands):
        """Least-used airport first (spread across the 11), a session snapshot never twice."""
        cands = [c for c in cands if c["ctx"] not in used_ctx]
        if not cands:
            return None
        aps = sorted({c["icao"] for c in cands}, key=lambda a: (used_ap[a], rng.random()))
        r = rng.choice([c for c in cands if c["icao"] == aps[0]])
        used_ctx.add(r["ctx"]); used_ap[r["icao"]] += 1
        return r

    def make(r, group, neg=False):
        variant = "FAA" if r["icao"].startswith("K") else "ICAO"
        if neg:
            said = r["said"][:1].upper() + r["said"][1:]
            rec = {"say": {}, "src": "neg"}
        else:
            rec = raw[(r["ctx"], r["line"])]
            said = phrase(rec)
        cs = r["line"].split()[0]
        ac = ctx_aircraft(r["ctx"])
        return {"group": group, "icao": r["icao"], "kind": r["kind"], "src": rec["src"], "variant": None if neg else variant,
                "show": "intent" if group == "free" else "read", "said": said,
                "intent": "Callsign not on frequency: the right answer is “say again”" if neg else intent_text(r["line"], r["ctx"]),
                "line": r["line"], "expect": "say again" if neg else "command",
                "name": None if neg else title_name(ac.get(cs, {}).get("name", "")),
                "callsigns": [l.split()[0] for l in r["ctx"].split("\n")[1:] if l.strip()], "ctx": r["ctx"]}

    groups = {"val": [], "sydney": [], "free": []}
    for split, group, total, n_neg, min_count in (("val", "val", 60, 2, 10), ("test_airport", "sydney", 30, 1, 30)):
        by = pool(splits[split])
        counts = {k: len(v) for k, v in by.items()}
        q = alloc(counts, total - n_neg, min_count=min_count)
        for k in sorted(q, key=lambda k: -q[k]):
            for _ in range(q[k]):
                r = pick(by[k])
                if r:
                    groups[group].append(make(r, group))
        # negatives: an airline + flight number that is not on frequency, then a whole instruction (not a cut-off)
        negs = [r for r in splits[split] if r["src"] == "neg" and re.match(r"^[a-z ]+ \d+ \w+ \w+ \w+", r["said"])]
        for _ in range(n_neg):
            r = pick(negs)
            groups[group].append(make(r, group, neg=True))
    free_kinds = ["heading", "altitude", "speed", "contact", "taxi", "takeoff", "clearedLand", "ils", "direct", "holdShort"]
    by = pool(splits["val"], set(free_kinds))
    for k in free_kinds:
        groups["free"].append(make(pick(by[k]), "free"))
    # ids by group; recording order interleaved (every block of 10 = 6 validation, 3 Sydney, 1 own-way) so any prefix
    # of a session is already a fair sample
    for g, pre in (("val", "v"), ("sydney", "s"), ("free", "f")):
        rng.shuffle(groups[g])
        for i, p in enumerate(groups[g]):
            p["id"] = f"{pre}{i + 1:02d}"
    order = []
    for b in range(10):
        block = groups["val"][6 * b:6 * b + 6] + groups["sydney"][3 * b:3 * b + 3] + groups["free"][b:b + 1]
        rng.shuffle(block); order += block
    prompts = [{"id": p["id"], "n": i + 1, **{k: v for k, v in p.items() if k != "id"}} for i, p in enumerate(order)]
    doc = {"version": 1, "seed": seed, "built": time.strftime("%Y-%m-%d"), "source": "ml/data/out4/ds (val, test_airport=YSSY) + exporter phrases ml/data/out2,out3",
           "count": len(prompts), "prompts": prompts}
    Path(out).write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    comp = collections.Counter((p["group"], p["kind"]) for p in prompts)
    print(f"{len(prompts)} prompts -> {out}")
    print(json.dumps({g: len(v) for g, v in groups.items()}), json.dumps(collections.Counter(p["icao"] for p in prompts)))
    print(json.dumps(collections.Counter(p["kind"] for p in prompts).most_common()))
    return doc, comp


# ───────────────────────────── recognisers ─────────────────────────────
def callsign_prompt(ctx):
    """Contextual biasing without training (same text as the GPU bake-off, ml/gpu/remote/stt_bench.py)."""
    names = []
    for line in ctx.split("\n")[1:]:
        m = re.match(r"^\S+ (.+?) (ARR|DEP) ", line)
        if m:
            names.append(m.group(1).title())
    return "Air traffic control. Callsigns: " + ", ".join(names) + "."


def read_wav(path):
    import numpy as np
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, f"{path}: not 16 kHz mono 16-bit"
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


class Recogniser:
    def __init__(self, tag):
        import torch
        from transformers import pipeline
        torch.set_num_threads(2)
        self.tag, base = tag, tag.split("+")[0]
        self.prompt = tag.endswith("+prompt")
        self.asr = pipeline("automatic-speech-recognition", model=ASR_IDS.get(base, base), device=-1)

    def __call__(self, audio, ctx):
        gk = {}
        if "moonshine" in self.tag:   # Moonshine loops without a cap; ~6.5 tokens per second of speech (model card)
            gk["max_new_tokens"] = int(len(audio) / 16000 * 6.5) + 12
        if self.prompt and "whisper" in self.tag:
            gk["prompt_ids"] = self.asr.tokenizer.get_prompt_ids(callsign_prompt(ctx), return_tensors="pt")
        t0 = time.perf_counter()
        text = self.asr({"raw": audio, "sampling_rate": 16000}, generate_kwargs=gk)["text"] if gk else self.asr({"raw": audio, "sampling_rate": 16000})["text"]
        ms = (time.perf_counter() - t0) * 1000
        if self.prompt and "Callsigns:" in text:   # Whisper may echo the prompt; keep what follows it
            text = text.split("Callsigns:")[-1].split(".", 1)[-1] if text.count(".") else text.split("Callsigns:")[-1]
        return text.strip(), round(ms, 1)


# ───────────────────────────── scoring ─────────────────────────────
def wer_words(s):
    """Both sides in one form: lower case, numbers as digits ('four two one' = '421'), 'seven thousand' = '7000'."""
    w = words_to_digits(stt_normalise(s).replace("decimal", "point").split())
    out = []
    for t in w:
        if t == "thousand" and out and out[-1].isdigit():
            out[-1] = str(int(out[-1]) * 1000); continue
        if t == "hundred" and out and out[-1].isdigit():
            v = int(out[-1]) * 100
            if len(out) > 1 and out[-2].isdigit() and int(out[-2]) % 1000 == 0:
                out.pop(); v += int(out[-1]); out[-1] = str(v); continue
            out[-1] = str(v); continue
        out.append(t)
    return out


def wer(ref, hyp):
    r, h = wer_words(ref), wer_words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)], len(r)


def build_chain():
    """Compile the node side (ml/stt/gold_chain.ts + the game's own parser, understand.ts and S1 engine) to .tmp/gold."""
    cmd = ["npx", "tsc", "--module", "commonjs", "--moduleResolution", "node", "--target", "es2020", "--lib", "es2022,dom,dom.iterable",
           "--outDir", str(CHAIN_OUT), "--rootDir", ".", "--skipLibCheck", "--esModuleInterop", "--strict", "--types", "node",
           "--resolveJsonModule", "--noEmitOnError", "false", "--ignoreConfig", "--ignoreDeprecations", "6.0", "ml/stt/gold_chain.ts"]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    js = CHAIN_OUT / "ml/stt/gold_chain.js"
    if not js.exists():
        sys.exit(f"tsc failed:\n{r.stdout}\n{r.stderr}")
    if r.returncode:
        print(f"(tsc reported errors, using the emitted js)\n{r.stdout[-800:]}", file=sys.stderr)
    return js


def run_chain(js, rows, model_dir):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
        json.dump(rows, t)
    r = subprocess.run(["node", str(js), "chain", t.name, str(model_dir)], capture_output=True, text=True, cwd=ROOT)   # cwd: airport data
    os.unlink(t.name)
    if r.returncode:
        sys.exit(f"gold_chain failed:\n{r.stderr[-2000:]}")
    out = json.loads(r.stdout)
    bad = sorted({x["key"].split("|")[1] for x in out if not x["gold_ok"]})
    if bad:
        print(f"WARNING: the gold line does not parse for {len(bad)} prompts (scored as misses): {', '.join(bad[:12])}", file=sys.stderr)
    return out


def load_prompts(path):
    doc = json.load(open(path))
    return {p["id"]: p for p in doc["prompts"]}


def load_clips(gold_dir, prompts):
    clips = []
    for wav in sorted(Path(gold_dir).glob("*.wav")):
        pid = wav.stem
        if pid not in prompts:
            continue
        meta_f = wav.with_suffix(".json")
        meta = json.load(open(meta_f)) if meta_f.exists() else {}
        clips.append({"id": pid, "wav": wav, "meta": meta, "prompt": prompts[pid], "sha": hashlib.sha256(wav.read_bytes()).hexdigest()[:16]})
    return clips


def pct(a, b):
    return round(a / b, 3) if b else None


def score(gold_dir, prompts_path, models, out_dir, model_dir=MODEL, limit=None, label="your voice"):
    prompts = load_prompts(prompts_path)
    clips = load_clips(gold_dir, prompts)[: limit or None]
    if not clips:
        print(f"no clips in {gold_dir}"); return None
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    cache_f = out_dir / "transcripts.json"
    cache = json.load(open(cache_f)) if cache_f.exists() else {}
    heard = collections.defaultdict(dict)   # recogniser -> id -> {heard, ms}
    for tag in models:
        todo = [c for c in clips if f"{tag}|{c['sha']}" not in cache]
        if todo:
            print(f"{tag}: transcribing {len(todo)} clips", flush=True)
            asr = Recogniser(tag)
            for c in todo:
                text, ms = asr(read_wav(c["wav"]), c["prompt"]["ctx"])
                cache[f"{tag}|{c['sha']}"] = {"heard": text, "ms": ms}
            json.dump(cache, open(cache_f, "w"), indent=0)
            del asr
        for c in clips:
            heard[tag][c["id"]] = cache[f"{tag}|{c['sha']}"]
    for c in clips:   # what Chrome / Edge heard live while recording (Web Speech cannot be re-run on a saved clip)
        bt = c["meta"].get("browserTranscript")
        if isinstance(bt, str):
            heard["browser (Web Speech)"][c["id"]] = {"heard": bt, "ms": None}
        if c["prompt"]["show"] == "read":   # upper bound: a perfect recogniser that writes exactly the prompt
            heard["text (perfect STT)"][c["id"]] = {"heard": c["prompt"]["said"], "ms": None}
    rows = [{"key": f"{tag}|{cid}", "heard": h["heard"], "ctx": prompts[cid]["ctx"], "line": prompts[cid]["line"], "icao": prompts[cid]["icao"]}
            for tag, hs in heard.items() for cid, h in hs.items()]
    rows.sort(key=lambda r: r["ctx"])   # consecutive rows share the KV-cached game state
    js = build_chain()
    print(f"chain: {len(rows)} transcripts through rules / rules + model", flush=True)
    res = {r["key"]: r for r in run_chain(js, rows, model_dir)}

    def stats(tag, ids):
        n = len(ids)
        if not n:
            return None
        acc = collections.Counter(); we = wn = 0; ms = []
        for cid in ids:
            p = prompts[cid]; h = heard[tag][cid]; r = res[f"{tag}|{cid}"]
            if p["show"] == "read" and not tag.startswith("text"):
                e, k = wer(p["said"], h["heard"]); we += e; wn += k
            if h["ms"] is not None:
                ms.append(h["ms"])
            acc["l0"] += r["l0"]["same"]; acc["chain"] += r["chain"]["same"]; acc["model"] += r["model"]["same"]
            acc["sent_right"] += r["chain"]["decision"] == "sent" and r["chain"]["same"]
            acc["sent_wrong"] += r["chain"]["decision"] == "sent" and not r["chain"]["same"]
            acc["check"] += r["chain"]["decision"] == "check"; acc["say_again"] += r["chain"]["decision"] == "sayagain"
            if p["expect"] == "command":
                acc["cmd"] += 1; acc["cs_l0"] += r["l0"]["cs_ok"]; acc["cs_chain"] += r["chain"]["cs_ok"]
        ms.sort()
        return {"n": n, "wer": pct(we, wn), "l0": pct(acc["l0"], n), "chain": pct(acc["chain"], n), "model": pct(acc["model"], n),
                "sent_right": pct(acc["sent_right"], n), "sent_wrong": pct(acc["sent_wrong"], n), "check": pct(acc["check"], n),
                "say_again": pct(acc["say_again"], n), "cs_l0": pct(acc["cs_l0"], acc["cmd"]), "cs_chain": pct(acc["cs_chain"], acc["cmd"]),
                "ms_p50": ms[len(ms) // 2] if ms else None}

    summary, by_group, failures = [], {}, []
    for tag in heard:
        ids = sorted(heard[tag])
        summary.append({"recogniser": tag, **stats(tag, ids)})
        for g in ("val", "sydney", "free", "kokoro"):
            s = stats(tag, [i for i in ids if prompts[i]["group"] == g])
            if s:
                by_group.setdefault(g, []).append({"recogniser": tag, **s})
        for cid in ids:
            r = res[f"{tag}|{cid}"]
            if not r["chain"]["same"]:
                p = prompts[cid]
                failures.append({"id": cid, "recogniser": tag, "group": p["group"], "kind": p["kind"], "said": p["said"] if p["show"] == "read" else None,
                                 "intent": p["intent"] if p["show"] != "read" else None, "heard": heard[tag][cid]["heard"], "gold": p["line"],
                                 "got": r["chain"]["line"], "decision": r["chain"]["decision"], "source": r["chain"]["source"],
                                 "confidence": r["chain"]["confidence"], "l0": r["l0"]["same"]})
    doc = {"label": label, "built": time.strftime("%Y-%m-%d %H:%M"), "clips": len(clips), "gold_dir": str(gold_dir), "model": str(Path(model_dir).relative_to(ROOT)) if str(model_dir).startswith(str(ROOT)) else str(model_dir),
           "seconds": round(sum(len(read_wav(c["wav"])) for c in clips) / 16000, 1), "summary": summary, "by_group": by_group,
           "failures": failures, "per_clip": {k: {"heard": heard[k.split("|")[0]][k.split("|")[1]]["heard"], **v} for k, v in res.items()}}
    json.dump(doc, open(out_dir / "scores.json", "w"), indent=1, ensure_ascii=False)
    (out_dir / "scores.md").write_text(markdown(doc))
    print(markdown(doc).split("\n## Failures")[0])
    return doc


def markdown(doc):
    f = lambda v: "–" if v is None else f"{v * 100:.1f}%"   # noqa: E731
    head = "| recogniser | n | WER | callsign L0 | callsign chain | exact L0 | exact chain | sent right | sent wrong | to check | say again | model alone | STT ms p50 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    row = lambda s: f"| {s['recogniser']} | {s['n']} | {f(s['wer'])} | {f(s['cs_l0'])} | {f(s['cs_chain'])} | {f(s['l0'])} | {f(s['chain'])} | {f(s['sent_right'])} | {f(s['sent_wrong'])} | {f(s['check'])} | {f(s['say_again'])} | {f(s['model'])} | {s['ms_p50'] if s['ms_p50'] is not None else '–'} |\n"  # noqa: E731
    md = f"# Gold set scores: {doc['label']}\n\n{doc['clips']} clips, {doc['seconds']} s of audio, model {doc['model']}, built {doc['built']}.\n\n"
    md += "exact = the command the chain ends with equals the prompt's command (parsed ASTs compared); sent = passed the confidence gate.\n\n"
    md += head + "".join(row(s) for s in doc["summary"])
    for g, rows in doc["by_group"].items():
        md += f"\n## {g}\n\n" + head + "".join(row(s) for s in rows)
    md += "\n## Failures (chain did not end with the right command)\n\n| id | recogniser | kind | heard | gold | got | decision |\n|---|---|---|---|---|---|---|\n"
    for x in doc["failures"]:
        md += f"| {x['id']} | {x['recogniser']} | {x['kind']} | {x['heard']} | {x['gold']} | {x['got']} | {x['decision']} |\n"
    return md


# ───────────────────────────── dry run ─────────────────────────────
def dryrun(n, models, keep=False):
    """Kokoro clips -> staged WAVs + a prompt file -> POSTed through the real route handler (node) into a temp gold dir
    -> scored exactly like real recordings."""
    import numpy as np
    clips = json.load(open(KOKORO / "clips.json"))
    icao_of = {}
    for l in open(ROOT / "ml/data/out/ds/val.jsonl"):   # stt_bench.py sampled the clips from this file
        r = json.loads(l); icao_of.setdefault(r["ctx"], r["icao"])
    rng = random.Random(3); rng.shuffle(clips)
    clips = clips[:n]
    stage = DRY / "stage"; shutil.rmtree(stage, ignore_errors=True); stage.mkdir(parents=True)
    prompts = []
    for i, c in enumerate(clips):
        pid = f"k{i + 1:03d}"
        a = np.load(KOKORO / f"clip{c['i']:04d}.npy")
        with wave.open(str(stage / f"{pid}.wav"), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
        prompts.append({"id": pid, "n": i + 1, "group": "kokoro", "icao": icao_of.get(c["ctx"], "?"), "kind": c["kind"], "src": "kokoro", "variant": None,
                        "show": "read", "said": c["text"], "intent": c["line"], "line": c["line"], "expect": "say again" if c["line"] == "SAY AGAIN" else "command",
                        "name": None, "callsigns": [l.split()[0] for l in c["ctx"].split("\n")[1:] if l.strip()], "ctx": c["ctx"], "voice": c["voice"]})
    (stage / "prompts.json").write_text(json.dumps({"version": 1, "count": len(prompts), "prompts": prompts}, indent=1))
    gold = Path(tempfile.mkdtemp(prefix="gold-dry-"))
    key = hashlib.sha256(os.urandom(16)).hexdigest()[:32]
    (gold / ".key").write_text(key + "\n")
    js = build_chain()
    env = {**os.environ, "GOLD_DIR": str(gold), "GOLD_PROMPTS": str(stage / "prompts.json"), "GOLD_KEY": key}
    r = subprocess.run(["node", str(js), "ingest", str(stage)], capture_output=True, text=True, env=env, cwd=ROOT)
    print(r.stdout.strip())
    if r.returncode:
        sys.exit(f"ingest failed:\n{r.stderr[-2000:]}")
    doc = score(gold, stage / "prompts.json", models, DRY, label="dry run: Kokoro synthetic speech")
    if not keep:
        shutil.rmtree(gold, ignore_errors=True)
    return doc


CEILING = ROOT / "ml/stt/out/gold-ceiling.json"


def ceiling_summary(out, prompts):
    """The chain on the prompt text itself (a perfect recogniser): the most the gold set can score."""
    read = [x for x in out if prompts[x["key"].split("|")[1]]["show"] == "read"]
    c = lambda xs, f: sum(1 for x in xs if f(x))  # noqa: E731
    return {"built": time.strftime("%Y-%m-%d %H:%M"), "n": len(read), "l0": c(read, lambda x: x["l0"]["same"]), "chain": c(read, lambda x: x["chain"]["same"]),
            "sent_right": c(read, lambda x: x["chain"]["decision"] == "sent" and x["chain"]["same"]), "sent_wrong": c(read, lambda x: x["chain"]["decision"] == "sent" and not x["chain"]["same"]),
            "misses": [{"id": x["key"].split("|")[1], "gold": prompts[x["key"].split("|")[1]]["line"], "got": x["chain"]["line"], "decision": x["chain"]["decision"]} for x in read if not x["chain"]["same"]]}


def ceiling(prompts_path=PROMPTS, model_dir=MODEL):
    prompts = load_prompts(prompts_path)
    rows = sorted(({"key": f"text|{p['id']}", "heard": p["said"], "ctx": p["ctx"], "line": p["line"], "icao": p["icao"]} for p in prompts.values() if p["show"] == "read"), key=lambda r: r["ctx"])
    doc = ceiling_summary(run_chain(build_chain(), rows, model_dir), prompts)
    CEILING.parent.mkdir(parents=True, exist_ok=True); json.dump(doc, open(CEILING, "w"), indent=1)
    print(json.dumps({k: v for k, v in doc.items() if k != "misses"}), *doc["misses"], sep="\n")
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prompts"); p.add_argument("--seed", type=int, default=11); p.add_argument("--out", default=str(PROMPTS))
    s = sub.add_parser("score"); s.add_argument("--gold", default=str(GOLD)); s.add_argument("--prompts", default=str(PROMPTS))
    s.add_argument("--models", default=DEFAULT_MODELS); s.add_argument("--model-dir", default=str(MODEL)); s.add_argument("--limit", type=int)
    s.add_argument("--out", default=None, help="default: <gold>/scores"); s.add_argument("--no-report", action="store_true")
    d = sub.add_parser("dryrun"); d.add_argument("--n", type=int, default=30); d.add_argument("--models", default=DEFAULT_MODELS)
    d.add_argument("--keep", action="store_true", help="keep the temp gold dir"); d.add_argument("--no-report", action="store_true")
    c = sub.add_parser("ceiling"); c.add_argument("--no-report", action="store_true")
    a = ap.parse_args()
    if a.cmd == "prompts":
        build_prompts(a.seed, a.out); return
    if a.cmd == "ceiling":
        ceiling()
        a.models = ""
    models = [m for m in a.models.split(",") if m]
    if a.cmd == "score":
        score(a.gold, a.prompts, models, a.out or Path(a.gold) / "scores", a.model_dir, a.limit)
    elif a.cmd == "dryrun":
        dryrun(a.n, models, a.keep)
    if not a.no_report:
        sys.path.insert(0, str(ROOT / "ml/report"))
        import build_gold
        build_gold.main([])


if __name__ == "__main__":
    main()
