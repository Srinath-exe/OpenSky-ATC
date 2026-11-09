# Real-voice gold set

Every voice number so far came from synthetic speech (espeak, Kokoro). The gold set is 100 fixed prompts that you
record once with your own voice. Each clip is then scored through several recognisers, the rules parser, and the
chain the game ships. Report: `/reports/voice-gold.html`.

## Record

1. Open `https://openatc.aeon-labs.site/voice/record.html#k=<key>` in Chrome or Edge. Get the key from
   `cat ml/data/gold/.key` on the server. These two browsers also run the browser recogniser (Web Speech) while you
   talk. It can't be run on a saved clip later, so its live transcript is saved with the clip. The page stores the key
   in localStorage and removes it from the URL.
2. Hold the button or Space, speak, and let go. The clip uploads straight away. You can play it back and re-record it
   (a new take replaces the old one). Use ← / → to move and Enter to go to the next unrecorded prompt. Tap mode
   (tap to start, tap to stop) is easier on a phone.
3. There are three kinds of prompt:
   - **Read** (60 from validation airports, 30 from Sydney, the airport the model never saw): read the sentence the
     way a controller would. It is the engine's own phrasing: FAA wording at US airports, ICAO elsewhere ("tree",
     "fife", "niner": say them as you naturally would).
   - **Own words** (10): only the intent is shown. Say it however you would on frequency.
   - **Say again** (3): the callsign is not on frequency, so the right result is "say again".
4. You can stop at any point and pick up later. The page asks the server what is already recorded. The order is
   interleaved, so any prefix of the set is still a fair mix.

Storage: `ml/data/gold/<id>.wav` (16 kHz mono 16-bit PCM) and `<id>.json` (prompt, browser transcript and
alternatives, mic settings, user agent, time). This folder is git-ignored. The API is
`src/app/api/voice/gold/route.ts`. It needs the key in the `x-gold-key` header, checks the WAV format, limits a clip to
1.5 MB and the set to 3000 clips, and names files from the prompt id. To turn recording off, delete `.key`.

## Score

```bash
ml/.venv/bin/python ml/stt/score_gold.py score          # CPU, 2 threads; first run downloads ~0.6 GB of models
ml/.venv/bin/python ml/stt/score_gold.py score --models whisper-small.en+prompt,moonshine-base   # other recognisers
```

- Recognisers: `whisper-base.en`, `whisper-base.en+prompt` (the callsigns on frequency as a text prompt, the same
  biasing as the GPU bake-off), `moonshine-tiny` (the model the game runs on-device), `moonshine-base`, plus the
  stored browser transcript. `text (perfect STT)` feeds the prompt text itself, which is the upper bound for the
  rules and the model.
- Chain: `ml/stt/gold_chain.ts`, which the scorer compiles to `.tmp/gold`, runs the game's own `understand()`
  (rules alone) and `understandVoice()` (rules, else the int8 S1 model `public/models/s1/2m-swap-v1`, with callsign
  fusion and the confidence gate) in node.
- Metrics:
  - WER, with numbers in one form on both sides; scripted prompts only.
  - Callsign accuracy.
  - Exact command: same parsed AST as the prompt's command.
  - What the game would do: sent right, sent wrong, left to check, say again.
  - Model alone.
  - The same numbers split by validation, Sydney and own words.
  - Every miss.
- Output:
  - `ml/data/gold/scores/scores.json` and `scores.md`.
  - `transcripts.json`, a cache, so re-runs only transcribe new or re-recorded clips.
  - `public/reports/voice-gold.html`, rebuilt from these. `python3 ml/report/build_gold.py` rebuilds the page on
    its own.

Run time is mostly Whisper, which pads every clip to a 30 s window. On an idle box, 100 clips take about 10 min. The
30-clip dry run took about 25 min with the box at load average 27 from other jobs, at 7 to 30 s per clip.

`score_gold.py ceiling` runs the chain on the prompt text itself, a perfect recogniser. That is the most the set can
score. A clip that misses here is a rules/model issue, not a speech one.

## Dry run

```bash
ml/.venv/bin/python ml/stt/score_gold.py dryrun --n 30
```

This takes Kokoro clips from the GPU bake-off (`ml/gpu/results/stt`) and POSTs them through the real route handler
into a temp gold dir. It then scores that dir like a real recording session and writes to `ml/stt/out/gold-dry/`.
API tests: `tests/engine/voice-gold.test.ts` (node:test; run it with `scripts/test-sim.sh tests/engine` or compile it
on its own).
