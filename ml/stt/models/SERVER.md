# Server speech-to-text: small CPU models, 2026-11-09

This is a measurement only; nothing in the game or the server changed. The candidates are recognisers that could replace or
join the server engine, which today is Whisper base.en through transformers.js in the Next process
(`src/app/api/voice/stt/engine.ts`). They run on this VPS's CPU (AMD EPYC 9354P, 8 cores, AVX-512 VNNI, no GPU) at 3 threads,
one utterance at a time. All numbers are in `server.json`.

## Bottom line

- **No small CPU model beats the shipped Whisper base.en on its own.** Whisper base.en with the callsign prompt, as 2-best,
  gets 76.9% exact on US/UK and 78.8% on the Indian-accent proxy. The best of the rest:
  - Granite TurboCTC: 73.8% / 78.8%;
  - Phonon-2.5-English: 72.8% / 76.9%;
  - Parakeet Ultra: 72.2% / 78.1%.

  On the same clips, Phonon alone is worse than Whisper on US/UK (-4.1 points, McNemar p=0.01). The other gaps are not
  significant.
- **The other models are 4 to 8 times faster, and they make different mistakes from Whisper.** A cascade has a fast model
  transcribe first and calls Whisper only when the game cannot understand the fast model's guesses (24-31% of
  transmissions). On the Indian-accent proxy, the cascades beat Whisper alone:
  - Parakeet Ultra then Whisper: 85.6% against 78.8%. Ultra was right on 11 clips where Whisper was wrong, and never the
    other way round (p=0.001).
  - Granite then Whisper: 84.4% (p=0.035).
  - Phonon then Whisper: 83.1% (p=0.07).

  On US/UK, the cascades are level with Whisper (76-80%, no significant difference). Median latency drops to 0.3-0.9 s.
- **Phonon-2.5-English** is the fastest good model: 0.15 s per transmission (0.30 s for 2-best). Its hotword option
  works, but it adds only about 1 point here. It runs only from Python, so using it means a sidecar.
- **For running inside Node**, sherpa-onnx-node runs the same NeMo models with per-request hotwords, in-process. The Node
  output was identical to Python's on 40 of 40 clips, at the same latency.
- There were **no real recordings from the owner** (`ml/data/gold/live/` was empty at the end). Everything here is synthetic
  speech (Kokoro TTS). The "Indian" set is Kokoro's Hindi voices reading English, so it is a proxy only.

## How it was measured

- **US/UK set:** `ml/stt/bench2/clips`, even ids (`--every 2`). 80 situations in 4 conditions (clean, laptop, radio, late
  start) make 320 clips.
- **Indian-accent proxy:** `ml/stt/bench2/clips_in`, even ids. 80 situations, clean and laptop only, make 160 clips.
- **Scoring:** `S1_MODEL=2m-grpo-v1 bash ml/stt/bench2/run.sh score <clipdir> <files> --every 2`, through the wrapper
  `ml/stt/models/srv_score.sh`, which removes duplicate rows. The chain is `nbest+S1`, what the game runs: repair, then
  n-best, then rules, then the S1 model.
  - **exact:** the final command parses to the gold command.
  - **sent-wrong:** the command was sent without a check, and it was wrong.
  - **callsign:** the command reached the right aircraft.
  - **WER:** the top-1 transcript against what was said.
- **Transcripts:** `ml/stt/bench2/results/srv-<engine>.jsonl`, and `srv-<engine>.in.jsonl` for the Indian set. Each run has a
  `.run.json` with load time and peak RSS. Runner: `ml/stt/models/srv_run.py`; queue: `srv_queue.sh`.
- **Biased engines:** `decodes = [biased, plain]`, so the scorer also reports `@prompt` (biased only) and `@plain`. The hotwords
  are the telephony words of the callsigns on frequency ("speedbird", "qatari", ...), at most 25 per transmission.
