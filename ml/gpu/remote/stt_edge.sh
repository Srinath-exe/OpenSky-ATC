#!/usr/bin/env bash
# GPU job: fine-tune the on-device speech models on the ATC data (ml/stt/DATA.md), one after the other:
#   Parakeet TDT 110M (phone, sherpa-onnx)  -> /opt/atc/results/stt-edge/p110/{atc.nemo, onnx/, eval.json}
#   Moonshine base (browser, transformers.js) -> /opt/atc/results/stt-edge/moon/{best/, moon_eval.json}  (ONNX export on the VPS)
# Training audio comes straight from the S3 archive (/opt/atc/s3.env: temporary credentials + BUCKET, written by the VPS).
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results/stt-edge; mkdir -p "$R"
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*"; }
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
set -a; . /opt/atc/s3.env; set +a
if [ ! -f ml/data/stt/.from_s3 ]; then
  say "data from S3"
  aws s3 sync "s3://$BUCKET/atc/ml/data/stt" ml/data/stt --only-show-errors --exclude "*/audio/*" --exclude "*/logs/*" || { say "S3 sync failed"; exit 1; }
  touch ml/data/stt/.from_s3; say "data: $(du -sh ml/data/stt | cut -f1)"
fi
if ! python -c "import nemo.collections.asr" 2>/dev/null; then
  say "install NeMo"; pip install -q "nemo_toolkit[asr]" onnx onnxruntime safetensors 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
if ! python -c "import numba_cuda" 2>/dev/null; then   # NeMo's TDT loss is a numba CUDA kernel (see stt_finetune.sh)
  pip install -q "numba-cuda[cu13]" "numpy<2.5" "nvidia-nvvm<13.1" 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
fi
python -c "import nemo, torch, transformers; print('nemo', nemo.__version__, 'transformers', transformers.__version__, 'cuda', torch.cuda.is_available())" || { say "imports failed"; exit 1; }

P="python ml/stt/train_parakeet.py --root /opt/atc/repo"; O=$R/p110; mkdir -p $O
if [ ! -f $O/atc.nemo ]; then
  say "p110: base"; $P base --pretrained nvidia/parakeet-tdt_ctc-110m --out $O > $O/base.log 2>&1 || { say "p110 base failed"; tail -20 $O/base.log; }
  say "p110: smoke"; $P train --out $O --smoke > $O/smoke.log 2>&1 || { say "p110 smoke failed"; tail -30 $O/smoke.log; }
  say "p110: train"; $P train --out $O --epochs ${P_EPOCHS:-3} --batch 16 --accum 2 --workers 6 --lr 1e-4 > $O/train.log 2>&1 || { say "p110 train failed"; tail -30 $O/train.log; }
  say "p110: $(grep -E 'trained in' $O/train.log)"
fi
if [ -f $O/atc.nemo ] && [ ! -f $O/onnx/encoder.int8.onnx ]; then
  say "p110: export"; $P export --nemo $O/atc.nemo --out $O/onnx > $O/export.log 2>&1 || { say "p110 export failed"; tail -20 $O/export.log; }
  (cd $O/onnx && find . -maxdepth 1 -type f ! -name '*.int8.onnx' ! -name tokens.txt ! -name bpe.vocab -delete)
  say "p110: eval"; $P eval --base $O/ultra.nemo --nemo $O/atc.nemo --out $O > $O/eval.log 2>&1 || say "p110 eval failed"
  say "p110 eval: $(tr -d '\n ' < $O/eval.json 2>/dev/null)"
  rm -f $O/ckpt/*.ckpt $O/smoke.nemo $O/m_*.jsonl
fi

M="python ml/stt/train_moonshine.py --root /opt/atc/repo"; O=$R/moon; mkdir -p $O
if [ ! -d $O/best ] || [ ! -f $O/trained ]; then
  say "moon: smoke"; $M train --out $O/smoke --smoke > $O/smoke.log 2>&1 || { say "moon smoke failed"; tail -30 $O/smoke.log; exit 1; }
  say "moon: train"; $M train --out $O --epochs ${M_EPOCHS:-4} --batch-seconds 480 --lr 1e-4 > $O/train.log 2>&1 || { say "moon train failed"; tail -30 $O/train.log; exit 1; }
  touch $O/trained; say "moon: $(grep -E 'trained in' $O/train.log)"
fi
say "moon: eval"; $M eval --model $O/best --out $O > $O/eval.log 2>&1 || say "moon eval failed"
say "moon eval: $(tr -d '\n ' < $O/moon_eval.json 2>/dev/null)"
rm -rf $O/smoke
say "done"
