"""Moonshine v2 streaming (moonshine-ai, Jan 2026; tiny 34M / small 123M) through the official moonshine-voice
package (C++ core on onnxruntime, the .ort files of download.moonshine.ai). Writes the bench JSONL rows.
    taskset -c 0,1 ml/stt/venvs/moonshine/bin/python ml/stt/bench2/edge_moonshine.py <clipdir> <out.jsonl> \
        --arch tiny|small [--keyterms none|names] [--alts] [--every 2]
--keyterms names: the airline telephony on frequency through Transcriber.set_keyterms (streaming archs only).
"""
import argparse, json, os, re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_cactus import load_clips, read_wav, names   # noqa: E402  (same clip loader / keyword list)
from moonshine_voice import Transcriber, ModelArch, get_model_for_language


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("out")
    ap.add_argument("--arch", default="tiny"); ap.add_argument("--keyterms", default="names")
    ap.add_argument("--alts", action="store_true"); ap.add_argument("--every", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--boost", default="")
    a = ap.parse_args()
    arch = {"tiny": ModelArch.TINY_STREAMING, "small": ModelArch.SMALL_STREAMING, "medium": ModelArch.MEDIUM_STREAMING,
            "tiny1": ModelArch.TINY, "base1": ModelArch.BASE}[a.arch]
    path, arch = get_model_for_language("en", arch)
    opts = {"keyterm_boost": a.boost} if a.boost else None
    t = Transcriber(model_path=path, model_arch=arch, options=opts)
    d = Path(a.dir)
    clips = load_clips(d)
    if a.every > 1:
        clips = [c for c in clips if not str(c.get("id", "")).isdigit() or int(c["id"]) % a.every == 0]
    if a.limit:
        clips = clips[: a.limit]
    done = {json.loads(l)["wav"] for l in open(a.out) if l.strip()} if os.path.exists(a.out) else set()
    print(json.dumps({"model": str(path), "arch": int(arch), "clips": len(clips), "done": len(done)}), file=sys.stderr)

    def run(audio, kw):
        if a.keyterms != "none" and a.arch in ("tiny", "small", "medium"):
            t.set_keyterms([k.title() for k in kw] if kw else None)
        s = time.time()
        tr = t.transcribe_without_streaming(audio.tolist(), 16000)
        return " ".join(l.text.strip() for l in tr.lines if l.text.strip()), round((time.time() - s) * 1000)

    t0 = time.time()
    n = 0
    with open(a.out, "a") as fo:
        for c in clips:
            if c["wav"] in done:
                continue
            audio = read_wav(d / c["wav"])
            kw = [] if a.keyterms == "none" else names(c["ctx"])
            text, ms = run(audio, kw)
            alts, more = [text], 0
            if a.alts and kw:
                t2, more = run(audio, [])
                alts.append(t2)
            uniq = list(dict.fromkeys(x for x in alts if x))
            fo.write(json.dumps({"wav": c["wav"], "heard": uniq[0] if uniq else "", "alts": uniq, "ms": ms, "moreMs": more,
                                 "sec": round(len(audio) / 16000, 2)}) + "\n")
            fo.flush()
            n += 1
            if n % 50 == 0:
                print(json.dumps({"n": n, "elapsed_s": round(time.time() - t0)}), file=sys.stderr)
    print(json.dumps({"finished": n, "elapsed_s": round(time.time() - t0)}), file=sys.stderr)


if __name__ == "__main__":
    main()
