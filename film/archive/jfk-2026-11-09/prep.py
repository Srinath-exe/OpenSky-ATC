"""JFK -> raea scene data.

Reads the game's own OSM aeroway GeoJSON and the world bake (height map, roads) and writes, into work/media:
  fieldA.png  R taxiway centreline, G runway surface, B pavement, A reveal time (geodesic from the tower)
  fieldB.png  R runway markings, G hold-short bars, B building footprints, A stand lead-in lines
  region.png  R water, G coastline, B major roads, A minor roads
and work/jfk.json (geometry in scene units: 1 unit = 10 m, x east, z south (-north), y up).
"""
import json, math, heapq, sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = '/root/atc/public'
OUT = sys.argv[1]
U = 10.0  # metres per scene unit

g = json.load(open(f'{ROOT}/maps/osm/KJFK.geojson'))
feats = g['features']

# reference: the middle of the runway system
rw_pts = [c for f in feats if f['properties'].get('aeroway') == 'runway' for c in f['geometry']['coordinates']]
LON0 = (min(p[0] for p in rw_pts) + max(p[0] for p in rw_pts)) / 2
LAT0 = (min(p[1] for p in rw_pts) + max(p[1] for p in rw_pts)) / 2
KX = 111320.0 * math.cos(math.radians(LAT0)); KY = 110574.0

def en(lon, lat):  # metres east, north
    return ((lon - LON0) * KX, (lat - LAT0) * KY)

def su(lon, lat):  # scene units [x, z]
    e, n = en(lon, lat); return [round(e / U, 3), round(-n / U, 3)]

# ---------- field textures ----------
FN = 4096; FHALF = 3600.0  # metres: the field texture covers +-3.6 km around the reference
def fpx(e, n):
    return ((e + FHALF) / (2 * FHALF) * FN, (FHALF - n) / (2 * FHALF) * FN)
MPP = 2 * FHALF / FN

def lines_of(kind, gtype='LineString'):
    out = []
    for f in feats:
        p = f['properties']
        if p.get('aeroway') != kind: continue
        gm = f['geometry']
        if gm['type'] == gtype: out.append((p, gm['coordinates']))
    return out

def polys_of(kinds):
    out = []
    for f in feats:
        p = f['properties']
        if p.get('aeroway') not in kinds: continue
        gm = f['geometry']
        if gm['type'] == 'Polygon': out.append((p, gm['coordinates'][0]))
        elif gm['type'] == 'MultiPolygon':
            for poly in gm['coordinates']: out.append((p, poly[0]))
    return out

# runways merged by ref (13L/31R comes in two pieces)
rw = {}
for p, c in lines_of('runway'):
    rw.setdefault(p['ref'], []).append([en(*q) for q in c])
