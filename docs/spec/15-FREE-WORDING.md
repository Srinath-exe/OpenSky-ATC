# Free wording: how well the game understands a controller who does not read the book

Status: results, 11 November 2026. Test sets and scorer in `ml/s1/freeword`. No GPU and no cost: everything here ran on the game server.

## Why this was measured

Every earlier number came from standard phraseology. The owner's 16 recordings are read from a prompt, so the rules handle 15 of them and the command model has almost nothing to do. Nobody had measured what happens when a controller says "come down to seven thousand" or "go to tower". That is the job the command model exists for.

## The test

270 transmissions written as the speech models write them, each in a real game situation (the 100 gold prompts' airports and traffic), with the command it must produce:

| set | lines | what it is |
|---|---|---|
| first set | 203 | own words, clipped or reordered, other phraseology standards, several commands at once, and 12 lines that are not commands |
| held-out set | 67 | written after the fixes below, with wordings not looked at while fixing; this is the number to trust |

Each line goes through the game's own chain: text clean-up, rules, the command model, the confidence gate.

## What it found first: dangerous misreadings in the rules

Before any fix, 76 % of the first set was sent right and **8 % was sent wrong**. Most wrong ones came from the rules, not the model:

| the controller said | the game sent |
|---|---|
| "go up to flight level eight zero" | Go around |
| "go to tower on one one eight decimal five" | Go around |
| "expedite your descent" | Expedite climb |
| "abort the landing, go around" | Cancel takeoff |
| "stand romeo fifteen via foxtrot two" | Standby |

All five are fixed in the parser (`src/lib/sim/commands.ts`) with regression tests: "go" is a go-around only with "around"; "stand" is "standby" only with "by"; "abort the landing" is a go-around; "expedite" understands "your descent" and "down", and with no direction follows the flight (an arrival is descending).

## A plain-language layer

`asr-repair.ts` now rewrites about 40 everyday phrasings into the standard phrase before the rules see them ("come down to" = descend, "slow to" = reduce speed, "switch to tower" = contact tower, "copy that" = roger, "hang on" = standby, "you can cross" = cross). Values are never touched.

## Results

| | sent right | held for the player, right command | sent wrong | not understood |
|---|---|---|---|---|
| first set, before (191 commands) | 76 % | 2 % | 8.4 % | 13 % |
| first set, after | **94 %** | 1 % | 2.6 % | 2 % |
| **held-out set (62 commands)** | **69 %** | 6 % | 6.5 % | 18 % |

- All 17 non-command lines ("how's the ride at your level", "are you ready to push") were refused in both sets; nothing was sent.
- Of the wrong sends that remain, most are harmless (the same command with a different free-text remark). The real ones: a model output that kept only half of a two-part instruction, and "expect two seven left ILS" read as an expectation plus an approach clearance (fixed afterwards because it is a safety bug; the held-out figures above are as first measured).
- Several commands in one transmission work when said in standard order (11 of 11). A twelfth, deliberately confusing line should have been refused and was sent as half an instruction.

## What the numbers mean

The gap between 94 % and 69 % is the lesson. A hand-written phrase table fixes what its author thought of and little else: the held-out set uses wordings like "give me one nine zero knots", "take up heading zero six five", "it'll be the ILS two seven left", and the table has none of them. This is the measured case for training the command model on free wording (spec 12): a model learns the pattern, a table only the examples.

Today's command model was trained on the game's own phrasing. On the held-out commands it reads 66 % right by itself (the rules alone, without the plain-language layer, 39 %), and when it is wrong it is confidently wrong ("got it" becomes "Direct BOSSO"), which is why the gate holds most of its answers for the player to check.

## Also done today

- The game server now runs the small fine-tuned speech model (Parakeet 110M): the owner's recordings 0.6 % word error (large model 1.7 %), about 0.25 s per transmission on the server (large model 0.5 to 0.9 s). Through the full chain the recordings give the same result as before: 15 of 16 sent right, none wrong. Going back is one file (`/etc/systemd/system/openatc.service.d/stt-model.conf`).
- The phone app's default is the same fine-tuned model (131 MB download, no live text while speaking, far more accurate). APK: `/downloads/openatc-stt-atc.apk`.
- The fine-tuned browser model (Moonshine) is not shipped: 27.7 % word error on the owner's real voice.

## What is left for launch on the voice side

1. **Train the command model on free wording** (spec 12, reduced): about 150 hand-written paraphrase templates per command kind expanded with real callsigns and numbers, real speech-model transcripts, non-commands and multi-command lines; the held-out set above is the exam. Needs a GPU for about 3 to 4 hours, roughly 3 to 5 US dollars. **Not started: it costs money and waits for the owner's yes.**
2. The same small speech model in the browser (one model for web and phone). Engineering only.
3. "Speedbird nine three two, roger" heard as "nine nine three two": the one recording still missed.
4. Merge the `voice-ai` branch into `main`.