- **Latency:** a separate pass over 40 US/UK clips (mean 5.0 s of audio), one engine at a time, 3 threads, with none of our
  other jobs running (`srv_latency.sh` writes `srv-lat-*.jsonl`). The other agent's jobs kept the load average at 6-8, so the
  numbers are somewhat pessimistic. The main runs are slower still (load average 10-27), so do not compare their `ms`
  across engines.

## Results

US/UK n=320, Indian proxy n=160. Each pair of numbers is US/UK then Indian.

| engine (exact command) | exact | sent-wrong | callsign | WER | latency p50 / p95 | peak RSS | download |
|---|--:|--:|--:|--:|--:|--:|--:|
| **Shipped**: Whisper base.en + callsign prompt, 2-best (transformers.js) | 76.9 / 78.8 | 6.3 / 7.5 | 86.3 / 90.0 | 26.3 / 20.9 | 1268 / 2582 ms (1-best: 1008 / 1918) | 1.24 GB | 136 MB |
| Phonon-2.5-English, fermion CPU engine, hotwords λ2, 2-best | 72.8 / 76.9 | 7.5 / 2.5 | 85.6 / 83.1 | 26.8 / 28.2 | 149 / 273 ms (2-best 304 / 529) | 0.93 GB | 158 MB |
| Phonon-2, same engine, 2-best | 67.2 / 71.3 | 2.8 / 1.9 | 75.6 / 76.9 | 43.9 / 45.7 | 165 / 318 ms | 0.93 GB | 158 MB |
| Phonon-2, with the engine's spacing bug fixed afterwards* | 70.6 / 75.6 | 4.7 / 2.5 | 78.7 / 81.9 | 26.8 / 23.6 | same | | |
| Granite Speech 5.0 470M TurboCTC (transformers, fp32), 1-best | 73.8 / 78.8 | 6.6 / 3.1 | 81.3 / 82.5 | 23.9 / 25.0 | 682 / 1183 ms | 3.4 GB (5.8 GB peak) | 903 MB |
| Parakeet Ultra int8, sherpa-onnx, beam + hotwords, 2-best | 72.2 / 78.1 | 6.3 / 1.3 | 82.8 / 83.1 | 23.6 / 27.5 | 419 / 800 ms (2-best 855 / 1561) | 1.2-1.4 GB | 487 MB |
| Parakeet Ultra int8 (ijar), onnx-asr, greedy | 71.3 / 78.1 | 5.0 / 1.3 | 79.4 / 83.8 | 26.1 / 30.7 | ~521 / 1069 ms (sherpa greedy) | 1.5 GB | 728 MB |
| Parakeet Redux int8, sherpa-onnx, beam + hotwords, 2-best | 73.4 / 75.6 | 6.9 / 5.0 | 85.3 / 85.0 | 28.2 / 28.9 | 424 / 768 ms | 1.0 GB | 327 MB |
| Parakeet Redux ternary, moondream Photon | 70.6 / 72.5 | 7.2 / 4.4 | 82.2 / 80.0 | 29.3 / 29.8 | 563 / 1126 ms (main run, loaded) | 1.3 GB | 178 MB |
| Parakeet TDT-CTC 110M int8, sherpa-onnx, beam + hotwords, 2-best | 69.4 / 68.8 | 5.3 / 5.6 | 78.1 / 79.4 | 35.4 / 33.8 | 174 / 1215 ms (greedy 154 / 287) | 0.34-0.42 GB | 108 MB |
| Hima-ASR int8 ONNX (Indian languages + English) | 66.9 / 59.4 | 5.6 / 6.3 | 78.1 / 78.1 | 36.0 / 39.0 | 420 / 962 ms | 1.1-1.3 GB | 600 MB |
| Canary-180M-Flash int8, onnx-asr | 51.9 / 44.4 | 3.4 / 4.4 | 59.1 / 50.6 | 94.3 / 85.0 | 296 ms / **46 s** (decoder loops) | 0.75 GB | 204 MB |
| *ref.* Nemotron 3.5 Transcribe 30B + context (L4 GPU, other agent) | 83.4 / 86.9 | 2.8 / 2.5 | 88.4 / 90.6 | 8.8 / 8.3 | GPU | | |
| *ref.* Nemotron 3.5 ASR streaming 0.6B (L4 GPU transcripts) | 71.6 / 64.4 | 3.1 / 3.7 | 80.0 / 77.5 | 20.0 / 24.5 | (CPU build in sherpa-onnx, not run) | | 475 MB |
| *ref.* Google Web Speech (round 2) | 72.5 / - | 3.4 / - | 79.4 / - | 30.3 / - | 78 ms after speech | | 0 |

