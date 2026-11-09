# 11 — Voice model: speak to the traffic, hear it read back

**Goal.** The player holds push-to-talk (PTT) and talks like a controller. When they let go, the command shows up in the command bar,
already parsed and editable, and the aircraft does it. The pilot then reads it back in their own voice. The whole thing runs
locally in the browser, on a phone, or on a cloud GPU. Latency is about the same as real radio, accuracy is high enough to trust,
and when the model is unsure the pilot says "say again" instead of doing the wrong thing.

Status (2026-11-09, overnight): **edge solution shipped and hardened.** Speech: ATC transcript repair, 5-guess n-best, 0.3 s pre-roll, our server's Whisper (`/api/voice/stt`, inside the Next server) as a second opinion: exact commands from the browser recogniser 52 → 80% on 320 degraded synthetic clips. Model: GRPO-tuned 2M S1 (`/models/s1/2m-grpo-v1`) with likelihood-scored callsign search (Sydney 86 → 94% exact). Gate: round-trip verifier (481-weight MLP + veto rules, 0.2 ms): wrong auto-sends on rules-failed recogniser transcripts 19 → 0.9%; whole chain 17.8 → 5.6% sent wrong at 80% exact. Phone: Flutter app (`mobile/`, sherpa-onnx on device), APK at `/downloads/`. Real-voice gold set: `/voice/record.html`. Diffusion LM measured (AR wins here). Earlier: cloud solutions on one L4 (Kev-0.8B System One 100%; LFM2.5-230M 97% / 93% unseen; vLLM 363 commands/s). Results: `/reports/ai-paths.html`, `docs/learning/ai-engineering-paths.md`.

## 0. What the game already gives us (*exists*)

| piece | where | why it matters |
|---|---|---|
| `CommandAST`, 66 kinds, JSON-serialisable, "produced by the text parser, the click tree and, later, STT / LLM" | `src/lib/sim/commandAst.ts` | **This is the model's structured output.** The model never writes game state. It emits an AST, and the engine validates and applies it (`dispatch.ts guard/applyToEngine`). Scoring, replay and determinism stay intact. |
| typed-command parser: spoken digits, telephony callsigns, last-digit callsigns | `src/lib/sim/commands.ts` | layer L0 (below), the fallback, and the label checker |
| AST → controller transmission and pilot readback text, ICAO and FAA variants | `src/lib/sim/phraseology.ts` `transmission()` / `readback()` | **a free generator of paired data** (AST ↔ spoken text). Readbacks are deterministic, so no model has to write them. |
| rule-based AI on all three positions, emitting `transmission` events with the AST | `engine.ts` auto steps | **the teacher**: run it headless and you get millions of realistic (state, command) pairs |
| deterministic headless sim, 6 airports | `scripts/test-sim.sh`, `tests/engine/helpers.ts` | mass data generation on CPU |
| text observation, LLM agent loop, OpenAI-compatible proxy, JSONL I/O recording | `src/lib/llm/*`, spec 07 | the System 2 path and its transport |
| pilot voice through `speechSynthesis` | `src/components/atc/sound.ts` | the fallback TTS |

**Baseline measured today** (`tests/tmp/roundtrip.test.ts`, JFK, 30 min full auto, 384 AI commands). Each AST is rendered to
the spoken transmission and fed back through the parser:

| input | parsed | exact AST |
|---|---|---|
| spoken text as the engine says it ("Air France eight sixty-five, fly heading one three eight") | **0 %** | 0 % |
| + a grouped-number normaliser ("eight sixty-five" → 865, "seventy-six" → 76) | 86.5 % | **82.3 %** |

The remaining misses are all deterministic: unit names ("John F. Kennedy Intl Approach, radar contact"), information tails
("…, altimeter 3033", "…, wind 263 at 4"), and `unable + standby` parsed as a sequence. So even with perfect speech-to-text,
voice cannot work today. A normaliser plus parser fixes take clean phraseology to roughly 99 % for about 0 ms. **The learned model
is the robustness layer**: speech-recognition errors, gamer phrasing, partial callsigns, implicit context, disfluencies and corrections.

