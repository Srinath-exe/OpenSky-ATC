# OpenATC ML: learn AI engineering by shipping the voice model

Written for the project owner, who is learning AI engineering end to end through this project, and for anyone reading the repo later.

The product goal is in [docs/spec/11-VOICE-MODEL.md](../docs/spec/11-VOICE-MODEL.md): talk to the traffic, and the command lands in
the command bar, the aircraft does it and the pilot reads it back, on the web, on phones and in the cloud. This folder is where the
models are built. Each module teaches one AI-engineering skill **by building a real part of that product**. Every module ends with
a measured result, so the repo doubles as a portfolio.

## The rule for every module
1. **Build it from scratch first** where the concept matters (tokenizer, attention, KV cache, sampling, diffusion decoding), small
   enough to read in one sitting.
2. **Then use the production tool** (HF Transformers/TRL, vLLM/SGLang, ONNX Runtime, llama.cpp, WebGPU) and compare it against
   your own version.
3. **Measure**: accuracy on the gold set, latency p50/p95, memory, model size, cost. Write the numbers in the module's `RESULTS.md`.
4. Ship whatever wins into the game.

## Skill map

| # | skill | module | what you build | what you learn | status |
|---|---|---|---|---|---|
| 1 | **Data and synthetic data** | `data/` | export (game state, command, spoken forms) from the headless sim; the rule-based AI is the teacher | distillation from a teacher, label quality, augmentation, noisy-channel training, train/test leakage | **done**: 75k labelled commands from 12 airports; airline-swap augmentation took the unseen airport from 71% to 87% |
| 2 | **Tokenization** | `tokenizer/` | byte-level BPE from scratch, trained on ATC text; compared with Qwen/Gemma tokenizers | merges, vocab size vs sequence length, why "two seven zero" costs 3–6 tokens, domain tokenizers for tiny models | **done**: 1,349-token BPE; every ATC word is one token |
| 3 | **Pre-training** | `s1/` | a 5–60 M GPT-style transformer (RMSNorm, RoPE, SwiGLU, causal attention), trained from random init on the synthetic corpus | the training loop, AdamW, LR warmup/cosine, mixed precision, loss curves, overfitting, scaling (params vs data) | **done**: 2M/11M/26M sweep on an L4 (48 s vs 43 min on CPU); more data beat more parameters |
| 4 | **Inference internals** | `s1/infer.py` | greedy/top-p sampling, **KV cache from scratch**, prefix caching of the game state, grammar-constrained decoding | why decode is memory-bound, prefill vs decode, cache reuse, structured output without hallucinated callsigns | **done**: hand-written KV cache 4.5×, prefix caching 7×; temperature scaling; likelihood-scored callsign search over a branched KV cache (Sydney 86 → 94% exact, +8 ms) |
| 5 | **Post-training: SFT / LoRA** | `slm/` | fine-tune LFM2-350M, Qwen3.5-0.8B and Gemma 3 270M on (state + transcript → command line) | full fine-tune vs LoRA/QLoRA, chat templates, loss masking, catastrophic forgetting, eval-driven training | **done for Kev-0.8B** (93→100% in 24 min on 3,000 examples); LFM2.5-230M full fine-tune running |
| 6 | **Post-training: preference + RL** | `slm/rl/` | DPO on (good, bad) command pairs; GRPO with the **game engine as the verifier** (reward = command parses, matches, is legal) | RL with verifiable rewards, reward hacking, KL control; RL on the controller's score for System 2 | **done (CPU)**: GRPO from scratch, 3 rewards + an SFT control; recogniser transcripts 79.6 → 83.8% (control 82.0%), Sydney flat; `ml/rl/`, /reports/voice-rl.html |
| 7 | **Function / tool calling** | `tools/` | the 66 `CommandAST` kinds exposed as JSON-schema tools; a tool-calling System 2 agent (get_traffic, issue_command, …); plain lines vs tool calls vs grammar compared | system prompts, tool schemas, parallel calls, JSON-schema constrained decoding, when not to use tools | **System One explored**: 7 models compared (Kev, Von, Laya, d1, Qwen letters, NanoJev, Nimble) |
| 8 | **Diffusion LMs** | `diffusion/` | a small **masked diffusion LM** (MDLM/LLaDA-style) for the same task, decoding the whole command line in a few parallel steps | forward masking process, denoising objective, step count vs quality, latency compared with autoregressive | **done (CPU)**: from scratch 0.6% vs AR 72% at matched compute; AR-initialised 91.5% / 89.4% Sydney, slower than AR on short commands (`ml/diffusion/`, /reports/voice-diffusion.html) |
| 9 | **Speech models** | `stt/`, `tts/` | STT bake-off (Moonshine v2, sherpa-onnx with hotwords, Whisper); fine-tune on synthetic ATC audio; pilot voices with TTS | CTC/transducer vs encoder-decoder, streaming, contextual biasing, WER vs callsign accuracy, audio augmentation | **shipped**: 640-clip degraded benchmark; ATC repair + n-best + pre-roll + server Whisper second opinion: browser 52 → 79% exact; verifier gate cuts wrong auto-sends 19 → 0.9%; whole chain 80% exact, 5.6% sent wrong; real-voice gold set ready (`ml/stt/`, /reports/voice-stt.html, /reports/voice-verifier.html, /voice/record.html); **built**: neural pilot voices, Paradee-8M (8.5 MB) in the browser, WER 5.7 % vs Kokoro-82M 7.1 % on 60 pilot lines, 6x real time in WASM (`ml/tts/`, /reports/voice-tts.html) |
| 10 | **Edge: browser** | `edge-web/` + game | models in a Web Worker on ONNX Runtime Web (WebGPU, WASM fallback) and WebLLM; download once and cache in the browser | quantization (int8/int4), operator support, WebGPU vs WASM, memory limits, first-load UX | **shipped**: 2 MB int8 model, hand-written TypeScript engine, parity 50/50, 98 ms in the browser |
| 11 | **Edge: phone app** | `edge-mobile/` | an app that downloads the model on first run and runs it on device (llama.cpp / ExecuTorch / sherpa-onnx natively, Capacitor shell around the game) | model delivery, on-device runtimes, NPU/GPU/CPU backends, thermal throttling, battery | **built**: Flutter app (`mobile/`), game in a WebView, sherpa-onnx streaming zipformer + hotwords on device (73 MB download, 62 ms), resumable checksummed downloads, 44 MB APK; not yet run on a phone (/reports/mobile-app.html) |
| 12 | **Cloud inference** | `serve/` | vLLM/SGLang on EC2 g6e (L40S 48 GB): multiple replicas behind a router, prefix-cache-aware routing, autoscaling; a load generator | PagedAttention, continuous batching, **KV-cache memory management**, prefix caching, speculative decoding, TTFT/TPOT/throughput, cost per 1k commands | **running**: vLLM on an L4, load test 1–64 users, prefix caching on/off |
| 13 | **Productization** | `product/` | model registry and versioning, eval gate in CI, download manager with checksums, telemetry for latency and say-again rate, A/B switch, licence audit | shipping ML: regressions, rollbacks, privacy (audio stays local), licences of data and weights | **in progress**: versioned model URLs, per-model verifier gates, parity tests, quantization check, cost tracking, real-voice gold set + one-command scoring |

Order: 1 → 2 → 3/4 on this host (CPU is enough for tiny models) → 5/6/9 on the 128 GB GPU → 7, 8 → 10 → 12 → 11, with 13 throughout.

## Interview angle
Every module answers a standard AI-engineer question with your own numbers: "how does a KV cache work?" (you wrote one), "LoRA or
full fine-tune?" (you measured both), "how do you serve many users?" (vLLM replicas on g6e, with your load-test curve), "how do
you run a model in the browser?" (it's in the game). Keep each `RESULTS.md` honest and short, with the charts in the HTML reports.

## Hardware
* This host: 8 CPU cores, 31 GB RAM, no GPU. Good for data generation, tokenizers, tiny models and evaluation.
* Training: a 128 GB-VRAM GPU (details pending).
* Cloud inference: EC2 g6e (1× L40S 48 GB) and larger g6e sizes for multi-replica tests.