\* The fermion CPU engine glues Phonon-2's digits to words ("United69 Descent to6000 ."). The fixed row re-spaces the text
after the fact; it is not what the engine returns. Phonon-2.5-English does not have the bug.

### Cascades: a fast first pass, then Whisper only when needed

In a cascade, the first engine's guesses go through the game chain. Only when nothing is understood does the server run
Whisper base.en (2-best, prompt) and mix both lists; this is the scorer's `a>b` rule. The `srv-casc-*` files are built from
the two result files. As a check, the Phonon cascade gives 83.1% both from the built file and from the scorer's own `a>b`.
Latency is estimated from the latency pass: first-pass time, plus Whisper's time for the share of transmissions that ask for
it.

| first pass, then Whisper base.en | exact | sent-wrong | callsign | asks Whisper | latency p50 / p95 (est.) | runs in Node? |
|---|--:|--:|--:|--:|--:|---|
| Whisper alone (shipped) | 76.9 / 78.8 | 6.3 / 7.5 | 86.3 / 90.0 | - | 1268 / 2582 ms | yes, today |
| Parakeet Ultra int8, sherpa-onnx, hotwords | 78.1 / **85.6** | 7.5 / 3.7 | 88.4 / 89.4 | 24% | 942 / 3018 ms (Node: 953 / 3332) | yes (sherpa-onnx-node) |
| same, biased decode only in the first pass | 78.1 / 85.6 | | | 24% | ~420 ms + Whisper on 24% | yes |
| Phonon-2.5-English, biased decode only in the first pass | 76.3 / 83.1 | | | | ~150 ms + Whisper on 26% | sidecar |
| Parakeet 110M int8, sherpa-onnx, hotwords | 78.4 / 79.4 | 7.8 / 8.1 | 87.8 / 88.7 | 31% | 484 / 2660 ms (Node: 456 / 2178) | yes |
| Parakeet Redux int8, sherpa-onnx, hotwords | 77.2 / 82.5 | 10.0 / 7.5 | 89.1 / 91.2 | | ~0.9 s / 3 s | yes |
| Phonon-2.5-English, hotwords | 76.2 / 83.1 | 8.7 / 5.6 | 88.1 / 89.4 | 26% | **328** / 2099 ms | sidecar |
| Granite TurboCTC | **80.0** / 84.4 | 8.1 / 5.0 | 88.4 / 90.0 | 25% | 870 / 2571 ms | ONNX port |
| always both, Whisper + Granite | 80.3 / 83.1 | 7.8 / 6.9 | 88.7 / 90.6 | 100% | max of the two | ONNX port |
| always both, Whisper + Parakeet Ultra | 79.1 / 83.8 | 6.9 / 5.6 | 88.7 / 89.4 | 100% | ~1.3 s / 2.6 s (in parallel, 6 threads) | yes |

On US/UK, a cascade raises sent-wrong by 1-2 points (6.3% becomes 7.5-8.7%). On the Indian proxy it lowers it (7.5% becomes
3.7-5.6%).

### Paired tests

Each cascade was compared with Whisper alone on the same clips, using the exact McNemar test (`.paired.json`).

