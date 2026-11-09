# Callsign by likelihood (S1 decoder)

Report: `public/reports/voice-callsign.html` (`python3 ml/s1/build_callsign_report.py`).

## Question
S1 picked the callsign greedily through a trie of the callsigns in the state: first token = arg-max among the valid
first tokens, then the next. That commits to an airline prefix before the model has scored the digits. The diffusion
experiment (`ml/diffusion/RESULTS.md`) found that scoring every callsign by its full likelihood lifts Sydney callsign
accuracy from 91.9% to 99.1%. Does the same hold for the autoregressive model?

**Yes, and it is shipped.**
- Exact accuracy (n = 1000 each, McNemar p < 0.001 everywhere), same weights:
  - 2m-swap-v1: Sydney 86.8 → 94.2%, val 94.2 → 98.2%, real recognisers 79.6 → 84.1%.
  - 2m-grpo-v1: Sydney 86.3 → 94.0%, val 95.5 → 97.9%, real recognisers 83.8 → 87.1%.
- Callsign accuracy ≥ 99.4% on val and Sydney.
- Cost: an exact best-first search, +1 to +2 model steps per command, +8 ms median / < 50 ms p95 in node.
- The verifier gate was refitted for both models. A gate export bug found on the way is fixed (see Verifier refit).

## Method
- Candidates: every callsign in the state plus `" SAY AGAIN"`, teacher-forced from the same `<cmd>` KV cache.
- `sum`: Σ log p(token) + log p(word boundary after it). The boundary is any token starting with a space or newline,
  or `<eos>`. Without it `UAL12` always beats `UAL123` (`sum_nb` below).
- `mean`: `sum / (tokens + 1)` (length-normalised).
- Arg-max wins, then the rest is decoded greedily. The first token after the callsign must be a boundary.
- Eval: the fixed sets of `ml/rl/common.py` (val and Sydney n = 1000 each, as `ml/s1/train.py` picks them, plus 1,000
  real-recogniser transcripts), PyTorch float weights. Paired rows, exact two-sided McNemar.
- Script: `ml/s1/callsign_scoring.py`; tables: `ml/s1/callsign_report.py` → `results/summary.json`.

## Accuracy (exact / callsign, n = 1000 each)

| model | set | greedy trie | sum, no boundary | sum | **mean (shipped)** | mean vs trie | say again missed / false: trie → mean |
|---|---|---|---|---|---|---|---|
| 2m-swap-v1 | val | 94.2 / 95.6 | 98.2 / 99.7 | 98.2 / 99.7 | **98.2 / 99.7** | +40 −0, p < 0.001 | 1/3 → 0/3 |
| 2m-swap-v1 | Sydney | 86.8 / 91.9 | 93.4 / 98.9 | 94.1 / 99.6 | **94.2 / 99.7** | +74 −0, p < 0.001 | 3/1 → 1/2 |
| 2m-swap-v1 | real recognisers | 79.6 / 88.5 | 83.3 / 92.2 | 83.0 / 91.9 | **84.1 / 93.3** | +54 −9, p < 0.001 | 0/41 → 0/55 |
| 2m-grpo-v1 | val | 95.5 / 97.0 | 98.0 / 99.5 | 98.0 / 99.5 | **97.9 / 99.4** | +25 −1, p < 0.001 | 5/3 → 3/3 |
| 2m-grpo-v1 | Sydney | 86.3 / 91.4 | 93.0 / 98.6 | 93.9 / 99.5 | **94.0 / 99.6** | +78 −1, p < 0.001 | 4/0 → 3/1 |
| 2m-grpo-v1 | real recognisers | 83.8 / 92.3 | 86.3 / 95.1 | 86.1 / 94.8 | **87.1 / 96.0** | +34 −1, p < 0.001 | 0/33 → 0/40 |

- `mean` vs `sum`: equal on val and Sydney. Better on real recognisers: +11 −0 (p < 0.001) and +10 −0 (p = 0.002).
  The sum over-prefers the 2-token `SAY AGAIN` on garbled transcripts.
- Beam search over the trie (width 2 / 4 / 8) is approximate. Width 4 is 92.6% on Sydney and costs ~19 steps.
- Typical failure fixed: Sydney, "527 maintain 210" (gold `VOZ527 Speed 210`).
  - The trie took `QFA` (p = 0.45 among first tokens, Qantas dominates Sydney traffic; `VOZ` 0.004).
  - It then reached the complete `QFA71`, released the constraint, and the model went on to `QFA717`, an aircraft
    not in the state.
  - Full likelihood: `VOZ527` costs 5.9 nats, `QFA71` 38 (`results/example.json`).

