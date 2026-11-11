# System 1, version 2: the plan to make the command model the best it can be

Status: plan, 11 November 2026. Owner decisions are listed at the end. Builds on spec 11 (voice model), `ml/s1`,
`ml/rl` (GRPO), `ml/verify` (gate), `ml/s1/CALLSIGN_SCORING.md` and the speech-to-text work of 9–11 November
(`public/reports/voice-stt-finetune.html`).

## 1. Where we are

The voice chain after speech-to-text:

| step | what | size | speed | job |
|---|---|---|---|---|
| text cleanup | `asr-repair.ts` rules | – | < 1 ms | fixes recogniser slips |
| rules (L0) | the game's grammar | – | ~10 ms | reads the standard phrasing; 15 of the owner's 16 recordings |
| **System 1 (L1)** | our transformer (`2m-grpo-v1`), constrained decoding + callsign likelihood search | 2 M parameters | 0.1–0.3 s in the browser | what the rules cannot read |
| verifier | 481-weight MLP + veto rules | – | 0.2 ms | send / let the player check / say again |

System 1 today, exact command (n = 1,000 each): game phrasing 97.9 %, unseen airport (Sydney) 94.0 %, old-recogniser
transcripts 87.1 %; callsign ≥ 99.4 %.

What is wrong with it now:

1. **It learned the wrong noise.** Its inputs imitate Google's and Whisper's slips ("climb one ate thousand"). The fine-tuned
   speech models write clean lower-case spoken words and make different, rarer mistakes. Nobody has measured System 1 on
   them.
2. **It only knows the game's phrasing.** The job left for it is everything the rules miss, and that is the player's own
   words: "hand him off to tower", "give him direct Biggin", "keep him coming down to five thousand". Its training data
   has little of that.
3. **It is rigid.** About 33 command kinds; anything else becomes "say again". It cannot say "I don't know, ask the big
   model", cannot give two commands at once, cannot handle a correction mid-sentence.
4. **The verifier was fitted to the old model.**

## 2. The goal

System 1 v2 is the fast path for everything a controller says to an aircraft that the game can act on, in any reasonable
wording, from any of the three speech models, at any airport, and it knows when to hand off:

- output: one or more command lines, or `SAY AGAIN` (not on frequency, unintelligible), or **`ASK`** (understood as
  speech but not a command it can map: a question, a request, chit-chat) which goes to the conversation layer (§7);
- never sends a wrong command when it could have abstained;
- small enough for the phone's web view and the browser.

Targets (fixed eval suite, §6):

| metric | today | v2 target |
|---|---|---|
| exact, game phrasing (val) | 97.9 % | ≥ 98.5 % |
| exact, unseen airports | 94.0 % | ≥ 97 % |
| exact, new speech models' transcripts | not measured | ≥ 97 % |
| exact, own-words paraphrases (unseen styles) | not measured (low) | ≥ 90 % |
| multi-command transmissions, all commands right | 0 % (not supported) | ≥ 90 % |
| non-commands correctly sent to `ASK` / `SAY AGAIN` | not measured | ≥ 95 % |
| **sent wrong** (all sets) | 0–1.9 % | **≤ 0.5 %** |
| latency p95, phone web view | ~0.3 s | ≤ 0.2 s |

## 3. The data engine (the biggest lever)

Every training row is `(game state, transcript) → command line(s) | SAY AGAIN | ASK`, and every label is checked by the
game's own parser. Six sources, each with a quota so no kind of command or wording is rare:

**3.1 Real speech-model transcripts.** The 133 hours of training audio are already spoken lines with known text. Run all
three fine-tuned speech models (server Parakeet, phone Parakeet 110M, browser Moonshine) over them, plus the untuned ones
for robustness. The label is the game parser's reading of the *clean* text; the input is what the recogniser wrote.
About 64,000 clips × 3–5 recognisers ≈ 250,000 real-noise rows. GPU, about 1 hour.

**3.2 A noise model learned from those transcripts.** Align recogniser output with the truth and count the edits per
word (substitutions such as "Cathay → city", dropped "one", split numbers). Sample from those edit statistics to add
realistic noise to the millions of text-only rows from the exporter. This replaces the hand-written noise of round 1.

**3.3 Paraphrases, own words.** For every command kind, generate many wordings a controller might use: casual, terse,
out of order, with fillers ("uh"), corrections ("heading two seven zero, correction, two eight zero"), partial callsigns,
other countries' styles (FAA, ICAO, UK), plain-language ("bring him down to five thousand"). Generator: a strong LLM
(teacher), prompted per kind with the game's command definition and 20 hand-written seeds. Every paraphrase is
round-trip checked: a second pass of the teacher plus the game parser must agree on the command; disagreements are
dropped. Target 200,000 paraphrases, with 10 % of the styles held out for testing.

**3.4 Multi-command transmissions.** "Speedbird 327, descend flight level 80, reduce speed 250, turn left heading 270":
composed from compatible commands, labelled as several lines. 30,000 rows.

**3.5 Negatives.** Callsign not on frequency → `SAY AGAIN`; questions, requests, chit-chat, half-sentences, other
frequencies' traffic → `ASK` or `SAY AGAIN`. 40,000 rows. These teach it to abstain instead of guessing.

