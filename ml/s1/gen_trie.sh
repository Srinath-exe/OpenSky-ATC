#!/usr/bin/env bash
# Greedy-trie generator pass, the "before" for ml/s1/callsign_gate.py: ml/s1/gen_trie.sh <model name> <sets...>
# -> ml/verify/out/<model>-trie/<set>.gen.jsonl, then: node ml/verify/post.cjs <model>-trie <sets...>
set -eu
cd "$(dirname "$0")/../.."
M=$1; shift
D=ml/verify/out/$M-trie; mkdir -p $D
for s in "$@"; do OMP_NUM_THREADS=1 ml/.venv/bin/python ml/verify/gen.py --model public/models/s1/$M --in ml/verify/out/$s.in.jsonl --out $D/$s.gen.jsonl --decode trie --no-s1 --threads 1 > $D/gen-$s.log 2>&1; done
echo done > $D/done-$(echo "$@" | tr " " -)