WIDTH = {'13L/31R': 46, '04L/22R': 61, '04R/22L': 61, '13R/31L': 61}
runways = []
for ref, pieces in rw.items():
    pts = [q for pc in pieces for q in pc]
    # the two ends: the farthest pair
    best = (0, None, None)
    for a in pts:
        for b in pts:
            d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
            if d > best[0]: best = (d, a, b)
    a, b = best[1], best[2]
    lo, hi = ref.split('/')
    # 'lo' (e.g. 13L) threshold is where an aircraft landing on 13L touches down: it flies heading ~130, so the
    # 13L end is the NW end. heading from a to b:
    hdg = (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360
    num = int(lo[:2]) * 10
    if abs(((hdg - num + 180) % 360) - 180) > 90: a, b = b, a  # a = the lo end (landing lo goes a -> b)
    runways.append({'ref': ref, 'lo': lo, 'hi': hi, 'a': [a[0] / U, -a[1] / U], 'b': [b[0] / U, -b[1] / U],
                    'width': WIDTH.get(ref, 46) / U})

A = Image.new('L', (FN, FN), 0); dA = ImageDraw.Draw(A)  # taxi centreline
Gr = Image.new('L', (FN, FN), 0); dG = ImageDraw.Draw(Gr)  # runway surface
Bp = Image.new('L', (FN, FN), 0); dB = ImageDraw.Draw(Bp)  # pavement
Mk = Image.new('L', (FN, FN), 0); dM = ImageDraw.Draw(Mk)  # runway markings
Hs = Image.new('L', (FN, FN), 0); dH = ImageDraw.Draw(Hs)  # hold short
Bd = Image.new('L', (FN, FN), 0); dD = ImageDraw.Draw(Bd)  # buildings
St = Image.new('L', (FN, FN), 0); dS = ImageDraw.Draw(St)  # stand lead-ins

for p, ring in polys_of({'apron'}):
    dB.polygon([fpx(*en(*q)) for q in ring], fill=110)
for p, c in lines_of('taxiway'):
    dB.line([fpx(*en(*q)) for q in c], fill=110, width=max(2, int(23 / MPP)), joint='curve')
for r in runways:
    a = np.array(r['a']) * U * np.array([1, -1]); b = np.array(r['b']) * U * np.array([1, -1])
    d = (b - a) / np.linalg.norm(b - a); nrm = np.array([-d[1], d[0]]); w = r['width'] * U / 2
    L = np.linalg.norm(b - a)
    quad = [a + nrm * w, b + nrm * w, b - nrm * w, a - nrm * w]
    dG.polygon([fpx(*q) for q in quad], fill=255)
    dB.polygon([fpx(*q) for q in quad], fill=110)
    # markings: centreline dashes (36 m dash, 24 m gap), threshold piano keys, aiming points, touchdown zone bars
    s = 60.0
    while s < L - 60:
        p0 = a + d * s; p1 = a + d * min(s + 36, L - 60)
        dM.line([fpx(*p0), fpx(*p1)], fill=255, width=max(1, int(1.2 / MPP)))
        s += 60
    for end, dd in ((a, d), (b, -d)):
        nn = np.array([-dd[1], dd[0]])
        for k in range(-8, 9):
            if k == 0: continue
            off = nn * (k * w / 9.2)
            dM.line([fpx(*(end + dd * 6 + off)), fpx(*(end + dd * 51 + off))], fill=255, width=max(1, int(1.8 / MPP)))
        for side in (-1, 1):  # aiming point blocks at 400 m
            off = nn * side * w * 0.42
            dM.line([fpx(*(end + dd * 400 + off)), fpx(*(end + dd * 460 + off))], fill=255, width=max(2, int(9 / MPP)))
            for z in (150, 300, 600, 750, 900):
                for t in (0.62, 0.78):
                    o2 = nn * side * w * t
                    dM.line([fpx(*(end + dd * z + o2)), fpx(*(end + dd * (z + 22) + o2))], fill=230, width=max(1, int(1.8 / MPP)))
    # edge stripes
    for side in (-1, 1):
        off = nrm * side * (w - 1.0)
        dM.line([fpx(*(a + off)), fpx(*(b + off))], fill=200, width=1)

for p, c in lines_of('holding_position'):
    dH.line([fpx(*en(*q)) for q in c], fill=255, width=max(2, int(3 / MPP)))
for p, c in lines_of('parking_position'):
    dS.line([fpx(*en(*q)) for q in c], fill=255, width=1)

bld = []
for p, ring in polys_of({'terminal', 'hangar'}):
    pts = [fpx(*en(*q)) for q in ring]
    dD.polygon(pts, fill=255)
    poly = [su(*q) for q in ring]
    if poly[0] == poly[-1]: poly = poly[:-1]
    # signed area: keep counter-clockwise in (x, -z) i.e. north-up
    area = sum(poly[i][0] * (-poly[(i + 1) % len(poly)][1]) - poly[(i + 1) % len(poly)][0] * (-poly[i][1]) for i in range(len(poly))) / 2
    if abs(area) < 4: continue  # < 400 m2
    if area < 0: poly = poly[::-1]
    h = 2.2 if p.get('aeroway') == 'terminal' else 1.8
    bld.append({'kind': p.get('aeroway'), 'name': p.get('name'), 'h': h, 'poly': poly, 'area': abs(area)})

# ---------- taxi graph + geodesic reveal ----------
nodes = {}; adj = {}
def nid(q):
    k = (round(q[0], 7), round(q[1], 7))
    if k not in nodes: nodes[k] = en(*k); adj[k] = []
    return k
def add_line(c, mult=1.0):
    for i in range(len(c) - 1):
        a, b = nid(c[i]), nid(c[i + 1])
        d = math.dist(nodes[a], nodes[b]) * mult
        adj[a].append((b, d)); adj[b].append((a, d))
for p, c in lines_of('taxiway'): add_line(c)
for p, c in lines_of('runway'): add_line(c, 6.0)

def dijkstra(src):
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18): continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    return dist, prev

