# Pilot voices (TTS): results

Neural pilot voices for the game, running in the player's browser: **Paradee-8M v1.2** (sahilmahendrakar, Apache-2.0,
7.88M parameters, distilled from Kokoro-82M; one 8.5 MB int8 ONNX file for four voices). Report:
`/reports/voice-tts.html`; listening page: `/reports/voice-tts-samples.html`.

```
pilot line --speakableAtc--> words --speechChunks--> clauses --tts-worker.js: G2P + Paradee (WASM)--> 24 kHz --radio--> speakers
"JBU248 holding short runway 04L" -> "JetBlue two forty-eight holding short runway zero four left."
```

## Numbers

60 real pilot lines (`data/bench60.jsonl`): exported from the headless engine at KJFK, EGLL, KLAX, OMDB, YSSY, LFPG
(32 readbacks, 16 requests, 12 status lines; 39 ICAO, 21 FAA), through the ATC normaliser. WER = Whisper base.en
(faster-whisper int8, beam 5, no prompt) against the normaliser's words; numbers count digit by digit whichever way
they are written. CPU: shared 8-core EPYC 9354P, load average 9-22 from other jobs during every run, so every speed
here is pessimistic and only comparable within this table.

| Model | Params | Download | Speed, native CPU | WER (n clips) | Licence | Browser |
|---|---:|---:|---:|---:|---|---|
| **Paradee-8M v1.2** (shipped) | 7.9M | 8.46 MB int8 ONNX, 4 voices | **27.7x** RT, 0.19 s/line, 1 thread | **5.7 %** (240: af_heart 5.6, am_puck 6.6, bf_isabella 5.2, bm_fable 5.5) | Apache-2.0 | yes, this work |
| Kokoro-82M (teacher) | 82M | 327 MB .pth | 0.76x, 7.0 s/line, 1 thread | 7.1 % (120: af_heart 4.8, bm_fable 9.4) | Apache-2.0 | kokoro-js, 80-330 MB |
| Leokani-tts-7M | 7.0M | 7.8 MB int8 ONNX + eSpeak NG | 12.5x, 0.46 s | 6.2 % (60, Dala) | Milliwatt Labs Model Licence 1.0 (free < US$1M revenue) | possible |
| PiVo-1.4M | 1.4M | 5.8 MB ONNX + 3.6 MB CMUdict | 6.9x, 0.69 s | 10.8 % (60, Pi) | Apache-2.0 | possible; CMUdict words only |
| Phonon-31M-en | 31M | 64.5 MB q8 GGUF | 3.2x, 1.5 s | 5.6 % (60, Easton) | Apache-2.0 | - |
| Supertonic 3 | 99M | ~398 MB ONNX | 1.0x, 5.1 s | 4.9 % (60, M1) | OpenRAIL-M | ~400 MB |
| Audio8-TTS-Realistic-Air | 601M + codec | 2.55 GB | 0.013x, 504 s/line, 3 threads | 4.5 % (5) | Apache-2.0 | no |
| KittenTTS 2 | ~1B LM + decoder | >= 0.5-3.5 GB | skipped | - | Stellon Labs Community Licence | no |

Paradee on the same two voices as Kokoro (af_heart + bm_fable, 120 clips): **5.6 % vs Kokoro 7.1 %**: as intelligible
as its teacher on ATC lines (60 lines; a point or two is within noise). Lines fully right: Paradee 60.8 %, Kokoro 54.2 %.

