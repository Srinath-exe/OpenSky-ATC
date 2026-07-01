#!/usr/bin/env python3
"""
Generate proper short jetbridge stubs for KLAX.

Strategy:
  For each gate point in osm_gates.geojson:
    1. Find the nearest terminal polygon (from osm_terminals.geojson)
    2. Find the nearest point on that terminal's boundary edge
    3. Draw a short LineString from the terminal edge point to ~10-15m beyond
       (representing the jetway extending from building face to aircraft stand)

Outputs: osm_jetbridges.geojson with correct short stubs.
"""

import json, math, os

GATES_FILE     = '/root/atc/public/maps/lax_experiment/osm_gates.geojson'
TERMINALS_FILE = '/root/atc/public/maps/lax_experiment/osm_terminals.geojson'
OUT_FILE       = '/root/atc/public/maps/lax_experiment/osm_jetbridges.geojson'

# Meters per degree (approx at LAX latitude ~33.94°)
LAT_M  = 111320.0
LON_M  = 111320.0 * math.cos(math.radians(33.94))

def dist_m(a, b):
    """Euclidean distance in metres between two [lon, lat] points."""
    dx = (b[0] - a[0]) * LON_M
    dy = (b[1] - a[1]) * LAT_M
    return math.sqrt(dx*dx + dy*dy)

def nearest_point_on_segment(p, a, b):
    """Return the nearest point on segment a→b to point p (all in [lon,lat])."""
    ax, ay = (a[0]-p[0])*LON_M, (a[1]-p[1])*LAT_M
    bx, by = (b[0]-p[0])*LON_M, (b[1]-p[1])*LAT_M
    abx, aby = bx-ax, by-ay
    t = -(ax*abx + ay*aby) / (abx*abx + aby*aby + 1e-18)
    t = max(0.0, min(1.0, t))
    nx = a[0] + (b[0]-a[0])*t
    ny = a[1] + (b[1]-a[1])*t
    return [nx, ny]

def nearest_point_on_ring(p, ring):
    """Return (nearest_point, distance) over all edges of a polygon ring."""
    best_pt, best_d = None, float('inf')
    for i in range(len(ring)-1):
        np_ = nearest_point_on_segment(p, ring[i], ring[i+1])
        d   = dist_m(p, np_)
        if d < best_d:
            best_d, best_pt = d, np_
    return best_pt, best_d

def make_stub(gate_pt, terminal_edge_pt, stub_extra_m=8.0):
    """
    Build a jetway LineString:
      terminal_edge_pt → point stub_extra_m beyond gate in same direction.
    This gives the classic short stub look from the reference image.
    """
    dx = (gate_pt[0] - terminal_edge_pt[0]) * LON_M
    dy = (gate_pt[1] - terminal_edge_pt[1]) * LAT_M
    length = math.sqrt(dx*dx + dy*dy) + 1e-9
    # direction unit vector (in degrees)
    ux = dx / length / LON_M
    uy = dy / length / LAT_M
    # endpoint: a bit past the gate
    end = [gate_pt[0] + ux * stub_extra_m, gate_pt[1] + uy * stub_extra_m]
    return [terminal_edge_pt, gate_pt, end]

# ── Load data ─────────────────────────────────────────────────────────────────
with open(GATES_FILE)     as f: gates_fc     = json.load(f)
with open(TERMINALS_FILE) as f: terminals_fc = json.load(f)

terminals = []
for feat in terminals_fc['features']:
    geom = feat['geometry']
    if geom['type'] == 'Polygon':
        terminals.append({
            'name': feat['properties'].get('name',''),
            'ring': geom['coordinates'][0],
        })

# ── Generate stubs ────────────────────────────────────────────────────────────
features = []
MAX_GATE_DIST_M = 120  # ignore gates further than this from any terminal

for gfeat in gates_fc['features']:
    geom = gfeat['geometry']
    if geom['type'] != 'Point':
        continue

    gate_pt   = geom['coordinates']   # [lon, lat]
    gate_name = gfeat['properties'].get('name', '')

    # Find nearest terminal and its closest edge point
    best_edge_pt, best_d, best_term = None, float('inf'), None
    for term in terminals:
        ep, d = nearest_point_on_ring(gate_pt, term['ring'])
        if d < best_d:
            best_d, best_edge_pt, best_term = d, ep, term['name']

    if best_d > MAX_GATE_DIST_M:
        # Gate too far from any terminal — skip
        continue

    # Only draw stub if gate is reasonably far from terminal (>5m) to avoid noise
    if best_d < 3.0:
        continue

    coords = make_stub(gate_pt, best_edge_pt, stub_extra_m=0)

    features.append({
        'type': 'Feature',
        'properties': {
            'gate': gate_name,
            'terminal': best_term,
            'aeroway': 'jetway',
            'dist_m': round(best_d, 1),
        },
        'geometry': {
            'type': 'LineString',
            'coordinates': coords,
        }
    })

out = {'type': 'FeatureCollection', 'features': features}
with open(OUT_FILE, 'w') as f:
    json.dump(out, f)

print(f"✓ Generated {len(features)} jetbridge stubs → {OUT_FILE}")

# Print summary per terminal
from collections import Counter
counts = Counter(ft['properties']['terminal'] for ft in features)
for term, cnt in sorted(counts.items()):
    print(f"  {term}: {cnt} stubs")
