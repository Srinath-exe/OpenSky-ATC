import json
import os
import re
import math


AIRPORTS = [
    ('KSFO', 'San Francisco Intl'),
    ('KJFK', 'John F Kennedy Intl'),
    ('KLAX', 'Los Angeles Intl'),
    ('KBOS', 'Boston Logan Intl'),
    ('VIDP', 'Indira Gandhi Intl'),
    ('EGKK', 'London Gatwick'),
]

base_root = '/root/atc/public/maps/xplane'


def polygon_area_deg2(coords):
    """Approximate signed area of a ring in degree^2 (shoelace formula)."""
    n = len(coords)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += coords[i][0] * coords[j][1]
        area -= coords[j][0] * coords[i][1]
    return abs(area) / 2.0


def feature_area(feat):
    """Return approximate area (deg^2) for a polygon feature."""
    geom = feat.get('geometry', {})
    gtype = geom.get('type', '')
    coords = geom.get('coordinates', [])
    if gtype == 'Polygon' and coords:
        return polygon_area_deg2(coords[0])
    elif gtype == 'MultiPolygon' and coords:
        return sum(polygon_area_deg2(ring[0]) for ring in coords if ring)
    return 0.0


def dist_to_segment(px, py, x1, y1, x2, y2):
    """Distance from point to line segment."""
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return math.sqrt((px-x1)**2 + (py-y1)**2)
    t = max(0, min(1, ((px-x1)*dx + (py-y1)*dy) / (dx*dx + dy*dy)))
    projx = x1 + t*dx
    projy = y1 + t*dy
    return math.sqrt((px-projx)**2 + (py-projy)**2)


def is_runway_polygon(polygon_coords, runway_coords, threshold=0.002):
    """Check if polygon is near any runway centerline."""
    for ring in polygon_coords:
        for c in ring:
            for rw in runway_coords:
                for i in range(len(rw)-1):
                    d = dist_to_segment(c[0], c[1], rw[i][0], rw[i][1], rw[i+1][0], rw[i+1][1])
                    if d < threshold:
                        return True
    return False


# Thresholds (in degree^2).
# 1 deg^2 ≈ 1.2e10 m^2 at mid-latitudes.
# A 60m-wide, 2000m-long taxiway strip ≈ 1.2e5 m^2 ≈ 1e-8 deg^2.
# A large apron (300m x 500m) ≈ 1.5e5 m^2 ≈ 1.25e-8 deg^2 — similar order.
# Use a relative threshold: classify the largest N% of non-runway pavements as aprons.
APRON_TOP_FRACTION = 0.35   # top 35% by area → apron; rest → taxiway
# Minimum area to even be considered apron (filters tiny slivers)
APRON_MIN_AREA = 5e-10   # ~6000 m^2 at mid-lat