## Decoder as shipped (`src/lib/voice/s1.ts` `callsignMode = 'score'`, mirrored in `ml/s1/decode.py`)
- Exact best-first search over the trie. A prefix's log-prob bounds every callsign below it (log-probs ≤ 0).
- Length-normalised, it is A* with the bound `lp(prefix) / (longest callsign below + 1)`.
- The first complete callsign popped is the arg-max. Same pick as scoring every candidate on all 6,000 eval rows.
- The KV cache is branched per trie node. Each stepped node's keys and values are saved, and the ancestors' are copied
  back to positions P.. before a node is stepped. Same `step()`, so it is identical to a straight decode of that callsign.
- Runner-up for the margin signal: until it is found, until nothing left is within 2 nats/token, or for at most 4
  steps. On a budget stop the margin is best minus the highest bound left (a lower bound).
- More than 48 steps before the best is found → the greedy trie (bounded worst case).
- `callsignMode = 'trie'` keeps the old decoder: tokens and confidence identical to the committed engine.
- New signals: `csLh` (log-likelihood of the chosen callsign) and `csLhMargin` (margin over the runner-up, capped at 2
  per token). The old signals are taken along the chosen path, so `csMargin` can now be negative.

End to end (`ml/s1/callsign_e2e.py`: `decode.generate_scored` vs the trie, same rows, n = 1000 each). Zero trie
fallbacks in 6,000 rows.

| model | set | trie exact / cs | shipped exact / cs | fixed / broken (McNemar) | search steps mean / p95 / max |
|---|---|---|---|---|---|
| 2m-swap-v1 | val | 94.2 / 95.6 | **98.2 / 99.7** | +40 −0 (p < 0.001) | 5.0 / 8 / 13 |
| 2m-swap-v1 | Sydney | 86.8 / 91.9 | **94.2 / 99.7** | +74 −0 (p < 0.001) | 5.1 / 9 / 17 |
| 2m-swap-v1 | real recognisers | 79.6 / 88.5 | **84.1 / 93.3** | +54 −9 (p < 0.001) | 6.2 / 11 / 33 |
| 2m-grpo-v1 | val | 95.5 / 97.0 | **97.9 / 99.4** | +25 −1 (p < 0.001) | 4.8 / 8 / 16 |
| 2m-grpo-v1 | Sydney | 86.3 / 91.4 | **94.0 / 99.6** | +78 −1 (p < 0.001) | 5.3 / 10 / 15 |
| 2m-grpo-v1 | real recognisers | 83.8 / 92.3 | **87.1 / 96.0** | +34 −1 (p < 0.001) | 5.8 / 9 / 29 |

## Compute and latency
- Model steps per command after the transcript (2m-swap-v1):
  - greedy trie: 8.4–8.7
  - every candidate (shared prefixes once): 49–52
  - beam 4: ~19
  - best-first as shipped: 9.9 / 10.0 / 10.6 on val / Sydney / real recognisers (search 5.0 / 5.1 / 6.2 steps,
    including ≤ 4 for the runner-up), so +1.2 to +2.2 steps. Without the runner-up phase it would be +0.1 to +0.5.
- Added `complete()` time, node, browser engine, one thread, 144 rows (val + Sydney + STT), both decoders on the
  same rows in one process (`ml/s1/callsign_latency.cjs`). The host is shared: load average ~4 on 8 cores.
  - 2m-swap-v1: +8 ms median, +48.7 ms p95, max +278.6 ms (trie 125.7 ms → 134 ms median).
  - 2m-grpo-v1: +8.5 ms median, +47.2 ms p95, max +115.8 ms (trie 118.6 ms → 134.4 ms median).
- Target was < 60 ms extra: met at p95 for both models.

## Parity
- PyTorch `decode.generate_scored` vs s1.ts (`ml/edge/parity_ref.py --decode score` → `node ml/verify/parity.cjs --ref`):
  300 of 300 Sydney rows (150 per model) have identical tokens. `csLh`, `csLhMargin` and `nSearch` are equal too.
