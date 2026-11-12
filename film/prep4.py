"""Crisp ground detail for the film, in the field texture's mapping (+-FHALF metres around the reference, 4096 px), written
into channels the film no longer reads: fieldB R pavement signed distance (0.5 = the edge, +-16 m), B apron flood light;
fieldA G apron signed distance; region G top rows: the runway designators as a signed distance atlas (a cell per end)
and in jfk.json: masts (apron flood light masts), tl_blue (taxiway edge lights), tl_green (taxiway centreline lights).
usage: prep4.py OUT_DIR"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage
OUT = sys.argv[1]
J = json.load(open(f'{OUT}/jfk.json'))
g = json.load(open(f"/root/atc/public/maps/osm/{J['icao']}.geojson"))
U = 10.0; LON0, LAT0 = J['lon0'], J['lat0']
KX = 111320.0 * math.cos(math.radians(LAT0)); KY = 110574.0
FHALF = J['field']['half'] * U; FN = 4096; SS = 2; NN = FN * SS; MPPs = 2 * FHALF / NN
en = lambda q: ((q[0] - LON0) * KX, (q[1] - LAT0) * KY)
px = lambda e, n: ((e + FHALF) / (2 * FHALF) * NN, (FHALF - n) / (2 * FHALF) * NN)
feats = g['features']
def lines(kind):
    return [f['geometry']['coordinates'] for f in feats if f['properties'].get('aeroway') == kind and f['geometry']['type'] == 'LineString']
def polys(kind):
    out = []
    for f in feats:
        if f['properties'].get('aeroway') != kind: continue
        gm = f['geometry']
        if gm['type'] == 'Polygon': out.append(gm['coordinates'][0])
        elif gm['type'] == 'MultiPolygon': out += [p[0] for p in gm['coordinates']]
    return out

# ---------- pavement and aprons, 2x supersampled, as signed distances ----------
pav = Image.new('1', (NN, NN), 0); dp = ImageDraw.Draw(pav)
apr = Image.new('1', (NN, NN), 0); da = ImageDraw.Draw(apr)
for ring in polys('apron'):
    pts = [px(*en(q)) for q in ring]; dp.polygon(pts, fill=1); da.polygon(pts, fill=1)
for c in lines('taxiway'):
    dp.line([px(*en(q)) for q in c], fill=1, width=int(30 / MPPs), joint='curve')  # 23 m + shoulders, as in the game
    for q in c:   # round the joints and ends
        x, y = px(*en(q)); r = 15.0 / MPPs; dp.ellipse([x - r, y - r, x + r, y + r], fill=1)
for r in J['runways']:
    a = np.array(r['a']) * U; b = np.array(r['b']) * U; a[1] *= -1; b[1] *= -1
    d = (b - a) / np.linalg.norm(b - a); nrm = np.array([-d[1], d[0]]); w = r['width'] * U / 2
    dp.polygon([px(*q) for q in (a + nrm * w, b + nrm * w, b - nrm * w, a - nrm * w)], fill=1)
def sdf(img):
    m = np.array(img, dtype=bool)
    d = (ndimage.distance_transform_edt(m) - ndimage.distance_transform_edt(~m)) * MPPs
    d = d.reshape(FN, SS, FN, SS).mean(axis=(1, 3))
    return d
P = sdf(pav); A = sdf(apr)
enc = lambda d: (np.clip(0.5 + d / 32.0, 0, 1) * 255 + 0.5).astype(np.uint8)
print('pavement and apron distance fields')

# ---------- flood light masts: along the apron edges near the terminals, every ~85 m ----------
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
term = unary_union([Polygon([(q[0] * U, -q[1] * U) for q in b['poly']]).buffer(0) for b in J['buildings'] if b['kind'] == 'terminal'])
masts = []
for ring in polys('apron'):
    try: pg = Polygon([en(q) for q in ring]).buffer(0)
    except Exception: continue
    if pg.area < 6000 or pg.distance(term) > 350: continue
    inner = pg.buffer(-6)
    for geom in getattr(inner, 'geoms', [inner]):
        bd = geom.exterior; L = bd.length
        for k in range(int(L // 85)):
            q = bd.interpolate(k * 85 + 20)
            if q.distance(term) > 400: continue
            if any(math.hypot(q.x - m[0], q.y - m[1]) < 55 for m in masts): continue
            masts.append((q.x, q.y))
print('masts', len(masts))
# light pools: gaussians around the masts on a coarse grid, then up to the field size
CN = 1024; cm = 2 * FHALF / CN
yy, xx = np.mgrid[0:CN, 0:CN]; E = (xx + 0.5) * cm - FHALF; Nn = FHALF - (yy + 0.5) * cm
fl = np.zeros((CN, CN))
for (me, mn) in masts:
    i0 = int((FHALF - mn) / cm); j0 = int((me + FHALF) / cm); r = int(150 / cm)
    sl = (slice(max(0, i0 - r), i0 + r), slice(max(0, j0 - r), j0 + r))
    fl[sl] += np.exp(-((E[sl] - me) ** 2 + (Nn[sl] - mn) ** 2) / (2 * 48.0 ** 2))
fl = np.clip(fl / 1.3, 0, 1) ** 0.8
flood = np.array(Image.fromarray((fl * 255).astype(np.uint8)).resize((FN, FN), Image.BICUBIC))
# into the channels the film no longer reads (a shader takes at most 4 textures): fieldB R = pavement, B = flood light,
# fieldA G = aprons
fb = np.array(Image.open(f'{OUT}/media/fieldB.png').convert('RGBA')); fb[..., 0] = enc(P); fb[..., 2] = flood
Image.fromarray(fb, 'RGBA').save(f'{OUT}/media/fieldB.png', optimize=True)
fa = np.array(Image.open(f'{OUT}/media/fieldA.png').convert('RGBA')); fa[..., 1] = enc(A)
Image.fromarray(fa, 'RGBA').save(f'{OUT}/media/fieldA.png', optimize=True)

# ---------- taxiway lights: blue edges just off the pavement, green centrelines (not on aprons or runways) ----------
def sample(arr, e, n):
    j = (e + FHALF) / (2 * FHALF) * FN - 0.5; i = (FHALF - n) / (2 * FHALF) * FN - 0.5
    j = min(max(j, 0), FN - 1.001); i = min(max(i, 0), FN - 1.001); j0, i0 = int(j), int(i); fj, fi = j - j0, i - i0
    return (arr[i0, j0] * (1 - fj) * (1 - fi) + arr[i0, j0 + 1] * fj * (1 - fi) + arr[i0 + 1, j0] * (1 - fj) * fi + arr[i0 + 1, j0 + 1] * fj * fi)
def on_rw(e, n, m):
    x, z = e / U, -n / U
    for r in J['runways']:
        ax, az = r['a']; bx, bz = r['b']; dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz); t = ((x - ax) * dx + (z - az) * dz) / L / L
        if -0.01 < t < 1.01 and abs((x - ax) * dz - (z - az) * dx) / L < r['width'] / 2 + m: return True
    return False
blue, green = [], []
gridB, gridG = {}, {}
def put(lst, grid, e, n, mind):
    k = (int(e // 20), int(n // 20))
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for (qe, qn) in grid.get((k[0] + di, k[1] + dj), []):
                if (qe - e) ** 2 + (qn - n) ** 2 < mind * mind: return
    grid.setdefault(k, []).append((e, n)); lst.append([round(e / U, 2), round(-n / U, 2)])
for c in lines('taxiway'):
    pts = [en(q) for q in c]
    for i in range(len(pts) - 1):
        (e0, n0), (e1, n1) = pts[i], pts[i + 1]; L = math.hypot(e1 - e0, n1 - n0)
        if L < 1: continue
        te, tn = (e1 - e0) / L, (n1 - n0) / L
        for k in range(int(L // 15) + 1):
            s = min(L, k * 15); e, n = e0 + te * s, n0 + tn * s
            if sample(A, e, n) < -3 and not on_rw(e, n, 0.6): put(green, gridG, e, n, 9)
            if k % 2: continue
            for side in (-1, 1):
                be, bn = e - tn * side * 16.0, n + te * side * 16.0
                d = sample(P, be, bn)
                if -3.5 < d < 0.8 and sample(A, be, bn) < -4 and not on_rw(be, bn, 1.0): put(blue, gridB, be, bn, 14)
print('taxiway lights: blue', len(blue), 'green', len(green))
J['masts'] = [[round(m[0] / U, 2), round(-m[1] / U, 2)] for m in masts]
J['tl_blue'] = blue; J['tl_green'] = green

# ---------- runway designators: a signed-distance atlas, one cell per runway end (a then b), 3.0 x 4.4 units each ----------
CW, CH, K = 256, 376, 4
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 400)
cells = []
for r in J['runways']:
    for lab in (r['lo'], r['hi']):
        lab = lab.lstrip('0'); num = ''.join(ch for ch in lab if ch.isdigit()); let = lab[len(num):]
        im = Image.new('L', (CW * K, CH * K), 0); dr = ImageDraw.Draw(im)
        def box(txt, y0, y1):   # fit txt into rows y0..y1 (from the top), centred, narrowed like runway lettering
            bb = dr.textbbox((0, 0), txt, font=font); tw, th = bb[2] - bb[0], bb[3] - bb[1]
            t = Image.new('L', (tw, th), 0); ImageDraw.Draw(t).text((-bb[0], -bb[1]), txt, font=font, fill=255)
            h = y1 - y0; w = min(int(tw * h / th * 0.78), CW * K - 8); t = t.resize((w, h), Image.LANCZOS)
            im.paste(t, ((CW * K - w) // 2, y0), t)
        unit = CH * K / 4.4
        if let: box(num, 0, int(1.83 * unit)); box(let, int(2.43 * unit), int(4.26 * unit))
        else: box(num, int(1.2 * unit), int(3.03 * unit))
        m = np.array(im) > 127
        d = (ndimage.distance_transform_edt(m) - ndimage.distance_transform_edt(~m)) / (K * CW / 3.0)   # units
        d = d.reshape(CH, K, CW, K).mean(axis=(1, 3))
        cells.append((np.clip(0.5 + d / 0.5, 0, 1) * 255 + 0.5).astype(np.uint8))
atlas = np.hstack(cells)   # 8 cells x 256 = 2048 wide: the top rows of region.png's G channel (the coast, unused)
rg = np.array(Image.open(f'{OUT}/media/region.png').convert('RGBA')); rg[:CH, :atlas.shape[1], 1] = atlas
Image.fromarray(rg, 'RGBA').save(f'{OUT}/media/region.png', optimize=True)
print('designators', [(r['lo'], r['hi']) for r in J['runways']])
json.dump(J, open(f'{OUT}/jfk.json', 'w'))
