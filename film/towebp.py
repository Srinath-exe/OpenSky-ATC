# Frames -> WebP in three sizes: f 1600 (desktop), m 960 (phones, slow links), l 480 (the first look, any link).
import sys, os
from multiprocessing import Pool
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
for t in ('f', 'm', 'l'): os.makedirs(f'{OUT}/{t}', exist_ok=True)
def one(i):
    im = Image.open(f'{SRC}/frame-{i:05d}.png').convert('RGB')
    im.save(f'{OUT}/f/{i:04d}.webp', 'WEBP', quality=74, method=5)
    im.resize((960, 540), Image.LANCZOS).save(f'{OUT}/m/{i:04d}.webp', 'WEBP', quality=70, method=5)
    # the first look: a quarter the pixels of m, loaded for every frame before anything sharper (slow links, first seconds)
    im.resize((480, 270), Image.LANCZOS).save(f'{OUT}/l/{i:04d}.webp', 'WEBP', quality=52, method=5)
N = len([f for f in os.listdir(SRC) if f.endswith('.png')])
with Pool(8) as p: p.map(one, range(N))
