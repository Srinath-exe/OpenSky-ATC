#!/usr/bin/env python3
"""Shared runway extraction for the generator scripts (gen_runway_manifest.py,
gen_airspace.py). Mirrors src/lib/osmAirport.ts EXACTLY:

  * every OSM runway LineString with a designator ref ("09R/27L") is a physical
    runway; split / duplicate ways with the same ref and unnamed collinear
    stubs (≤ 20 m off the main way's line, abutting within 40 m) are merged
    into ONE runway whose ends are the extreme vertices along the axis
  * the end whose designator ×10 (magnetic — the airport variation is applied)
    matches the bearing FROM that end TO the other gets that name
  * displaced thresholds are read from way splits only when the main way covers
    ≥ 70 % of the runway and the extension is ≤ 320 m (informational)

Keep this file and osmAirport.ts in sync; tests/data/airportData.test.ts
cross-checks the emitted manifest against the TypeScript builder.
"""
import json, math, os, sys

R = 6371000.0
D2R = math.pi / 180

# Fallback magnetic variation, degrees east-positive (same table as osmAirport.ts).
MAGVAR_FALLBACK = {'EGLL': 0.5, 'KLAX': 11.5, 'KJFK': -12.7, 'KSFO': 13.2, 'KBOS': -14.2, 'VIDP': 0.9}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSM_DIR = os.path.join(ROOT, 'public', 'maps', 'osm')


def bearing(lng1, lat1, lng2, lat2):
    dlng = (lng2 - lng1) * D2R
    lat1r, lat2r = lat1 * D2R, lat2 * D2R
    y = math.sin(dlng) * math.cos(lat2r)
    x = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlng)
    return (math.atan2(y, x) * 180 / math.pi + 360) % 360


def dist_m(lng1, lat1, lng2, lat2):
    dlat = (lat2 - lat1) * D2R
    dlng = (lng2 - lng1) * D2R
    mid = (lat1 + lat2) / 2 * D2R
    return math.hypot(dlat * R, dlng * R * math.cos(mid))


def ang_diff(a, b):
    return abs(((a - b) % 360 + 540) % 360 - 180)


def advance(lng, lat, hdg, m):
    dn = math.cos(hdg * D2R) * m
    de = math.sin(hdg * D2R) * m
    return (lng + de / (R * D2R * math.cos(lat * D2R)), lat + dn / (R * D2R))


class Frame:
    def __init__(self, center_lng, center_lat):
        self.c = (center_lng, center_lat)
        self.kx = R * math.cos(center_lat * D2R) * D2R
        self.ky = R * D2R

    def xy(self, lng, lat):
        return ((lng - self.c[0]) * self.kx, (lat - self.c[1]) * self.ky)


def is_rwy_ref(ref):
    if not ref or '/' not in ref:
        return False
    parts = [p.strip() for p in ref.split('/')]
    if len(parts) != 2:
        return False
    for p in parts:
        digits = ''.join(c for c in p if c.isdigit())
        rest = p[len(digits):]
        if not digits or len(digits) > 2 or rest not in ('', 'L', 'R', 'C'):
            return False
        n = int(digits)
        if n < 1 or n > 36:
            return False
    return True


def seg_len(cs):
    return sum(dist_m(cs[i][0], cs[i][1], cs[i + 1][0], cs[i + 1][1]) for i in range(len(cs) - 1))


