#!/usr/bin/env bash
# The /landing film: JFK from the game's own data, rendered with raea (https://raea.io), then cut to WebP frames and
# tracks.json for src/app/landing. raea's Linux build needs glibc 2.38+, so it runs in an Ubuntu 24.04 container with
# software Vulkan (no GPU needed: ~6 min for 480 frames on 8 cores).
#   1. curl -fsSL https://raea.io/install | sh            (raea in ~/.raea)
#   2. film/render.sh            -> public/landing/{f,m}/NNNN.webp + public/landing/tracks.json
# Edit scene.js (story clock, traffic, camera) and landing.tsx (the 3D); preview with:
#   film/render.sh probe         (the PROBE frames in landing.tsx, half size, ~25 s, into film/out/probe)
set -euo pipefail
cd "$(dirname "$0")"; F=$PWD; W=$F/out/work
mkdir -p $W/media && cp scene.js landing.tsx export-tracks.mjs package.json $W/
docker build -q -t raea-env . >/dev/null
[ -f $W/media/fieldA.png ] || { FIELD=1 python3 prep.py $W && python3 prep2.py $W; }
for m in A320:37.6 B738:39.5 B77W:73.9 A359:66.8; do n=${m%%:*}; [ -f $W/media/$n.glb ] && continue
  (cd $F && npx -y @gltf-transform/cli@4.1.1 dequantize ../public/models/aircraft/$n.glb $W/media/$n.glb && node norm.mjs $W/media/$n.glb $W/media/$n.glb ${m##*:}); done
run() { docker run --rm -v $HOME/.raea:/root/.raea -v $W:/work -w /work raea-env raea "$@"; }
if [ "${1:-}" = probe ]; then rm -rf $W/probe; run render landing.tsx --composition probe -o probe/; exit; fi
rm -rf $W/frames; run render landing.tsx --composition landing -o frames/
python3 towebp.py $W/frames ../public/landing && rm -rf $W/frames
node $W/export-tracks.mjs ../public/landing/tracks.json
