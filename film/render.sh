#!/usr/bin/env bash
# The /landing film: SFO from the game's own data, rendered with raea (https://raea.io), cut to WebP frames and
# tracks.json for src/app/landing. raea's Linux build needs glibc 2.38+, so it runs in an Ubuntu 24.04 container with
# software Vulkan (no GPU: about 40 min for 1440 frames at 1920x1080 on this host).
#   1. curl -fsSL https://raea.io/install | sh            (raea in ~/.raea)
#   2. film/render.sh            -> public/landing/sfo/{f,m}/NNNN.webp + tracks.json
# Edit scene.js (story clock, traffic, camera, taxi instructions) and landing.tsx (the 3D); check and preview with:
#   film/render.sh check         (ground conflicts over the loop: moving vs moving vs parked)
#   film/render.sh probe         (the PROBE frames in landing.tsx, half size, into film/out/sfo/probe)
# The data steps run when the work dir has no jfk.json (delete it to rebuild): prep.py (OSM + world bake -> field
# textures, runways, stands), prep2.py (taxiway lines, stand spacing), prep3.py (the story routes and stop bar),
# prep4.py (pavement and apron distance fields, floods, taxiway lights, runway designators). prep3's last argument
# 'auto' picks the other arrivals' stands clear of the departure's route.
set -euo pipefail
cd "$(dirname "$0")"; F=$PWD; W=$F/out/sfo; DST=$F/../public/landing/sfo
mkdir -p $W/media && cp scene.js landing.tsx airports.js export-tracks.mjs check.mjs package.json $W/
docker build -q -t raea-env . >/dev/null
if [ ! -f $W/jfk.json ]; then
  FIELD=1 python3 prep.py $W KSFO && python3 prep2.py $W && python3 prep3.py $W A9 A8 auto && python3 prep4.py $W
fi
for m in A320:37.6 B738:39.5 B77W:73.9 A359:66.8 A388:72.7 B744:70.7; do n=${m%%:*}; [ -f $W/media/$n.glb ] && continue
  (cd $F && npx -y @gltf-transform/cli@4.1.1 dequantize ../public/models/aircraft/$n.glb $W/media/$n.glb && node norm.mjs $W/media/$n.glb $W/media/$n.glb ${m##*:}); done
run() { docker run --rm -v $HOME/.raea:/root/.raea -v $W:/work -w /work raea-env raea "$@"; }
case "${1:-}" in
  check) (cd $W && node check.mjs jfk.json); exit ;;
  probe) rm -rf $W/probe; run render landing.tsx --composition probe -o probe/; exit ;;
esac
(cd $W && node check.mjs jfk.json)
rm -rf $W/frames; run render landing.tsx --composition landing -o frames/
python3 towebp.py $W/frames $DST && rm -rf $W/frames
(cd $W && node export-tracks.mjs $DST/tracks.json)
