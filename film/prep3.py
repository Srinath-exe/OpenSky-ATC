"""The loop's ground story: the hero's taxi-in to its stand, the departure across the apron and its route to the
runway, with the taxiway names along each route (for the controller's instruction). Adds J['story'] to jfk.json.
usage: prep3.py OUT_DIR HERO_STAND DEP_STAND [OTHER_STAND ...]"""
import json, math, heapq, sys
OUT, HERO, DEP, *OTHERS = sys.argv[1:]
J = json.load(open(f'{OUT}/jfk.json'))
g = json.load(open(f"/root/atc/public/maps/osm/{J['icao']}.geojson"))
U = 10.0; LON0, LAT0 = J['lon0'], J['lat0']
KX = 111320.0 * math.cos(math.radians(LAT0)); KY = 110574.0
su = lambda q: ((q[0] - LON0) * KX / U, -(q[1] - LAT0) * KY / U)
nodes, adj, ref = {}, {}, {}
def nid(q):
    k = (round(q[0], 7), round(q[1], 7))
    if k not in nodes: nodes[k] = su(k); adj[k] = []
    return k
taxi = set()
for f in g['features']:
    p = f['properties']; aw = p.get('aeroway')
    if aw not in ('taxiway', 'runway') or f['geometry']['type'] != 'LineString': continue
    c = f['geometry']['coordinates']
    for i in range(len(c) - 1):
        a, b = nid(c[i]), nid(c[i + 1]); d = math.dist(nodes[a], nodes[b]) * (1 if aw == 'taxiway' else 8)
        adj[a].append((b, d)); adj[b].append((a, d))
        ref[(a, b)] = ref[(b, a)] = p.get('ref') if aw == 'taxiway' else ('RWY ' + (p.get('ref') or ''))
        if aw == 'taxiway': taxi.update((a, b))
def nearest(x, z):
    return min(taxi, key=lambda k: (nodes[k][0] - x) ** 2 + (nodes[k][1] - z) ** 2)
