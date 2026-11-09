#!/usr/bin/env bash
# Refit the voice verifier for an S1 model, end to end (one command, ~1 h on 2 CPU threads, nothing needs a GPU):
#   ml/verify/refit.sh [public/models/s1/<name>]      default: the shipped model (src/lib/voice/l1.ts S1_MODEL_URL)
# 1. example sets (only if missing: they do not depend on the model)  2. generator pass with that model's weights
# 3. label + round-trip features with the game's code  4. fit, thresholds -> the entry for /models/s1/<name> in
# src/lib/voice/verify-model.ts and public/models/verifier/roundtrip-v1/verifier.json (other models' gates are kept)
# 5. parity (decode unchanged, signals match)  6. report + RESULTS.md (every fitted model side by side)
# Outputs per model: ml/verify/out/<name>/. The generator pass skips the hard negatives unless HARDNEG=1 (they did not
# help the shipped gate); the example sets in ml/verify/out/*.in.jsonl are shared by all models.
set -eu
cd "$(dirname "$0")/../.."
MODEL=${1:-public/models/s1/$(sed -n "s#.*S1_MODEL_URL = '/models/s1/\([^']*\)'.*#\1#p" src/lib/voice/l1.ts)}
PY=ml/.venv/bin/python
[ -f ml/verify/out/val.in.jsonl ] || $PY ml/verify/make_sets.py
SETS="val syd stt noisy trainA trainB"; [ "${HARDNEG:-0}" = 1 ] && SETS="$SETS hardneg"
MODEL=$MODEL ml/verify/run_gen.sh $SETS
ml/verify/build.sh
TAG=$(basename "$MODEL"); D=ml/verify/out/$TAG
node ml/verify/post.cjs "$TAG" val syd stt noisy trainA trainB hardneg
OMP_NUM_THREADS=2 $PY ml/verify/fit.py --s1-model "$MODEL"
ml/verify/build.sh > /dev/null   # pick up the new verify-model.ts
node ml/verify/parity.cjs 200 "$MODEL" > "$D/parity.log"; tail -1 "$D/parity.log" > "$D/parity.json"
node ml/verify/bench.cjs stt 400 "$TAG" > "$D/bench.json"
$PY ml/verify/report.py
echo "refit done for $MODEL: review git diff src/lib/voice/verify-model.ts, run ml/verify/test.sh (tests/engine/voice.test.ts)"
