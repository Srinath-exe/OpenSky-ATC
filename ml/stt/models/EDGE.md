# On-device speech-to-text, November 2026 (browser and phone)

Report: `public/reports/voice-stt-models.html` (/reports/voice-stt-models.html), built by `ml/stt/models/build_report.py`
from `edge.json` (this part) and `server.json` (the server-side part). Numbers: `python3 ml/stt/bench2/edge_collect.py`.

## Verdict

- **Browser: keep Moonshine base as the default.** Nothing that runs in the game's page (not cross-origin isolated, one
  WASM thread, no WebGPU here) beats it on both sets. **Whistle** (Cactus, 18 MB) is the light option: a quarter of the
  download, 40% of the RAM, slightly faster, but 2.8 points behind on US/UK and 8.1 behind on the Indian-accent proxy.
  It is in the worker as an opt-in (`?stt-model=whistle` on the game page).
- **Phone: switch the app from the streaming zipformer to Moonshine base through the same sherpa-onnx runtime**:
  57.8 → 67.8% (US/UK) and 57.5 → 76.9% (Indian proxy). The exact manifest change is in `mobile/STT_MODEL_NOTE.md`
  (not built).
- No owner recordings exist yet (`ml/data/gold/live/` is empty): everything here is synthetic speech.

## Results

Exact = the game's chain (n-best + repair + S1 `2m-grpo-v1` + verifier) ends on the gold command. Sent wrong = a wrong
command the game would send. US/UK: `clips`, even ids, 320 clips (clean/laptop/radio/late). IN: `clips_in` (Kokoro
Hindi voices reading the English), even ids, 160 clips (clean/laptop).

