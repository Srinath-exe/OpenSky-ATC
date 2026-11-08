# Building an AI model: the paths, what we tried, what we chose

Written for a senior software engineer moving into AI engineering. Everything here comes from building the OpenATC
voice model: you speak like a controller, the command lands in the command bar, the aircraft does it, the pilot reads it
back. The numbers are measurements from this repo, not estimates, unless they are marked as targets.

The HTML version with charts is at `/reports/ai-paths.html` on the OpenATC site.

---

## 0. The mental model

Building an AI feature is a chain of decisions. At each one there are several real options, and you choose by
**measuring against the product's constraints**, not by picking the most impressive technique. Ours were:

| constraint | target | why |
|---|---|---|
| latency | under 150–250 ms from push-to-talk release to the command | it has to feel like radio |
| accuracy | at most 0.5% of commands executed wrong with high confidence | a wrong heading is worse than "say again" |
| size | ~150 MB for everything in a browser, less on phones | it has to download and run on the device |
| privacy | audio can stay on the device | voice is personal data |
| cost | close to zero per command at the edge | a game, not an enterprise tool |

The ten decisions below are the ones you meet in almost every AI project.

---

## 1. Do we need a model at all?

| option | what it is | verdict |
|---|---|---|
| **Rules / a parser** | hand-written grammar | **kept as layer L0** |
| Learned model only | everything through the network | rejected as the only path |
| **Rules first, model for the rest** | cheap exact path, model for the messy tail | **chosen** |

**What we measured.** The game already had a typed-command parser. We fed it what the engine itself *says* for
1,955 AI commands across six airports. It understood **41%**, and **0%** at US airports, because FAA phrasing groups
numbers ("eight sixty-five"). Seven small parser fixes took it to **99.8%** (1,951/1,955).

But when we drop the filler words people actually skip ("and maintain", "runway", "degrees"), the rules fall to 93–99%,
and real speech-recognition errors make it worse again. So rules cover clean speech for free, and a model has to cover
the rest.

**Lesson.** Build the cheapest baseline first and measure it. It tells you how big the model's job really is. Here it
turned "build a model" into "build a model for the hard 5–20%".

---

## 2. Frame the problem: what goes in, what comes out?

| option | verdict |
|---|---|
| free text in, free text out (chatbot style) | rejected: nothing to check, hard to execute |
| model writes the new game state | rejected: the model could break invariants, scoring and replay |
| **structured in → structured out**: game state + transcript → one command line | **chosen** |
| JSON / tool calls as the output | kept as the System 2 experiment |

The output is the **same command line a player types** (`DAL421 Turn left heading 270`). That one choice gives us three
things at once:
- it's readable and editable in the command bar;
- the existing parser turns it into a structured command (an AST);
- the engine validates and applies it. The model never touches game state.

This is the "System 1" idea you mentioned: fast, narrow, structured. The deterministic system stays the source of truth.

**Lesson.** Make the model's output something your existing system can *check*. Validation is what makes a small model
safe to ship.

---

## 3. Architecture: one model, or a pipeline?

| option | parts | pros | cons | verdict |
|---|---|---|---|---|
| **Cascade** | speech-to-text → understanding model → engine → text-to-speech | each part testable and swappable, editable transcript | errors add up, more hops | **chosen for v1** |
| End-to-end speech → command | one audio model emits the command line | lowest latency, can learn to fix ASR errors | needs much more data, hard to debug | **experiment E3** |
| Speech-native LLM (audio in) | e.g. Gemma 4 edge models with audio input | one big model | far too large for a phone | rejected for edge |

Readbacks don't need a model at all: the engine already generates them from the AST. Text-to-speech only has to finish
within the pilot's 1–3 s reply delay, so it isn't on the critical path.

---

## 4. Which kind of model for the understanding step?

| option | size | how it's built | verdict |
|---|---|---|---|
| classic NLU: intent classifier + slot tagger (BERT-style encoder) | 20–110 M | fine-tune | considered; a seq2seq with copying covers the same ground and handles multi-part commands |
| **tiny transformer trained from scratch** (E1) | 2–60 M | **pre-train** on our synthetic data | **chosen as the edge candidate** |
| **small LLM, fine-tuned** (E2): LFM2-350M, Qwen3.5-0.8B, Gemma 3 270M | 0.3–0.8 B | **SFT / LoRA**, then DPO / RL | **chosen for cloud and System 2** |
| prompt a hosted frontier model | huge | prompting only | rejected for the voice path: 0.5–2 s and per-call cost |
| **masked diffusion LM** (E4) | 15–60 M | pre-train | **experiment**: writes the whole line in a few parallel steps |

