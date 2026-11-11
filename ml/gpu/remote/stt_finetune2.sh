#!/usr/bin/env bash
# GPU job, round 2: continue the ATC fine-tune (ml/data/stt/init/atc_v1.nemo) on the coverage-driven data
# (ml/stt/data/coverage_lines.py + round 1 + the public corpora twice). `JOBS=stt_finetune2.sh ml/gpu/gpu.sh jobs`.
# Results in /opt/atc/results/stt-ft2/: atc.nemo, onnx/, eval.json (base = round 1, tuned = round 2), logs.
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results/stt-ft2; mkdir -p "$R"
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*"; }
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
INIT=/opt/atc/repo/ml/data/stt/init/atc_v1.nemo
if ! python -c "import nemo.collections.asr" 2>/dev/null; then
  say "install NeMo"; pip install -q "nemo_toolkit[asr]" onnx onnxruntime safetensors 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
if ! python -c "import numba_cuda" 2>/dev/null; then   # the TDT loss is a numba CUDA kernel (see stt_finetune.sh)
  pip install -q "numba-cuda[cu13]" "numpy<2.5" "nvidia-nvvm<13.1" 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
python -c "import nemo, torch; print('nemo', nemo.__version__, 'cuda', torch.cuda.is_available())" || { say "NeMo import failed"; exit 1; }
P="python ml/stt/train_parakeet.py --root /opt/atc/repo"
if false; then
say "smoke (4 steps)"
$P train --out $R --init $INIT --smoke > $R/smoke.log 2>&1 || { say "smoke failed"; tail -40 $R/smoke.log; exit 1; }
fi
say "train round 2"
$P train --out $R --init $INIT --epochs ${EPOCHS:-2} --batch ${BATCH:-4} --accum ${ACCUM:-8} --maxdur 12 --lr ${LR:-3e-5} > $R/train.log 2>&1 || { say "train failed"; tail -40 $R/train.log; exit 1; }
say "$(grep -E 'trained in' $R/train.log)"
say "export int8 ONNX"
$P export --nemo $R/atc.nemo --out $R/onnx > $R/export.log 2>&1 || { say "export failed"; tail -30 $R/export.log; }
(cd $R/onnx && find . -maxdepth 1 -type f ! -name '*.int8.onnx' ! -name tokens.txt ! -name bpe.vocab -delete)
say "eval round 1 vs round 2"
$P eval --base $INIT --nemo $R/atc.nemo --out $R > $R/eval.log 2>&1 || say "eval failed"
cat $R/eval.json 2>/dev/null
rm -f $R/ckpt/*.ckpt $R/smoke.nemo $R/m_*.jsonl
say "done"
