#!/usr/bin/env bash
# Latency-only pass (ml/stt/models/SERVER.md): the first 40 even-id clips of the US/UK bench (10 situations x 4
# conditions), each engine alone (nothing else of ours running), 3 threads, one utterance at a time.
# Writes ml/stt/bench2/results/srv-lat-<name>.jsonl (+ .run.json) and srv-lat-load.txt (load average per engine).
cd "$(dirname "$0")/../../.."
exec 9>ml/stt/models/.queue.lock; flock 9
V=ml/stt/venvs; R=ml/stt/bench2/results; S=sherpa-onnx-nemo-parakeet; N=${N:-40}
lat() { local name=$1 venv=$2 eng=$3; shift 3; rm -f $R/srv-lat-$name.jsonl
  echo "$name start $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt
  $V/$venv/bin/python ml/stt/models/srv_run.py "$eng" ml/stt/bench2/clips $R/srv-lat-$name.jsonl --every 2 --limit $N --threads 3 "$@" 2>&1 | grep -E '^\{' | tail -n 1
  echo "$name end   $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt; }
: > $R/srv-lat-load.txt
lat phonon       fermion phonon --hotwords
lat phonon2      fermion phonon2 --hotwords
lat p110-sherpa  onnx "sherpa-${S}_tdt_transducer_110m-en-36000-int8:beam" --hotwords
lat p110-greedy  onnx "sherpa-${S}_tdt_transducer_110m-en-36000-int8"
lat redux-sherpa onnx "sherpa-${S}-tdt-0.6b-redux-int8:beam" --hotwords
lat ultra-sherpa onnx "sherpa-${S}-tdt-0.6b-ultra-int8:beam" --hotwords
lat ultra-greedy onnx "sherpa-${S}-tdt-0.6b-ultra-int8"
lat canary180    onnx canary-onnxasr
lat hima         onnx hima
lat granite      granite granite
NP=${SHERPA_NODE_PATH:-/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad/node/node_modules}
for m in "${S}_tdt_transducer_110m-en-36000-int8:p110" "${S}-tdt-0.6b-ultra-int8:ultra"; do
  echo "node-${m#*:} start $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt
  NODE_PATH=$NP /usr/bin/time -f '{"peak_rss_kb": %M}' node ml/stt/models/srv_sherpa_node.cjs ml/stt/models/sherpa/${m%:*} \
    ml/stt/bench2/clips $R/srv-lat-node-${m#*:}.jsonl --every 2 --limit $N --threads 3 2>&1 | tail -n 2
  echo "node-${m#*:} end   $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt
done
for alts in alts single; do
  rm -f $R/srv-lat-tjs-whisper-base.en-$alts.jsonl
  echo "whisper-$alts start $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt
  /usr/bin/time -f '{"peak_rss_kb": %M}' node ml/stt/bench2/transcribe_tjs.cjs ml/stt/bench2/clips $R/srv-lat-tjs-whisper-base.en-$alts.jsonl --model whisper-base.en \
    --prompt phrases $([ $alts = alts ] && echo --alts) --every 2 --limit $N --threads 3 2>&1 | tail -n 2
  echo "whisper-$alts end   $(cut -d' ' -f1-3 /proc/loadavg)" >> $R/srv-lat-load.txt
done
echo "latency pass done"