| engine | where | exact US/UK | exact IN | sent wrong US/IN | callsign US | WER US/IN | download | latency | RAM | licence |
|---|---|--:|--:|--:|--:|--:|--:|---|---|---|
| Moonshine base (shipped) | browser | 67.2% | 75.0% | 5.0 / 3.7% | 76.6% | 33.8 / 33.4% | 69 MB | 1.31 s p50 WASM | +674 MB | MIT |
| Whistle + ATC keywords, 1 decode | browser (opt-in) | 64.4% | 66.9% | 5.3 / 4.4% | 73.4% | 32.7 / 35.0% | 18 MB | 0.93 s p50 WASM | +260 MB | Apache-2.0 |
| Whistle, names only + 2nd decode | browser | 63.7% | 66.2% | 5.0 / 4.4% | 74.1% | 36.7 / 40.3% | 18 MB | 2.08 s | +190 MB | Apache-2.0 |
| Moonshine tiny | browser | 56.3% | 66.2% | 2.2 / 3.1% | 65.0% | 42.4 / 43.2% | 35 MB | 0.70 s | +628 MB | MIT |
| Whisper tiny.en + callsign prompt | browser | 72.5% | 77.5% | 6.6 / 6.9% | 86.6% | 27.1 / 24.1% | 41 MB | ~4.1 s | - | MIT |
| Moonshine v2 tiny streaming + keyterms | (browser blocked) / phone | 66.2% | 66.2% | 4.1 / 5.6% | 76.6% | 39.2 / 39.9% | 45 MB | - | - | MIT |
| Moonshine v2 small streaming + keyterms | (browser blocked) / phone | 70.9% | 74.4% | 3.7 / 4.4% | 79.1% | 27.7 / 32.2% | 142 MB | ~1.6 s (x86, 1 core, 2 decodes) | - | MIT |
| Zipformer + hotwords (app today) | phone | 57.8% | 57.5% | 4.7 / 5.6% | 73.8% | 40.1 / 43.1% | 73 MB | 55 ms after release | - | Apache-2.0 |
| **Moonshine base, sherpa-onnx** | **phone** | **67.8%** | **76.9%** | 5.9 / 1.9% | 76.9% | 34.4 / 34.7% | 141 MB | 0.47-0.54 s after release | - | MIT |
| Parakeet TDT 110M + hotwords (server agent's run) | phone | 69.4% | 68.8% | 5.3 / 5.6% | 78.1% | 35.4 / 33.8% | 136 MB | ~0.5-0.7 s (x86) | 225-359 MB RSS | CC-BY-4.0 |
| Phonon-2.5 English (server agent's run; LiteRT parity) | phone, flagships | 72.8% | 76.9% | 7.5 / 2.5% | 85.6% | 26.8 / 28.2% | 940 MB (LiteRT CPU) | 0.7 s (LiteRT, x86 1 thread) | 6.1 GB peak (card, S26) | CC-BY-4.0 |
| Web Speech (Google), reference, not on-device | browser | 72.5% | - | 3.4% | 79.4% | 30.3% | 0 | 78 ms | - | - |

How each was measured (n as above unless stated):
- **Accuracy, browser engines**: transformers.js on onnxruntime-node (`transcribe_tjs.cjs`, the same ONNX files the
  browser loads); Whistle with `cactus-compute` 4.1.0 (`edge_cactus.py`), the same engine and weights the browser runs
  (36 of 40 browser transcripts identical, the rest differ in number formatting); Moonshine v2 with `moonshine-voice`
  0.1.6 (`edge_moonshine.py`, the official C++ core on ONNX Runtime, model files `quantized_26_11_02`).
- **Browser latency / RAM / download**: `edge_browser.cjs`, headless Chromium, the game's worker, 40 clips (mean 5.0 s
  audio), WASM. Latency = from the worker getting the audio to the text (the wait after release). RAM = peak PSS of all
  Chromium processes above a blank page. Download = bytes fetched (models + runtime). The machine was shared with
  other jobs (load average 12-20), so latencies are pessimistic. Whistle 1-decode by length: 0.73 s under 4 s of
  audio, 0.97 s for 4-6 s, 1.9 s above 6 s; Moonshine base 1.08 / 1.05 / 2.38 s.
- **WebGPU**: not available (no GPU on this server, no adapter in headless Chromium). Moonshine base would be faster on a
  player's GPU; Whistle's engine has no WebGPU path.
- **Phone**: `mobile/tool/stt_bench.dart` (the app's `SttEngine`, hotword builder and sherpa-onnx, on Linux x86, 2
  threads); clips converted with `edge_phone.py`. Parakeet 110M and Phonon are the server agent's runs
  (`results/srv-p110-sherpa*.jsonl`, `results/srv-phonon*.jsonl`, scored in its `.sum_*.json`); Phonon's LiteRT int8 phone
  build (`edge_phonon_litert.py`, 40 clips per set) gives the same text as that run's plain decode on 37/40 (US/UK) and
  33/40 (IN) clips.
- **Baselines rescored** with today's scorer: the verifier added since round 2 lowered every engine's sent-wrong
  (Moonshine base 17.5% → 5.0%), so the round-2 tables are not comparable on that column.

## Candidates

- **Cactus-Compute/whistle** (Apache-2.0, weights rev `741118687e1f`, engine `Cactus-Compute/cactus` 4.1.0 rev
  `4e822c9036be`): 16.9 MB `.cact`, an encoder-decoder (8 + 8 blocks, 5-beam search) with keyword biasing (an
  Aho-Corasick automaton over the phrases, lifting their log-probability during the beam search). Runtimes: C++ engine for
  17 targets; the browser build is Emscripten (`wasm/cactus.js` 62 KB + `cactus.wasm` 1.24 MB, single-threaded, SIMD),
  a classic script exposing `createCactus`, C API `cactus_load` / `cactus_transcribe(pcm, n, lang, keywords, ...)`;
  Android: `android-arm64/libcactus.a` + `cactus.h` (or the CLI). Streaming: `cactus_stream_transcribe_process`
  re-transcribes the buffer each chunk and commits words two passes agree on. Keywords: names alone barely helped
  (61.6 / 61.9% one decode); names + ATC command words gave 64.4 / 66.9% and lowered WER 36.7 → 32.7%. Where it loses
  to Moonshine base: late start (56% vs 64%), clean (72.5% vs 77.5%), and the Indian proxy (−8 points).
  Native x86 quirk: above ~5 s of audio the x86 engine slows sharply (0.2 → 1.5 s with 2 threads); WASM does not.
- **Moonshine v2 streaming** (moonshine-ai, MIT): `moonshine-ai/moonshine-streaming-{tiny,small,medium}` (safetensors);
  runtime files (`.ort`: frontend, encoder, adapter, cross_kv, decoder_kv) on download.moonshine.ai, mirrored in
  `moonshine-ai/moonshine-voice-assets`. Keyterm biasing (`set_keyterms`, streaming archs only). Browser: transformers.js
  4.3.2 and 4.4.0-next.0 do not know `moonshine_streaming`; `@moonshine-ai/moonshine-wasm` 0.1.6 (MIT, 13 MB wasm) runs
  it, but its published build needs SharedArrayBuffer (COOP/COEP), and the single-thread build must be compiled from
  source. Third-party ONNX exports exist (e.g. an fp32 asr.js bundle of ~700 MB) but nothing practical. Not worth the
  isolation work: v2 small is +3.7 / −0.6 points against Moonshine base at twice the size; v2 tiny is below it.
- **Phonon-2.5 English** (FermionResearch, CC-BY-4.0 weights): parakeet-tdt-0.6b-v3 architecture; the 157.6 MB file is
  a packed MLX container for Apple silicon. `litert-community/Phonon-2.5-English`: int8 CPU encoder 902 MB (+ mel graphs,
  18 MB decoder, tokenizer: 0.94 GB), f16 GPU 1.45 GB, SM8850 NPU build 1.40 GB; the card's "57x real time" is the int8
  CPU on a Galaxy S26, with 6.1 GB peak RAM. Most accurate on-device-capable model here; not a tiny model.
- **Trending tiny ASR (HF, Nov 2026)**: `inclusionAI/Ming-3.0-asr-tiny` is 17.7 GB of weights despite the name;
  `moondream/parakeet-redux` (178 MB ternary) and `parakeet-ultra` (1.26 GB) are 0.6B parakeets for CPU/Apple silicon
  with no browser runtime (the server agent ran them); `granite-speech-5.0-470m-turboctc` is 470M. Nothing under ~150 MB
  with a browser runtime beyond the ones above.

## What shipped

- `public/voice/stt-worker.js`: `?model=whistle` loads the Cactus engine's WASM build and `whistle.cact` from pinned
  Hugging Face revisions (Cache API, progress events), biases each transmission with the airline telephony on frequency
  and the ATC command words, one decode (`&alts=1` adds an unbiased second decode). transformers.js is imported lazily
  (only for Moonshine/Whisper). A failed model load is no longer cached: the next push-to-talk retries.
- `src/lib/voice/recognizer.ts` `createLocalRecognizer`: the page URL's `?stt-model=whistle|tiny|whisper-tiny.en|...`
  picks the on-device model to try; default unchanged (Moonshine base), so the settings label is unchanged.
- `mobile/STT_MODEL_NOTE.md`: the phone change (manifest entry, file URLs and hashes, the tokens.txt to host).

## Not done / failed

- Moonshine v2 in the browser (needs cross-origin isolation or a custom WASM build); WebGPU (no GPU here).
- Whistle fine-tuning (Cactus offers it through its hosted platform; not tried).
- The APK was not rebuilt (the change needs `tokens.txt` hosted first).
- Leftovers of a duplicate session (stopped by the coordinator, see `ml/stt/models/COORD.txt`) remain in
  `ml/stt/bench2/` (`edge_zf.py`, `edge_queue_base.sh`, `edge_base.log`, `edge_score_base_us.log`); its orphaned queue
  ran after mine and exited without changing the result files (they were already complete). Safe to delete.

## Files

`ml/stt/bench2/`: `edge_cactus.py`, `edge_moonshine.py`, `edge_phone.py`, `edge_phonon_litert.py`, `edge_browser.cjs`,
`edge_table.py`, `edge_collect.py`, `edge_queue*.sh`; results `results/edge-*.jsonl` (transcripts),
`results/edge-sum-*.json` (scores), `results/edge-browser-*.summary.json` (browser latency/RAM/download).
Venvs: `ml/stt/venvs/{cactus,moonshine,litert}` (git-ignored). Phonon LiteRT files: `ml/stt/models/edge-phonon-litert/`
(git-ignored).
