#!/usr/bin/env python3
"""Pack the baked world textures for the web: public/world/<ICAO>/{land,height}.png -> .webp (the PNGs stay as the fallback).

  land.webp   RGBA lossless WebP of the land data quantised to 5 bits per channel (the shader thresholds are far coarser
              than 1/32; lossless keeps shorelines exact, unlike lossy WebP's chroma subsampling)   ~3.5x smaller than PNG
  height.webp lossless WebP of the height split across R/G, rounded to 32 of the 65536 steps (a few cm on a 35 m
              grid - the low bits are DEM noise and cost most of the bytes)                             ~2-3x smaller

Usage: scripts/pack_world.py [ICAO ...]   (default: every airport under public/world). Bump WORLD_ASSET_VERSION in
src/components/atc/WorldMap/worldList.ts after re-baking so the immutable cache is refreshed.
"""
import os, sys
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'world')

def pack(icao):
    d = os.path.join(ROOT, icao)
    land = np.asarray(Image.open(os.path.join(d, 'land.png')).convert('RGBA'))
    q = ((land[..., :3].astype(np.int32) + 4) // 8 * 8).clip(0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([q, land[..., 3]]), 'RGBA').save(os.path.join(d, 'land.webp'), 'WEBP', lossless=True, quality=100, method=6)
    hp = np.asarray(Image.open(os.path.join(d, 'height.png')).convert('RGB')).astype(np.int32)
    h = ((hp[..., 0] * 256 + hp[..., 1] + 16) // 32 * 32).clip(0, 65535)
    Image.fromarray(np.dstack([h // 256, h % 256, np.zeros_like(h)]).astype(np.uint8), 'RGB').save(os.path.join(d, 'height.webp'), 'WEBP', lossless=True, quality=100, method=6)
    for f in ['land', 'height']:
        a, b = os.path.getsize(os.path.join(d, f + '.png')), os.path.getsize(os.path.join(d, f + '.webp'))
        print(f'{icao} {f}: {a // 1024} KB png -> {b // 1024} KB webp')

if __name__ == '__main__':
    for icao in (sys.argv[1:] or sorted(os.listdir(ROOT))):
        if os.path.isdir(os.path.join(ROOT, icao)): pack(icao)
