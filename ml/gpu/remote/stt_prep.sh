#!/usr/bin/env bash
# First half of stt_finetune.sh (install NeMo, build the Ultra .nemo) while the training data is still being made.
PHASE=prep exec bash "$(dirname "$0")/stt_finetune.sh"
