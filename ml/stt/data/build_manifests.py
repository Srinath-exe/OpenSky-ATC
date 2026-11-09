"""Training and test lists for the speech-to-text fine-tune: ml/data/stt/manifests/*.jsonl (NeMo-style rows:
audio_filepath, duration, text, plus source / licence / use and, for synthetic lines, the command line and context).
    ml/stt/.venv/bin/python ml/stt/data/build_manifests.py
  train_synth.jsonl   synthetic controller speech (commercial use OK: Apache-2.0 / OpenRAIL-M voices, our own text)
  train_nc.jsonl      UWB-ATCC + ATCOSIM train (non-commercial licences)
  train_all.jsonl     both
  test_synth.jsonl    3 % of the synthetic lines (by id), never trained on
  test_atco2.jsonl, test_uwb.jsonl, test_atcosim.jsonl   the corpora's own test splits
  test_gold.jsonl     the owner's recordings read from the gold set (ml/data/gold; the free-wording ones have no reference)
Synthetic rows point at the augmented clip (augment_synth.py: clean / radio / laptop / phone); synthetic clips that
Parakeet (check.cjs, on the clean clip) hears with >= 60 % word error after number folding are marked tts_suspect
and left out of training (a bad synthesis, not a hard example: the median is far lower)."""
import hashlib, json, sys
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import norm
from wer import wer_num

S, P, M = ROOT / "ml/data/stt/synth", ROOT / "ml/data/stt/public", ROOT / "ml/data/stt/manifests"
LIC = {"kokoro": "Apache-2.0 (Kokoro-82M)", "paradee": "Apache-2.0 (Paradee-8M)", "phonon": "Apache-2.0 (Phonon-31M)", "supertonic": "OpenRAIL-M (Supertonic 3)"}


def held_out(i):
    return int(hashlib.md5(i.encode()).hexdigest(), 16) % 100 < 3


def jl(p):
    return [json.loads(l) for l in open(p)] if Path(p).exists() else []


def main():
    M.mkdir(parents=True, exist_ok=True)
    check = {r["id"]: r for r in jl(S / "check_parakeet.jsonl")}
    synth, test_synth, suspect, missing = [], [], 0, 0
    for r in jl(S / "lines.jsonl"):
        clean = S / "audio" / r["engine"] / f"{r['id']}.wav"; wav = S / "aug" / r["engine"] / f"{r['id']}.wav"   # augment_synth.py
        if not wav.exists(): missing += 1; continue
        c = check.get(r["id"]); w = wer_num(r["text"], c["heard"]) if c and c.get("heard") is not None else None
        row = {"audio_filepath": str(wav), "duration": round(sf.info(str(wav)).duration, 3), "text": r["text"], "source": f"synth-{r['engine']}",
               "voice": r["voice"], "licence": LIC[r["engine"]], "use": "train", "line": r["line"], "kind": r["kind"], "icao": r["icao"],
               "ctx": r["ctx"], "said": r["say"], "clean_filepath": str(clean), "parakeet_wer_clean": None if w is None else round(w, 3)}
        if held_out(r["id"]): test_synth.append({**row, "use": "test"}); continue
        if w is not None and w >= 0.6: suspect += 1; row["tts_suspect"] = True; continue
        synth.append(row)
    nc = []
    for name in ("uwb_atcc", "atcosim"):
        for r in jl(P / f"{name}_train.jsonl"):
            nc.append({"audio_filepath": str(ROOT / r["wav"]), "duration": r["duration"], "text": r["text"], "source": name, "role": r["role"], "licence": r["licence"], "use": r["use"]})
    tests = {}
    for name, key in (("atco2_1h", "atco2"), ("uwb_atcc", "uwb"), ("atcosim", "atcosim")):
        tests[key] = [{"audio_filepath": str(ROOT / r["wav"]), "duration": r["duration"], "text": r["text"], "source": name, "role": r["role"], "licence": r["licence"], "use": "test"} for r in jl(P / f"{name}_test.jsonl")]
    prompts = {p["id"]: p for p in json.load(open(ROOT / "public/voice/gold-prompts.json"))["prompts"]}
    gold = []
    for j in sorted((ROOT / "ml/data/gold").glob("*.json")):
        m = json.load(open(j)); p = prompts.get(m["id"]) or m.get("prompt", {}); wav = j.with_suffix(".wav")
        if not wav.exists(): continue
        gold.append({"audio_filepath": str(wav), "duration": round(sf.info(str(wav)).duration, 3), "text": norm(p["said"]) if p.get("show") == "read" and p.get("said") else None,
                     "source": "gold-owner", "line": p.get("line"), "ctx": p.get("ctx"), "icao": p.get("icao"), "licence": "owner's recordings (private)", "use": "test"})
    out = {"train_synth": synth, "train_nc": nc, "train_all": synth + nc, "test_synth": test_synth, "test_gold": gold,
           **{f"test_{k}": v for k, v in tests.items()}}
    summary = {}
    for k, rows in out.items():
        with open(M / f"{k}.jsonl", "w") as fo:
            for r in rows: fo.write(json.dumps(r) + "\n")
        summary[k] = {"clips": len(rows), "hours": round(sum(r["duration"] for r in rows) / 3600, 2)}
    summary["synth_missing"] = missing; summary["synth_tts_suspect"] = suspect
    json.dump(summary, open(M / "summary.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
