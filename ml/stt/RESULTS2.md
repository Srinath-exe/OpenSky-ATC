# Speech-to-text, round 2: a realistic benchmark and the fix (2026-11-08)

The owner tried push-to-talk and said "the STT is so bad". This round measures why, on speech that is closer to a
player on a laptop than the GPU bake-off (ml/stt/score.py, clean Kokoro clips only), and ships the fixes.
Report with charts: `public/reports/voice-stt.html` (/reports/voice-stt.html).

## Why it was bad (measured)

<!-- why -->
Measured on the common set (320 clips, all four conditions; details below):

- **The recogniser's first guess, read by the rules, was the right command 24% of the time** with
  Google Web Speech (the default engine) and 16% with Moonshine tiny (the on-device option). With the
  S1 model behind the rules, as the game ran until tonight: 52% and 42%.
- **Generic speech-to-text writes ATC speech as English.** Word error rate 30% (Web Speech), 42%
  (Moonshine tiny), on synthetic speech. Typical: "speedbird fife zero" -> "Happy Bird 50" / "Bieber 50"; "speedbird
  two seven three climb one three thousand" -> "Speedbird 2, 73, Climb 1, 3000" (Whisper) / "Speedpert 2: 73klim
  13000" (Moonshine); "flight level niner zero" -> "flight level 9 or 0"; "Quantas"; "heading to one one".
- **The callsign is what breaks.** Right aircraft in 75% of transmissions (Web Speech, old chain),
  60% (Moonshine tiny). Airline telephony is rare English, and nothing told any recogniser which
  callsigns are on frequency (no contextual biasing anywhere). Whisper base.en without a prompt: WER 38%;
  with the callsigns on frequency as its prompt: 26%.
- **Late start costs the first word, which is the callsign.** Web Speech, old chain: 51% on the
  late-start clips against 59% on the same recordings captured in full.
- **Nothing at all**: Moonshine tiny returned an empty transcript for 10% of the clips (Web Speech
  7%, Moonshine base 2%, Whisper 0%).
- **Release timing** (the 1.2 s grace, the stop flush) was not measured separately; the recognisers now record 250 ms
  past release and wait up to 2 s for Web Speech's final result.
<!-- /why -->

## Benchmark (ml/stt/bench2/)

- **Situations**: 160 records of the voice dataset (`ml/data/out4/ds`): 100 from validation sessions at the 11
  training airports, 60 from Sydney (never trained on). At most 9 (val) / 6 (Sydney) per command kind, so headings
  (40 % of the data) do not dominate; no "say again" negatives. Each has the game state (`ctx`), what the
  controller said (`said`, fillers removed, digits spoken the ATC way, the dataset's simulated recogniser homophones
  put back to what was meant) and the gold command line.
- **Speech**: Kokoro-82M on this CPU, 8 voices (af_heart, af_bella, am_michael, am_adam, bf_emma, bf_isabella,
  bm_george, bm_lewis: American and British, female and male), speed 0.9-1.3. 52 minutes of audio.
- **Conditions** (`make_bench.py`), every situation in all four:
  - `clean`: the TTS with the silence push-to-talk leaves around speech (0.25-0.45 s before, 0.3 s after);
  - `laptop`: 120 Hz-7 kHz, room reverb (RT60 0.25-0.5 s), pink fan noise at 15-25 dB SNR, 50 Hz hum, level -14..-2 dB;
  - `radio`: band-pass 300-3400 Hz, soft compression, white or pink noise at 6-12 dB SNR;
  - `late`: the laptop clip with the lead silence and the first 150-400 ms of speech cut (mean 272 ms): a recogniser
    or microphone that starts after the player started talking. The callsign is the first word.
- **Scoring** (`score.ts`, compiled with the game's own modules): WER with numbers in one form on both sides (as
  `ml/stt/score.py`), then the command the game ends with, through six chains: rules alone; rules then S1
  (`understandVoice`, what the game did before tonight); repair then rules; repair then rules then S1; the same over
  the n-best list. Exact = the final command line parses to the gold AST. "Sent wrong" = the game would have sent a
  wrong command without a check (the verifier/confidence gate of `understand.ts` said send).