# tower: centroid of the terminals (stylised position in the central terminal area)
term = [b for b in bld if b['kind'] == 'terminal']
tx = sum(sum(q[0] for q in b['poly']) / len(b['poly']) * b['area'] for b in term) / sum(b['area'] for b in term)
tz = sum(sum(q[1] for q in b['poly']) / len(b['poly']) * b['area'] for b in term) / sum(b['area'] for b in term)
tower = [round(tx, 2), round(tz, 2)]
te, tn = tx * U, -tz * U
def nearest_node(e, n, pool=None):
    best = None
    for k in (pool or nodes):
        d = (nodes[k][0] - e) ** 2 + (nodes[k][1] - n) ** 2
        if best is None or d < best[0]: best = (d, k)
    return best[1]
taxi_nodes = set()
for p, c in lines_of('taxiway'):
    for q in c: taxi_nodes.add((round(q[0], 7), round(q[1], 7)))
src = nearest_node(te, tn, taxi_nodes)
dist, _ = dijkstra(src)
dmax = max(v for k, v in dist.items() if k in taxi_nodes and v < 1e17)

R = Image.new('L', (FN, FN), 0); dR = ImageDraw.Draw(R)
# everything else: straight-line distance from the tower, a little later than the network
yy, xx = np.mgrid[0:FN, 0:FN]
ee = xx / FN * 2 * FHALF - FHALF; nnn = FHALF - yy / FN * 2 * FHALF
eu = np.hypot(ee - te, nnn - tn) / dmax * 1.05
reveal = np.clip(eu, 0, 1)
for p, c in lines_of('taxiway'):
    for i in range(len(c) - 1):
        a, b = nid(c[i]), nid(c[i + 1])
        da, db = dist.get(a, dmax), dist.get(b, dmax)
        pa, pb = nodes[a], nodes[b]
        L = math.dist(pa, pb); n = max(1, int(L / 8))
        for j in range(n):
            t0, t1 = j / n, (j + 1) / n
            q0 = (pa[0] + (pb[0] - pa[0]) * t0, pa[1] + (pb[1] - pa[1]) * t0)
            q1 = (pa[0] + (pb[0] - pa[0]) * t1, pa[1] + (pb[1] - pa[1]) * t1)
            v = (da + (db - da) * (t0 + t1) / 2) / dmax
            dR.line([fpx(*q0), fpx(*q1)], fill=max(1, min(255, int(v * 254) + 1)), width=9)
Rn = np.array(R).astype(np.float32)
reveal = np.where(Rn > 0, Rn / 255.0, reveal)

def blur(im, r):
    return im.filter(ImageFilter.GaussianBlur(r)) if r > 0 else im
for p, c in lines_of('taxiway'):
    dA.line([fpx(*en(*q)) for q in c], fill=255, width=3, joint='curve')
A = blur(A, 0.8)
fieldA = np.dstack([np.array(A), np.array(blur(Gr, 0.6)), np.array(blur(Bp, 1.2)), (reveal * 255).astype(np.uint8)])
if os.environ.get('FIELD'): Image.fromarray(fieldA, 'RGBA').save(f'{OUT}/media/fieldA.png', optimize=True)
fieldB = np.dstack([np.array(blur(Mk, 0.5)), np.array(blur(Hs, 0.6)), np.array(blur(Bd, 0.8)), np.array(blur(St, 0.5))])
if os.environ.get('FIELD'): Image.fromarray(fieldB, 'RGBA').save(f'{OUT}/media/fieldB.png', optimize=True)

