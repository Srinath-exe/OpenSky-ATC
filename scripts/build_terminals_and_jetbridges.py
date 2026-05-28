#!/usr/bin/env python3
"""
Build terminal building polygons + jetbridges for all airports.

Strategy:
- Terminal polygons = large pavement areas (area > TERMINAL_MIN_AREA) that
  have at least one gate within MAX_GATE_DIST degrees.
- Jetbridges = line from gate point toward the nearest edge of the nearest
  terminal polygon, stopping at the polygon boundary.

Outputs per airport (to combined/):
  terminals.geojson   — dark-blue terminal building fills
  jetbridges.geojson  — thin connector lines from gate → terminal edge
"""
import json
import math
import os

AIRPORTS = [
    ('KSFO', 'San Francisco Intl'),
    ('KJFK', 'John F Kennedy Intl'),
    ('KLAX', 'Los Angeles Intl'),
    ('KBOS', 'Boston Logan Intl'),
    ('VIDP', 'Indira Gandhi Intl'),
]

BASE_ROOT = '/root/atc/public/maps/xplane'

# Thresholds
TERMINAL_MIN_AREA   = 5e-07   # ~6 000 m² in degree² — any large pavement is candidate
MAX_GATE_DIST       = 0.003   # ~300 m in degrees — gate must be this close to a terminal poly
JETBRIDGE_THRESHOLD = 0.002   # ~200 m — max gate→terminal edge distance to spawn jetbridge


# ─── geometry helpers ─────────────────────────────────────────────────────────

def poly_area(ring):
    """Shoelace area in degree²."""
    n = len(ring)
    a = 0.0
    for i in range(n):
        j = (i + 1) % n
        a += ring[i][0] * ring[j][1]
        a -= ring[j][0] * ring[i][1]
    return abs(a) / 2.0


def poly_centroid(ring):
    cx, cy, n = 0.0, 0.0, len(ring)
    for p in ring:
        cx += p[0]; cy += p[1]
    return cx / n, cy / n