- **Engines**: Web Speech in Google Chrome 157 (extracted from the official .deb into `ml/stt/chrome`, not installed;
  Xvfb; each clip played into `SpeechRecognition.start(MediaStreamTrack)`, maxAlternatives 5, so the audio went to
  Google); transformers.js 4.3.1 on onnxruntime-node for Moonshine and Whisper (the same ONNX files the browser
  downloads; `transcribe_tjs.cjs` runs the server engine module itself); faster-whisper (CTranslate2 int8)
  for the separate-service option. The slow engines (Whisper, faster-whisper) ran on every other situation (80
  situations x 4 = 320 clips); all comparisons use that common set. CPU: 2 threads per engine on this 8-core VPS,
  shared with five other jobs (load average 12-27 through the night), so every latency here is pessimistic.
- **On-device latency**: `browser_latency.cjs`, headless Chromium, the game's worker, WASM (no WebGPU adapter
  headless, and the site is not cross-origin isolated, so WASM runs on one thread, as for players today).

## Results

<!-- results -->
Common set, 320 clips, exact command (all four conditions). "Sent wrong" is a wrong command the game would send without a check; part of it is label noise in the dataset ("hold position" spoken for the gold "hold position (traffic)", a garbled speed in the source text), the same for every engine. The share of sends that are right rose (Web Speech: 77% -> 82% of what it sends is right).

| engine | exact, old chain (rules + S1) | exact, new chain | sent wrong: old -> new | callsign right: old -> new | WER | latency (median) | download |
|---|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | 52% | **72%** | 15% -> 12% | 75% -> 86% | 30% | 78 ms after speech | 0 MB |
| On-device · Moonshine tiny | 42% | **53%** | 13% -> 16% | 60% -> 73% | 42% | 0.6 s in the browser | 28 MB |
| On-device · Moonshine base | 57% | **65%** | 12% -> 17% | 74% -> 86% | 34% | 1.1 s in the browser | 63 MB |
| Whisper tiny.en + callsign prompt | 61% | **69%** | 16% -> 18% | 83% -> 92% | 27% | 1.9 s server CPU | 41 MB |
| Server · Whisper base.en + callsign prompt | 64% | **74%** | 16% -> 18% | 87% -> 95% | 26% | 3.4 s server CPU | 136 MB on the server |
| faster-whisper base.en int8 + prompt | 65% | **76%** | 16% -> 18% | 87% -> 97% | 24% | 4.5 s server CPU | 75 MB |
| Browser + Server, always both | 56% | **79%** | 17% -> 16% | 81% -> 97% | 26% | 3.4 s server CPU | 0 MB |
| Browser (Google) + server second opinion | 52% | **79%** | 15% -> 17% | 75% -> 96% | 30% | 80 ms after speech | 0 MB |

What each fix contributed (exact command, common set):

| fix | without | with | detail |
|---|--:|--:|---|
| biasing: Whisper base.en without -> with the callsign prompt (1-best, repair + S1) | 66% | 69% | WER 38% -> 26% |
| repair, Browser · Google Web Speech (rules + S1) | 52% | 62% | rules alone 24% -> 45% |
| repair, Server · Whisper base.en + callsign prompt (rules + S1) | 64% | 69% | rules alone 35% -> 55% |
| repair, On-device · Moonshine base (rules + S1) | 57% | 65% | rules alone 24% -> 49% |
| repair, On-device · Moonshine tiny (rules + S1) | 42% | 53% | rules alone 16% -> 35% |
| n-best, Browser · Google Web Speech | 62% | 72% | 5 alternatives |
| n-best, Server · Whisper base.en + callsign prompt | 69% | 74% | with + without the prompt |
| server second opinion when the browser is not understood | 72% | 79% | asked for 20% of transmissions |
| pre-roll (late start -> full capture), Browser · Google Web Speech | 71% | 80% | upper bound: what an open microphone + 0.3 s ring buffer recovers |
| pre-roll (late start -> full capture), Server · Whisper base.en + callsign prompt | 68% | 78% | upper bound: what an open microphone + 0.3 s ring buffer recovers |
| pre-roll (late start -> full capture), On-device · Moonshine base | 65% | 72% | upper bound: what an open microphone + 0.3 s ring buffer recovers |

Latency: server engines on this VPS with 2 threads under load average 10-27 (a quiet machine is ~2-3x faster); Web Speech is the time from the end of the audio to the final result (the game adds the 250 ms release tail and the 0.3 s delay line); the second-opinion median stays at the browser's because most transmissions never ask the server.
<!-- /results -->

## What shipped