def route(p0, p1):
    s, t = nearest(*p0), nearest(*p1)
    dist, prev, pq = {s: 0.0}, {}, [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == t: break
        if d > dist.get(u, 1e18): continue
        for v, w in adj[u]:
            if d + w < dist.get(v, 1e18): dist[v] = d + w; prev[v] = u; heapq.heappush(pq, (d + w, v))
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    path.reverse()
    runs = []   # [name, start point, length m]
    for a, b in zip(path, path[1:]):
        n = ref.get((a, b)); L = math.dist(nodes[a], nodes[b]) * U
        if runs and runs[-1][0] == n: runs[-1][2] += L
        else: runs.append([n, [round(v, 2) for v in nodes[a]], L])
    names = []
    for n, p0, L in runs:   # what a controller would say: the long stretches, in order, no repeats in a row
        if n and L >= 140 and not n.startswith('RWY') and (not names or names[-1][0] != n): names.append([n, p0])
    return [[round(v, 2) for v in nodes[k]] for k in path], names
# the arrivals' exit: a taxiway that leaves the runway at a shallow angle on the terminal side (a high-speed exit),
# taken from its runway end until it is clear of the runway
arw = next(r for r in J['runways'] if r['ref'] == J['arr']['ref'])
athr = arw[J['arr']['end']]; aoth = arw['a' if J['arr']['end'] == 'b' else 'b']
RL = math.dist(athr, aoth); adl = ((aoth[0] - athr[0]) / RL, (aoth[1] - athr[1]) / RL); anrm = (-adl[1], adl[0])
tside = 1 if (J['tower'][0] - athr[0]) * anrm[0] + (J['tower'][1] - athr[1]) * anrm[1] > 0 else -1
best = None
for f in g['features']:
    p = f['properties']
    if p.get('aeroway') != 'taxiway' or f['geometry']['type'] != 'LineString': continue
    pts = [su(q) for q in f['geometry']['coordinates']]
    for end in (0, -1):
        seq = pts if end == 0 else pts[::-1]
        q = seq[0]; a = (q[0] - athr[0]) * adl[0] + (q[1] - athr[1]) * adl[1]; off = (q[0] - athr[0]) * anrm[0] + (q[1] - athr[1]) * anrm[1]
        if abs(off) > 3.5 or not (140 < a < RL - 40): continue
        k = min(4, len(seq) - 1); d = (seq[k][0] - q[0], seq[k][1] - q[1]); dn = math.hypot(*d) or 1
        ang = math.degrees(math.acos(max(-1, min(1, (d[0] * adl[0] + d[1] * adl[1]) / dn))))
        sgn = (seq[k][0] - athr[0]) * anrm[0] + (seq[k][1] - athr[1]) * anrm[1]
        if sgn * tside <= 0 or ang > 60: continue
        cut = next((i for i, w in enumerate(seq) if abs((w[0] - athr[0]) * anrm[0] + (w[1] - athr[1]) * anrm[1]) > 9), len(seq) - 1)
        cand = (abs(a - 200) + ang * 2, p.get('ref'), a, ang, [[round(w[0], 2), round(w[1], 2)] for w in seq[:cut + 1]])
        if best is None or cand[0] < best[0]: best = cand
_, xref, xs, xang, xpath = best
print('exit', xref, 'at', round(xs), 'units, angle', round(xang), 'deg,', len(xpath), 'points')
J['exit2'] = {'ref': xref, 's': xs, 'path': xpath}
stand = {s['ref']: s for s in J['stands'] if s['ref'] and s['lead']}
dep_rw = next(r for r in J['runways'] if r['ref'] == J['dep']['ref'])
thr = dep_rw[J['dep']['end']]
story = {}
h = stand[HERO]; r, n = route(xpath[-1], h['lead'][0])
story['hero'] = {'exit': xref, 'stand': HERO, 'p': h['p'], 'hdg': h['hdg'], 'lead': h['lead'], 'route': r, 'names': n}
d = stand[DEP]; r, n = route(d['lead'][0], thr)
story['dep'] = {'stand': DEP, 'p': d['p'], 'hdg': d['hdg'], 'lead': d['lead'], 'route': r, 'names': n}
# the departure's runway holding position: the last OSM holding line its route crosses (its stop bar)
def xing(a, b, c, d):
    cr = lambda o, p, q: (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    return (cr(a, b, c) > 0) != (cr(a, b, d) > 0) and (cr(c, d, a) > 0) != (cr(c, d, b) > 0)
hold = None
R = story['dep']['route']
for f in g['features']:
    if f['properties'].get('aeroway') != 'holding_position' or f['geometry']['type'] != 'LineString': continue
    hp = [su(q) for q in f['geometry']['coordinates']]
    for i in range(len(R) - 1):
        if any(xing(R[i], R[i + 1], hp[j], hp[j + 1]) for j in range(len(hp) - 1)) and (hold is None or i >= hold[0]):
            hold = (i, [[round(v, 2) for v in hp[0]], [round(v, 2) for v in hp[-1]]])
story['dep']['hold'] = hold[1] if hold else None
print('dep hold bar', story['dep']['hold'])
story['others'] = []
if OTHERS == ['auto']:   # the other arrivals' stands: routes that never come near the departure's, spread over the field
    dpts = story['dep']['route'] + d['lead']
    hp = [story['hero']['p'], story['dep']['p']]
    cand = []
    for sref, s in stand.items():
        if any(math.dist(s['p'], q) < 12 for q in hp): continue
        r, n = route(xpath[-1], s['lead'][0])
        Lm = sum(math.dist(a, b) for a, b in zip(r, r[1:])) * U
        if not 700 < Lm < 3500: continue
        if min(math.dist(a, b) for a in r + s['lead'] for b in dpts) < 5: continue
        cand.append(sref)
    OTHERS = []
    while cand and len(OTHERS) < 3:
        pick = max(cand, key=lambda c: min([math.dist(stand[c]['p'], stand[o]['p']) for o in OTHERS] + [math.dist(stand[c]['p'], story['hero']['p'])]))
        OTHERS.append(pick); cand.remove(pick)
    print('others', OTHERS)
for o in OTHERS:
    s = stand[o]; r, n = route(xpath[-1], s['lead'][0])
    story['others'].append({'stand': o, 'p': s['p'], 'hdg': s['hdg'], 'lead': s['lead'], 'route': r, 'names': n})
J['story'] = story
json.dump(J, open(f'{OUT}/jfk.json', 'w'))
L = lambda pts: sum(math.dist(a, b) for a, b in zip(pts, pts[1:])) * U
print('hero', HERO, round(L(story['hero']['route'])), 'm via', [x[0] for x in story['hero']['names']])
print('dep', DEP, round(L(story['dep']['route'])), 'm via', [x[0] for x in story['dep']['names']])
for o in story['others']: print('other', o['stand'], round(L(o['route'])), 'm')
