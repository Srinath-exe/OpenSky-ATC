#!/usr/bin/env bash
# GPU job: fine-tune the game's speech-to-text model (Parakeet Ultra) on ATC speech (ml/stt/DATA.md), export the int8
# ONNX the game loads, and score base vs tuned. Started by `JOBS=stt_finetune.sh ml/gpu/gpu.sh jobs` after `push`.
#   TRAIN=train_all (default, includes the non-commercial corpora) | train_synth (commercial use OK)
# Results in /opt/atc/results/stt-ft/: atc.nemo, onnx/ (encoder/decoder/joiner .int8.onnx, tokens.txt, bpe.vocab), eval.json, logs.
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results/stt-ft; mkdir -p "$R"
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*"; }
TRAIN=${TRAIN:-train_all}
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
# PHASE=prep (stt_prep.sh): install + base only, while the data is still being made on the VPS. Steps already done are skipped.
if ! python -c "import nemo.collections.asr" 2>/dev/null; then
  say "install NeMo"
  pip install -q "nemo_toolkit[asr]" onnx onnxruntime safetensors 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
# NeMo's TDT loss is a numba CUDA kernel. On this AMI (torch cu130, CUDA from pip, no /usr/local/cuda) numba needs
# numba-cuda, numpy < 2.5 (numba 0.68 still uses np.row_stack) and an NVVM that matches torch's nvJitLink 13.0.
if ! python -c "import numba_cuda" 2>/dev/null; then
  pip install -q "numba-cuda[cu13]" "numpy<2.5" "nvidia-nvvm<13.1" 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
python -c "import nemo, torch; print('nemo', nemo.__version__, 'torch', torch.__version__, 'cuda', torch.cuda.is_available())" || { say "NeMo import failed"; exit 1; }
P="python ml/stt/train_parakeet.py --root /opt/atc/repo"
if [ ! -f $R/ultra.nemo ]; then
  say "base: v3 architecture + Ultra weights"
  $P base --out $R > $R/base.log 2>&1 || { say "base failed"; tail -30 $R/base.log; exit 1; }
fi
[ "${PHASE:-all}" = prep ] && { say "prep done"; exit 0; }
say "smoke (4 steps)"
$P train --out $R --train ml/data/stt/manifests/$TRAIN.jsonl --smoke > $R/smoke.log 2>&1 || { say "smoke failed"; tail -40 $R/smoke.log; exit 1; }
say "train on $TRAIN"
$P train --out $R --train ml/data/stt/manifests/$TRAIN.jsonl --epochs ${EPOCHS:-3} --batch ${BATCH:-8} --accum 4 > $R/train.log 2>&1 || { say "train failed"; tail -40 $R/train.log; exit 1; }
say "$(grep -E 'trained in' $R/train.log)"
say "export int8 ONNX"
$P export --nemo $R/atc.nemo --out $R/onnx > $R/export.log 2>&1 || { say "export failed"; tail -30 $R/export.log; }
say "eval base vs tuned"
$P eval --nemo $R/atc.nemo --out $R > $R/eval.log 2>&1 || say "eval failed"
cat $R/eval.json 2>/dev/null
rm -f $R/ckpt/*.ckpt $R/smoke.nemo $R/parakeet-tdt-0.6b-v3.nemo $R/model.safetensors
say "done"