# ---------- region texture ----------
meta = json.load(open(f'{ROOT}/world/KJFK/meta.json'))
bb = meta['bbox']
sw = en(bb['minLng'], bb['minLat']); ne = en(bb['maxLng'], bb['maxLat'])
RN = 2048
him = np.array(Image.open(f'{ROOT}/world/KJFK/height.png').convert('RGBA')).astype(np.float64)
h = meta['hMin'] + (him[..., 0] * 256 + him[..., 1]) * (meta['hMax'] - meta['hMin']) / 65535
water = Image.fromarray(((h < 0.25) * 255).astype(np.uint8)).resize((RN, RN), Image.BILINEAR)
# the airport itself is flattened to 0 in the bake: not water
wa = np.array(water).astype(np.float32)
ry, rx = np.mgrid[0:RN, 0:RN]
re = sw[0] + rx / RN * (ne[0] - sw[0]); rn = ne[1] - ry / RN * (ne[1] - sw[1])
# the airport itself is flattened to 0 in the bake: not water. Land = pavement grown by ~300 m.
pav = Bp.resize((512, 512), Image.BILINEAR).filter(ImageFilter.MaxFilter(43)).filter(ImageFilter.GaussianBlur(4))
pav = np.array(pav).astype(np.float32) / 255
fi = np.clip(((re + FHALF) / (2 * FHALF) * 512).astype(int), 0, 511); fj = np.clip(((FHALF - rn) / (2 * FHALF) * 512).astype(int), 0, 511)
infield = (np.abs(re) < FHALF) & (np.abs(rn) < FHALF)
land = np.where(infield, pav[fj, fi], 0) > 0.25
wa = np.where(land, 0, wa)
water = blur(Image.fromarray(wa.astype(np.uint8)), 1.5)
wf = np.array(water).astype(np.float32) / 255
gy, gx = np.gradient(np.array(blur(water, 3)).astype(np.float32) / 255)
coast = np.clip(np.hypot(gx, gy) * 18, 0, 1)
def rpx(lon, lat):
    e, n = en(lon, lat)
    return ((e - sw[0]) / (ne[0] - sw[0]) * RN, (ne[1] - n) / (ne[1] - sw[1]) * RN)
vec = json.load(open(f'{ROOT}/world/KJFK/vectors.json'))
Rm = Image.new('L', (RN, RN), 0); dRm = ImageDraw.Draw(Rm)
Rs = Image.new('L', (RN, RN), 0); dRs = ImageDraw.Draw(Rs)
for kind, lines in vec['roads'].items():
    for c in lines:
        pts = [rpx(*q) for q in c]
        if len(pts) < 2: continue
        if kind in ('motorway', 'trunk'): dRm.line(pts, fill=255, width=2)
        elif kind in ('primary', 'secondary'): dRs.line(pts, fill=170, width=1)
region = np.dstack([(wf * 255).astype(np.uint8), (coast * 255).astype(np.uint8), np.array(blur(Rm, 0.6)), np.array(blur(Rs, 0.5))])
Image.fromarray(region, 'RGBA').save(f'{OUT}/media/region.png', optimize=True)

# ---------- stands with headings, routes ----------
pp = lines_of('parking_position')
stands = []
for f in feats:
    p = f['properties']
    if p.get('aeroway') != 'stand' or f['geometry']['type'] != 'Point': continue
    se, sn = en(*f['geometry']['coordinates'])
    best = None
    for _, c in pp:
        for end in (0, -1):
            q = en(*c[end]); d = math.dist(q, (se, sn))
            if best is None or d < best[0]: best = (d, c, end)
    if best is None or best[0] > 45: continue
    c, end = best[1], best[2]
    near = en(*c[end]); far = en(*c[-1 if end == 0 else 0])
    hdg = math.atan2(near[0] - far[0], near[1] - far[1])  # radians, 0 = north, clockwise
    stands.append({'ref': p.get('ref'), 'p': [round(se / U, 2), round(-sn / U, 2)], 'hdg': round(hdg, 4),
                   'lead': [su(*q) for q in (c if end == len(c) - 1 or end == -1 else c[::-1])]})

def route(e0, n0, e1, n1):
    s = nearest_node(e0, n0, taxi_nodes); t = nearest_node(e1, n1, taxi_nodes)
    dist, prev = dijkstra(s)
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    path.reverse()
    return [[round(nodes[k][0] / U, 2), round(-nodes[k][1] / U, 2)] for k in path]

