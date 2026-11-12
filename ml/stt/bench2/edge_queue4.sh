#!/usr/bin/env bash
# After queue2: the phone app's sherpa-onnx zipformer + hotwords (mobile/tool/stt_bench.dart, 2 threads) on both sets.
set -u
cd "$(dirname "$0")/../../.."
while kill -0 "$1" 2>/dev/null; do sleep 10; done
source /opt/mobile-env.sh
S=/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad
R=$PWD/ml/stt/bench2/results
for set in clips clips_in; do
  (cd mobile && dart run tool/stt_bench.dart --dir /opt/stt-models/zf-0626 --clips $S/phone_$set --out $S/phone_out_$set --threads 2)
  tag=edge-phone-zipformer-hot; [ $set = clips_in ] && tag=edge-in-phone-zipformer-hot
  ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_phone.py import $S/phone_$set $S/phone_out_$set/zipformer-en-2023-06-26-int8+hot2.0.json $R/$tag.jsonl
done