Why a model trained from scratch is realistic here: the domain is tiny. All of ATC English in our corpus is **565
distinct words**. A 2 M-parameter model can learn that; it does not need world knowledge.

**Lesson.** Model size follows the task's information content, not its importance. Narrow, structured tasks are where
small models beat big ones on latency, and often on accuracy, once you add constraints.

---

## 5. Prompt, retrieve, fine-tune, or pre-train?

| technique | when it fits | here |
|---|---|---|
| prompting (zero/few-shot) | general model, fuzzy task, little data | baseline for E2 only |
| RAG (retrieval) | the model lacks *knowledge* | not our problem: everything it needs is in the game state we pass in |
| **fine-tuning (SFT / LoRA)** | a good base model, a specific format and skill | **E2** |
| **preference tuning / RL (DPO, GRPO)** | you can score answers | **E2 after SFT**: the engine is a perfect verifier (does the line parse, match, and is it legal?) |
| **pre-training from scratch** | narrow domain, unlimited synthetic data, strict size budget | **E1** |
| distillation | a strong teacher exists | **our data**: the rule-based AI controllers are the teacher |

---

## 6. Data: where does it come from?

| source | verdict | note |
|---|---|---|
| **the simulator as teacher** | **chosen** | the headless sim runs the rule-based AI; every decision = (state, command) |
| **command-tree sampler** | **chosen** | the teacher only says 19 kinds of command; sampling the click UI's valid actions adds 12 more → **31 kinds** |
| **phraseology generator** | **chosen** | the engine speaks every command in ICAO and FAA style |
| augmentation | **chosen** | number styles, dropped words, "uh", homophones, flight-number-only callsigns, "say again" negatives |
| public ATC speech (ATCO2, UWB-ATCC, ATCOSIM) | test only (pending the licence answer) | several are non-commercial, and it's a different domain: VHF radio vs a gamer's headset |
| your own recordings | **planned: the gold test set** | the only data that matches real users |

What we built: **15,566 labelled commands** (10,198 from the teacher, 5,368 sampled; 6 airports × 4 seeds × 40 sim-minutes), **0 rejected** by label checks,
augmented into **33.7k train / 3.8k validation / 2.75k unseen-airport test** examples.

Data engineering that matters more than the model:
- **Label hygiene by round trip.** Every target line must parse back to the exact command, or it's dropped.
- **Split by session, not by row.** Rows from one session share aircraft and context, so a random split leaks test data
  into training. Sydney (YSSY) is held out entirely to measure generalisation to an unseen airport.
- **Don't let noise destroy meaning.** Our first augmentation could drop the word "left" from "runway 31 left" while the
  label still said 31L, which made the example impossible. Meaning-carrying words are now protected.
- **Watch the teacher's bias.** 57% of what the AI says is "fly heading". Without the sampler, the model would barely
  see holds or go-arounds.

---

## 7. Tokenization

| option | verdict |
|---|---|
| a big general tokenizer (GPT/Qwen, 100k–150k tokens) | used by E2: comes with the base model |
| **our own byte-level BPE** (written from scratch) | **chosen for E1/E4** |
| characters only | rejected: sequences ~2.3× longer |

What we found:
- BPE ran out of useful merges at a **1,349-token vocabulary**. Every ATC word became one token: "established",
  "speedbird", "altimeter".
- Digits are deliberately kept one per token, so "270" is "2 7 0" and the model can copy any number.
- The game-state context is **311 of every 330 tokens (94%)**. That one fact drives the inference design: the context is
  computed once and cached (prefix caching) while the player is still talking.

---

## 8. Controlling the output

| option | verdict |
|---|---|
| free generation + validate afterwards | the fallback |
| **constrained decoding**: mask tokens that break a grammar or schema | **chosen for callsigns**: the model can only name aircraft that exist |
| JSON schema / function calling | System 2 experiment (module 7) |
| confidence gate | **chosen**: unsure → the pilot says "say again" instead of executing |

Even an untrained model gets 20% of callsigns right with the constraint (pure luck among the valid ones), against 0%
without it. The constraint removes a whole class of errors for free.

---

## 9. Speech recognition: which engine?

| option | where | measured | verdict |
|---|---|---|---|
| **browser Web Speech API** | Chrome/Edge (cloud), Safari (on device) | live in the game now | **shipped as E0** (no download) |
| **Moonshine tiny / base** (MIT) | in the browser via transformers.js, WASM or WebGPU | 28 MB download, 8 s first load, **270–630 ms** per command (WASM, CPU) | **wired in as "On-device"**; accuracy not good enough yet |
| Whisper base / small | same | not yet | bake-off on the GPU box |
| sherpa-onnx streaming + hotword biasing | browser WASM, native mobile | not yet | strong candidate: can be told this turn's callsigns |
| Parakeet / Nemotron streaming | cloud GPU | not yet | cloud tier |