<!-- shipped -->
- **Default engine: Browser (Google Web Speech) with this server as a second opinion**: 79% exact on the
  common set against 52% before, the best of every engine measured, and the fastest (median 80 ms after
  speech; only the 20% of transmissions the browser's guesses do not explain wait for the server). The server alone was
  74%, always running both 79%. Browsers without Web Speech (Firefox) fall back to the server engine.
- **Repair** (`src/lib/voice/asr-repair.ts`, every engine): numbers into one spoken form (digits -> words, "2, 73",
  "4,000", "2-7-0", "9 or 0", "one to six", "niner"/"tree"/"fife"), command words by phonetic key and inflection
  ("klim", "heating", "holds", "increased", "hole position", "160 not", "ILL's"), and the callsign: the words before
  the first number run against every aircraft's spoken name by a Metaphone-style key, the number run against its flight
  number (exact, clipped, one digit off, run-on with the next number), with a margin over the runner-up. A digit change
  or a name that is not really similar is flagged and left to the player to check. A name the parser cannot read (3-word
  telephony) is written as the ICAO callsign.
- **n-best** (`src/lib/voice/asr-nbest.ts`): Web Speech `maxAlternatives` 5; the server returns 2 (with and without the
  prompt, one encoder pass). Rules on every repaired guess, first that parses wins; else S1 on the raw and the repaired
  text of the first two guesses, most confident proposal wins (the model was trained on raw recogniser output, so a
  repair can mislead it).
- **Pre-roll**: Web Speech listens through a 0.3 s delay line on the game's own microphone stream
  (`SpeechRecognition.start(MediaStreamTrack)`, Chrome; checked end to end in Chrome 157); the on-device and server
  capture keeps the microphone open a minute after the last transmission with a 0.3 s ring buffer in the AudioWorklet;
  250 ms recorded past release.
- **Server engine** (`src/app/api/voice/stt/`): Whisper base.en (fp32 encoder, int8 decoder) through transformers.js on
  onnxruntime-node inside the Next.js server, loaded lazily once per process, 2 threads, the callsigns on frequency as the
  prompt. Guards: 1 MB / 15 s per request, 30 per minute per IP (bursts of 10), one transcription at a time with 4 waiting
  (then 503), 12 s timeout (504). `next.config.js` lists onnxruntime-node's CPU binaries for the standalone bundle
  (transformers.js loads it through createRequire, which the file tracer cannot see; checked by tracing the route's files
  into an empty directory and running a transcription from there). Models cache in `~/.cache/openatc-stt` (already
  downloaded on this host).
- **On-device** moved from Moonshine tiny to base (53% -> 65% with the new chain; 63 MB once,
  1.1 s per transmission in headless WASM here). On-device Whisper is too slow for WASM on one thread
  (whisper-tiny.en 4.1 s here).
- **Settings** -> Voice recognition: "Browser (Google)" (states that a not-understood transmission goes to this game's
  server), "Server (Whisper, tuned for ATC)" (audio to this game's server, not Google, not stored; slower), "On-device
  (Moonshine)"; the phone app's "Phone" engine (another agent) is unchanged.
- **Not shipped**: faster-whisper as a separate service: base.en 76% vs 74% for the in-process
  engine (it ran on 1 thread, so its latency here is not comparable); small.en on 2 threads was no faster than
  transformers.js small.en (median 6.2 s vs 5.5 s). Not clearly better, so no new
  service: `ml/serve/stt_server.py` + `scripts/openatc-stt.service` are written, not installed (that needs the owner's
  approval); `OPENATC_STT_URL` switches the route to it. Bigger models: see the clean + late table below.
<!-- /shipped -->

## Not measured yet / caveats

- **Real voices.** Everything above is synthetic. The owner's recordings (gold set, `ml/data/gold`, recorded with
  `/voice/record.html`, which also saves the live Web Speech transcript and its alternatives) score with one command:
  `bash ml/stt/bench2/run.sh gold` (Web Speech from the recordings, server Whisper, Moonshine base and tiny; same
  table). Real accented speech on a laptop microphone favours the recogniser trained on the most real speech (Google).
- **Chrome's on-device Web Speech + `phrases` biasing**: Chrome's cloud recogniser rejects `phrases`
  ("phrases-not-supported", measured); the on-device language pack (`SpeechRecognition.available/install` with
  `processLocally`) hung headless, so on-device Chrome speech with biasing is untested. The game sets `phrases` once,
  and on that error stops sending them.
- **Latency on a quiet machine**: all CPU numbers are under heavy shared load.
- **distil-small.en with a prompt loops** ("8, 8, 8, ...", "United, United, ..."; distil-whisper was not trained with
  prompts), which also made it slower than small.en here; its run was stopped after the clips in its table row. Its
  unprompted decodes looked fine.
- **The first transmission** still loses whatever is said before the microphone opens (permission prompt, device
  start). After it, the microphone stays open for a minute and the 0.3 s pre-roll covers early speech.
- **Parser gap found on the way**: `resolveCallsign` (src/lib/sim/commands.ts) only reads 1-2 word telephony, so
  "Hong Kong Express 528" never resolved (8 of the 100 gold prompts). The repair layer works around it by writing
  the ICAO callsign; the parser fix belongs to its owner.

## Reproduce

```bash
ml/stt/.venv/bin/python ml/stt/bench2/make_bench.py                 # 640 clips (30 min on 2 CPU threads)
bash ml/stt/bench2/queue.sh A; bash ml/stt/bench2/queue.sh B; bash ml/stt/bench2/queue.sh C
xvfb-run -a node ml/stt/bench2/webspeech_bench.cjs ml/stt/bench2/clips ml/stt/bench2/results/webspeech-google.jsonl
bash ml/stt/bench2/run.sh score ml/stt/bench2/clips ml/stt/bench2/results/<engine>.jsonl --every 2 --out ml/stt/bench2/results/sum_even_<engine>.json
python3 ml/stt/bench2/report.py                                      # this file's tables + the HTML report
bash ml/stt/bench2/test.sh                                           # tests/engine/voice-stt.test.ts
xvfb-run -a node ml/stt/bench2/recognizer_e2e.cjs <clip.wav> browser|server|local   # the game's recognisers end to end in Chrome
```

## Tables

<!-- tables -->
_Generated by `python3 ml/stt/bench2/report.py` from `ml/stt/bench2/results/`._

### Common set (every other situation: 80 situations x 4 conditions = 320 clips)

| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | all | 320 | 30.3% | 24% | 52% | 45% | 62% | 59% | 72% | 12% | 86% | 78 |
| On-device · Moonshine tiny | all | 320 | 42.4% | 16% | 42% | 35% | 53% | 35% | 53% | 16% | 73% | 466 |
| On-device · Moonshine base | all | 320 | 33.8% | 24% | 57% | 49% | 65% | 49% | 65% | 17% | 86% | 925 |
| Whisper tiny.en + callsign prompt | all | 320 | 27.1% | 32% | 61% | 48% | 65% | 53% | 69% | 18% | 92% | 1913 |
| Server · Whisper base.en + callsign prompt | all | 320 | 26.3% | 35% | 64% | 55% | 69% | 61% | 74% | 18% | 95% | 3351 |
| Whisper base.en, prompt, 1-best | all | 320 | 26.3% | 35% | 64% | 55% | 69% | 55% | 69% | 16% | 91% | 3351 |
| Whisper base.en, no prompt | all | 320 | 37.6% | 21% | 52% | 50% | 66% | 50% | 66% | 18% | 87% | 3351 |
| Whisper tiny.en, no prompt | all | 320 | 46.8% | 18% | 49% | 45% | 64% | 45% | 64% | 16% | 84% | 1913 |
| faster-whisper base.en int8 + prompt | all | 320 | 24.3% | 41% | 65% | 54% | 68% | 62% | 76% | 18% | 97% | 4481 |
| Browser + Server, always both | all | 320 | 26.4% | 26% | 56% | 49% | 67% | 68% | 79% | 16% | 97% | 3351 |
| Browser (Google) + server second opinion | all | 320 | 30.3% | 24% | 52% | 45% | 62% | 68% | 79% | 17% | 96% | 80 |

### Per condition

| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | clean | 80 | 21.3% | 31% | 61% | 55% | 74% | 68% | 80% | 14% | 96% | 79 |
| Browser · Google Web Speech | laptop | 80 | 24.7% | 28% | 59% | 51% | 70% | 68% | 80% | 12% | 92% | 78 |
| Browser · Google Web Speech | radio | 80 | 40.8% | 14% | 39% | 30% | 46% | 44% | 56% | 15% | 74% | 78 |
| Browser · Google Web Speech | late | 80 | 34.4% | 24% | 51% | 44% | 59% | 57% | 71% | 9% | 80% | 78 |
| On-device · Moonshine tiny | clean | 80 | 31.3% | 20% | 50% | 42% | 60% | 42% | 60% | 14% | 78% | 466 |
| On-device · Moonshine tiny | laptop | 80 | 30.0% | 24% | 56% | 41% | 65% | 41% | 65% | 15% | 84% | 525 |
| On-device · Moonshine tiny | radio | 80 | 63.7% | 8% | 22% | 24% | 36% | 24% | 36% | 24% | 69% | 522 |
| On-device · Moonshine tiny | late | 80 | 44.8% | 12% | 41% | 31% | 50% | 31% | 50% | 11% | 62% | 387 |
| On-device · Moonshine base | clean | 80 | 24.5% | 34% | 66% | 59% | 72% | 59% | 72% | 19% | 95% | 958 |
| On-device · Moonshine base | laptop | 80 | 24.5% | 31% | 64% | 59% | 72% | 59% | 72% | 19% | 95% | 889 |
| On-device · Moonshine base | radio | 80 | 47.0% | 15% | 41% | 32% | 49% | 32% | 49% | 21% | 78% | 953 |
| On-device · Moonshine base | late | 80 | 39.1% | 16% | 55% | 46% | 65% | 46% | 65% | 10% | 78% | 892 |
| Whisper tiny.en + callsign prompt | clean | 80 | 15.4% | 48% | 74% | 61% | 75% | 65% | 78% | 16% | 98% | 1986 |
| Whisper tiny.en + callsign prompt | laptop | 80 | 20.6% | 41% | 71% | 51% | 72% | 60% | 78% | 18% | 95% | 1829 |
| Whisper tiny.en + callsign prompt | radio | 80 | 38.5% | 22% | 54% | 32% | 55% | 36% | 56% | 24% | 94% | 1932 |
| Whisper tiny.en + callsign prompt | late | 80 | 33.9% | 16% | 44% | 45% | 56% | 51% | 64% | 15% | 82% | 1915 |
| Server · Whisper base.en + callsign prompt | clean | 80 | 16.2% | 45% | 76% | 65% | 79% | 69% | 80% | 19% | 99% | 3355 |
| Server · Whisper base.en + callsign prompt | laptop | 80 | 16.9% | 42% | 72% | 61% | 75% | 66% | 78% | 16% | 99% | 3351 |
| Server · Whisper base.en + callsign prompt | radio | 80 | 25.2% | 34% | 62% | 50% | 69% | 52% | 71% | 20% | 98% | 3425 |
| Server · Whisper base.en + callsign prompt | late | 80 | 47.0% | 19% | 46% | 44% | 54% | 56% | 68% | 18% | 85% | 3301 |
| Whisper base.en, prompt, 1-best | clean | 80 | 16.2% | 45% | 76% | 65% | 79% | 65% | 79% | 16% | 99% | 3355 |
| Whisper base.en, prompt, 1-best | laptop | 80 | 16.9% | 42% | 72% | 61% | 75% | 61% | 75% | 15% | 98% | 3351 |
| Whisper base.en, prompt, 1-best | radio | 80 | 25.2% | 34% | 62% | 50% | 69% | 50% | 69% | 18% | 99% | 3425 |
| Whisper base.en, prompt, 1-best | late | 80 | 47.0% | 19% | 46% | 44% | 54% | 44% | 54% | 15% | 69% | 3301 |
| Whisper base.en, no prompt | clean | 80 | 28.6% | 29% | 65% | 64% | 78% | 64% | 78% | 16% | 95% | 3355 |
| Whisper base.en, no prompt | laptop | 80 | 30.4% | 28% | 62% | 59% | 75% | 59% | 75% | 15% | 95% | 3351 |
| Whisper base.en, no prompt | radio | 80 | 44.7% | 14% | 40% | 39% | 60% | 39% | 60% | 22% | 89% | 3425 |
| Whisper base.en, no prompt | late | 80 | 46.8% | 15% | 39% | 38% | 50% | 38% | 50% | 18% | 69% | 3301 |
| Whisper tiny.en, no prompt | clean | 80 | 35.0% | 26% | 65% | 56% | 76% | 56% | 76% | 16% | 95% | 1986 |
| Whisper tiny.en, no prompt | laptop | 80 | 35.7% | 28% | 61% | 55% | 76% | 55% | 76% | 19% | 94% | 1829 |
| Whisper tiny.en, no prompt | radio | 80 | 68.2% | 8% | 35% | 28% | 48% | 28% | 48% | 20% | 76% | 1932 |
| Whisper tiny.en, no prompt | late | 80 | 48.4% | 11% | 35% | 42% | 55% | 42% | 55% | 9% | 70% | 1915 |
| faster-whisper base.en int8 + prompt | clean | 80 | 13.4% | 50% | 76% | 65% | 78% | 70% | 82% | 15% | 100% | 4498 |
| faster-whisper base.en int8 + prompt | laptop | 80 | 13.6% | 54% | 75% | 62% | 76% | 71% | 82% | 15% | 100% | 4500 |
| faster-whisper base.en int8 + prompt | radio | 80 | 39.6% | 32% | 61% | 44% | 64% | 46% | 68% | 26% | 100% | 4559 |
| faster-whisper base.en int8 + prompt | late | 80 | 30.8% | 26% | 48% | 45% | 55% | 62% | 71% | 18% | 86% | 4402 |
| Browser + Server, always both | clean | 80 | 20.6% | 31% | 61% | 55% | 74% | 71% | 80% | 18% | 99% | 3355 |
| Browser + Server, always both | laptop | 80 | 23.2% | 28% | 59% | 52% | 71% | 72% | 82% | 15% | 99% | 3351 |
| Browser + Server, always both | radio | 80 | 29.8% | 20% | 50% | 42% | 60% | 61% | 76% | 18% | 99% | 3425 |
| Browser + Server, always both | late | 80 | 32.1% | 26% | 54% | 46% | 61% | 69% | 76% | 12% | 90% | 3301 |
| Browser (Google) + server second opinion | clean | 80 | 21.3% | 31% | 61% | 55% | 74% | 71% | 80% | 18% | 99% | 80 |
| Browser (Google) + server second opinion | laptop | 80 | 24.7% | 28% | 59% | 51% | 70% | 72% | 82% | 15% | 98% | 79 |
| Browser (Google) + server second opinion | radio | 80 | 40.8% | 14% | 39% | 30% | 46% | 60% | 74% | 21% | 98% | 82 |
| Browser (Google) + server second opinion | late | 80 | 34.4% | 24% | 51% | 44% | 59% | 69% | 79% | 12% | 91% | 81 |

### Training airports vs Sydney (unseen)

| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | val | 200 | 28.1% | 22% | 54% | 47% | 60% | 60% | 72% | 12% | 85% | 78 |
| Browser · Google Web Speech | syd | 120 | 34.3% | 28% | 50% | 42% | 65% | 57% | 72% | 13% | 87% | 78 |
| On-device · Moonshine tiny | val | 200 | 41.6% | 18% | 44% | 40% | 52% | 40% | 52% | 14% | 72% | 990 |
| On-device · Moonshine tiny | syd | 120 | 44.0% | 12% | 41% | 26% | 54% | 26% | 54% | 19% | 75% | 370 |
| On-device · Moonshine base | val | 200 | 34.2% | 20% | 52% | 50% | 62% | 50% | 62% | 17% | 84% | 1059 |
| On-device · Moonshine base | syd | 120 | 33.0% | 31% | 63% | 47% | 69% | 47% | 69% | 18% | 89% | 835 |
| Whisper tiny.en + callsign prompt | val | 200 | 27.6% | 28% | 58% | 46% | 62% | 52% | 66% | 18% | 92% | 1918 |
| Whisper tiny.en + callsign prompt | syd | 120 | 26.2% | 39% | 65% | 49% | 69% | 55% | 72% | 18% | 93% | 1890 |
| Server · Whisper base.en + callsign prompt | val | 200 | 24.3% | 33% | 62% | 55% | 66% | 61% | 73% | 18% | 96% | 3593 |
| Server · Whisper base.en + callsign prompt | syd | 120 | 30.0% | 38% | 69% | 56% | 74% | 61% | 76% | 18% | 94% | 3112 |
| Whisper base.en, prompt, 1-best | val | 200 | 24.3% | 33% | 62% | 55% | 66% | 55% | 66% | 16% | 90% | 3593 |
| Whisper base.en, prompt, 1-best | syd | 120 | 30.0% | 38% | 69% | 56% | 74% | 56% | 74% | 16% | 92% | 3112 |
| Whisper base.en, no prompt | val | 200 | 37.5% | 20% | 51% | 50% | 64% | 50% | 64% | 18% | 86% | 3593 |
| Whisper base.en, no prompt | syd | 120 | 37.8% | 22% | 52% | 49% | 68% | 49% | 68% | 18% | 88% | 3112 |
| Whisper tiny.en, no prompt | val | 200 | 47.0% | 18% | 50% | 46% | 62% | 46% | 62% | 16% | 82% | 1918 |
| Whisper tiny.en, no prompt | syd | 120 | 46.6% | 18% | 47% | 43% | 67% | 43% | 67% | 16% | 86% | 1890 |
| faster-whisper base.en int8 + prompt | val | 200 | 20.1% | 38% | 66% | 56% | 68% | 64% | 76% | 19% | 98% | 4686 |
| faster-whisper base.en int8 + prompt | syd | 120 | 32.2% | 45% | 64% | 52% | 68% | 61% | 76% | 18% | 95% | 4012 |
| Browser + Server, always both | val | 200 | 24.4% | 24% | 57% | 50% | 64% | 67% | 76% | 18% | 96% | 3593 |
| Browser + Server, always both | syd | 120 | 30.2% | 30% | 53% | 47% | 71% | 71% | 83% | 12% | 97% | 3112 |
| Browser (Google) + server second opinion | val | 200 | 28.1% | 22% | 54% | 47% | 60% | 66% | 76% | 18% | 96% | 79 |
| Browser (Google) + server second opinion | syd | 120 | 34.3% | 28% | 50% | 42% | 65% | 71% | 82% | 13% | 96% | 80 |

### Bigger models (clean + late clips of the common set)

| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | all | 160 | 27.8% | 28% | 56% | 49% | 66% | 62% | 76% | 11% | 88% | 78 |
| On-device · Moonshine base | all | 160 | 31.8% | 25% | 61% | 52% | 69% | 52% | 69% | 14% | 86% | 934 |
| Server · Whisper base.en + callsign prompt | all | 160 | 31.6% | 32% | 61% | 54% | 66% | 62% | 74% | 18% | 92% | 3343 |
| Whisper base.en, prompt, 1-best | all | 160 | 31.6% | 32% | 61% | 54% | 66% | 54% | 66% | 16% | 84% | 3343 |
| Whisper base.en, no prompt | all | 160 | 37.7% | 22% | 52% | 51% | 64% | 51% | 64% | 17% | 82% | 3343 |
| faster-whisper base.en int8 + prompt | all | 160 | 22.1% | 38% | 62% | 55% | 66% | 66% | 77% | 16% | 93% | 4454 |
| faster-whisper small.en int8 + prompt | all | 160 | 18.0% | 46% | 66% | 62% | 72% | 66% | 75% | 16% | 92% | 6202 |
| faster-whisper distil-small.en + prompt | all | 57 | 747.0% | 0% | 2% | 0% | 2% | 53% | 65% | 21% | 84% | 6370 |
| Whisper small.en + prompt (transformers.js) | all | 160 | 21.5% | 44% | 68% | 59% | 71% | 64% | 73% | 16% | 92% | 5457 |
| Browser (Google) + server second opinion | all | 160 | 27.8% | 28% | 56% | 49% | 66% | 70% | 79% | 15% | 95% | 80 |

### All 640 clips (the engines that ran on all)

| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Browser · Google Web Speech | all | 640 | 32.7% | 22% | 55% | 46% | 67% | 62% | 76% | 12% | 89% | 78 |
| On-device · Moonshine tiny | all | 640 | 44.4% | 16% | 42% | 34% | 52% | 34% | 52% | 14% | 71% | 463 |
| On-device · Moonshine base | all | 640 | 35.1% | 23% | 56% | 48% | 66% | 48% | 66% | 16% | 84% | 876 |

### On-device latency in headless Chromium (WASM, 1 thread, loaded VPS; ms per utterance, ~4.5 s of audio)

| engine | n | p50 | p90 |
|---|--:|--:|--:|
| moonshine-base | 30 | 1140 | 1728 |
| moonshine-tiny | 30 | 561 | 849 |
| whisper-tiny.en | 10 | 4092 | 6951 |
<!-- /tables -->
