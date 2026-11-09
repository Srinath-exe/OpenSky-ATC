# GRPO on the 2 M voice model, with the game engine as the reward

Report: `public/reports/voice-rl.html` (built by `ml/rl/report.py`). Everything here is CPU-only, 1 thread per run.

## Question

Does reinforcement learning (GRPO) with rewards computed by the game's own parser make the 2 M S1 model
(`ml/gpu/results/s1-2m-11ap-swap`) better, especially at the unseen airport (Sydney) and on real speech-recogniser
transcripts? And is any gain from RL, or just from more training on hard cases (the SFT control)?

## Setup

| piece | file | what it does |
|---|---|---|
| engine | `reward_server.ts` → `build.sh` → `.build/` | long-lived node process, JSON lines; `parseCommand` with the aircraft list from the state text, plus `phraseology.transmission` (the command rendered back to speech). ~7,000 parses/s, memoised |
| eval sets | `common.py: eval_sets` | val n=1000 and Sydney n=1000 picked exactly as `ml/s1/train.py` does (reproduces the checkpoint's eval.json: 94.2 / 86.8); real STT n=1000 = 5 recognisers × 200 clips from `ml/gpu/results/stt`. Constrained greedy decoding (production decoder). Fixed for every run |
| hard prompts | `mine.py`, `noise.py` | 24,000 random **train** rows + a noisy copy of each (STT-style edits: split digit runs, "9 or" for niner, homophones, misspelt words, split airline names, dropped/repeated words). Teacher-forced pass; hard = smallest gold-token margin < 2 logits. Never val / Sydney / STT |
| GRPO | `grpo.py` | k=8 samples per prompt at T=1, 16 prompts per step, group-normalised advantages `(r-mean)/(std+0.05)`, PPO clip 0.2, 2 passes per batch, KL to the frozen start model (k3 estimator, β=0.04), AdamW lr 3e-5, grad clip 1. Prompt KV cache shared by the group (prefill once, broadcast) |
| rewards | `rewards.py` | **exact** (1/0 vs label) · **shaped** (AST: 0.1 parses + 0.4 aircraft + 0.2 kind + 0.3 values) · **verifier** (no label: parses + callsign heard in the transcript + F1 of the engine's spoken rendering vs the transcript) |
| control | `sft.py` | same pool, same CPU budget, loss-masked cross-entropy with the labels, lr 2e-4 warmup + cosine to the budget |
| eval | `evalrun.py` | full fixed eval with per-row predictions (for paired fixed/broken counts and McNemar tests) |
| verifier check | `vcheck.py` | how well the label-free reward agrees with labels |

Callsign trie ON during sampling and in every log-prob (policy, old policy, reference): the deployed decoder always
masks aircraft that are not on frequency, so the constrained policy is the one worth training; with it off a share of
every group is wasted on impossible aircraft that the trie already removes for free.

## Results (fixed eval sets, constrained greedy, exact / callsign %, paired vs start: +fixed −broken, exact McNemar)

| run | val n=1000 | Sydney n=1000 (unseen) | real STT n=1000 | train CPU-min |
|---|---|---|---|---|
| Start model | 94.2 / 95.6 | 86.8 / 91.9 | 79.6 / 88.5 | — |
| GRPO · exact | **95.5** / 97.0 (+24 −11, p=0.04) | 86.3 / 91.4 (+8 −13, p=0.38) | **83.8** / 92.3 (+53 −11, p<0.001) | 20 |
| GRPO · shaped | 95.0 / 96.6 (+19 −11, p=0.20) | 86.2 / 91.3 (+9 −15, p=0.31) | 83.4 / 92.2 (+51 −13, p<0.001) | 20 |
| GRPO · verifier (no labels) | 94.9 / 96.7 (+17 −10, p=0.25) | 87.1 / 92.2 (+10 −7, p=0.63) | 83.4 / 91.8 (+49 −11, p<0.001) | 20 |
| SFT control | 94.6 / 96.1 (+15 −11, p=0.56) | 86.3 / 91.5 (+12 −17, p=0.46) | 82.0 / 89.8 (+33 −9, p<0.001) | 20 |

GRPO vs the SFT control, same rows: real STT exact 33 vs 15 (p=0.013), shaped 31 vs 17 (p=0.06), verifier 30 vs 16
(p=0.05); val 14 vs 5 (p=0.06) for exact; Sydney no difference for any variant. One seed per run.

Unseen hard train prompts (last 500 of the pool order, never sampled by any GRPO run; 80% noisy): greedy exact
51.2 → 72.0 (exact) / 72.2 (shaped) / 69.6 (verifier). SFT 74.6, but it trained on these rows.

Where the gain came from: wrong-aircraft errors on real STT 74 → 44 / 45 / 46; instruction errors 89 → 85 / 88 / 84
(SFT the other way round: 60 wrong aircraft, 78 wrong instructions); per
recogniser every one improves (e.g. Moonshine medium 82.0 → 87.0, Whisper base 78.0 → 81.0 with GRPO-exact).

Sydney did not move: its errors are unseen fix names ("direct ssyno" → DIRECT HNNO) and flight-number-only callsigns of
airlines rare in training. The hard pool (11 training airports) does not contain that failure mode, and RL can only
reinforce answers the policy already samples.

## Training dynamics (first 30 steps → last 30 steps)

| | exact | shaped | verifier |
|---|---|---|---|
| sample exact on hard prompts (T=1) | 0.48 → 0.64 | 0.48 → 0.65 | 0.48 → 0.64 |
| KL to reference (nats/token, k3) | 0.013 → 0.113 | 0.011 → 0.083 | 0.013 → 0.097 |
| sampling entropy | 0.13 → 0.09 | 0.13 → 0.08 | 0.13 → 0.08 |
| completion length (tokens) | 10.3 → 10.5 | 10.3 → 10.5 | 10.3 → 10.3 |
| groups with signal (of 16) | 7.2 → 5.5 | 9.3 → 6.9 | 8.6 → 6.3 |
| SAY AGAIN rate in samples | 2.8% → 1.0% | 2.5% → 0.6% | 2.5% → 0.9% |

## Reward hacking

- The rewards leak, from step one. Shaped: 38% of logged samples are wrong yet score ≥ 0.6 (right instruction to the
  wrong aircraft = 0.6; "TAXI STAND X3" for "TAXI RWY 28" = 0.875). Verifier: 16% (doubled taxiway "VIA F5 G G" = 0.98;
  "DIRECT SINNO" for "proceed direct" with no fix said = 0.87; "EXPEDITE CLIMB" for "expedite descend" = 1.0 because
  climb/descend are ignored, the rendering has no aircraft state).
- The policy did not grow into them in 20 CPU-min: wrong-but-high share flat (shaped 40% → 36%, verifier 15.5% → 17%,
  first vs second half), length flat, no collapse to short or common commands, SAY AGAIN rate fell.
- Side effect worth watching: shaped made SAY AGAIN rarer where it is needed (Sydney missed SAY AGAIN 3 → 11, the
  dangerous direction: a command then goes to an aircraft nobody called).
- Verifier vs labels (`vcheck.py`): gold beats another real command for the same state 96.8% of the time (n=3000);
  AUC on the start model's predictions 0.91 val / 0.89 Sydney / 0.91 STT; 47 of 132 wrong Sydney predictions still
  score ≥ 0.8 (unseen fix names are one token of the F1).

## Throughput and cost

- GRPO: 16 prompts × 8 samples per step ≈ 4.2 CPU-s (1 thread, shared host at load 10–25). 259–288 steps,
  4,144–4,608 prompts, 33–37k samples per 20 CPU-min run, ≈ 30 samples/CPU-s. Engine: 1.7–1.9 CPU-s per run (0.15%).
- SFT control: 339 steps × 32 = 10,848 examples in the same 20 CPU-min (≈ 1 epoch of the pool; GRPO saw 43% of it).
- Eval: ~0.05–0.08 CPU-s per row.
- Total spent ≈ 3.1 CPU-h: mining 45 (2 threads under contention; ~20 at 1 thread), 3 × GRPO ≈ 78 incl. in-training
  evals, SFT 22, full evals 16, baseline/checks 10, a discarded first launch 14 (in-training eval used all 1,000 STT rows).
- CPU is the bottleneck. On an L4 (~$1/h), batched rollouts (16 × 8 = 128 rows in one decode) and a tiny update
  should make a step ~0.1 s: this whole 20-minute run in ~30 s, an epoch of the pool in ~1 min, cents per run.

## Export

Not exported to `public/models/s1/2m-grpo-v1`: the criterion was "improves Sydney without hurting val", and Sydney is
flat. The candidate (GRPO-exact: +4.2 STT, +1.3 val) was exported to `ml/rl/runs/export-check-grpo-exact/` (gitignored)
to check the int8 path: fp32 96.33% = int8 96.33% exact on 300 val rows. To publish, if the lead wants it:

    python3 ml/edge/export_web.py --run ml/rl/runs/grpo-exact --name s1/2m-grpo-v1 --int8 --check 300 --data ml/data/out4/ds/val.jsonl

The policy is sharper (entropy 0.13 → 0.08): re-check the confidence gate before switching `S1_MODEL_URL`.

## Next

1. Sydney-style hard prompts: rename fixes and airlines consistently in state, transcript and label so unseen names
   appear in training; then RL has correct copies to reinforce.
2. Close the verifier holes before unlabelled speech: render with the aircraft's state (climb vs descend), match fix
   names by spelling, weigh tokens the speaker never said more.
3. 2–3 seeds of GRPO-exact and SFT; then SFT → GRPO in sequence.
4. GPU: batched rollouts, a full epoch, k = 16, the 11 M model.

## Reproduce

    ml/rl/build.sh
    python3 ml/rl/evalrun.py --out ml/rl/runs/baseline/eval_full.json
    python3 ml/rl/mine.py --n 24000 --threads 1
    BUDGET=1200 ml/rl/run_all.sh
    python3 ml/rl/vcheck.py; python3 ml/rl/heldout_hard.py
    python3 ml/rl/report.py     # -> public/reports/voice-rl.html