- `ml/verify/parity.cjs 200` (s1.ts vs `ml/verify/gen.py`, the verifier's generator):
  - 2m-swap-v1: 200/200 lines identical, 200/200 rows with every signal within tolerance (max |Δ| csLh 9.27e-05, csLhMargin 1.92e-05, nSearch 0).
    Trie mode matches the committed engine (tokens + confidence) on 200/200.
  - 2m-grpo-v1: 200/200 lines identical, 200/200 rows with every signal within tolerance (max |Δ| csLh 3.01e-05, csLhMargin 6.21e-06, nSearch 0).
    Trie mode matches the committed engine (tokens + confidence) on 200/200.

## Verifier refit
- Both gates refitted on the new decoder's signals.
  - 2m-grpo-v1: `ml/verify/refit.sh`. 2m-swap-v1: the same steps, with its generator pass run alongside.
  - Shipped gate: MLP + vetoes for both. Features: the old ones plus `cs_lh_margin` and `cs_lh`.
  - Hard negatives: not used (`HARDNEG=0`).
  - Thresholds: 2m-grpo-v1 send ≥ 0.9553, say again < 0.1533; 2m-swap-v1 send ≥ 0.9487, say again < 0.3928.
- **Bug fixed in `ml/verify/fit.py`.**
  - The trunk-head experiment reused `mu, sd`, so every exported MLP gate carried the 384 hidden-state means and
    deviations instead of its feature statistics.
  - `verifierScore()` in the browser used the first 28 of them: wrong standardisation. The numbers in RESULTS.md were
    computed in-process and were fine; the gate the game ran was not.
  - Fixed, and fit.py now asserts that the exported gate reproduces the fitted probabilities.
- Effect on the gate: `ml/s1/callsign_gate.py`, same transcripts, current rules parser, transcripts the rules cannot
  parse. Middle column: the greedy-trie decoder with a correctly exported gate fitted on its own signals
  (`ml/s1/gen_trie.sh`), which separates the bug fix from the decoder.

| model | set | rules failed | sent right / sent wrong: trie + gate as it ran | trie + fixed gate | **likelihood + refitted gate** |
|---|---|---:|---|---|---|
| 2m-swap-v1 | val | 1585 | 951 / 36 | 904 / 4 | **947 / 4** |
| 2m-swap-v1 | Sydney | 1629 | 963 / 97 | 904 / 9 | **963 / 10** |
| 2m-swap-v1 | real recognisers | 456 | 314 / 32 | 283 / 4 | **281 / 3** |
| 2m-swap-v1 | heavy noise | 1729 | 875 / 177 | 717 / 27 | **888 / 36** |
| 2m-grpo-v1 | val | 1585 | 972 / 40 | 838 / 3 | **939 / 6** |
| 2m-grpo-v1 | Sydney | 1629 | 969 / 132 | 844 / 4 | **969 / 10** |
| 2m-grpo-v1 | real recognisers | 456 | 334 / 29 | 275 / 1 | **324 / 4** |
| 2m-grpo-v1 | heavy noise | 1729 | 976 / 191 | 670 / 22 | **1019 / 39** |

- The bug fix removes most wrong sends, e.g. Sydney 97 → 9 (2m-swap-v1), but costs correct sends (963 → 904).
- The new decoder wins the correct sends back at the same error level: 904 → 963 with 9 → 10 wrong (2m-swap-v1),
  844 → 969 with 4 → 10 (2m-grpo-v1).
- Net against what ran before:
  - Validation and Sydney: about as many right commands sent, and 7–13× fewer wrong ones.
  - Real recognisers: fewer right commands sent (314 → 281 swap, 334 → 324 GRPO). The rest go to check or say again.
  - Heavy noise: more right commands, 5× fewer wrong.
  - Say-again goes up, as the gate is designed to do. It bounces ≤ 1.5% of correct proposals (2m-swap-v1: 4% under
    heavy noise; `say_again_bounced_correct` in `results/gate_*.json`).
- `ml/verify/RESULTS.md` and `public/reports/voice-verifier.html` were regenerated (`ml/verify/report.py`).
  `ml/verify/parity.cjs` 200/200 for both models (above).
- `ml/verify/test.sh`: 10/10 pass. `npx tsc --noEmit -p .` is clean.

## Files
- `ml/s1/callsign_scoring.py`: variants experiment.
- `ml/s1/callsign_e2e.py`: shipped decoder, end to end.
- `ml/s1/callsign_report.py`: tables.
- `ml/s1/callsign_example.py`: worked example.
- `ml/s1/callsign_latency.cjs`: node latency.
- `ml/s1/callsign_gate.py` + `ml/s1/gen_trie.sh`: the gate before and after, and the trie decoder with a fixed gate.
- `ml/s1/build_callsign_report.py`: the HTML report.
- `ml/s1/results/`.
- Decoder: `src/lib/voice/s1.ts` (`decodeScored`, `decodeTrie`) and `ml/s1/decode.py` (`callsign_search`,
  `generate_scored`).
- Verifier: `ml/verify/gen.py` (`--decode score|trie`, `--norm`), `fit.py` (features `cs_lh_margin`, `cs_lh`),
  `src/lib/voice/verify.ts` (`featureMap`), `ml/verify/parity.cjs` (trie vs committed engine, score vs PyTorch,
  `--ref`), `ml/edge/parity_ref.py` (`--decode`).
