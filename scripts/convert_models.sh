#!/usr/bin/env bash
# Convert the Flightradar24 community aircraft models (GPLv2, https://github.com/Flightradar24/fr24-3d-models —
# COLLADA sources) into small glTF 2.0 binaries for the 3D world map: public/models/aircraft/<OUR_TYPE>.glb
#   deps: git, unzip, assimp-utils (apt), node (npx @gltf-transform/cli@3)
#   usage: bash scripts/convert_models.sh [/path/to/fr24-3d-models]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${1:-/tmp/fr24-3d-models}"
OUT="$ROOT/public/models/aircraft"
mkdir -p "$OUT"
[ -d "$REPO/source" ] || git clone -q --depth 1 https://github.com/Flightradar24/fr24-3d-models.git "$REPO"

# our ICAO type -> fr24 source folder
declare -A MAP=(
  [A320]=a320 [A20N]=a320 [A319]=a319 [A321]=a321 [B738]=b738 [B38M]=b738 [B737]=b737 [B739]=b739
  [B752]=b752 [B763]=b763 [B77W]=b773 [B772]=b772 [B788]=b788 [B789]=b789 [A333]=a333 [A332]=a332
  [A359]=a350 [A346]=a346 [A343]=a343 [B744]=b744 [B748]=b748 [A388]=a380 [MD11]=b763
  [E190]=e190 [E175]=e170 [CRJ9]=crj900 [CRJ7]=crj700 [DH8D]=q400 [AT76]=atr42 [C172]=pa28 [PA28]=pa28
  [C17]=b763 [VC25]=b744 [F18]=citation [F35]=citation
)
TMP="$(mktemp -d)"
for code in "${!MAP[@]}"; do
  src="${MAP[$code]}"
  dir="$REPO/source/$src"; zip="$(ls "$dir"/*.zip 2>/dev/null | head -1)"
  [ -n "$zip" ] || { echo "skip $code (no zip for $src)"; continue; }
  work="$TMP/$code"; rm -rf "$work"; mkdir -p "$work"
  unzip -o -q "$zip" -d "$work" -x "__MACOSX/*" "*.DS_Store" || true
  dae="$(ls "$work"/*.dae | head -1)"
  ( cd "$work" && assimp export "$dae" "$work/raw.glb" -f glb2 > /dev/null 2>&1 ) || { echo "assimp failed for $code"; continue; }
  # pack the external textures into the binary, shrink them, quantize the geometry
  ( cd "$work" && npx -y @gltf-transform/cli@3 optimize raw.glb "$OUT/$code.glb" --compress quantize --texture-size 512 > /dev/null 2>&1 ) \
    || { echo "gltf-transform failed for $code, keeping the raw file"; cp "$work/raw.glb" "$OUT/$code.glb"; }
  printf '%-5s <- %-7s %6d KB\n' "$code" "$src" "$(( $(stat -c %s "$OUT/$code.glb") / 1024 ))"
done
cp "$REPO/LICENSE" "$OUT/LICENSE"
cat > "$OUT/README.md" <<EOR
Aircraft models for the 3D world map. Converted from the Flightradar24 community model repository
(https://github.com/Flightradar24/fr24-3d-models), licensed under the GNU GPL v2 (see LICENSE). Not the
Infinite Flight models used by Flightradar24's current 3D view (those are proprietary).
Pipeline: scripts/convert_models.sh (COLLADA -> assimp glb2 -> gltf-transform quantize + 512 px textures).
EOR
rm -rf "$TMP"
