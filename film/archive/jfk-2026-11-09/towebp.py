import sys, os
from multiprocessing import Pool
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(f'{OUT}/f', exist_ok=True); os.makedirs(f'{OUT}/m', exist_ok=True)
def one(i):
    im = Image.open(f'{SRC}/frame-{i:05d}.png').convert('RGB')
    im.save(f'{OUT}/f/{i:04d}.webp', 'WEBP', quality=80, method=5)
    im.resize((960, 540), Image.LANCZOS).save(f'{OUT}/m/{i:04d}.webp', 'WEBP', quality=78, method=5)
with Pool(8) as p: p.map(one, range(480))