| against Whisper alone | US/UK: points, right only here vs only Whisper, p | Indian proxy: same |
|---|---|---|
| Parakeet Ultra then Whisper | +1.2, 9 vs 5, p=0.42 | **+6.9, 11 vs 0, p=0.001** |
| Granite then Whisper | +3.1, 16 vs 6, p=0.05 | **+5.6, 12 vs 3, p=0.035** |
| Phonon-2.5-English then Whisper | -0.6, 4 vs 6, p=0.75 | +4.4, 9 vs 2, p=0.07 |
| Parakeet 110M then Whisper | +1.6, 18 vs 13, p=0.47 | +0.6, 4 vs 3, p=1.0 |
| Phonon-2.5-English alone | **-4.1, 5 vs 18, p=0.01** | -1.9, 9 vs 12, p=0.66 |
| Granite alone | -3.1, 18 vs 28, p=0.18 | 0.0, 13 vs 13, p=1.0 |


## Candidates, one by one

### Phonon-2.5-English (FermionResearch)

- **Package:** `pip install --no-deps torch --index-url https://download.pytorch.org/whl/cpu`, then
  `pip install fermion-research` (0.2.15). The CPU engine is C, with packed int8 weights, an avx512-vnni kernel and a C TDT
  loop. The model is 158 MB, unpacked to `~/.cache/fermion`. It loads in 2 s and peaks at 0.93 GB RSS.
- **Hotwords:** yes. `set_hotwords([...], lam=)` takes up to 25 words. It is an Aho-Corasick bonus of λ (default 2) per
  matching word piece in the greedy TDT decoder, and the blank is never biased.
  - At λ2, the biased decode alone gets 71.6% against 70.6% unbiased, and the 2-best gets 72.8%.
  - At λ4, the 2-best gets 73.4%.
  - At λ8, the biased decode falls apart (WER 94%).

  The biasing does not fix "Katari", "Count us" or "If lie" (Qatari, Qantas, iFly). Parakeet's error is digit grouping
  ("Velocity for 27" for "velocity four two seven", "Jetstar 6, 14"), and the hotwords do not touch it.
