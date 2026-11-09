"""Collect the on-device (edge) results into ml/stt/models/edge.json for ml/stt/models/build_report.py.
Numbers come from the score.ts summaries (S1_MODEL=2m-grpo-v1, --every 2: 320 US/UK clips, 160 Indian-proxy clips) and
the headless-Chromium summaries (edge_browser.cjs); the server agent's summaries (ml/stt/models/.sum_*.json) for the two
models it ran that matter for phones.
    python3 ml/stt/bench2/edge_collect.py
"""
import json
from pathlib import Path

R = Path(__file__).resolve().parent / "results"
M = Path(__file__).resolve().parents[1] / "models"


def summaries(*files):
    out = {}
    for f in files:
        p = f if isinstance(f, Path) else R / f
        if p.exists():
            for r in json.load(open(p)):
                if r["group"] == "all":
                    out[r["cand"]] = r
    return out


S = summaries("edge-sum-us-base.json", "edge-sum-us1.json", "edge-sum-us2.json", "edge-sum-us-phone.json",
              "edge-sum-in-base.json", "edge-sum-in1.json", "edge-sum-in2.json", "edge-sum-in-phone.json",
              *sorted(M.glob(".sum_*.json")))


def m(cand):
    r = S.get(cand)
    if not r:
        return None
    return {"n": r["n"], "exact": r["nbest+S1"], "wrong": r["nbest+S1:wrong"], "cs": r["nbest+S1:cs"], "wer": r["wer"], "old": r["rules+S1"]}


def br(name):
    p = R / f"{name}.summary.json"
    return json.load(open(p)) if p.exists() else {}


def lat(b, note=""):
    return f"p50 {b['msP50'] / 1000:.2f} s, p90 {b['msP90'] / 1000:.1f} s{note}" if b else "-"


bw, bw2, bb, bt = br("edge-browser-whistle-kwp"), br("edge-browser-whistle"), br("edge-browser-base"), br("edge-browser-tiny")
rows = [
    {"name": "Moonshine base (shipped)", "where": "browser", "runtime": "transformers.js 4.3.1, ONNX q8, WASM", "licence": "MIT",
     "sizeMB": bb.get("downloadedMB", 69.4), "streaming": "no", "biasing": "none",
     "us": m("tjs-moonshine-base"), "in": m("edge-in-tjs-moonshine-base"),
     "latency": lat(bb), "ram": f"+{bb.get('ramModelMB', '-')} MB", "measured": "accuracy: transformers.js on onnxruntime-node; latency/RAM: headless Chromium, 40 clips"},
    {"name": "Whistle + ATC keywords", "where": "browser (opt-in)", "runtime": "Cactus engine 4.1.0 as WASM (1.3 MB), one decode", "licence": "Apache-2.0",
     "sizeMB": bw.get("downloadedMB", 18.2), "streaming": "chunked re-transcription (cactus stream API)", "biasing": "keywords: airline names + ATC words",
     "us": m("edge-whistle-kwp"), "in": m("edge-in-whistle-kwp"),
     "latency": lat(bw), "ram": f"+{bw.get('ramModelMB', '-')} MB", "measured": "accuracy: cactus-compute 4.1.0 (same engine, x86); browser: 36/40 identical transcripts"},
    {"name": "Whistle, names + 2nd decode", "where": "browser (alts=1)", "runtime": "Cactus WASM, two decodes", "licence": "Apache-2.0",
     "sizeMB": bw2.get("downloadedMB", 18.2), "streaming": "as above", "biasing": "keywords: airline names",
     "plot": False, "us": m("edge-whistle-kw"), "in": m("edge-in-whistle-kw"), "latency": lat(bw2), "ram": f"+{bw2.get('ramModelMB', '-')} MB",
     "measured": "as above"},
    {"name": "Moonshine tiny", "where": "browser", "runtime": "transformers.js, WASM", "licence": "MIT", "sizeMB": bt.get("downloadedMB", 34.6),
     "streaming": "no", "biasing": "none", "us": m("tjs-moonshine-tiny"), "in": m("edge-in-tjs-moonshine-tiny"),
     "latency": lat(bt), "ram": f"+{bt.get('ramModelMB', '-')} MB", "measured": "as Moonshine base"},
    {"name": "Whisper tiny.en + callsign prompt", "where": "browser", "runtime": "transformers.js, WASM", "licence": "MIT", "sizeMB": 41,
     "streaming": "no", "biasing": "text prompt (callsigns)", "us": m("tjs-whisper-tiny.en"), "in": m("edge-in-tjs-whisper-tiny.en"),
     "latency": "p50 4.1 s (round 2, 10 clips)", "ram": "-", "measured": "accuracy: transformers.js on node; too slow on one WASM thread"},
    {"name": "Moonshine v2 tiny (streaming)", "where": "browser* / phone", "runtime": "moonshine-voice 0.1.6 (C++ on ORT, .ort int8)", "licence": "MIT",
     "sizeMB": 45, "streaming": "yes", "biasing": "keyterms", "us": m("edge-moonshine2-tiny"), "in": m("edge-in-moonshine2-tiny"),
     "latency": "browser not run (needs cross-origin isolation)", "ram": "-", "measured": "moonshine-voice Python, 1 core, with keyterms (+ plain decode as 2nd guess)"},
    {"name": "Moonshine v2 small (streaming)", "where": "browser* / phone", "runtime": "moonshine-voice 0.1.6", "licence": "MIT",
     "sizeMB": 142, "streaming": "yes", "biasing": "keyterms", "us": m("edge-moonshine2-small"), "in": m("edge-in-moonshine2-small"),
     "latency": "x86 1 core: ~1.6 s per clip (2 decodes)", "ram": "-", "measured": "as v2 tiny"},
    {"name": "Zipformer + hotwords (phone app today)", "where": "phone", "runtime": "sherpa-onnx (Flutter app), streaming", "licence": "Apache-2.0",
     "sizeMB": 73, "streaming": "yes", "biasing": "hotwords (callsigns, names, phraseology)", "us": m("edge-phone-zipformer-hot"), "in": m("edge-in-phone-zipformer-hot"),
     "latency": "after release p50 55 ms (x86, 2 threads)", "ram": "-", "measured": "mobile/tool/stt_bench.dart, the app's own engine code"},
    {"name": "Moonshine base via sherpa-onnx", "where": "phone (recommended)", "runtime": "sherpa-onnx offline, .ort quantized 2026-02-27", "licence": "MIT",
     "sizeMB": 141, "streaming": "no (transcribes on release)", "biasing": "none", "us": m("edge-phone-moonshine-base"), "in": m("edge-in-phone-moonshine-base"),
     "latency": "after release p50 0.47-0.54 s (x86, 2 threads)", "ram": "-", "measured": "mobile/tool/stt_bench.dart, the app's own engine code"},
    {"name": "Parakeet TDT 110M + hotwords", "where": "phone", "runtime": "sherpa-onnx offline transducer, int8", "licence": "CC-BY-4.0",
     "sizeMB": 136, "streaming": "no", "biasing": "hotwords", "us": m("srv-p110-sherpa"), "in": m("srv-p110-sherpa.in"),
     "latency": "p50 0.5-0.7 s (x86, 3 threads)", "ram": "225-359 MB RSS (x86)", "measured": "server agent's run (sherpa-onnx Python), shared"},
    {"name": "Phonon-2.5 English", "where": "phone (flagships only)", "runtime": "LiteRT int8 CPU (or NPU/GPU builds)", "licence": "CC-BY-4.0 weights, Apache-2.0 code",
     "sizeMB": 940, "streaming": "no", "biasing": "hotwords in the reference package; none in LiteRT greedy", "us": m("srv-phonon"), "in": m("srv-phonon.in"),
     "latency": "LiteRT int8 x86 1 thread: p50 0.7 s", "ram": "card: 6.1 GB peak on a Galaxy S26 CPU run", "measured": "accuracy: server agent's reference run; LiteRT parity: 37/40 and 33/40 identical to its plain decode"},
]
rows = [r for r in rows if r["us"] or r["in"]]