## 1. Architecture (System 1 / System 2)

```
 PTT down ─► mic (AudioWorklet, 16 kHz) ─► streaming STT ─► partial transcript while talking
                                             ▲ hotwords from state: callsigns + telephony on frequency, runways, taxiways, fixes
 PTT up ───► final transcript (≈50–100 ms)
              │
              ├─► L0  normaliser + rule parser (<1 ms) ── unambiguous parse ─────────────┐
              └─► L1  System-1 model: [compact state] + transcript → canonical line ─────┤  (grammar-constrained, entity pointers)
                                                                                        ▼
                                  canonical command line in the command bar (readable, EDITABLE) ─► parse → CommandAST
                                                                                        │
                       confidence ≥ τ and guard() ok ─► execute       below τ ─► pilot "say again"  /  wait for an edit
                                                                                        │
                       engine applies AST (state update) ─► readback(ast) text ─► TTS (per-aircraft voice) ─► radio DSP ─► speaker
                                                                         (the sim's pilot delay of 1–3 s hides TTS latency)

 System 2 (slow, optional): the spec-07 LLM controller (advise / control positions), fine-tuned on AI rollouts. Cloud or desktop.
```

Design rules:
* **Output = the canonical typed line.** It is what the player already types, what the bar shows, what they can edit, and what
  the parser turns into the AST. Being readable, editable and structured are the same thing. A strict `toCommandLine(ast)` serialiser
  is needed (`describe()` is display text, not the grammar) and must be round-trip tested: `parse(toCommandLine(ast)) ≡ ast`.
* **Entities are pointers.** Callsigns, runways, taxiways and fixes come from the state list and are never spelled by the model.
  The decoder is masked to the grammar and to the entities in the current state, so it cannot invent a callsign.
* **Readback is the hearback.** The pilot reads back exactly what the AST says, generated deterministically. A misunderstanding is
  audible right away, just like on real radio, and fixable with "correction …".
* **Confidence maps to phraseology.** Low ASR or NLU confidence, an ambiguous callsign (DAL421 and DAL412 both on frequency), or
  an engine rejection makes the pilot answer "say again" or "confirm …". A confident wrong execution is the metric we drive to zero.

## 2. The three experiments (plus the baseline)

All of them share the data engine (§3), the evaluation (§4) and the integration (§5). Only the L1 box differs.

| | E0 baseline | **E1 System-1 tiny** | **E2 small LLM** | **E3 end-to-end speech→command** |
|---|---|---|---|---|
| NLU | normaliser + rule parser | encoder-decoder transformer, 20–60 M params, trained from scratch (or T5-small init), copy/pointer head over state entities | fine-tuned decoder SLM: **LFM2-350M**, **Qwen3.5-0.8B**, **Gemma 3 270M** (bake-off), full fine-tune, grammar-constrained decoding | ASR decoder trained to emit the canonical line directly (optionally `transcript ⟶ line`), on-frequency entities as decoder prompt |
| STT | separate (§2.1) | separate | separate | **is** the model: Moonshine v2 small/medium or Whisper base/small, fine-tuned |
| input | transcript | compact state (60–200 tok) + transcript | compact state + transcript; state prefix **KV-cached and prefilled while the player is still talking** | audio + entity prompt |
| expected latency after PTT up | ~1 ms | 2–10 ms WASM | 80–200 ms desktop WebGPU, 200–400 ms phone | single pass, ~50–150 ms |
| size (int8/q4) | 0 | 15–40 MB | 200–600 MB | 40–250 MB (replaces STT) |
| strength | free, exact on standard phrasing | runs on any phone, deterministic speed | handles free-form speech, shares weights with System 2 | fewest stages, learns to fix ASR errors internally |
| risk | brittle off-script | needs good noisy-transcript data | download size, prefill on low-end phones | data-hungry, loses the verbatim transcript, harder to debug |

What we expect to ship: **L0 → E1** on every platform (fast path plus robust path), **E2** on cloud and desktop for free-form
speech and as System 2, and **E3** only if it beats E1 on accuracy after the same data budget. The experiments decide. These are
hypotheses until measured.