- **Node:** the package is Python with a native `.so`, so it cannot run in-process. The sidecar was tested:
  - Command: `FERMION_CPU_THREADS=3 fermion serve phonon-2.5-en --unix-socket <path>` (or `--host 127.0.0.1 --port 8010`).
  - Endpoint: `POST /v1/audio/transcriptions`, multipart, the OpenAI/Whisper shape. Fields: `file`, `hotwords`
    (comma-separated, at most 25), `hotword_lambda`, and `prompt`, which also feeds the hotwords.
  - Response: `{"text": ...}`.
  - Requests run one at a time behind a lock.
  - Round trip over curl: 0.33-0.36 s for a 3 s clip.
  - It also offers a WebSocket `/v1/audio/stream` for live transcription.

  To adopt it, the server needs:
  - a venv with torch-cpu (~200 MB) and fermion-research;
  - one service (a systemd unit, which needs the owner's approval);
  - a small client in the STT route that posts the 16 kHz WAV it already has, with the callsign words. The
    `OPENATC_STT_URL` path to `ml/serve/stt_server.py` is the template; it needs a response-shape adapter.

  The model fetch is the only network call found in the package.
- **LiteRT build** (`litert-community/Phonon-2.5-English`): the CPU encoder is an int8 tflite of 902 MB (not the 158 MB
  low-bit file), with mel graphs per window length and an int8 decoder. The browser/phone agent measured it
  (`edge-phonon-litert.jsonl`). No LiteRT runtime is maintained for Node on a Linux server; LiteRT.js targets browsers.
  Two possible routes, both untested:
  - convert with `tf2onnx --tflite` for onnxruntime-node, and write the TDT greedy loop in JS;
  - dequantize fermion's weights into its vendored PyTorch Parakeet-TDT and export a sherpa-onnx NeMo transducer, which then
    gets hotwords in sherpa-onnx-node. That is about 0.6 GB int8, so the size advantage is lost, and roughly a day of work.
- **Licence:** weights CC-BY-4.0 (Parakeet TDT 0.6B v3 derivative); the package and CPU engine are Apache-2.0. Commercial use
  is OK, with attribution.

### Phonon-2 (FermionResearch)

- Same package, model `phonon-2`, 25 languages, 158 MB.
- On this ATC speech it is worse than 2.5-English: 67.2% / 71.3% as the engine returns it. With the engine's digit-spacing bug
  fixed afterwards, it is 70.6% / 75.6%.
- Hotwords lower it slightly: the biased decode alone gets 67.5% against 69.1% plain (fixed).

### Parakeet Ultra and Redux, through sherpa-onnx

- **Builds:** k2-fsa publishes int8 builds of both (`sherpa-onnx-nemo-parakeet-tdt-0.6b-{ultra,redux}-int8`).
- **Hotwords:** the decoder is `modified_beam_search` (4 paths) with per-stream hotwords. Hotword score 1.5 per token, in
  lower and title case. The NeMo builds ship only `tokens.txt`, so `srv_run.py` writes a sentencepiece-style `bpe.vocab`
  from it, at a score of -1 per piece.
  - Ultra: 70.9% unbiased against 72.2% biased.
  - 110M: 65.6% unbiased against 69.1% biased (+3.5).
- **Node:** sherpa-onnx-node 2.0.1 (prebuilt addon, `OfflineRecognizer`, `createStream(hotwords)`) gave the same
  transcripts as Python on 40 of 40 clips for Ultra and for the 110M, at the same latency (`srv_sherpa_node.cjs`).
- **Licence:** CC-BY-4.0 weights; sherpa-onnx Apache-2.0.
- **Parakeet Redux through moondream Photon** (`pip install moondream`): the weights are CC-BY-4.0, but Photon's
  `kestrel-kernels` are proprietary. The licence says use needs a separate written agreement with M87 Labs, and Photon
  reports usage telemetry to api.moondream.ai. It was measured for completeness. It is not shippable as-is, and the open
  sherpa-onnx int8 build of the same weights scores better.
- **Parakeet Ultra through onnx-asr** (`ijar/parakeet-ultra-onnx-latin-int8`): greedy decoding with no hotwords, 728 MB on
  disk. Its accuracy is in line with the sherpa build.

### Granite Speech 5.0 470M TurboCTC (IBM)

- The best 1-best WER (23.9%) and the best single-model cascade partner. Apache-2.0.
- **Cost:** it is heavy in its reference form: transformers 5.22 and torch fp32 at 3.4 GB RSS (5.8 GB peak in the long run),
  0.7 s p50, and a 903 MB download in bf16.
- **Biasing:** there is no biasing API. CTC logits would allow hotword-boosted prefix beam search; not tried.
- **Node:** it needs a community ONNX export (`qwertz92/...-onnx`), a JS port of the log-mel + delta + frame-stacking front
  end, and CTC greedy decoding. Not tried.

### Parakeet TDT-CTC 110M (NVIDIA)

- The smallest: 108 MB and 0.4 GB RSS, 0.15 s greedy.
- Weaker alone (69.4% / 68.8%), but as a cascade first pass it matches the bigger models on US/UK (78.4%).
- CC-BY-4.0. Runs in sherpa-onnx-node with hotwords.

### Canary-180M-Flash (NVIDIA)

- Run as the int8 ONNX through onnx-asr (`istupakov/canary-180m-flash-onnx`). Its attention decoder loops on about 3% of
  clips ("two two two ...", "Sky Dubai six Sky Dubai six ..."), for up to 93 s and 4,000 characters.
- Only the task tokens act as a prompt, so there is no biasing.
- 51.9% / 44.4%. Not a candidate.

### Hima-ASR (Prahaladha, new this month)

- A 0.46B Indian-languages + English model: a Qwen3-ASR encoder and a Gemma-3-270M writer. Int8 ONNX, 600 MB, 0.42 s.
- On the Indian-accent proxy it is the worst usable model (59.4%). It writes "speed bird", "all nepan", "taxi the holding
  point" and splits digits.
- Licence: Apache-2.0 plus the Gemma Terms of Use (commercial use OK under Gemma's prohibited-use policy).

## Recommendation

1. **Keep Whisper base.en**, and give it a fast first pass instead of replacing it. Every candidate is at most level with
   Whisper alone, while every cascade is level or better on US/UK and better on the Indian proxy.
2. **First pass inside Node:** Parakeet Ultra int8 through sherpa-onnx-node, with the callsigns on frequency as per-request
   hotwords.
   - 78.1% on US/UK and 85.6% on the Indian proxy, against 76.9% and 78.8% today.
   - Same-process, with no new service. Node gives the same output as Python.
   - The cost is +487 MB on disk and +1.2 GB RSS.
   - p50 is about 0.95 s with the 2-best first pass. With the biased decode only, the same 78.1% on US/UK comes at about
     0.42 s plus Whisper on the 24% it does not understand.
   - **The smaller option** is the 110M (108 MB, +0.4 GB): 78.4% / 79.4% at p50 0.46 s.
   - To build it:
     - add `sherpa-onnx-node` to the server's dependencies, and add its prebuilt `sherpa-onnx-linux-x64` binary to the
       standalone trace in `next.config.js`, as was done for onnxruntime-node;
     - keep the model in `~/.cache/openatc-stt`;
     - generate `bpe.vocab` from `tokens.txt` (as `srv_run.py` does);
     - create a stream per request with the callsigns as hotwords;
     - fall through to the existing Whisper engine when `understandHeard` does not accept the guesses.
3. **If speed matters most:** Phonon-2.5-English as the first pass through a `fermion serve` sidecar.
   - 76.2% / 83.1% at p50 0.33 s, with +0.93 GB RSS.
   - It needs a Python venv and a service, which needs the owner's approval.
   - It suits the owner's taste (they rate Phonon-2 on their Mac), but on this ATC speech Phonon-2.5-English is the better
     Phonon, and Phonon-2's CPU engine has the spacing bug.
4. **Before anything ships**, re-check on the owner's own recordings. None existed when this was written, and synthetic
   Hindi-voice TTS is a weak stand-in for a real Indian accent on a laptop microphone. To score them, add the `srv-*`
   engines to `bash ml/stt/bench2/run.sh gold`, or run `srv_run.py` on `ml/data/gold/live` with `srv_score.sh`.

## What failed or was left out

- **Canary-180M-Flash:** the decoder loops (see above).
- **Phonon-2:** the CPU engine's detokenisation bug.
- **Photon's licence:** not usable without an agreement with M87 Labs.
- **Hima-ASR:** much worse than the card suggests on English ATC.
- **Hotwords** helped little on Phonon and Parakeet Ultra (+1 point) and more on the 110M (+3.5). None of them fixes the
  digit grouping. At high λ, Phonon's decoder degenerates.
- **Not run:**
  - Granite's ONNX or GGUF builds, and CTC hotword decoding;
  - Nemotron 3.5 ASR streaming 0.6B on CPU (its GPU transcripts score 71.6% / 64.4%, below the others);
  - Underdog Bark 3.0, which is CC-BY-NC, so not commercial;
  - Cactus Whistle, Moonshine and the LiteRT Phonon, which the browser/phone agent covers.
- **Coordination:** a duplicate copy of this agent ran for a few minutes at 05:01-05:07. Its partial outputs were deleted and
  re-run. `srv_queue.sh` now holds `ml/stt/models/.queue.lock`.