**First on-device result** (40 commands spoken by the robotic espeak voice):

| variant | word error rate | commands understood | p50 latency |
|---|---|---|---|
| tiny, int8 | 82% | 0/40 | 270 ms |
| tiny, fp32 | 75% | 0/40 | 284 ms |
| base, int8 | 76% | 3/40 | 553 ms |
| base, fp32 | 76% | 2/40 | 629 ms |

Off-the-shelf small STT does not know "Speedbird", "Sierra Kilo Whiskey" or "climb and maintain"; it heard "cold
position" for "hold position". The robotic voice makes it look worse than human speech will, but the direction is
clear: **vocabulary is the problem**. The fixes are contextual biasing (tell the recogniser which callsigns are on
frequency right now) and fine-tuning on synthetic ATC speech.

Quantization (fp32 → int8) cost little latency on WASM here and changed accuracy only slightly. The model size, tiny vs
base, mattered more.

---

## 10. Where it runs: browser, phone, cloud

| target | runtimes | key concerns | plan |
|---|---|---|---|
| browser | ONNX Runtime Web (WebGPU / WASM), transformers.js, WebLLM | download size, first load, WebGPU availability, memory | E0 + Moonshine live; E1 next |
| phone app | llama.cpp, ExecuTorch, LiteRT, sherpa-onnx; app downloads the model on first run | RAM, battery, thermal throttling, store size limits | after the web version |
| cloud (EC2 g6e, L40S 48 GB) | vLLM / SGLang | KV-cache memory (PagedAttention), continuous batching, prefix caching, replicas behind a router, cost per 1,000 commands | E2 + System 2 |
| quantization | fp32 → fp16 → int8 → int4 | accuracy vs size vs speed: measure per model | per target |

---

## 11. Inference, the core ideas we built by hand

- **KV cache.** When generating token *t*, the keys and values of tokens 0..t−1 don't change. Keep them, and each new
  token costs O(T) instead of re-running the whole sequence. Written by hand in `ml/s1/model.py`.
- **Prefix caching.** The game-state context is identical for every utterance until the state changes. Compute it while
  the player is talking, and at release only the transcript and the answer remain. `ml/s1/bench.py` measures all three.
- **Sanity check on training.** At random initialisation the loss should be about ln(vocabulary size). Ours was 7.24 vs
  ln(1,349) = 7.21. If yours isn't, something is wrong before training has even started.

**Results of the first from-scratch run** (2.0 M parameters, 2,000 steps, 43 min on 8 CPU cores):

| | exact command | callsign |
|---|---|---|
| validation, with the callsign constraint | 67.5% | 73.6% |
| validation, without the constraint | 45.3% | 49.3% |
| unseen airport (Sydney) | 40.1% | 51.1% |

| decoding (1 CPU thread, identical outputs) | p50 |
|---|---|
| no cache | 222 ms |
| KV cache | 50 ms |
| KV cache + game state precomputed | 32 ms |

Training loss fell to 0.03 while validation flattened at ~65%: **overfitting**, the model memorising the training
sessions. The fix is more varied data and a bigger model, i.e. the GPU run.

---

## 11b. System One models (typed answers, no text)

A **System One model** takes a state and named questions (pick one option / yes-no / score) and returns a probability
over the allowed options in one forward pass. No text is generated, so the answer is always valid, with a confidence.
TypeSafe's Jev started the category (closed); open ones are below. Our test: the same 100 ATC commands, two
questions each (which aircraft, which instruction kind), zero-shot, on this CPU:

| model | aircraft | instruction | CPU time | confidence right / wrong |
|---|---|---|---|---|
| **our S1 2M, trained on our data, calibrated** | **93%** | **99%** | **95 ms** | 0.85 / 0.41 |
| Kev-0.8B (Qwen3.5-0.8B + LoRA + pointer head) | 93% | 83% | 4.1 s | 0.42 / 0.05 |
| Qwen3.5-0.8B, letter probabilities, no training | 78% | 63% | 3.1 s | 0.83 / 0.46 |
| Von 395M (ModernBERT) | 76% | 36% | 1.1 s | 0.84 / 0.66 |
| Laya 420M (ModernBERT) | 69% | 78% | 0.9 s | 0.86 / 0.65 |
| d1-omni-600M (text) | 51% | 58% | 1.3 s | 0.49 / 0.22 |
| d1-omni-600M (straight from audio) | 10% | 19% | 1.4 s | not informative |

