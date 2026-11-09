# Module 8: masked diffusion LM vs autoregressive (voice command line)

Report: `public/reports/voice-diffusion.html` (built by `python3 ml/diffusion/build_report.py`).

## What was built
- `dlm.py`: a masked diffusion LM made from the S1 blocks (RMSNorm, RoPE, SwiGLU, tied embeddings).
  - Attention is bidirectional. Pad keys are masked out.
  - It adds one `[MASK]` token (vocabulary 1,350).
  - The answer is a canvas of L = 24 slots: the line, then `<eos>` padding. That covers 99.7% of lines; 505 longer training lines are dropped, as is 1 val row of the 1,000.
  - Slot j is predicted from position j-1, the "shift" Dream uses, so an AR checkpoint loads directly.
- `train_dlm.py`: the MDLM/LLaDA objective. Each example gets a masking level t (spread evenly over the batch), and each answer token is masked with probability t. The loss is the cross-entropy on masked slots times 1/t (the ELBO weight). `--weight mean` gives a plain mean cross-entropy instead, and `--init-ar` starts from an AR checkpoint.
- `denoise.py`: the decoder.
  - Low-confidence remasking with a fixed number of steps S, or a confidence threshold τ (Fast-dLLM).
  - Once a `<eos>` is kept, every slot after it becomes `<eos>`.
  - Callsign constraints: `none`, `first`, `snap` and `span`.
  - Prompt caches: `exact`, `prompt` (keys/values from pass 1) and `ctx` (game state encoded while the player talks).
- `ar_span.py`: span-scored callsigns in the shipped AR model (see below).
- `evaluate.py`, `bench.py`, `likelihood.py` and `diagnose.py` produce `runs/*/grid.json`, `results/bench.json`, `results/likelihood.json` and `results/diagnose.json`.

## Matched compute
Both models were trained the same way:
- data: `ml/data/out4/ds`, 204k rows;
- model: 2.03 M parameters (d 192, 4 layers, 6 heads);
- 1200 steps × batch 32 (0.19 epoch);
- learning rate 2e-3, 100 warmup steps, cosine decay to 10%;
- 1 CPU thread each, run at the same time on the shared host (load 15–28).

The AR baseline is the unmodified `ml/s1/train.py`, in `runs/ar-matched`. Wall-clock: AR 106 min, diffusion 117 min, both including their evaluations.

## Accuracy (exact / callsign)
n = 1000 val and n = 1000 Sydney (YSSY, unseen). These are the same rows as every AR `eval.json` (seed-0 shuffle of ml/s1/train.py).

| model | val exact | val callsign | Sydney exact | Sydney callsign |
|---|---|---|---|---|
| AR, matched (greedy + trie) | **72.2%** | 83.6% | **66.0%** | 82.4% |
| Diffusion, random init, S = 1 / 8 / 24 (span) | 0.6% / 0.6% / 0.6% | 5.6% | 0.8% / 0.6% / 0.6% | 5.4% / 5.3% |
| Diffusion, random init, S = 8, no constraint | 2.3% | 2.3% | 2.3% | 2.3% |
| Diffusion, random init, mean-CE loss (`--weight mean`), S = 8 | 2.1% | 19.3% | 2.0% | 16.3% |
| Diffusion, AR init, S = 1 | 70.4% | 96.9% | 64.5% | 99.1% |
| Diffusion, AR init, S = 4 | 84.4% | 96.9% | 78.5% | 99.1% |
| Diffusion, AR init, S = 8 | 88.9% | 96.9% | 86.9% | 99.1% |
| Diffusion, AR init, S = L = 24 (~10 passes) | **91.5%** | 96.9% | **89.4%** | 99.1% |
| Diffusion, AR init, τ = 0.9 (2.2 / 2.4 passes) | 85.8% | 96.9% | 80.2% | 99.1% |
| AR shipped (6000 × 64, GPU), ceiling | 94.2% | 95.6% | 86.8% | 91.9% |

The AR-init diffusion model at step 0, before any diffusion training, scores 8.5% (val, n = 200, S = 8).

Callsign constraints, AR-init model, S = 8 (val / Sydney):

| constraint | val | Sydney |
|---|---|---|
| none | 79.9% | 75.0% |
| first | 81.6% | 76.1% |
| snap | 83.7% | 80.1% |
| **span** | **88.9%** | **86.9%** |

Likelihood (val / Sydney, nats per command, n = 500):

| model | val | Sydney |
|---|---|---|
| AR matched NLL | 2.21 | 3.59 |
| AR shipped NLL | 0.26 | 1.95 |
| Diffusion random-init ELBO bound | 17.8 | 19.5 |
| Diffusion AR-init ELBO bound | 2.35 | 3.10 |

## Latency
CPU, 1 thread, n = 200 val, p50 after push-to-talk release. Mean prompt length is 324 tokens.