### 2.1 STT candidates (bake-off before any fine-tuning)
| model | size | streaming | biasing | runs on |
|---|---|---|---|---|
| Moonshine v2 tiny / small / medium (MIT) | 34 M / 123 M / 245 M | yes (sliding-window encoder) | none built in, so fine-tune vocabulary or re-score with L1 | ONNX: web WASM/WebGPU, iOS, Android |
| sherpa-onnx streaming Zipformer / Nemotron transducers | 20–120 M | yes | **hotwords at decode time** (modified beam search + context graph): feed this turn's callsigns, taxiways and fixes | WASM, Android, iOS native |
| Whisper base / small (MIT), plus the community ATC fine-tunes as a reference | 74 M / 244 M | chunked only | prompt conditioning | transformers.js WebGPU, whisper.cpp |
| Parakeet TDT 0.6B v3 / Nemotron streaming (cloud) | 600 M | Nemotron yes | NeMo boosting | L40S |

The player's input is **a gamer on a headset in a quiet room**, not VHF radio audio. The hard part is vocabulary (Speedbird,
Cactus, CAMRN, "two two left"), not noise. So hotword biasing from the live state plus vocabulary fine-tuning on synthetic speech
is the main lever. Real ATC corpora (ATCO2, UWB-ATCC, ATCOSIM) are a different domain, and several are **non-commercial**
(UWB-ATCC is CC BY-NC-SA). Use them only for evaluation or robustness unless OpenATC is non-commercial.

### 2.2 TTS (pilot voices)
Kokoro-82M (Apache, multi-voice, WebGPU), Kitten TTS (~25 MB, CPU), Piper (fast WASM, many voices). On cloud: Kokoro batched on
the GPU. Each aircraft gets a stable voice, pitch and speed (hashed from the callsign; airline nationality picks the accent where
the voice set allows). A WebAudio radio chain (300–3400 Hz band-pass, compression, light hiss, squelch tail) runs on top. The
current `speechSynthesis` stays as the fallback. TTS does not need to be ultra-fast: it only has to finish inside the pilot delay.

## 3. Data engine (the actual moat)

1. **State + command pairs**: headless rollouts over 6 airports × winds × seeds × densities, AI on every position. Each AI
   decision gives (compact state, AST, canonical line). A **command-tree sampler** adds commands the AI never issues: it picks
   from each aircraft's currently valid `can:` actions with random valid parameters (odd headings, holds, directs, speeds,
   go-arounds, conditionals, corrections). Volume: 2–5 M pairs on CPU.
2. **Surface forms**: `transmission()` in ICAO and FAA variants, then a phrasing grammar: callsign forms (full telephony, grouped
   "four twenty-one", digit-by-digit, flight number only, last three digits), number styles, optional words ("and maintain",
   "runway", "degrees"), word order, fillers, restarts, "correction …". An offline paraphrase pass with a large model on the
   128 GB box adds gamer phrasing ("Delta 421 go ahead and come left to two seventy").
3. **Audio**: synthesise the surface forms with dozens of TTS voices, speeds and accents, then augment as a microphone (room
   impulse responses, noise, gain, codec). These are the STT fine-tuning pairs. **Noisy channel**: run the candidate STT on them
   and train L1 on its real error distribution, not on clean text.
4. **Negatives**: callsigns not on frequency or nonexistent, look-alike callsigns both on frequency, truncated commands, gibberish
   → `SAY AGAIN` / `CONFIRM <callsign>`.
5. **Gold set (real voice)**: an in-game *Voice training* panel shows a generated command, the player reads it, and the clip is
   saved with its AST (local, consented). 500–2000 clips from the team, split by speaker. **Never trained on.** Plus the
   existing Record-I/O JSONL from real sessions.

## 4. Evaluation (one harness, every experiment)
* **Command exact match** (canonical AST equality) on the gold real-voice set: target ≥ 97 %. **Callsign accuracy** ≥ 99.5 %.
* **Confident-wrong rate** ≤ 0.5 %. **Say-again rate** ≤ 3 %.
* **Latency, PTT up → line in the bar**: p50 ≤ 150 ms desktop web, ≤ 250 ms mid-range phone, ≤ 200 ms + RTT cloud.
  TTS first audio ≤ 300 ms.
