#!/usr/bin/env bash
# vLLM serving lab, second try: ninja for vLLM's kernel JIT, and the venv's bin on PATH.
set -uo pipefail
cd /opt/atc/repo; R=/opt/atc/results
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
for _ in $(seq 240); do [ -f $R/PHASE6-DONE ] && break; sleep 15; done
for p in $(pgrep -f "vllm serv[e]"); do kill "$p"; done; sleep 5
. /opt/pytorch/bin/activate
uv pip install -q --python /opt/atc/vllm/bin/python ninja >> $R/vllm-install.log 2>&1
export PATH=/opt/atc/vllm/bin:$PATH
export VLLM_USE_FLASHINFER_SAMPLER=0
CUDART=$(dirname "$(find /opt/atc/vllm/lib -name "libcudart.so*" 2>/dev/null | head -1)")
export LIBRARY_PATH=$CUDART:${LIBRARY_PATH:-}; export LD_LIBRARY_PATH=$CUDART:${LD_LIBRARY_PATH:-}
rm -rf ~/.cache/flashinfer
for cache in on off; do
  flag=""; [ "$cache" = off ] && flag="--no-enable-prefix-caching"
  say "P3 vLLM serve E2 model, prefix caching $cache (retry 2)"
  setsid nohup /opt/atc/vllm/bin/vllm serve $R/e2-lfm230m/model --served-model-name atc --max-model-len 1024 --gpu-memory-utilization 0.6 $flag \
    --port 8000 > $R/vllm-serve-$cache.log 2>&1 < /dev/null &
  ok=0; for _ in $(seq 120); do curl -s -o /dev/null http://127.0.0.1:8000/v1/models && { ok=1; break; }; grep -q "Engine core initialization failed" $R/vllm-serve-$cache.log && break; sleep 5; done
  if [ $ok = 1 ]; then
    /opt/atc/vllm/bin/python ml/serve/loadtest.py --url http://127.0.0.1:8000 --model atc --levels 1,4,16,64 --n 128 --out $R/vllm-cache-$cache.json --tag "cache-$cache" > $R/vllm-load-$cache.log 2>&1
    say "P3 cache $cache: $(tail -n 1 $R/vllm-load-$cache.log | cut -c1-220)"
  else
    say "P3 cache $cache: server failed: $(grep -m1 -E 'Error' $R/vllm-serve-$cache.log | cut -c1-160)"
  fi
  for p in $(pgrep -f "vllm serv[e]"); do kill "$p"; done; sleep 10
done
say "VLLM LAB 2 DONE"; touch $R/VLLM2-DONE
