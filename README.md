# OpenATC

An air traffic control game you can play by voice: you are SFO's ground, tower or approach controller, you key the mic
and talk, the pilots answer and fly what you said. Live at https://openatc.aeon-labs.site (launch airport: KSFO; eleven
more reachable with `/play?icao=`).

Everything that understands or speaks runs on small models built for this game: on the server CPU, in the browser and on
the phone. No large language model, no GPU at run time.

## How a transmission flows

```
mic ─▶ speech to text ─▶ clean-up rules ─▶ command parser ─┬─▶ safety gate ─▶ send / ask to confirm / "say again"
         Parakeet 110M     asr-repair.ts     commands.ts     └─ if the rules fail: command model S1 (2M, in the browser)
                                                                                         │
pilot readback ◀── pilot voice (Paradee 8M, in the browser) ◀── phraseology.ts ◀── game engine
```

The model only ever writes a typed command line (`UAL214 C 5000`), which the game's own parser turns into a command;
it never touches game state. Readbacks are deterministic.

## Models (state at close, 2026-11-12)

| Model | Where it runs | Live file / config | Benchmark |
|---|---|---|---|
| Speech to text: Parakeet TDT 110M, fine-tuned on ATC speech | server (sherpa-onnx, CPU, ~0.2 s), phone app | `/etc/systemd/system/openatc.service.d/stt-model.conf`, `public/models/stt/parakeet-110m-atc-v1` | owner's recordings 0.6 % WER, standard phrasing 0.8 %, casual speech 2.8 % |
| Command model S1 `2m-free-v1` (2M-param transformer, int8) | browser worker, 0.1–0.2 s | `S1_MODEL_URL` in `src/lib/voice/l1.ts` | independent exam 51/60 right, 2 wrong; voiced end to end 178/208 right, 10 wrong; standard phrasing 94 % |
| Safety gate (verifier), one per command model | browser, < 1 ms | `src/lib/voice/verify-model.ts`, `public/models/verifier/roundtrip-v1` | non-commands not sent 108/115 |
| Pilot voice Paradee-8M v1.2 + ATC lexicon | browser | `public/models/tts/` | 0.06 % word error read back on 240 lingo-heavy lines |
| Whole chain on the owner's 16 recordings | | | 15 right, 1 missed, **0 wrong** |

Fallbacks: Whisper base.en on the server when Parakeet's text is not understood; the browser's Web Speech.
Rollbacks kept on disk: command models `2m-grpo-v1`, `2m-swap-v1`; the large Parakeet (remove the drop-in above,
`systemctl daemon-reload && systemctl restart openatc`).

Experiments that were run and not shipped (fine-tuned Kev-0.8B and LFM2.5-230M, GRPO, a masked diffusion LM, a
fine-tuned Moonshine, a model-size sweep): see `/reports/ai-paths.html`. Total GPU spend for the whole project: about $8.

## Run, test, deploy

```bash
npm install
npm run dev                         # http://localhost:3000
npm run typecheck
bash scripts/test-sim.sh tests/commands tests/engine tests/systems tests/tutor   # headless (node:test, no vitest)
npm run test:e2e                    # Playwright
bash scripts/deploy.sh              # build, copy static + public into .next/standalone, restart the openatc service
```

`deploy.sh` replaces the live build: only one deploy at a time, and a failed build takes the site down until the next
good one.

Scoring the voice chain:

```bash
bash ml/s1/freeword/allsets.sh public/models/s1/2m-free-v1    # every exam through the game's real chain
OPENATC_STT_URL=http://127.0.0.1:3005/api/voice/stt python3 ml/stt/score_gold.py score --models server-parakeet
```

## Where things are

| Path | What |
|---|---|
| `src/lib/sim/` | the game engine: aircraft, commands, phraseology, the pilot brain (ledger, pilotmind, persona) |
| `src/lib/voice/` | the voice chain: recogniser, asr-repair, S1 client, verifier |
| `src/components/atc/WorldMap/` | the 3D airport (three.js); world data baked by `scripts/bake_world.py` |
| `src/app/landing/`, `film/` | the landing page and its rendered SFO film |
| `src/game/Tutorial/` | `/learn`, the tutorial |
| `ml/` | everything trained: data generators, tokenizer, S1, verifier, STT/TTS benchmarks, GPU job scripts, self-play |
| `mobile/` | the Flutter app (game in a WebView, on-device speech) |
| `docs/spec/` | the specs, 00 to 16 |
| `public/reports/` | the write-ups, hub at https://openatc.aeon-labs.site/reports/ |

## Known gaps

- About 1 in 20 commands in casual wording is still sent wrong; fixing that needs real players' speech (opt-in
  logging, spec 12).
- The speech models were fine-tuned partly on UWB-ATCC and ATCOSIM, which are **non-commercial** licences. Fine for a
  showcase; a commercial release needs a retrain on the synthetic audio only.
- The browser has no on-device Parakeet yet (it uses the server; the plan is sherpa-onnx WASM).
- SFO's real runway plan (depart 01L/01R) loses separation with AI on approach, so the default is 28L/28R.