for icao, name in AIRPORTS:
    print(f"\n{'='*50}")
    print(f"Processing {icao} — {name}")
    print('='*50)

    base = f'{base_root}/{icao}'
    out = f'{base_root}/{icao}/combined'
    os.makedirs(out, exist_ok=True)

    # Load raw files
    with open(f'{base}/{icao}_all.pavements.geojson') as f:
        pavements = json.load(f)
    with open(f'{base}/{icao}_all.runways.geojson') as f:
        runways = json.load(f)
    with open(f'{base}/{icao}_all.linear_features.geojson') as f:
        lines = json.load(f)
    with open(f'{base}/{icao}_all.startup_locations.geojson') as f:
        startups = json.load(f)
    with open(f'{base}/{icao}_all.signs.geojson') as f:
        signs = json.load(f)
    with open(f'{base}/{icao}_all.windsocks.geojson') as f:
        windsocks = json.load(f)
    with open(f'{base}/{icao}_all.boundary.geojson') as f:
        boundary = json.load(f)

    # Clean sign text markup (X-Plane format like {@Y}R{^r})
    for feat in signs['features']:
        raw = feat['properties'].get('text', '')
        # Remove markup tags: {@...}, {^...}, {@@,...}
        cleaned = re.sub(r'\{[^{}]*\}', ' ', raw)
        cleaned = ' '.join(cleaned.split())
        feat['properties']['label'] = cleaned.strip()

    # ----------------------------------------------------------------
    # Categorize pavements
    # Step 1: exclude runway polygons by name or geometry
    # Step 2: classify remaining by area — large polys = aprons
    # ----------------------------------------------------------------
    runway_names = set()
    for r in runways['features']:
        runway_names.add(r['properties'].get('name_1', ''))
        runway_names.add(r['properties'].get('name_2', ''))
    runway_names.discard('')

    runway_coords = [r['geometry']['coordinates'] for r in runways['features']]

    runway_polys = []
    non_runway = []

    for p in pavements['features']:
        pname = p['properties'].get('name', '')
        geom = p['geometry']
        coords = geom['coordinates']
        # Method 1: name-based detection (works for KSFO, KLAX, etc.)
        name_match = runway_names and any(pname.startswith(r) for r in runway_names)
        # Method 2: geometry-based detection (works for EGKK where all named "New Taxiway")
        geom_match = is_runway_polygon(coords, runway_coords)
        if name_match or geom_match:
            runway_polys.append(p)
        else:
            non_runway.append(p)

    # Compute area for each non-runway pavement
    for p in non_runway:
        p['_area'] = feature_area(p)

    # Sort by area descending
    non_runway_sorted = sorted(non_runway, key=lambda p: p['_area'], reverse=True)

    # Determine area threshold: top APRON_TOP_FRACTION of non-runway pavements
    # that are larger than APRON_MIN_AREA are aprons; rest are taxiways.
    n_non_rwy = len(non_runway_sorted)
    apron_count = max(1, int(math.ceil(n_non_rwy * APRON_TOP_FRACTION))) if n_non_rwy > 0 else 0

    apron_polys = []
    taxiway_polys = []

    for i, p in enumerate(non_runway_sorted):
        area = p.pop('_area', 0)  # remove temp field before writing
        if i < apron_count and area >= APRON_MIN_AREA:
            apron_polys.append(p)
        else:
            taxiway_polys.append(p)

    # ----------------------------------------------------------------
    # Categorize lines (fixed for airports like EGKK with 'VERY_WIDE_YELLOW')
    # ----------------------------------------------------------------
    hold_lines = []
    centerlines = []
    edge_lines = []
    other_lines = []

    for l in lines['features']:
        t = l['properties'].get('painted_line_type', '')
        if 'HOLD' in t:
            hold_lines.append(l)
        elif 'CENTERLINE' in t or 'BROKEN_WHITE' in t:
            centerlines.append(l)
        elif 'EDGE' in t or 'BORDER' in t:
            edge_lines.append(l)
        # Additional yellow taxiway edges (EGKK-style airports)
        elif any(y in t for y in ['VERY_WIDE_YELLOW', 'WIDE_SOLID_YELLOW', 'DOUBLE_SOLID_YELLOW',
                                   'SOLID_YELLOW', 'BROKEN_YELLOW', 'SEPARATED_BROKEN_YELLOW']):
            edge_lines.append(l)
        else:
            other_lines.append(l)

    print(f"  Pavements: {len(runway_polys)} runway, {len(taxiway_polys)} taxiway, {len(apron_polys)} apron")
    print(f"  Lines: {len(hold_lines)} holds, {len(centerlines)} centerlines, {len(edge_lines)} edges, {len(other_lines)} other")
    print(f"  Signs: {len(signs['features'])}, Gates: {len(startups['features'])}, Windsocks: {len(windsocks['features'])}")

    # Write combined files
    for fname, data in [
        ('pavement_runways',  {'type': 'FeatureCollection', 'features': runway_polys}),
        ('pavement_taxiways', {'type': 'FeatureCollection', 'features': taxiway_polys}),
        ('pavement_aprons',   {'type': 'FeatureCollection', 'features': apron_polys}),
        ('lines_holds',       {'type': 'FeatureCollection', 'features': hold_lines}),
        ('lines_centerlines', {'type': 'FeatureCollection', 'features': centerlines}),
        ('lines_edges',       {'type': 'FeatureCollection', 'features': edge_lines}),
        ('lines_other',       {'type': 'FeatureCollection', 'features': other_lines}),
        ('runways',           runways),
        ('startup_locations', startups),
        ('signs',             signs),
        ('windsocks',         windsocks),
        ('boundary',          boundary),
    ]:
        with open(f'{out}/{fname}.geojson', 'w') as f:
            json.dump(data, f)

    print(f"  Written to {out}")

print(f"\n{'='*50}")
print("ALL AIRPORTS PROCESSED!")
print('='*50)
