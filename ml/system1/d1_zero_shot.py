"""Zero-shot test of a System One decision model on the ATC task (no training).

LiquidAI/d1-omni-600M answers typed questions about a state in one forward pass, with zero output tokens.
We ask it two multiple-choice questions per spoken command:
  aircraft     which aircraft in the game state was called (options = the callsigns, or "none")
  instruction  which kind of instruction it was (heading, altitude, taxi, ...)
from (a) the transcript text and (b) the audio clip directly, and compare with the S1 model trained from scratch.

    ml/.venv/bin/python ml/system1/d1_zero_shot.py --n 120            # text, validation set
    ml/.venv/bin/python ml/system1/d1_zero_shot.py --audio ml/stt/out/clips   # audio clips
"""
import argparse, json, random, re, statistics, sys, time, wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "s1"))
import compat  # noqa: F401,E402  (this host's Python 3.11rc shim, before torch)
import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModel  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
KINDS = {
    "heading": "Turn or fly a heading", "altitude": "Climb or descend to an altitude", "speed": "Change speed",
    "direct": "Proceed direct to a fix", "ils": "Cleared for the ILS approach", "clearedLand": "Cleared to land",
    "takeoff": "Cleared for takeoff", "lineup": "Line up and wait", "taxi": "Taxi to a runway or a stand",
    "pushback": "Pushback or start-up approved", "holdPosition": "Hold position or hold short", "cross": "Cross a runway",
    "contact": "Contact another frequency", "ack": "Acknowledge only: roger, radar contact, standby or unable",
}
GOLD = {"heading": "heading", "altitude": "altitude", "speed": "speed", "direct": "direct", "ils": "ils", "clearedLand": "clearedLand",
        "takeoff": "takeoff", "lineup": "lineup", "taxi": "taxi", "pushback": "pushback", "startup": "pushback", "holdPosition": "holdPosition",
        "holdShort": "holdPosition", "cross": "cross", "contact": "contact", "roger": "ack", "radarContact": "ack", "standby": "ack", "unable": "ack"}


VARIANT = {"none": True, "names": "full"}


def aircraft_options(ctx: str):
    opts = {}
    for line in ctx.split("\n")[1:]:
        p = line.split()
        if len(p) < 4:
            continue
        cs = p[0]
        # "DAL76 delta 76 ARR APP approach 11000ft h121 31R" -> "delta 76 (DAL76), arrival on approach"
        m = re.match(r"^(\S+) (.+?) (ARR|DEP) (\S+) (\S+)", line)
        name = m.group(2) if m else cs
        opts[cs] = name if VARIANT["names"] == "plain" else f"{name} ({cs}), {'arrival' if (m and m.group(3) == 'ARR') else 'departure'}"
    if VARIANT["none"]:
        opts["none"] = "None of these aircraft was called, or the call was cut off"
    return opts


def questions(ctx):
    return {
        "aircraft": {"type": "choice", "instructions": "Which aircraft did the air traffic controller call?", "criteria": aircraft_options(ctx)},
        "instruction": {"type": "choice", "instructions": "What did the controller instruct that aircraft to do?", "criteria": KINDS},
    }


def gold_of(ex):
    if ex["line"] == "SAY AGAIN":
        return "none", None
    return ex["line"].split()[0], GOLD.get(ex["kind"].split("+")[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=120); ap.add_argument("--audio", default=None); ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--data", default=str(ROOT / "ml/data/out/ds/val.jsonl")); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-none", action="store_true", help="no 'none' option for the aircraft question")
    ap.add_argument("--plain", action="store_true", help="options are just the spoken names ('delta 76')")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    VARIANT["none"] = not a.no_none; VARIANT["names"] = "plain" if a.plain else "full"
    t0 = time.time()
    model = AutoModel.from_pretrained("LiquidAI/d1-omni-600M", trust_remote_code=True, dtype=torch.float32).eval()
    print(f"loaded in {time.time() - t0:.0f}s", flush=True)
    if a.audio:
        meta = json.load(open(Path(a.audio) / "meta.json"))
        rows = [{"ctx": m["ctx"], "line": m["line"], "kind": m["kind"], "wav": str(Path(a.audio) / m["wav"])} for m in meta]
    else:
        rows = [json.loads(l) for l in open(a.data)]
        random.Random(a.seed).shuffle(rows)
        rows = [r for r in rows if (r["line"] == "SAY AGAIN" and VARIANT["none"]) or (r["line"] != "SAY AGAIN" and GOLD.get(r["kind"].split("+")[0]))][: a.n]
    hit_cs = hit_k = n_k = 0; ms = []; conf_ok, conf_bad = [], []; fails = []
    for ex in rows:
        q = questions(ex["ctx"])
        audio = None
        if a.audio:
            with wave.open(ex["wav"]) as w:
                audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            state = "Air traffic control radio. Aircraft on frequency:\n" + "\n".join(f"- {v}" for k, v in q["aircraft"]["criteria"].items() if k != "none")
        else:
            state = "Aircraft on frequency:\n" + "\n".join(f"- {v}" for k, v in q["aircraft"]["criteria"].items() if k != "none") + f"\n\nThe controller said: \"{ex['said']}\""
        t1 = time.perf_counter()
        with torch.inference_mode():
            out = model.system_one(state, q, audio=audio)["answers"]
        ms.append((time.perf_counter() - t1) * 1000)
        gcs, gk = gold_of(ex)
        pcs, pk = out["aircraft"]["choice"], out["instruction"]["choice"]
        ok = pcs == gcs; hit_cs += ok
        (conf_ok if ok else conf_bad).append(out["aircraft"]["confidence"])
        if gk:
            n_k += 1; hit_k += pk == gk
        if not ok and len(fails) < 8:
            fails.append(f"{ex.get('said', ex['line'])!r}: gold {gcs}/{gk} got {pcs}/{pk} ({out['aircraft']['confidence']:.2f})")
    ms.sort()
    res = {"mode": "audio" if a.audio else "text", "variant": ("no-none " if a.no_none else "") + ("plain" if a.plain else "full"), "n": len(rows), "aircraft_acc": round(hit_cs / len(rows), 3), "instruction_acc": round(hit_k / max(1, n_k), 3),
           "ms_p50": round(ms[len(ms) // 2]), "ms_p95": round(ms[int(len(ms) * .95)]), "conf_when_right": round(statistics.mean(conf_ok), 3) if conf_ok else None,
           "conf_when_wrong": round(statistics.mean(conf_bad), 3) if conf_bad else None, "threads": a.threads}
    print(json.dumps(res))
    for f in fails:
        print("  ", f)
    out_dir = ROOT / "ml/system1/out"; out_dir.mkdir(parents=True, exist_ok=True)
    json.dump({"summary": res, "fails": fails}, open(out_dir / f"d1-{res['mode']}-{res['variant'].replace(' ', '_')}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