def point_in_ring(px, py, ring):
    """Ray-casting point-in-polygon test."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def point_to_seg_dist(px, py, ax, ay, bx, by):
    """Perpendicular distance from (px,py) to segment (ax,ay)-(bx,by); returns (dist, closest_point)."""
    dx, dy = bx - ax, by - ay
    len_sq = dx * dx + dy * dy
    if len_sq == 0:
        return math.hypot(px - ax, py - ay), (ax, ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    proj = (ax + t * dx, ay + t * dy)
    return math.hypot(px - proj[0], py - proj[1]), proj


def nearest_point_on_ring(px, py, ring):
    """Nearest point on the perimeter of a polygon ring to (px, py)."""
    best_d, best_pt = float('inf'), ring[0]
    for i in range(len(ring) - 1):
        d, pt = point_to_seg_dist(px, py, ring[i][0], ring[i][1], ring[i+1][0], ring[i+1][1])
        if d < best_d:
            best_d, best_pt = d, pt
    return best_pt, best_d


def get_outer_ring(feature):
    geom = feature.get('geometry', {})
    gtype = geom.get('type', '')
    coords = geom.get('coordinates', [])
    if gtype == 'Polygon' and coords:
        return coords[0]
    if gtype == 'MultiPolygon' and coords:
        # pick the largest sub-polygon
        best = max(coords, key=lambda p: poly_area(p[0]))
        return best[0]
    return None


# ─── main loop ────────────────────────────────────────────────────────────────

for icao, airport_name in AIRPORTS:
    print(f"\n{'='*52}")
    print(f"  {icao}  —  {airport_name}")
    print('=' * 52)

    base    = f'{BASE_ROOT}/{icao}'
    out_dir = f'{base}/combined'
    os.makedirs(out_dir, exist_ok=True)

    startup_path   = f'{base}/{icao}_all.startup_locations.geojson'
    pavements_path = f'{base}/{icao}_all.pavements.geojson'

    if not os.path.exists(startup_path) or not os.path.exists(pavements_path):
        print(f'  ⚠  Missing source files, skipping')
        continue

    with open(startup_path) as f:
        startups = json.load(f)
    with open(pavements_path) as f:
        pavements = json.load(f)

    # All gates (passenger + cargo)
    all_gates = [
        g for g in startups['features']
        if g['properties'].get('location_type', '').lower() == 'gate'
    ]
    print(f'  Gates: {len(all_gates)}')

    # ── Step 1: identify candidate terminal polygons ──────────────────────────
    # A terminal polygon must:
    #   a) have area >= TERMINAL_MIN_AREA
    #   b) have at least one gate within MAX_GATE_DIST degrees of its centroid

    candidate_terminals = []
    for feat in pavements['features']:
        ring = get_outer_ring(feat)
        if ring is None:
            continue
        area = poly_area(ring)
        if area < TERMINAL_MIN_AREA:
            continue
        cx, cy = poly_centroid(ring)

        # Check proximity of any gate
        has_gate = any(
            math.hypot(g['geometry']['coordinates'][0] - cx,
                       g['geometry']['coordinates'][1] - cy) < MAX_GATE_DIST
            for g in all_gates
        )
        if has_gate:
            candidate_terminals.append({
                'feature': feat,
                'ring': ring,
                'area': area,
                'cx': cx,
                'cy': cy,
            })

    print(f'  Terminal polygons: {len(candidate_terminals)}')

    # ── Step 2: generate jetbridges ───────────────────────────────────────────
    jetbridges = []

    for gate in all_gates:
        gx, gy = gate['geometry']['coordinates'][0], gate['geometry']['coordinates'][1]
        gate_name = gate['properties'].get('name', '')

        # Find nearest terminal polygon
        best_d   = float('inf')
        best_pt  = None

        for term in candidate_terminals:
            # Quick bounding check
            if math.hypot(gx - term['cx'], gy - term['cy']) > MAX_GATE_DIST * 2:
                continue
            pt, d = nearest_point_on_ring(gx, gy, term['ring'])
            if d < best_d:
                best_d  = d
                best_pt = pt

        if best_pt is None or best_d > JETBRIDGE_THRESHOLD:
            continue  # gate too far from any terminal

        # Build the jetbridge line: terminal-edge → gate
        dx, dy = gx - best_pt[0], gy - best_pt[1]
        dist   = math.hypot(dx, dy)

        if dist < 1e-9:
            continue  # gate sits exactly on edge — skip

        # Offset the terminal end slightly outward (avoid z-fighting with polygon fill)
        OFFSET = 0.000015  # ~1.5 m in degrees
        start  = [best_pt[0] + (dx / dist) * OFFSET,
                  best_pt[1] + (dy / dist) * OFFSET]

        jetbridges.append({
            'type': 'Feature',
            'properties': {
                'gate': gate_name,
                'location_type': gate['properties'].get('location_type', ''),
                'airline_codes': gate['properties'].get('airline_codes', ''),
            },
            'geometry': {
                'type': 'LineString',
                'coordinates': [start, [gx, gy]],
            },
        })

    print(f'  Jetbridges generated: {len(jetbridges)}')

    # ── Step 3: write outputs ─────────────────────────────────────────────────

    # terminals.geojson
    terminal_features = [t['feature'] for t in candidate_terminals]
    terminals_fc = {'type': 'FeatureCollection', 'features': terminal_features}
    with open(f'{out_dir}/terminals.geojson', 'w') as f:
        json.dump(terminals_fc, f)
    print(f'  ✓  terminals.geojson ({len(terminal_features)} features)')

    # jetbridges.geojson
    jb_fc = {'type': 'FeatureCollection', 'features': jetbridges}
    with open(f'{out_dir}/jetbridges.geojson', 'w') as f:
        json.dump(jb_fc, f)
    print(f'  ✓  jetbridges.geojson ({len(jetbridges)} features)')

print(f"\n{'='*52}")
print('  ALL AIRPORTS — TERMINALS + JETBRIDGES DONE')
print('=' * 52)