NanoJev (games only, CUDA-only server) and Nimble 9B (needs a GPU) were not run.

- A tiny model trained on the domain beats 0.4–0.8 B general models zero-shot, and is 10–40× faster.
- Kev, untrained on ATC, is the best at knowing when it is wrong: exactly what a "say again" gate needs.
- Our model was overconfident (0.90 when wrong). **Temperature scaling**, one number fitted on 300 other commands,
  fixed that (0.41) without changing accuracy. That is calibration, and it is cheap.
- Next: fine-tune Kev-0.8B on our 33k examples (it ships a fine-tune pipeline; needs a GPU), and keep the tiny model
  for the browser and phones.

---

## 11c. The GPU session (one NVIDIA L4, g6.2xlarge, ~$1 an hour)

| finding | numbers |
|---|---|
| GPU vs CPU training | the same S1 run: **48 s** on the L4, 43 min on this server's 8 CPU cores (54×) |
| GPU vs CPU inference | Kev-0.8B 4.1 s → 59 ms; d1 1.0 s → 50 ms; Laya 0.9 s → 77 ms |
| **more data beats a bigger model** | 2M: 67.5% → **93.8%** with 3× data; 11M 94.1%, 26M 95.6%, but both *worse* on the unseen airport (45%) |
| **airport variety** | 2M on 11 airports: unseen airport 50% → **71%** |
| **targeted augmentation** | swap airlines across the whole table: unseen airport 71% → **87%**, false "say again" 87 → 1 |
| fine-tuning a pretrained model | Kev-0.8B, 3,000 examples, 24 min: 93/84% → **100/100%**, also at the unseen airport |
| speech-to-text + clean-up | 5 recognisers on neural speech: rules alone 42–57% of commands, **rules + our model 81–88%**; a callsign hint cuts Whisper's WER 27% → 17% |
| quantization | int8 (2.07 MB) = fp32 accuracy (95.3% vs 95.0%) |
| browser engine | hand-written TypeScript: **50/50 identical tokens** to PyTorch; 98 ms after push-to-talk release |
| pretrained generator (E2) | LFM2.5-230M, full fine-tune, 14 min: 5 airports → 96.1% / **90.4% unseen**; 11 airports + swap → **97.3% / 93.2% unseen** |
| serving (vLLM, one L4) | 26–33 ms per command for one player (3× plain HF generate); **363 commands/s at 64 players**; prefix caching +38% throughput and half the p95 at 64 players, slightly slower at 1 |
| cost | the whole session: **130 min, $2.13**, then terminated |

## 11d. Many paths, three solutions

1. **Edge (shipped in the game):** speech in the browser → rules → our 2 MB model in a Web Worker → confidence gate.
   94% on known airports, 87% on an unseen one, free per command, audio can stay on the device.
2. **Cloud System One:** Whisper + callsign hint → Kev-0.8B fine-tuned → which aircraft / which instruction, calibrated,
   80 ms on an L4, 100% even at the unseen airport; values from the rules or the edge model.
3. **Cloud generator:** a fine-tuned LFM2.5-230M writes the whole command (97.3% known airports, 93.2% unseen),
   served by vLLM: 363 commands/s for 64 players on one L4.

The lesson: there is rarely one answer. Pick per constraint (cost, privacy, latency, generalisation), ship the cheap
one, and keep the strong ones as the upgrade path and as teachers for the next small model.

---

## 12. What we finalised

1. The model outputs the **canonical command line**; the engine validates and applies it; readbacks stay deterministic.
2. **Layers:** L0 rules (live, 99.8% on clean phrasing) → L1 model for the messy tail → confidence gate → "say again".
3. **Data:** simulator teacher + command sampler + augmentation, label round-trip checks, session splits, an unseen-airport test.
4. **Models:** E1 tiny from-scratch transformer for the edge; E2 fine-tuned small LLM for the cloud; E3 end-to-end and E4
   diffusion as experiments. All are scored on the same harness.
5. **Speech:** browser recogniser now; on-device Moonshine wired in; biasing + fine-tuning next, on the GPU box.
6. **Open:** GPU access, and whether OpenATC is commercial (decides which public datasets we may train on).

## 13. Habits worth keeping from this project

- Measure the dumb baseline before building the clever thing.
- The data pipeline is most of the work, and most of the bugs live in it.
- Make labels self-checking (round trips) and splits leak-proof (by session, plus a held-out environment).
- Keep the deterministic system as the source of truth; let the model propose.
- Find where the tokens go before optimising the model: here, 94% was context.
- Constrain outputs where you can; it's free accuracy.
- Report honest numbers, including the bad ones. The STT result above changed the plan.