| decoder | p50 | p95 | passes | exact (n = 200) |
|---|---|---|---|---|
| AR matched, KV cache | 52 ms | 74 | 9.8 | 71% |
| AR matched, state prefilled while talking | 27 ms | 45 | | |
| AR shipped, KV cache | 48 ms | 62 | 9.5 | 94% |
| AR shipped, state prefilled | 24 ms | 35 | | |
| Diffusion S = 1, exact / state cache | 27 / 8 ms | 32 / 9 | 1 | 68% |
| Diffusion S = 4, exact / prompt / state | 112 / 47 / 23 ms | | 3.8 | 82% |
| Diffusion S = 8, exact / prompt / state | 208 / 66 / 45 ms | 260 / 75 / 85 | 6.9 | 88% |
| Diffusion S = 24, exact / prompt / state | 264 / 78 / 50 ms | | 9.6 | 90% |
| Diffusion τ = 0.9, exact / prompt / state | 36 / 37 / 14 ms | 159 / 59 / 45 | 2.0 | 84% |

One pass over prompt plus canvas (388 tokens) costs 27 ms; one pass over the canvas only, with the prompt cached (25 tokens), costs 4.1 ms. Encoding the game state ahead of time takes about 25 ms, while the player is still talking.

**The prefix-cache question.** In a bidirectional model the prompt also attends to the canvas, so its keys and values change at every pass. Caching them is an approximation, unlike in an AR model. Measured on the same 500 rows, it cost nothing:

| prompt handling | val, S = 8 | Sydney, S = 8 |
|---|---|---|
| exact | 89.4% | 86.8% |
| prompt cache from pass 1 | 89.6% | 86.6% |
| state encoded alone | 89.6% | 86.0% |

## Borrowed back: span scoring in the shipped AR model (`ar_span.py`)
Each callsign in the state is scored by its AR log-likelihood after the prompt, plus a word boundary after it. The best one is kept, and the rest of the line is decoded greedily. Same n = 1000 rows:

| shipped AR | val exact | val callsign | Sydney exact | Sydney callsign | p50, 1 thread (n = 200) |
|---|---|---|---|---|---|
| greedy + trie (as shipped) | 94.2% | 95.6% | 86.8% | 91.9% | 51 ms |
| **span-scored callsign** | **98.2%** | **99.7%** | **93.9%** | **99.4%** | 72 ms |

The fast version scores all candidates in one batched pass on top of the prompt cache. Its output is identical to scoring them one by one (200/200). This is the actionable result of the module: the trie walks greedily, so a wrong airline token cannot be undone, while span scoring compares whole callsigns.

## Why from-scratch diffusion failed here
- **Not a bug.** The same code memorises 64 commands (loss 0.009 after 300 steps), and from an AR start it learns to 88.5%.
- **The model ignores the canvas.** Masked cross-entropy on command tokens is 1.95 nats at t = 0.1 (90% of the canvas visible) and 2.29 at t = 1. For the AR-init model the same numbers are 0.07 and 0.44. The padding is learned (0.0002), so the model writes well-formed lines without copying the content.
- **It reads the prompt only weakly.** Giving it another command's prompt raises the CE at t = 1 from 0.90 to 1.97, against 0.24 → 3.86 for the AR-init model.
- **The 1/t weight is not the cause.** A plain mean-CE run (`runs/dlm-meanw`, 72 min) ended at 2.1% val / 2.0% Sydney, against 0.6% for the ELBO run. It is a little better and has much less loss noise, but it is still nowhere near the AR model's 72%.
- **Reading:** the masked objective learns to copy from the transcript far more slowly than teacher-forced AR does. That fits published results that masked diffusion needs many times AR's compute to reach the same likelihood. On a CPU at 0.19 epoch it never got there.

## Verdict
For this task (short, ~10-token structured lines, and a CPU at batch 1), autoregressive decoding wins. At matched compute, diffusion from scratch learned almost nothing.

Adapted from the shipped AR model, diffusion is competitive in accuracy: 91.5% val and 89.4% Sydney at S = L. It is not faster at equal accuracy: 45–78 ms against AR's 24–48 ms.

Diffusion would pay off in four cases:
- long outputs;
- GPU decoding at batch 1, where a 25-slot pass costs about the same as a 1-token pass;
- editing or infilling part of a command already in the bar;
- a parallel decoder with a confidence knob, when an AR model already exists to adapt.

The callsign accuracy of the span constraint (97–99%) comes from scoring whole callsigns. That is a decoding idea, and it lifts the shipped AR model to 98.2% / 93.9% (see the AR span-scoring section above).

## What a GPU would change
One 1200 × 32 run takes about 1 minute on an L4 (the shipped 6000 × 64 AR run took 645 s, evaluations included). A from-scratch diffusion run at 4–20× the shipped budget would take 45 min to 4 h on an L4, about $0.75–4. That would answer whether from-scratch diffusion catches up on this task. Nothing in this module used a GPU.

## Next
1. Ship span-scored callsigns in the browser engine, with a parity test against `ar_span.py`. Measured: +4.0 points val, +7.1 points Sydney, +21 ms. The same idea is being built in parallel in `ml/s1/callsign_scoring.py`, `ml/s1/decode.py` (`callsign_search`) and `s1.ts`; `ar_span.py` is an independent check.
2. Prompt-causal attention: exact prompt cache, and K noisy canvases per prompt.
3. A from-scratch diffusion run on a GPU with 10–20× the compute.
4. AR→diffusion adaptation with a lower learning rate, for longer.
5. An edit mode that remasks only the corrected field.

## Reproduce
See the bottom of the HTML report. Every command runs from the repo root with `ml/.venv/bin/python`.
