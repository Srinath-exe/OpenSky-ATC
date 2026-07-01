#!/usr/bin/env python3
"""Generate minimal Endless-ATC format airspace files from OSM runway geojson data."""
import json, math, sys, os

def bearing(lng1, lat1, lng2, lat2):
    d2r = math.pi / 180
    dlng = (lng2 - lng1) * d2r
    lat1r, lat2r = lat1 * d2r, lat2 * d2r
    y = math.sin(dlng) * math.cos(lat2r)
    x = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlng)
    return (math.atan2(y, x) * 180 / math.pi + 360) % 360

def dist_m(lng1, lat1, lng2, lat2):
    R = 6371000
    d2r = math.pi / 180
    dlat = (lat2 - lat1) * d2r
    dlng = (lng2 - lng1) * d2r
    mid = (lat1 + lat2) / 2 * d2r
    return math.hypot(dlat * R, dlng * R * math.cos(mid))

def fmt_lat(lat):
    return f"N{abs(lat):.6f}" if lat >= 0 else f"S{abs(lat):.6f}"

def fmt_lng(lng):
    return f"E{abs(lng):.6f}" if lng >= 0 else f"W{abs(lng):.6f}"

# Airport metadata
AIRPORTS = {
    'KLAX': {'name': 'Los Angeles Intl', 'elev': 125, 'radius': 25, 'magvar': -13},
    'KJFK': {'name': 'John F. Kennedy',  'elev': 13,  'radius': 25, 'magvar': -13},
    'KSFO': {'name': 'San Francisco Intl','elev': 13,  'radius': 25, 'magvar': 13},
    'KBOS': {'name': 'Logan Intl',        'elev': 19,  'radius': 25, 'magvar': -14},
    'VIDP': {'name': 'Indira Gandhi',     'elev': 777, 'radius': 25, 'magvar': 0},
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSM_DIR = os.path.join(ROOT, 'public', 'maps', 'osm')
OUT_DIR = os.path.join(ROOT, 'public', 'airspace')

for icao, meta in AIRPORTS.items():
    path = os.path.join(OSM_DIR, f'{icao}.geojson')
    if not os.path.exists(path):
        print(f'{icao}: no geojson, skipping')
        continue

    with open(path) as f:
        d = json.load(f)

    # Extract unique runway LineStrings
    seen = set()
    runways = []
    for ft in d['features']:
        p = ft.get('properties') or {}
        ref = p.get('ref') or ''
        g = ft['geometry']
        if g['type'] != 'LineString' or '/' not in ref or ref.count('/') != 1:
            continue
        # Filter out non-runway designators (only digits + optional L/R/C)
        parts = ref.split('/')
        def is_rwy_name(s):
            s = s.strip()
            if not s: return False
            digits = ''.join(c for c in s if c.isdigit())
            if not digits: return False
            n = int(digits)
            return 1 <= n <= 36
        if not is_rwy_name(parts[0]) or not is_rwy_name(parts[1]):
            continue
        coords = g['coordinates']
        c0, c1 = coords[0], coords[-1]
        key = f"{c0[0]:.5f},{c0[1]:.5f},{c1[0]:.5f},{c1[1]:.5f}"
        if key in seen:
            continue
        seen.add(key)
        hdg_fwd = bearing(c0[0], c0[1], c1[0], c1[1])
        length_m = dist_m(c0[0], c0[1], c1[0], c1[1])
        length_ft = round(length_m * 3.28084)

        # Determine which end corresponds to which designator
        # The designator number × 10 ≈ magnetic heading
        def rwy_num(s):
            return int(''.join(c for c in s if c.isdigit()))
        n0, n1 = rwy_num(parts[0]), rwy_num(parts[1])
        # Check: n0*10 close to hdg_fwd (or its magnetic equivalent)
        diff0 = min(abs(n0*10 - hdg_fwd), abs(n0*10 - hdg_fwd + 360), abs(n0*10 - hdg_fwd - 360))
        diff1 = min(abs(n1*10 - hdg_fwd), abs(n1*10 - hdg_fwd + 360), abs(n1*10 - hdg_fwd - 360))
        if diff0 < diff1:
            # parts[0] lands heading hdg_fwd, so parts[0] threshold is c0 (aircraft arrive heading hdg_fwd TO c0)
            # Wait: if n0*10 ≈ hdg_fwd then parts[0] is the runway you land on flying heading hdg_fwd
            # So parts[0]'s threshold is c0 (the start), and parts[1]'s threshold is c1 (the end)
            e0_name, e0_c = parts[0], c0  # threshold for rwy designator 0 → aircraft land heading hdg_fwd → threshold at c0
            e1_name, e1_c = parts[1], c1
            e0_hdg, e1_hdg = hdg_fwd, (hdg_fwd + 180) % 360
        else:
            e0_name, e0_c = parts[1], c0
            e1_name, e1_c = parts[0], c1
            e0_hdg, e1_hdg = hdg_fwd, (hdg_fwd + 180) % 360

        if length_ft < 3000:
            continue  # filter out helipads and short taxiways
        runways.append({'ref': ref, 'name0': e0_name, 'pos0': e0_c, 'hdg0': e0_hdg,
                        'name1': e1_name, 'pos1': e1_c, 'hdg1': e1_hdg, 'length_ft': length_ft})

    if not runways:
        print(f'{icao}: no runways found, skipping')
        continue

    # Compute center from all threshold positions
    all_lats = [r['pos0'][1] for r in runways] + [r['pos1'][1] for r in runways]
    all_lngs = [r['pos0'][0] for r in runways] + [r['pos1'][0] for r in runways]
    center_lat = sum(all_lats) / len(all_lats)
    center_lng = sum(all_lngs) / len(all_lngs)

    # Entry points: 8 compass directions at the boundary
    radius_nm = meta['radius']
    elev = meta['elev']

    def make_txt():
        lines = [
            f'[airspace]',
            f'radius = {radius_nm}',
            f'center = {fmt_lat(center_lat)}, {fmt_lng(center_lng)}',
            f'magneticvar = {meta["magvar"]}',
            f'floor = 1500',
            f'ceiling = 11000',
            f'above = 13000',
            f'transitionaltitude = 18000',
            f'separation = 3',
            f'name = {icao} approach',
            '',
            '[airport1]',
            f'name = {meta["name"]}',
            f'code = {icao}',
            'runways =',
        ]

        seen_names = set()
        for r in runways:
            # Add both ends as separate entries
            for suffix in ['0', '1']:
                name = r[f'name{suffix}']
                if name in seen_names:
                    continue
                seen_names.add(name)
                pos = r[f'pos{suffix}']
                hdg = r[f'hdg{suffix}']
                length_ft = r['length_ft']
                lat_s = fmt_lat(pos[1])
                lng_s = fmt_lng(pos[0])
                rid = name.lower().replace('/', '')
                # id, name, lat, lng, trueHdg, lengthFt, 0, 0, elevFt, gs, locCourse
                lines.append(f'\t{rid}, {name}, {lat_s}, {lng_s}, {hdg:.1f}, {length_ft}, 0, 0, {elev}, 3, {hdg:.1f}')

        lines += [
            '',
            'entrypoints =',
        ]
        # 8 equally-spaced entry points (no beacon: use '-' as placeholder that won't match any fix)
        for hdg_in in [0, 45, 90, 135, 180, 225, 270, 315]:
            lines.append(f'\t{hdg_in}, -, 8000')
        lines.append('')
        return '\n'.join(lines)

    txt = make_txt()
    out_path = os.path.join(OUT_DIR, f'{icao}.txt')
    with open(out_path, 'w') as f:
        f.write(txt)
    print(f'{icao}: wrote {out_path} ({len(runways)*2} runway ends)')

print('Done.')
