# The overnight run: the command model learns free wording

Status: results, night of 11 to 12 November 2026. Everything ran on the game server's CPU: no GPU, nothing paid. Scripts in `ml/data/plain.py`, `ml/rl/sft.py`, `ml/s1/freeword/`, `ml/tts/roundtrip.py`.

## What is live now

| part | before tonight | now |
|---|---|---|
| command model | `2m-grpo-v1` (trained on the game's own phrasing) | **`2m-free-v1`** (fine-tuned on everyday wording and hard cases), with its own refitted safety gate; the old model is kept for instant rollback |
| text clean-up and rules | | corrections, cut-off values, everyday words, courtesy phrases, three-part taxiway names, "give way then continue" (below) |
| speech recognition | the fine-tuned Parakeet 110M (since yesterday) | unchanged |
| pilot voice | Paradee-8M | unchanged: tested, no training needed (below) |

## The result

Each test set goes through the game's real chain (clean-up, rules, the command model, the safety gate), each model with its own gate. "Wrong" means a command was sent that is not what the controller meant; a held command is shown to the player to confirm and never executes by itself.

| test set | what it is | old model: sent right / sent wrong | **new model: sent right / sent wrong** |
|---|---|---|---|
| independent exam | 60 commands in everyday wording, written by a separate author who never saw the training data | 40 / 3 | **51 / 2** |
| stress exam | 86 commands + 34 non-commands in 12 hard categories, separate author | 80 / 4 | **81 / 3** |
| casual speech, end to end | the exam lines spoken by four voices, heard by the game's speech model, then read | 161 / 12 (of 208) | **178 / 10** |
| held-out wording | 62 commands | 44 / 3 | **51 / 2** |
| first wording set | 190 commands | 180 / 4 | **181 / 4** |
| speech-model transcripts, standard phrasing | 164 commands | 155 / 6 | **155 / 5** |
| the owner's 16 recordings | | 15 / 0 | **15 / 0** |
| non-commands not sent | small talk, questions, cut-offs and wrong callsigns across the sets | 108 of 115 | **108 of 115** |

Standard phrasing on the training format's own checks (200 lines each): 94.5 % / 86.5 % (unseen airport) / 79 % (recogniser text) before, 94.0 % / 88.0 % / 79 % after: unchanged within noise.

The rule: a model ships only if it sends right more often and sends wrong **no more often on any set**. The new model passes on every set. In the browser it loads in 0.24 s and answers in 110 to 170 ms, the same as before (same 2-million-parameter size).

## How it was trained

1. **Data.** `ml/data/plain.py` takes 26,000 real game situations and says each instruction the way a controller talks when not reading the book: 10 to 20 phrasings per command kind ("come down to", "give me two one zero knots", "switch to tower", "copy that", "hang on"), values copied from the game so every label is exact, plus small talk labelled "do nothing". Round 2 adds hard cases: two or three instructions in one breath, corrections ("four thousand, correction, five thousand"), flight number only, questions, "do not ..." and cut-off transmissions. Every label is checked by the game's own parser before it is used.
2. **Training.** Fine-tuning from the shipped model, mixing the new data with 50,000 to 60,000 rows of the original data so standard phrasing is not forgotten. Round 1 (everyday wording), then round 2 from round 1's best checkpoint (hard cases). About 4 hours of CPU in total.
3. **Choosing.** Every saved checkpoint was scored automatically against the shipped model (`ml/s1/freeword/watch.py`). Round 2 step 2000 and the final step 3700 both passed; with their own gates they send wrong equally rarely and step 2000 sends right more often, so step 2000 shipped.
4. **The safety gate** (the verifier that decides send / ask the player / say again) was refitted for the new model (`ml/verify/refit.sh`, one hour of CPU). Browser engine and training framework agree on all 200 parity checks.

## Bugs found and fixed on the way

The tests found mistakes in the rules, not only in the model; all fixed with tests:

| the controller said | the game did | now |
|---|---|---|
| "four thousand, correction, five thousand" | gave up | 5,000 |
| "fly heading two" (cut off) | sent heading 002 | asks again |
| "... four thousand, cheers mate" | heard "cheers" as "cross" | 4,000 |
| "... do you copy" | broke the sentence | ignored |
| "via zulu nine alpha" | taxiways Z9 then A | Z9A |
| "give way to the Qatari, then continue" | give way **and** continue at once | one give-way |

The rule fixes alone took wrong sends on the stress exam from 8 to 4 and on recogniser transcripts from 13 to 6, before the new model.

## Honest notes

- The two exams were written by separate authors, but I used the stress exam's results by category (corrections, questions, cut-offs) to decide which rules to fix, using my own example sentences, never its lines. The independent exam was only scored.
- The stress exam counts "say your heading" as "do nothing"; the game has a real "report heading" request, so I count that answer as acceptable.
- All speech in these tests is synthetic (four neural voices). Real players will find wordings and accents nothing here covers; the opt-in logging idea (spec 12, flywheel) is how that gets fixed.
- About 1 in 20 everyday-wording commands is still sent wrong (2 of 60 on the independent exam, 10 of 208 end to end). Most are near misses; some are not. That is the main open problem, and more data of the same kind gives less and less: the rest needs real players' speech.

## The owner's questions

**Should we train the pilot voice (text to speech) for aviation lingo?** No. Test (`ml/tts/roundtrip.py`): 240 lingo-heavy pilot lines (callsigns, flight levels, headings, runways, frequencies, QNH, ICAO "tree / fife / niner") spoken by the game's pilot voice and by a ten times larger reference voice, then transcribed: 0.06 % word error for the game voice, and no word the game voice says worse than the reference. Caveat: the speech model learned from these voices, so its ears are friendly; the owner's ear is the final check.

**Should we train the speech model again (GPU)?** Not needed. On casual speech its word error is 2.8 % (0.8 % on standard phrasing), mostly dropped fillers ("uh", "okay") and "stand by" written as "standby". End to end it costs 3 commands in 208 compared with perfect transcripts. A third round on casual audio would cost about 3 US dollars of GPU and gain about that much.

**Does the command model need a GPU or a bigger size?** No. The earlier size sweep (2, 11 and 26 million parameters) moved accuracy by about 2 points; better data moved it by 37 points (unseen airport, 50 % to 87 %). Tonight's gains came from data, on a CPU.

So there is no GPU job to run in the morning. If the owner still wants one, the most useful would be the speech-model round on casual audio (about 3 US dollars), or nothing.

## Safety overnight

`scripts/ops/overnight_guard.sh` ran as the systemd unit `atc-guard`: free disk checked every minute (cleanup below 6 GB, ML jobs stopped below 3 GB), the site checked every minute and restarted after three failures. Disk stayed at 20 to 21 GB free; the site never failed a check. Stop it with `systemctl stop atc-guard`.

## Rollback

`src/lib/voice/l1.ts`: set `S1_MODEL_URL` back to `/models/s1/2m-grpo-v1` and deploy. Both models and both gates are on the server.
