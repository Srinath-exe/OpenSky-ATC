"""The tutorial's film clips: smooth 30 fps H.264 cut from the raea SFO film's frames (public/landing/sfo/f, three per
story frame), one or more shots joined per clip, into public/learn/clips/. Cached: a clip is remade only when its shots
change. usage: python3 scripts/learn_clips.py"""
import json, os, shutil, subprocess, tempfile, hashlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = f'{ROOT}/public/landing/sfo/f'; OUT = f'{ROOT}/public/learn/clips'; os.makedirs(OUT, exist_ok=True)
C = json.load(open(f'{ROOT}/src/game/Tutorial/clips.json'))
idx_p = f'{OUT}/index.json'; idx = json.load(open(idx_p)) if os.path.exists(idx_p) else {}
SUB = 3
def make(cid, shots, small):
    h = hashlib.sha1(json.dumps([shots, small, 'v3']).encode()).hexdigest()[:10]
    dst = f'{OUT}/{cid}.mp4'
    if idx.get(cid, {}).get('h') == h and os.path.exists(dst): return
    tmp = tempfile.mkdtemp(); n = 0
    for a, b in shots:
        for i in range(a * SUB, b * SUB + 1):
            src = f'{SRC}/{i:04d}.webp'
            if os.path.exists(src): os.symlink(src, f'{tmp}/{n:05d}.webp'); n += 1
    vf = 'scale=960:-2:flags=lanczos' if small else 'scale=1920:-2'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '30', '-i', f'{tmp}/%05d.webp', '-vf', vf, '-c:v', 'libx264', '-preset', 'slow',
                    '-crf', '27' if small else '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', dst], check=True)
    shutil.rmtree(tmp)
    idx[cid] = {'h': h, 'dur': round(n / 30, 3)}
    json.dump(idx, open(idx_p, 'w'))
    print(cid, n, 'frames', round(os.path.getsize(dst) / 1e6, 2), 'MB')
for cid, shots in C['full'].items(): make(cid, shots, False)
for cid, shots in C['small'].items(): make(cid, shots, True)
for cid, f in C['stills'].items(): shutil.copy(f'{SRC}/{f * SUB:04d}.webp', f'{OUT}/{cid}.webp')
print('done', len(idx), 'clips')
