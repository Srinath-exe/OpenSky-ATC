import json, math, sys
import numpy as np
from PIL import Image
OUT = sys.argv[1]
J = json.load(open(f'{OUT}/jfk.json'))
g = json.load(open('/root/atc/public/maps/osm/KJFK.geojson'))
U = 10.0; LON0, LAT0 = J['lon0'], J['lat0']
KX = 111320.0 * math.cos(math.radians(LAT0)); KY = 110574.0
su = lambda q: ((q[0] - LON0) * KX / U, -(q[1] - LAT0) * KY / U)
# low-res field for far views: area-averaged, lines boosted
A = Image.open(f'{OUT}/media/fieldA.png'); B = Image.open(f'{OUT}/media/fieldB.png')
a = np.array(A).astype(np.float32); b = np.array(B).astype(np.float32)
def down(x, n=512): return np.array(Image.fromarray(x.astype(np.uint8)).resize((n, n), Image.BOX)).astype(np.float32)
lo = np.dstack([np.clip(down(a[..., 0]) * 3.0, 0, 255), down(a[..., 1]), np.clip(down(np.maximum(a[..., 2], b[..., 2])), 0, 255), down(a[..., 3])])
Image.fromarray(lo.astype(np.uint8), 'RGBA').save(f'{OUT}/media/fieldLo.png')
# taxiway edge lights (blue), every 60 m, 11.5 m either side
edge = []
for f in g['features']:
    p = f['properties']
    if p.get('aeroway') != 'taxiway' or f['geometry']['type'] != 'LineString': continue
    pts = [su(q) for q in f['geometry']['coordinates']]
    acc = 3.0
    for i in range(len(pts) - 1):
        x0, z0 = pts[i]; x1, z1 = pts[i + 1]; L = math.hypot(x1 - x0, z1 - z0)
        if L < 1e-6: continue
        ux, uz = (x1 - x0) / L, (z1 - z0) / L; nx, nz = -uz, ux
        s = acc
        while s < L:
            for side in (-1, 1): edge.append([round(x0 + ux * s + nx * side * 1.15, 2), round(z0 + uz * s + nz * side * 1.15, 2)])
            s += 6.0
        acc = s - L
# drop edge lights that fall on a runway
def on_rw(x, z):
    for r in J['runways']:
        ax, az = r['a']; bx, bz = r['b']; dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz); t = ((x - ax) * dx + (z - az) * dz) / L / L
        if -0.02 < t < 1.02 and abs((x - ax) * dz - (z - az) * dx) / L < r['width'] * 0.5 + 1.5: return True
    return False
edge = [e for e in edge if not on_rw(*e)]
# stand spacing
P = np.array([s['p'] for s in J['stands']])
for i, s in enumerate(J['stands']):
    d = np.hypot(*(P - P[i]).T); d[i] = 1e9; s['nn'] = round(float(d.min()), 2)
J['taxi_edge'] = edge
json.dump(J, open(f'{OUT}/jfk.json', 'w'))
print('edge lights', len(edge), 'stands nn median', float(np.median([s['nn'] for s in J['stands']])))
# taxiway centrelines for the 3D ribbons
J = json.load(open(f'{OUT}/jfk.json'))
J['taxi_lines'] = [[[round(v, 2) for v in su(q)] for q in f['geometry']['coordinates']] for f in g['features'] if f['properties'].get('aeroway') == 'taxiway' and f['geometry']['type'] == 'LineString']
json.dump(J, open(f'{OUT}/jfk.json', 'w'))
