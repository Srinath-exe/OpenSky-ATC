#!/usr/bin/env bash
# Runs on the GPU instance once, after the first push: Python packages for our scripts, the System One SDKs, Kev.
set -euo pipefail
cd /opt/atc
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
# The Deep Learning AMI ships PyTorch in a venv; use it for everything that does not pin its own torch.
if [ -f /opt/pytorch/bin/activate ]; then . /opt/pytorch/bin/activate; fi
python -c "import torch, sys; print('python', sys.version.split()[0], 'torch', torch.__version__, 'cuda', torch.cuda.is_available())"
pip install -q "transformers>=5.17,<6" soundfile "von-sdk>=1.3.7" laya uv 2>&1 | grep -vE "already satisfied|WARNING: Running pip" | tail -3 || true
# Kev pins its own torch (CUDA build) through uv; give it its own environment.
if [ ! -d /opt/atc/kev ]; then git clone -q --depth 1 https://github.com/jaredpalmer/kev.git /opt/atc/kev; fi
( cd /opt/atc/kev && uv sync -q --extra serve ) 2>&1 | tail -3 || true
/opt/atc/kev/.venv/bin/python -c "import torch; print('kev torch', torch.__version__, 'cuda', torch.cuda.is_available())"
echo SETUP-OK
