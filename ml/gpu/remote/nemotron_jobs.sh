#!/usr/bin/env bash
# GPU session 2 jobs: Nemotron 3.5 Transcribe (plain + contextual) and Nemotron 3.5 ASR streaming 0.6B on the
# benchmark clips (US/UK set and the Indian-accent proxy). Results -> /opt/atc/results/nemo-*.jsonl.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
. /opt/pytorch/bin/activate 2>/dev/null || true
cd /opt/atc/repo
R=/opt/atc/results; B=ml/stt/bench2; M=/opt/atc/models/nemotron/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-AD-Q2_0_M.gguf   # 13.6 GB: IQ4_NL (19.7 GB) + the encoder left no room for buffers on the L4
wait_up() { for i in $(seq 1 240); do curl -s -o /dev/null "http://127.0.0.1:$1/" && return 0; sleep 5; done; return 1; }   # any HTTP answer = listening
echo "[$(date +%T)] serve SALM"; nemo-speech serve --asr-model "$M" --host 127.0.0.1 --port 8080 --asr.salm.max_sequences 2 --asr.salm.n_ctx_per_sequence 4096 --asr.salm.max_context 4096 --asr.salm.mtp_draft 0 --asr.salm.n_batch 512 --asr.salm.encoder_max_batch 2 > $R/nemo-serve.log 2>&1 &
SALM=$!
wait_up 8080 || { echo "SALM server did not come up"; tail -30 $R/nemo-serve.log; }
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
for set in clips clips_in; do
  for mode in plain context; do
    echo "[$(date +%T)] salm $mode $set"; python ml/gpu/remote/nemo_client.py $B/$set $R/nemo-salm-$mode-$set.jsonl --mode $mode --port 8080 --every 2
  done
done
kill $SALM; sleep 5
echo "[$(date +%T)] serve streaming 0.6B"; nemo-speech serve --asr-model nvidia/nemotron-3.5-asr-streaming-0.6b --host 127.0.0.1 --port 8081 > $R/nemo-serve-0.6b.log 2>&1 &
S06=$!
wait_up 8081 || { echo "0.6B server did not come up"; tail -30 $R/nemo-serve-0.6b.log; }
for set in clips clips_in; do echo "[$(date +%T)] 0.6b $set"; python ml/gpu/remote/nemo_client.py $B/$set $R/nemo-asr06-$set.jsonl --mode plain --port 8081 --every 2; done
kill $S06
echo "[$(date +%T)] ALL-DONE"; touch $R/NEMO-DONE