| Paradee variant (af_heart + bm_fable, 120 clips) | WER |
|---|---:|
| dry, misaki G2P | 5.6 % |
| through the game's radio effect (offline rendering, synth.radio) | 10.6 % (af 6.8, bm 14.4) |
| lighter radio (tanh drive 1.4, hiss -40 dB) | 9.8 % |
| eSpeak-only G2P (kokoro-js style) instead of the lexicon | 6.5 % (af 5.8, bm 7.3) |
| made in the browser by the worker (10 lines, the game's voices) | 3.5 % |

The radio costs Whisper 4-5 points, mostly on the male British voice; making it lighter barely helps (the band-pass is
what Whisper never saw), so the game keeps it. Common errors for every model are Whisper's: "Sky Dubai" -> "sky to by",
"Los Angeles" -> "Lowe's Angels", digit strings written "1.5.3".

## Browser

Headless Chromium 153 (playwright), `tests/tmp/tts-worker.cjs`, WASM, 1 thread (the site is not cross-origin
isolated), load average 9-11:

- worker load (ORT from jsDelivr, model from a local server, compile): 2.0-5.0 s cold, 1.1-1.4 s for a second worker
  from the HTTP cache;
- 10 readbacks: 667 ms median, 1156 ms slowest per line; **6.1x real time** (mean of 3 runs: 6.5, 4.6, 7.3); 0 page
  errors; G2P 0.1 ms per line;
- fp32 (35 MB) is ~1.3x faster in WASM (8.3, 8.7, 7.1) but 4x the download: int8 ships;
- WASM is ~3.8x slower than native onnxruntime on the same line and load; profile: Conv 39 %, Sin 15 % (vocoder),
  MatMul 13 %;
- the game path (`tests/tmp/tts-game-voice.cjs`, esbuild bundle of pilotVoice.ts): first sound 733 ms median for lines
  not queued (469 / 1187 / 552 ms for lines spaced like traffic); 5 lines at once: the first plays, 2 dropped, the last
  two read faster and played after it;
- download on the first pilot line: model 8.46 MB + onnxruntime-web 1.30.0 WASM 3.07 MB + loader 24 kB (brotli) +
  lexicon 27 kB (gzip) = **11.6 MB**; eSpeak NG 0.69 MB (gzip) only if a word is outside the lexicon;
- WebGPU: not used. The original int8 uses dynamic quantisation WebGPU cannot run; danyalmalik/Paradee-8M-ONNX-WebGPU
  is a re-quantisation of v1.1 (af_heart only), not of the four-voice v1.2.

## G2P in the browser

misaki (Kokoro's G2P, what Paradee was trained on) is Python. `public/voice/tts-g2p.js`:
1. lexicon of misaki's own phonemes for the game's vocabulary, US and GB (`/models/tts/atc-lexicon-v1.json`,
   `build_lexicon.py`: every exported pilot line read in context, the words in the engine's string literals, the
   airspace fixes with their spoken names "BIG ... bigg-in", letter names); 91 kB, 27 kB gzip, 1,969 words per accent;
2. capital codes not in it: misaki's letter names ("JFKSE" -> spelled; but the lexicon has the airspace's
   "jfk south east");
3. anything else: eSpeak NG (`phonemizer@1.2.1`, what kokoro-js uses; 1.3 MB, 0.69 MB gzip, loaded only then) +
   paradee's eSpeak-to-misaki table (`web/misaki.js`).

On the 60 lines x 4 voices, against misaki, with a lexicon built *without* those lines (`--exclude-bench`):

| | lexicon + eSpeak (shipped) | eSpeak NG + misaki table only |
|---|---:|---:|
| lines identical to misaki | 96.7 % | 0 % |
| phoneme character error | 0.47 % | 5.37 % |
| words differing | 1.9 % | 26.8 % |
| time per line (node) | 0.13 ms | 75 ms (+0.7 s first load) |
| words needing eSpeak | 0 of 2768 | all |

The 8 lines that differ are the two with a fix, where the lexicon says the airspace file's spoken name ("C D G north
west") instead of spelling five letters. eSpeak's typical slips: British "one" wɒn, "zero" zˈiəɹO, "runway" without its
secondary stress. Checked words: niner nˈInəɹ / nˈInə, Speedbird spˈidbɜɹd / spˈiːdbɜːd, flight level flˈIt lˈɛvᵊl,
"runway two seven left" ɹˈʌnwˌA tˈu sˈɛvən lˈɛft (US), all identical to misaki.

## Game integration

- `src/lib/tts/pilotSpeech.ts`: `speakableAtc(text, variant)` (callsign codes -> the engine's telephony, ICAO
  tree/fife/niner or FAA grouping as `phraseology.ts`; FL, runways incl. "16R/34L", frequencies, altitudes, headings,
  squawk/QNH digits, units, fix names), `splitSentences`, `speechChunks` (long sentences cut at commas into clauses
  of >= 3 words), `voiceFor(callsign)` (FNV-1a hash -> voice, rate 1.00-1.14, detune +-70 cents; British airlines get
  bf_/bm_, US airlines af_/am_).
- `public/voice/tts-worker.js`: module worker, onnxruntime-web 1.30.0 WASM from jsDelivr (1 thread unless the page is
  cross-origin isolated), model self-hosted under `/models/tts/paradee-8m-v1.2/` (LICENSE + NOTICE), messages in order,
  cancellable.
- `src/components/atc/pilotVoice.ts`: lazy load on the first line, queue (at most 2 waiting behind the line playing,
  oldest dropped, lines that cannot start within 12 s dropped, lines behind others read up to 24 % faster), WebAudio
  radio (2x high-pass 300 Hz + 2x low-pass 3400 Hz biquads, tanh soft clip, compressor, hiss ~-34 dB, squelch click
  and tail).
- `src/components/atc/sound.ts`: `speak()` uses the neural voice when "Pilot voices" is Neural (default) and it has
  loaded; while it loads, the browser voice (or, with none, up to two lines wait); if it fails, speechSynthesis.
- Setting: Settings -> Audio -> Pilot voices: "Neural (on this device, ~12 MB)" / "Browser"
  (`LS.pilotVoice = skycontrol_pilot_voice`, shown when Pilot voice is on).

## Audio8-TTS-Realistic-Air

Edge0/Audio8-TTS-Realistic-Air: 0.6B DualAR (24-layer slow AR + 4-layer fast AR over 10 codebooks), 44.1 kHz codec,
2.55 GB, Apache-2.0, 23 languages incl. Hindi, zero-shot cloning from a reference clip + exact transcript. Its custom
code (configuration/modeling/processing_arktts.py) was read first: it only builds the model, loads weights (safetensors,
`torch.load(weights_only=True)`), encodes text and generates; it was loaded from the local snapshot
(`ml/tts/venvs/audio8`, transformers 4.57.3, torch CPU). No reference voice, no cloning.

- 5 lines, 3 threads, fp32: 141, 372, 432, 851, 724 s for 5.5-8.8 s of speech: **504 s per readback, 0.013x real
  time** (0.9-4 s per 46 ms frame as the machine's load rose to 15-21; codec decode 7 % of it). Not usable live on a
  CPU; far too big for a browser.
- Whisper base.en WER 4.5 % (n = 5).
- GPU estimate (not measured): one L4/A10-class GPU in bf16 without CUDA graphs should run a DualAR of this size at
  roughly real time per stream; the SGLang Omni adapter's batching gives much more aggregate throughput.
- Promise: offline training data for speech-to-text (many voices and accents reading controller lines on a GPU
  overnight), and a voice cloned from the owner's own gold-set recordings, with consent, to read new lines for
  fine-tuning. Nobody else's voice.
- 3 lines are on the listening page (dry and radio).

## Skipped / failed

- KittenTTS 2 (KittenML/kitten-tts-2): skipped; not tiny (a ~1 GB ternary language model, 3.5 GB full, plus
  decoders) and under the Stellon Labs Community Licence.
- Kokoro was measured on 2 of the 4 voices (af_heart, bm_fable): at 1 thread it ran at 0.76x real time on the shared
  CPU, and Whisper took 2-4 s per clip. Every Paradee variant (radio, eSpeak) was also measured on those two voices.
- The duplicate session that briefly ran in this workspace (stopped by the lead) had started the listening page; its
  8 lines were kept (one replaced: its ILS line was not in the final export) and every clip was regenerated.
- Not done: WebGPU; multi-threaded WASM (needs cross-origin isolation, which would affect the rest of the site);
  the radio effect in the report is rendered offline in Python (same biquads, soft clip, hiss and squelch; no
  DynamicsCompressor), not captured from WebAudio; no full game session in a real browser (the integration was tested
  through the bundled module, tsc and unit tests).
- eSpeak NG (inside phonemizer.js) is GPL-3.0; it is loaded from jsDelivr only for a word outside the lexicon and is
  not self-hosted.

## Reproduce

```
ml/tts/lines.sh; ml/tts/lines.sh normalize; python3 ml/tts/pick.py             # lines
PY=ml/stt/.venv/bin/python
$PY ml/tts/bench.py synth paradee; $PY ml/tts/bench.py radio paradee            # clips + timing
$PY ml/tts/bench.py synth kokoro --voices af_heart,bm_fable --threads 1
$PY ml/tts/build_lexicon.py [--exclude-bench]; node ml/tts/g2p_eval.mjs          # browser G2P vs misaki
$PY ml/tts/bench.py synth paradee-ph --phonemes ml/tts/data/bench60_ph_espeak.jsonl --name paradee-espeak
$PY ml/tts/others.py pivo|leokani; ml/tts/venvs/phonon/bin/python ml/tts/others.py phonon  (supertonic likewise)
ml/tts/venvs/audio8/bin/python ml/tts/audio8.py --n 5 --threads 3
$PY ml/tts/bench.py transcribe <system> [--voices ...]; $PY ml/tts/bench.py score
node tests/tmp/tts-worker.cjs 10 [--fp32]; node tests/tmp/tts-game-voice.cjs        # browser
ml/tts/test.sh                                                                     # unit tests
$PY ml/tts/samples.py; python3 ml/tts/samples_page.py; $PY ml/tts/report.py      # pages
```