**3.6 Real players (the flywheel, once live).** With opt-in, every voice transmission logs the transcript, the game
state and what was finally sent (including the player's edits when the command was held for a check). Weekly, the rows
where the chain failed or the player corrected it go into training and the eval set. This is the only source of truly
new wordings.

Coverage is enforced, not hoped for: a table of command kind × airport × position × wording style × recogniser,
with a minimum count per cell, and unseen airports (Sydney plus one more) kept out of training entirely.

## 4. The model

- **Size sweep** with the latency budget as the hard limit: 2 M (today), 11 M, 26 M, and a 50 M probe. The earlier sweep
  showed accuracy rising with size; the phone now runs a 110 M speech model, so a 10–30 M System 1 is affordable.
  Pick the smallest that meets the targets at ≤ 0.2 s p95 in the phone web view.
- **Tokenizer**: refit `ml/tokenizer/atc.json` on the new transcript style (lower-case spoken words, digit words),
  keeping digits and callsign pieces as atomic tokens.
- **Inputs**: game state (as now) + transcript + the recogniser's 2–3 alternative transcripts when it gives them,
  marked as such, so the model can vote across them.
- **Outputs**: one or more command lines, `SAY AGAIN` or `ASK`; decoding stays constrained by the callsign trie and
  the command grammar (nothing unparseable can come out), with callsign likelihood search.

## 5. Training recipe

| stage | what | why | compute |
|---|---|---|---|
| A. pre-train | next-token training on millions of exporter rows with learned noise (§3.2), clean → noisy curriculum | the language of ATC and the game state format | GPU 1–2 h (26 M) |
| B. supervised fine-tune | real transcripts (§3.1), paraphrases (§3.3), multi-command (§3.4), negatives (§3.5), mixed by quota | the actual job | GPU < 1 h |
| C. distillation | a teacher (fine-tuned Kev-0.8B, 100/100 on the bake-off) labels hard and ambiguous rows with soft targets; the student learns its full distribution, not only the top answer | the teacher's judgement on the long tail | GPU 1 h (teacher inference) |
| D. GRPO | reinforcement learning with the game engine as the reward, as in `ml/rl` (which beat plain fine-tuning on real transcripts, p = 0.013), with an **asymmetric** reward: right +1, abstain 0, wrong −2 | teaches it that a wrong command is worse than asking | CPU/GPU 1 h |
| E. calibration | temperature fit, verifier refit (`ml/verify/refit.sh`), abstention thresholds per command kind | the confidence it reports means what it says | CPU minutes |
| F. ship | int8, the TS engine `s1.ts` + worker, parity tests (node vs browser), rollback model kept | same as today's pipeline | CPU |

Every stage is compared with the stage before on the fixed suite; a stage that does not pay is dropped.

## 6. Evaluation suite (fixed, versioned, run on every candidate)

1. val (game phrasing), n = 1,000; 2. unseen airports, n = 1,000 each; 3. each speech model's transcripts of held-out
audio, n = 1,000 each; 4. the owner's recordings through each speech model; 5. held-out paraphrase styles, n = 2,000;
6. multi-command, n = 500; 7. negatives, n = 1,000; 8. latency in node, headless Chromium and the phone engine.

Reported per set: exact, sent wrong, abstained (right and wrong abstentions), callsign, p50/p95 latency; paired
comparisons with McNemar tests, as `ml/rl` does. A candidate ships only if **sent wrong does not rise on any set**.

## 7. The conversation layer (System 2), and how System 1 hands over

System 1 v2 says `ASK` when the speech is clear but is not a command it can map. That transcript, with the game state,
goes to a language model, which may answer with a command line (checked by the game's parser before it is sent), several
commands, or a reply the pilot speaks ("unable visual, we'll take the ILS", "say again your request?"). Standard commands
stay on the fast path; only unusual transmissions pay the 1–2 s. Every `ASK` is logged and becomes System 1 training data
(§3.6), so the fast path keeps growing. The game also needs a few facts for pilots to answer sensibly (fuel, intentions,
"unable" reasons). Specified separately in spec 07.

## 8. Phases

| phase | work | GPU | result |
|---|---|---|---|
| 1. Measure | today's System 1 on the three new speech models' transcripts and on the owner's free wording | 1 h (transcribe held-out audio) | the real baseline |
| 2. Data engine | §3.1–3.5: transcripts, noise model, paraphrases, multi-command, negatives, coverage table | 1 h | ~1 M labelled rows |
| 3. Train | §5 A–E for 2 M, 11 M, 26 M | 3–4 h | three candidates |
| 4. Choose and ship | eval suite, latency on phone and browser, verifier refit, deploy, rollback kept | – | System 1 v2 live |
| 5. Conversation layer | `ASK` → language model → command or pilot reply | – | the game stops being rigid |
| 6. Flywheel | opt-in logging, weekly retrain | ~$2 a week | keeps improving |

## 9. Cost

GPU about 6–8 hours in total, about $3–10 on spot instances or $8–15 on demand. The paraphrase teacher is the open
choice: a commercial LLM API costs about $10–40 for 200,000 checked paraphrases; our own Kev-0.8B costs GPU time instead
(about 1–2 hours) and gives less varied wording.

## 10. Risks

- Synthetic wordings can still miss how real controllers talk: the flywheel (§3.6) and the owner's own-words recordings
  are the check.
- A bigger model may not fit the phone's latency budget: the 2 M model stays as the fallback.
- A teacher can hallucinate commands: every label is checked by the game's parser and a second pass.
- `ASK` can be over-used, making the game slower: its rate is a tracked metric with a ceiling.
- Licences: Kev-0.8B's licence must allow distillation into a model we ship; check before stage C.

## 11. Decisions for the owner

1. The paraphrase teacher: commercial LLM API (best variety, ~$10–40) or our own Kev-0.8B (GPU time).
2. GPU budget for phases 1–3: about $10–15.
3. Opt-in logging of players' voice transmissions (needed for the flywheel; needs a consent line and a privacy note).
4. The conversation layer's model: cloud API per call, or our own model on a GPU server.
