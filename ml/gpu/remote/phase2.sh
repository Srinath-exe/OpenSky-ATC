#!/usr/bin/env bash
# Phase 2 of the GPU session (after lane A): speech-to-text bake-off, E2 fine-tune, vLLM serving lab.
# Waits for lane A (the S1 sweep) to finish so timings are not shared with a training run.
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results
. /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
for _ in $(seq 240); do grep -q "A2 s1-26m done" $R/jobs.log && break; sleep 15; done

say "P1 speech-to-text bake-off (Kokoro speech, 200 commands)"
python ml/gpu/remote/stt_bench.py --n 200 > $R/stt.log 2>&1
say "P1 done: $(grep -cE '\"ms_p50\"' $R/stt.log) recognisers ok, $(grep -c '\"error\"' $R/stt.log) failed"

say "P2 E2 full fine-tune LFM2.5-230M on 30k examples"
python ml/e2/sft.py --model LiquidAI/LFM2.5-230M-Base --data ml/data/out2/ds --out $R/e2-lfm230m --n-train 30000 --bs 16 --lr 5e-5 > $R/e2-lfm230m.log 2>&1
say "P2 done: $(grep FINAL $R/e2-lfm230m.log | cut -c1-230)"

say "P3 vLLM lab: install"
if [ ! -x /opt/atc/vllm/bin/python ]; then uv venv -q /opt/atc/vllm --python 3.12 && uv pip install -q --python /opt/atc/vllm/bin/python vllm httpx > $R/vllm-install.log 2>&1; fi
for cache in on off; do
  flag=""; [ "$cache" = off ] && flag="--no-enable-prefix-caching"
  say "P3 vLLM serve E2 model, prefix caching $cache"
  setsid nohup /opt/atc/vllm/bin/vllm serve $R/e2-lfm230m/model --served-model-name atc --max-model-len 1024 --gpu-memory-utilization 0.6 $flag \
    --port 8000 > $R/vllm-serve-$cache.log 2>&1 < /dev/null &
  for _ in $(seq 120); do curl -s -o /dev/null http://127.0.0.1:8000/v1/models && break; sleep 5; done
  /opt/atc/vllm/bin/python ml/serve/loadtest.py --url http://127.0.0.1:8000 --model atc --levels 1,4,16,64 --n 128 --out $R/vllm-cache-$cache.json --tag "cache-$cache" > $R/vllm-load-$cache.log 2>&1
  say "P3 cache $cache: $(tail -n 1 $R/vllm-load-$cache.log | cut -c1-200)"
  for p in $(pgrep -f "vllm serv[e]"); do kill "$p"; done; sleep 10
done
say "PHASE 2 DONE"; touch $R/PHASE2-DONE