def p(x):
    return f"{100 * x:.1f}%"


base_us, base_in = m("tjs-moonshine-base"), m("edge-in-tjs-moonshine-base")
wk_us, wk_in = m("edge-whistle-kwp"), m("edge-in-whistle-kwp")
zf_us, zf_in = m("edge-phone-zipformer-hot"), m("edge-in-phone-zipformer-hot")
pm_us, pm_in = m("edge-phone-moonshine-base"), m("edge-in-phone-moonshine-base")
doc = {
    "title": "On-device: the browser keeps Moonshine base; the phone should switch to it",
    "updated": "2026-11-09",
    "lede": ("Nothing new beats Moonshine base in the browser on both sets. Whistle is the light option (18 MB, a quarter of the RAM, "
             "about as fast) but 3 to 8 points less accurate. On the phone, the app's streaming zipformer is the weakest engine measured; "
             "the same sherpa-onnx runtime runs Moonshine base, which is 10 to 19 points better."),
    "headline": [
        {"value": f"{p(base_us['exact'])} / {p(base_in['exact'])}", "label": "Moonshine base in the browser, exact command US/UK / Indian proxy (unchanged default)"},
        {"value": f"{p(wk_us['exact'])} / {p(wk_in['exact'])}", "label": f"Whistle, 18 MB, opt-in (?stt-model=whistle), {bw.get('msP50', 0) / 1000:.2f} s median in WASM"},
        {"value": f"{p(zf_us['exact'])} → {p(pm_us['exact'])}", "label": f"phone app, US/UK: zipformer → Moonshine base (Indian proxy {p(zf_in['exact'])} → {p(pm_in['exact'])})"},
    ],
    "best": [
        "<b>Browser: Moonshine base stays the default.</b> Best accuracy of anything that runs in a normal (not cross-origin-isolated) page "
        f"on one WASM thread: {p(base_us['exact'])} / {p(base_in['exact'])}. Whisper tiny.en scores higher but takes about 4 s per transmission in WASM.",
        f"<b>Phone: Moonshine base through sherpa-onnx</b> ({p(pm_us['exact'])} / {p(pm_in['exact'])}, sent wrong {p(pm_us['wrong'])} / {p(pm_in['wrong'])}), "
        "a model swap inside the runtime the app already has (its engine already supports the 'moonshine' kind). Parakeet 110M with hotwords "
        "is close (better on US/UK, worse on the Indian proxy, CC-BY); Phonon-2.5 is the most accurate but a 0.94 GB download.",
    ],
    "shipped": [
        "public/voice/stt-worker.js: a Whistle engine (<code>?model=whistle</code>): the Cactus engine's WASM build and the .cact weights from "
        "pinned Hugging Face revisions, cached with the Cache API, keyword-biased with the airline names on frequency and the ATC command words; "
        "transformers.js is now imported only for the engines that use it; a failed model load is retried on the next push-to-talk.",
        "src/lib/voice/recognizer.ts: the game page's <code>?stt-model=whistle</code> (or tiny, whisper-tiny.en) picks the on-device model; "
        "the default is unchanged (Moonshine base), so the settings label is unchanged.",
        "mobile/STT_MODEL_NOTE.md: the exact manifest change for the phone (not built).",
    ],
    "failed": [
        "Moonshine v2 in the browser: transformers.js (4.3.2, 4.4.0-next) has no moonshine_streaming support, and the official "
        "@moonshine-ai/moonshine-wasm 0.1.6 ships only a SIMD + pthreads build, which needs COOP/COEP headers the game does not send "
        "(a single-thread build has to be compiled from source with emsdk 4.0.8 and ONNX Runtime). Not worth it: v2 small is +3.7 points on "
        "US/UK and -0.6 on the Indian proxy against Moonshine base, at 142 MB.",
        "WebGPU: this server has no GPU, so headless Chromium has no adapter; every browser number is WASM (one thread, as players without "
        "cross-origin isolation get). On a player's GPU Moonshine base would be faster; Whistle has no WebGPU path.",
        "Whistle's native x86 engine has a cliff above 5 s of audio (0.2 s → 1.5 s per clip with 2 threads, worse under load); the WASM build "
        "scales smoothly (0.73 s under 4 s, 1.9 s over 6 s).",
        "Phonon-2.5 English as a 'tiny' phone model: the 157.6 MB file is an MLX (Apple silicon) container; the Android LiteRT CPU build "
        "is 0.94 GB and its card reports 6.1 GB peak RAM on a Galaxy S26 CPU run.",
        "No real recordings yet: ml/data/gold/live/ is empty, so every number is synthetic speech (Kokoro). The Indian-accent set is "
        "Kokoro's Hindi voices reading English, a proxy, not the owner.",
    ],
    "notes": [
        "Contextual biasing paid off for Whistle only with the command words: names alone 61.6% / 61.9% (one decode), "
        f"names + ATC words {p(wk_us['exact'])} / {p(wk_in['exact'])}; WER 36.7 → 32.7% (US/UK).",
        "Where Whistle loses (US/UK, against Moonshine base): late start 56% vs 64% and clean 72.5% vs 77.5%; it ties on laptop (75%) and "
        "radio (54% vs 52.5%). On the Indian-accent proxy it is 8 points behind (66.9% vs 75.0%), the gap that matters most for the owner.",
        "Sent wrong (a wrong command the game would send) is 2-7% for every engine: the verifier holds back most misrecognitions, so the "
        "differences are in how often the player has to repeat.",
    ],
    "method": [
        "Clips: ml/stt/bench2/clips (160 situations x clean/laptop/radio/late, US/UK Kokoro voices), even ids: 320; "
        "ml/stt/bench2/clips_in (Kokoro Hindi voices, clean/laptop), even ids: 160.",
        "Score: ml/stt/bench2/score.ts with S1_MODEL=2m-grpo-v1; 'exact' = the game's n-best + repair + S1 chain ends on the gold command; "
        "baselines were rescored with today's scorer (the verifier lowered every engine's sent-wrong since round 2).",
        "Browser: ml/stt/bench2/edge_browser.cjs, headless Chromium (playwright), the game's worker, 40 clips (mean 5.0 s), WASM; RAM = PSS of "
        "all Chromium processes above a blank page (peak); download = bytes fetched. The machine was shared (load average 12-20), so "
        "latencies are pessimistic.",
        "Phone: mobile/tool/stt_bench.dart (the app's SttEngine and hotword builder, sherpa-onnx on Linux x86, 2 threads).",
    ],
    "rows": rows,
}
(M / "edge.json").write_text(json.dumps(doc, indent=1))
print(f"wrote {M / 'edge.json'}: {len(rows)} rows")
for r in rows:
    u, i = r["us"] or {}, r["in"] or {}
    print(f"{r['name'][:36]:36} {100 * u.get('exact', 0):5.1f} {100 * i.get('exact', 0):5.1f}  {r['sizeMB']} MB  {r['latency']}")