json.dump({'unit_m': U, 'lon0': LON0, 'lat0': LAT0,
           'field': {'half': FHALF / U}, 'region': {'minX': sw[0] / U, 'maxX': ne[0] / U, 'minZ': -ne[1] / U, 'maxZ': -sw[1] / U},
           'runways': runways, 'buildings': bld, 'tower': tower, 'stands': stands,
           'taxi_nodes': len(taxi_nodes), 'taxiways': len(lines_of('taxiway')), 'holds': sum(1 for f in feats if f['properties'].get('aeroway') == 'holding_position'),
           'stand_count': sum(1 for f in feats if f['properties'].get('aeroway') == 'stand'),
           'graph_nodes': {f'{nodes[k][0]/U:.2f},{-nodes[k][1]/U:.2f}': 1 for k in taxi_nodes} if False else None},
          open(f'{OUT}/jfk.json', 'w'))
print('runways', [(r['ref'], r['a'], r['b']) for r in runways])
print('buildings', len(bld), 'stands', len(stands), 'tower', tower, 'dmax m', round(dmax))
print('region units', sw[0] / U, ne[0] / U, -ne[1] / U, -sw[1] / U)

# ---------- taxi routes for the scripted aircraft ----------
def route_units(p0, p1):
    s = nearest_node(p0[0] * U, -p0[1] * U, taxi_nodes); t = nearest_node(p1[0] * U, -p1[1] * U, taxi_nodes)
    dist, prev = dijkstra(s)
    if t not in dist: return []
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    path.reverse()
    return [[round(nodes[k][0] / U, 2), round(-nodes[k][1] / U, 2)] for k in path]

r31R = next(r for r in runways if r['ref'] == '13L/31R')
r31L = next(r for r in runways if r['ref'] == '13R/31L')
def along(r, frm, d):  # point d units from end `frm` ('a' or 'b') toward the other end
    p0 = np.array(r[frm]); p1 = np.array(r['b' if frm == 'a' else 'a']); u = (p1 - p0) / np.linalg.norm(p1 - p0)
    return (p0 + u * d).tolist()
# arrival exit: the first taxiway node on the terminal (south) side ~1.7-2.3 km past the 31R threshold
exit_pt = None
p0 = np.array(r31R['b']); dl = (np.array(r31R['a']) - p0); Lr = np.linalg.norm(dl); dl /= Lr
nrm = np.array([-dl[1], dl[0]])
best = None
for k in taxi_nodes:
    q = np.array([nodes[k][0] / U, -nodes[k][1] / U]) - p0
    s_al = q @ dl; off = q @ nrm
    if 150 < s_al < 230 and 4 < abs(off) < 12:
        side = np.sign(off)
        cand = (abs(s_al - 190), (p0 + dl * s_al).tolist(), [nodes[k][0] / U, -nodes[k][1] / U], side, s_al)
        # prefer the side the terminals are on
        tw = np.array(tower) - p0
        if np.sign(tw @ nrm) == side and (best is None or cand[0] < best[0]): best = cand
exit_info = {'runway_pt': best[1], 'node': best[2], 's': best[4]}
tw = np.array(tower)
near_stands = sorted([s for s in stands if s['lead']], key=lambda s: np.linalg.norm(np.array(s['p']) - tw))
def lead_start(s): return s['lead'][0]
arr_routes = []
for st in near_stands[2:5]:
    arr_routes.append({'stand': st['ref'], 'p': st['p'], 'hdg': st['hdg'], 'route': route_units(exit_info['node'], lead_start(st)), 'lead': st['lead']})
thr31L = r31L['b']
far_stands = sorted([s for s in stands if s['lead']], key=lambda s: -np.linalg.norm(np.array(s['p']) - np.array(thr31L)))
dep_routes = []
for st in [near_stands[0], far_stands[5], near_stands[8], far_stands[25]]:
    dep_routes.append({'stand': st['ref'], 'p': st['p'], 'hdg': st['hdg'], 'lead': st['lead'], 'route': route_units(lead_start(st), thr31L)})
J = json.load(open(f'{OUT}/jfk.json'))
J['exit'] = exit_info; J['arr_routes'] = arr_routes; J['dep_routes'] = dep_routes
json.dump(J, open(f'{OUT}/jfk.json', 'w'))
print('exit', exit_info, [len(r['route']) for r in arr_routes], [len(r['route']) for r in dep_routes])
