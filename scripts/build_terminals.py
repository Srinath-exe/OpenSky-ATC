#!/usr/bin/env python3
"""Generate terminal buildings and jet bridges for SFO gates."""
import json
import math
from collections import defaultdict

# Load gates
with open('/root/atc/refrence/airport-simulation/data/sfo/build/gates.json') as f:
    gates = json.load(f)

# Group gates by terminal/area
def get_terminal(name):
    if name.startswith('A'):
        return 'A'
    if name.startswith('G'):
        return 'G'
    try:
        num = int(name)
        if 20 <= num <= 25:
            return 'T2'
        if 30 <= num <= 48:
            return 'T3'
        if 50 <= num <= 81:
            return 'G'
        if num in [60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81]:
            return 'G'
    except:
        pass
    return 'OTHER'

# Group
term_gates = defaultdict(list)
for g in gates:
    term = get_terminal(g['name'])
    term_gates[term].append(g)

# Compute bounding box for each terminal and create polygon
def compute_terminal_polygon(gate_list):
    if len(gate_list) < 2:
        return None
    lats = [g['lat'] for g in gate_list]
    lngs = [g['lng'] for g in gate_list]
    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)
    # Add padding
    lat_pad = (max_lat - min_lat) * 0.15 + 0.0002
    lng_pad = (max_lng - min_lng) * 0.15 + 0.0002
    # Determine main orientation
    if (max_lng - min_lng) > (max_lat - min_lat):
        # Terminal is roughly east-west oriented (long side horizontal)
        # Building behind gates (north if gates face south, or vice versa)
        mid_lat = (min_lat + max_lat) / 2
        return [
            [min_lng - lng_pad, min_lat - lat_pad],
            [max_lng + lng_pad, min_lat - lat_pad],
            [max_lng + lng_pad, max_lat + lat_pad],
            [min_lng - lng_pad, max_lat + lat_pad],
            [min_lng - lng_pad, min_lat - lat_pad],
        ]
    else:
        # Terminal is roughly north-south oriented
        return [
            [min_lng - lng_pad, min_lat - lat_pad],
            [max_lng + lng_pad, min_lat - lat_pad],
            [max_lng + lng_pad, max_lat + lat_pad],
            [min_lng - lng_pad, max_lat + lat_pad],
            [min_lng - lng_pad, min_lat - lat_pad],
        ]

# Find building edge point closest to gate
def get_jet_bridge(gate, term_polygon):
    # Simple approach: project gate onto terminal bounding box edge
    # Find which edge the gate is closest to, draw bridge from there
    gx, gy = gate['lng'], gate['lat']
    # Find closest point on polygon
    pts = term_polygon[:-1]
    best_d = float('inf')
    best_pt = pts[0]
    for i in range(len(pts)):
        a, b = pts[i], pts[(i+1) % len(pts)]
        # Project gate onto segment a-b
        ax, ay = a[0], a[1]
        bx, by = b[0], b[1]
        # Vector ab
        abx, aby = bx - ax, by - ay
        ab_len_sq = abx**2 + aby**2
        if ab_len_sq == 0:
            proj = [ax, ay]
        else:
            t = max(0, min(1, ((gx - ax) * abx + (gy - ay) * aby) / ab_len_sq))
            proj = [ax + t * abx, ay + t * aby]
        d = (proj[0] - gx)**2 + (proj[1] - gy)**2
        if d < best_d:
            best_d = d
            best_pt = proj
    return [best_pt, [gx, gy]]

# Build GeoJSON features
terminal_features = []
jetbridge_features = []

for term, glist in term_gates.items():
    if len(glist) < 2:
        continue
    poly = compute_terminal_polygon(glist)
    if not poly:
        continue
    terminal_features.append({
        'type': 'Feature',
        'properties': {'name': f'Terminal {term}', 'terminal': term},
        'geometry': {'type': 'Polygon', 'coordinates': [poly]},
    })
    for gate in glist:
        jb = get_jet_bridge(gate, poly)
        jetbridge_features.append({
            'type': 'Feature',
            'properties': {'gate': gate['name'], 'terminal': term},
            'geometry': {'type': 'LineString', 'coordinates': jb},
        })

# Write
import os
os.makedirs('/root/atc/public/maps/geojson', exist_ok=True)

with open('/root/atc/public/maps/geojson/sfo_terminals.geojson', 'w') as f:
    json.dump({'type': 'FeatureCollection', 'features': terminal_features}, f)

with open('/root/atc/public/maps/geojson/sfo_jetbridges.geojson', 'w') as f:
    json.dump({'type': 'FeatureCollection', 'features': jetbridge_features}, f)

print(f"Terminals: {len(terminal_features)}")
print(f"Jet bridges: {len(jetbridge_features)}")
for t, g in term_gates.items():
    print(f"  Terminal {t}: {len(g)} gates")
