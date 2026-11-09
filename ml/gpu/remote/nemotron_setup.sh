#!/usr/bin/env bash
# GPU session 2 (2026-11-09): NVIDIA Nemotron 3.5 Transcribe 30B-A4B on one L4, through NVIDIA's NeMo-Speech.cpp.
# Installs the prebuilt CUDA CLI (the installer checks the release archive's SHA-256) and the GGUF files:
#   AtomicChat's community conversion (the owner OK'd it): IQ4_NL decoder (19.7 GB, "recommended outside Blackwell:
#   24 GB GPUs") + the F16 encoder (1.7 GB); and NVIDIA's own nemotron-3.5-asr-streaming-0.6b for comparison.
set -euo pipefail
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
mkdir -p /opt/atc/results /opt/atc/models/nemotron
# NVIDIA's prebuilt CUDA release, fetched through the GitHub API (github.com itself was answering 504 on 2026-11-09),
# checked against the release's published SHA-256, unpacked under ~/.local/nemo-speech
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
if ! command -v nemo-speech >/dev/null; then
  python3 - <<'PY' > /tmp/ns-assets.txt
import json, urllib.request
rel = json.load(urllib.request.urlopen("https://api.github.com/repos/NVIDIA/NeMo-Speech.cpp/releases/latest", timeout=30))
want = [a for a in rel["assets"] if a["name"].endswith("-linux-x86_64-cuda.tar.gz") or a["name"].endswith("-linux-x86_64-cuda.tar.gz.sha256")]
for a in sorted(want, key=lambda a: a["name"].endswith(".sha256")): print(a["name"], a["url"])
PY
  cat /tmp/ns-assets.txt
  mkdir -p /tmp/ns && cd /tmp/ns
  while read -r name url; do curl -fsSL -H "Accept: application/octet-stream" "$url" -o "$name"; done < /tmp/ns-assets.txt
  tgz=$(ls *.tar.gz); sum=$(awk '{print $1}' "$tgz.sha256")
  echo "$sum  $tgz" | sha256sum -c - || { echo "checksum mismatch"; exit 1; }
  mkdir -p "$HOME/.local/nemo-speech" "$HOME/.local/bin" && tar xzf "$tgz" -C "$HOME/.local/nemo-speech"
  bin=$(find "$HOME/.local/nemo-speech" -type f -name nemo-speech -perm -u+x | head -1)
  [ -n "$bin" ] || { echo "nemo-speech binary not found in the archive"; find "$HOME/.local/nemo-speech" -maxdepth 3 | head -30; exit 1; }
  ln -sf "$bin" "$HOME/.local/bin/nemo-speech"
  cd - >/dev/null
fi
command -v nemo-speech || { ls -la "$HOME/.local/bin" "$HOME/bin" 2>/dev/null; echo "nemo-speech not on PATH"; exit 1; }
nemo-speech --version
nemo-speech --json model list > /opt/atc/results/nemo-models.json || true
nemo-speech doctor 2>&1 | tail -5 || true
. /opt/pytorch/bin/activate 2>/dev/null || true
pip install -q "huggingface_hub[hf_transfer]" soundfile requests 2>&1 | tail -1 || true
export HF_HUB_ENABLE_HF_TRANSFER=1
REPO=AtomicChat/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF
python - <<'PY'
from huggingface_hub import hf_hub_download
repo = "AtomicChat/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF"
for f in ["NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-Encoder-F16.gguf", "NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-AD-IQ4_NL.gguf"]:
    print(hf_hub_download(repo, f, local_dir="/opt/atc/models/nemotron"), flush=True)
PY
nemo-speech pull nvidia/nemotron-3.5-asr-streaming-0.6b 2>&1 | tail -2 || true
ls -la /opt/atc/models/nemotron
echo NEMO-SETUP-OK