def load_geojson(icao):
    path = os.path.join(OSM_DIR, f'{icao}.geojson')
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def runways_for(icao, magvar=None, fc=None):
    """Return a list of merged, oriented runways:
    {ref, lengthM, ends: [{name, hdg (true), lng, lat, displacedM, thrLng, thrLat}, ...] (2 entries), segments}
    ordered longest first — the same order osmAirport.ts produces."""
    fc = fc or load_geojson(icao)
    if not fc:
        return []
    if magvar is None:
        magvar = MAGVAR_FALLBACK.get(icao, 0.0)
    center = fc.get('center') or [0, 0]
    frame = Frame(center[0], center[1])

    segs = [f for f in fc['features']
            if (f.get('properties') or {}).get('aeroway') == 'runway'
            and f['geometry']['type'] == 'LineString' and len(f['geometry']['coordinates']) >= 2]

    builds = {}
    for f in segs:
        ref = (f.get('properties') or {}).get('ref')
        if not is_rwy_ref(ref):
            continue
        cs = f['geometry']['coordinates']
        prev = builds.get(ref)
        if not prev or seg_len(cs) > seg_len(prev['main']):
            n0, n1 = [p.strip() for p in ref.split('/')]
            a = frame.xy(cs[0][0], cs[0][1])
            b = frame.xy(cs[-1][0], cs[-1][1])
            L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
            builds[ref] = {'ref': ref, 'names': (n0, n1), 'main': cs, 'members': [],
                           'axis': ((b[0] - a[0]) / L, (b[1] - a[1]) / L), 'origin': a,
                           'minT': 0.0, 'maxT': L, 'mainT0': 0.0, 'mainT1': L, 'verts': {}}

    def t_of(rb, p):
        return (p[0] - rb['origin'][0]) * rb['axis'][0] + (p[1] - rb['origin'][1]) * rb['axis'][1]

    def perp_of(rb, p):
        return abs((p[0] - rb['origin'][0]) * -rb['axis'][1] + (p[1] - rb['origin'][1]) * rb['axis'][0])

    claimed = set()
    for rb in builds.values():
        for lng, lat in rb['main']:
            rb['verts'][(round(lng, 6), round(lat, 6))] = (t_of(rb, frame.xy(lng, lat)), lng, lat)
        pool = [f for f in segs if id(f) not in claimed
                and ((f.get('properties') or {}).get('ref') == rb['ref'] or not is_rwy_ref((f.get('properties') or {}).get('ref')))]
        grew = True
        while grew:
            grew = False
            for f in pool:
                if id(f) in claimed:
                    continue
                cs = f['geometry']['coordinates']
                if cs is rb['main']:
                    claimed.add(id(f)); rb['members'].append(f); continue
                pts = [frame.xy(c[0], c[1]) for c in cs]
                if not all(perp_of(rb, p) <= 20 for p in pts):
                    continue
                ts = [t_of(rb, p) for p in pts]
                lo, hi = min(ts), max(ts)
                if hi < rb['minT'] - 40 or lo > rb['maxT'] + 40:
                    continue
                claimed.add(id(f)); rb['members'].append(f); grew = True
                rb['minT'] = min(rb['minT'], lo); rb['maxT'] = max(rb['maxT'], hi)
                for c, t in zip(cs, ts):
                    rb['verts'][(round(c[0], 6), round(c[1], 6))] = (t, c[0], c[1])

    out = []
    for rb in sorted(builds.values(), key=lambda b: -(b['maxT'] - b['minT'])):
        chain = sorted(rb['verts'].values(), key=lambda v: v[0])
        if len(chain) < 2:
            continue
        P0, P1 = chain[0], chain[-1]
        b01 = bearing(P0[1], P0[2], P1[1], P1[2])
        mag_b01 = (b01 - magvar + 360) % 360
        d0 = int(''.join(c for c in rb['names'][0] if c.isdigit())) * 10
        d1 = int(''.join(c for c in rb['names'][1] if c.isdigit())) * 10
        diff0, diff1 = ang_diff(d0, mag_b01), ang_diff(d1, mag_b01)
        first, second = (rb['names'][0], rb['names'][1]) if diff0 <= diff1 else (rb['names'][1], rb['names'][0])
        ambiguous = min(diff0, diff1) > 25 or abs(diff0 - diff1) < 30
        length_m = rb['maxT'] - rb['minT']
        main_frac = (rb['mainT1'] - rb['mainT0']) / max(1.0, length_m)

        def disp_ok(d):
            return d if (main_frac >= 0.7 and 0 < d <= 320) else 0.0

        disp0 = disp_ok(rb['mainT0'] - rb['minT'])
        disp1 = disp_ok(rb['maxT'] - rb['mainT1'])

        def mk_end(name, P, hdg, disp):
            thr = advance(P[1], P[2], hdg, disp) if disp > 0 else (P[1], P[2])
            return {'name': name, 'hdg': hdg, 'lng': P[1], 'lat': P[2], 'displacedM': disp,
                    'thrLng': thr[0], 'thrLat': thr[1]}

        out.append({'ref': rb['ref'], 'lengthM': length_m, 'segments': len(rb['members']),
                    'ambiguous': ambiguous, 'magvar': magvar,
                    'ends': [mk_end(first, P0, b01, disp0), mk_end(second, P1, (b01 + 180) % 360, disp1)]})
    return out


if __name__ == '__main__':
    for icao in (sys.argv[1:] or sorted(MAGVAR_FALLBACK)):
        print(f'== {icao}')
        for rw in runways_for(icao):
            e0, e1 = rw['ends']
            flag = ' AMBIGUOUS' if rw['ambiguous'] else ''
            print(f"  {rw['ref']:9} {rw['lengthM']:6.0f} m  {e0['name']:>3} {e0['hdg']:6.1f}T  <->  {e1['name']:>3} {e1['hdg']:6.1f}T{flag}")