* Footprint: web total download ≤ 150 MB for STT + L1 + TTS (E2 is an opt-in extra). Phone RAM ≤ 600 MB.
* STT: callsign-aware WER on the gold set.
* The headless round-trip probe becomes a permanent test: L0 must stay ≥ 99 % on the engine's own phraseology.

## 5. Platforms

| | web (browser) | cloud (EC2 g6e.xlarge, 1× L40S 48 GB) | phone |
|---|---|---|---|
| STT | Moonshine / sherpa-onnx in a Web Worker (ONNX Runtime Web: WebGPU, WASM-SIMD fallback) | Parakeet / Nemotron streaming or the fine-tuned winner | v1: the same PWA (iOS Safari and Android Chrome have WebGPU); v2 if needed: Capacitor plus native sherpa-onnx |
| L1 | E1 via ORT Web (tiny); E2 via WebLLM or transformers.js (opt-in) | E2 via vLLM / SGLang with prefix caching, OpenAI-compatible, so the existing `/api/llm/chat` proxy works as is | E1 via WASM on any phone; E2 via llama.cpp / ExecuTorch only in the native build |
| TTS | Kokoro (WebGPU) / Kitten or Piper (WASM) | Kokoro batched | same as web; native Piper or Kokoro in v2 |
| transport | none (all local) | one WebSocket "voice gateway": Opus audio in, line + confidence + readback audio out | local, or the cloud gateway on low-end devices |
| caching | Cache Storage / OPFS, downloaded on the first PTT setup | the models stay warm; hundreds of concurrent players per L40S at these sizes | same |

Watch out: multithreaded WASM needs cross-origin isolation (COOP/COEP headers on nginx). That can break the external satellite or
OSM tiles unless they send CORP/CORS headers. Test it before relying on threads, or use WebGPU, which does not need isolation.

## 6. Training (128 GB GPU box)
`ml/` (Python) in the repo. `export` runs the TS dataset exporter through the `test-sim.sh`-style tsc build and writes JSONL
shards. `tts_synth`, `train_e1` (PyTorch), `train_e2` (HF TRL SFT), `train_stt` (HF / NeMo), `train_e3`, and `eval` (the §4
harness) follow. Exports: ONNX + int8/q4 (optimum), GGUF (llama.cpp), MLC (WebLLM).
Compute, roughly: E1 on 2 M pairs < 1 h. E2 full fine-tune, 0.35–0.8 B on ~300 M tokens: 2–4 h per base model. STT fine-tune on
200–300 h synthetic: several hours. Audio synthesis: hours. All three experiments fit in 1–2 GPU-days.

## 7. Order of work
**Day 0, on this host, no GPU needed**
1. L0: grouped numbers, unit-name / altimeter / wind / "report …" tails, `unable+standby` equivalence. The round-trip probe goes
   from 82 % to ≥ 99 % and becomes a headless test. `toCommandLine(ast)` gets a round-trip test over all 66 kinds.
2. Dataset exporter: compact state, AST, line, surface forms, the command-tree sampler, negatives → JSONL.
3. Game plumbing: PTT (configurable key plus an on-screen button for mobile), AudioWorklet capture, voice worker, the line into
   the bar with a confidence chip, auto-execute or confirm, "say again" readback, the *Voice training* recorder.
4. E0 end to end in the browser with an off-the-shelf STT (Moonshine or sherpa-onnx with hotwords). Voice works before any training.

**Day 1, GPU**: synthesise audio → STT bake-off and fine-tune → train E1, E2 (2–3 bases), E3 → evaluate on the gold set → pick.
**Day 2**: ship the winners on the web, build the cloud voice-gateway container on g6e, measure on phones, pilot voices plus radio DSP.
**Later**: System 2 controller fine-tune (behaviour cloning from the rule AI plus player sessions, then RL against the engine's
score), an open-mic mode with VAD, more languages and accents.
