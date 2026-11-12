#!/usr/bin/env bash
# After queue5: the phone app's engine with sherpa-onnx's Moonshine base (offline, no hotwords) on both sets, 2 threads.
set -u
cd "$(dirname "$0")/../../.."
[ -n "${1:-}" ] && while kill -0 "$1" 2>/dev/null; do sleep 10; done
source /opt/mobile-env.sh
S=/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad; R=$PWD/ml/stt/bench2/results
for set in clips clips_in; do
  (cd mobile && dart run tool/stt_bench.dart --manifest $S/phone_models.json --model moonshine-base-en-quantized-2026-02-27 --dir /tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad/dl_msbase/sherpa-onnx-moonshine-base-en-quantized-2026-02-27 --clips $S/phone_$set --out $S/phone_ms_$set --threads 2)
  tag=edge-phone-moonshine-base; [ $set = clips_in ] && tag=edge-in-phone-moonshine-base
  ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_phone.py import $S/phone_$set $S/phone_ms_$set/moonshine-base-en-quantized-2026-02-27.json $R/$tag.jsonl
done
