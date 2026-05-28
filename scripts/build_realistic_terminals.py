#!/usr/bin/env python3
"""Build realistic terminal concourse piers and angled jet bridges for SFO.
Uses gate positions to create finger-pier geometry."""
import json
import math
from collections import defaultdict

with open('/root/atc/refrence/airport-simulation/data/sfo/build/gates.json') as f:
    gates = json.load(f)

# SFO terminal groups with realistic names
TERMINAL_GROUPS = {
    'A': ['A1','A2','A3','A4','A5','A6','A7','A8','A9','A10','A11','A12'],
    'T2': ['20','21','22','23','24','25'],
    'T3': ['30','31','32','32A','33','34','35','36','37','38','39',
           '40','41','42','43','44','45','46','47','48'],
    'G_Intl': ['G91','G92','G92A','G93','G94','G95','G96','G97','G98','G99','G99A','G100','G101','G101A','G102'],
    'G_North': ['50','51A','51B','52','53','54A','54B','55','56A','56B','57','58A','58B','59',
                '60','60A','61','62A','62B','63','64','64A','65','65A','66','66A','67',
                '68','69','70','71','72','73','73A','74','75','76','77','77A','78','79','80','81',
                '82','83','84','85','86','87','87A','88','89','90'],
}

def get_terminal(name):
    for term, gates_list in TERMINAL_GROUPS.items():
        if name in gates_list:
            return term
    return None

def oriented_bbox(gate_list):
    """Compute oriented bounding box aligned with gate distribution."""
    if len(gate_list) < 2:
        return None
    # Principal axis via PCA-like approach
    lats = [g['lat'] for g in gate_list]
    lngs = [g['lng'] for g in gate_list]
    mean_lat = sum(lats) / len(lats)
    mean_lng = sum(lngs) / len(lngs)
    
    # Find dominant direction
    dx = max(lngs) - min(lngs)
    dy = max(lats) - min(lats)
    angle = math.atan2(dy, dx)
    
    # Project gates onto axis and perpendicular
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    projections = []
    for g in gate_list:
        px = (g['lng'] - mean_lng) * cos_a + (g['lat'] - mean_lat) * sin_a
        py = -(g['lng'] - mean_lng) * sin_a + (g['lat'] - mean_lat) * cos_a
        projections.append((px, py))
    
    min_p = min(p[0] for p in projections)
    max_p = max(p[0] for p in projections)
    min_q = min(p[1] for p in projections)
    max_q = max(p[1] for p in projections)
    
    # Add padding for building width (concourse is wider than gate span)
    pad_p = (max_p - min_p) * 0.05 + 0.0001
    pad_q = max(0.0003, (max_q - min_q) * 0.3 + 0.0002)  # building depth
    
    corners_proj = [
        (min_p - pad_p, min_q - pad_q),
        (max_p + pad_p, min_q - pad_q),
        (max_p + pad_p, max_q + pad_q),
        (min_p - pad_p, max_q + pad_q),
    ]
    
    # Back to lat/lng
    corners = []
    for px, py in corners_proj:
        lng = mean_lng + px * cos_a - py * sin_a
        lat = mean_lat + px * sin_a + py * cos_a
        corners.append([lng, lat])
    corners.append(corners[0])  # close polygon
    return corners

def get_jet_bridge_realistic(gate, concourse_polygon):
    """Find closest point on concourse edge, draw bridge perpendicular."""
    gx, gy = gate['lng'], gate['lat']
    pts = concourse_polygon[:-1]
    
    # Find closest edge and project
    best_d = float('inf')
    best_proj = pts[0]
    best_edge_vec = (1, 0)
    
    for i in range(len(pts)):
        a, b = pts[i], pts[(i+1) % len(pts)]
        ax, ay = a[0], a[1]
        bx, by = b[0], b[1]
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
            best_proj = proj
            # Edge vector for perpendicular extension
            edge_len = math.sqrt(ab_len_sq)
            if edge_len > 0:
                best_edge_vec = (-aby / edge_len, abx / edge_len)  # perpendicular, pointing outward
            else:
                best_edge_vec = (0, 1)
    
    # Extend slightly from building edge to make bridge start outside
    extend = 0.00002
    start = [best_proj[0] + best_edge_vec[0] * extend, best_proj[1] + best_edge_vec[1] * extend]
    
    return [start, [gx, gy]]

# Build features
term_features = []
jb_features = []

for term_name, gate_names in TERMINAL_GROUPS.items():
    gate_objs = [g for g in gates if g['name'] in gate_names]
    if len(gate_objs) < 2:
        continue
    
    poly = oriented_bbox(gate_objs)
    if not poly:
        continue
    
    term_features.append({
        'type': 'Feature',
        'properties': {'name': f'Terminal {term_name}', 'terminal': term_name},
        'geometry': {'type': 'Polygon', 'coordinates': [poly]},
    })
    
    for gate in gate_objs:
        jb = get_jet_bridge_realistic(gate, poly)
        jb_features.append({
            'type': 'Feature',
            'properties': {'gate': gate['name'], 'terminal': term_name},
            'geometry': {'type': 'LineString', 'coordinates': jb},
        })

import os
os.makedirs('/root/atc/public/maps/geojson', exist_ok=True)

with open('/root/atc/public/maps/geojson/sfo_terminals.geojson', 'w') as f:
    json.dump({'type': 'FeatureCollection', 'features': term_features}, f)

with open('/root/atc/public/maps/geojson/sfo_jetbridges.geojson', 'w') as f:
    json.dump({'type': 'FeatureCollection', 'features': jb_features}, f)

print(f"Terminals: {len(term_features)}")
print(f"Jet bridges: {len(jb_features)}")
for t in term_features:
    n = len([j for j in jb_features if j['properties']['terminal'] == t['properties']['terminal']])
    print(f"  {t['properties']['name']}: {n} gates")
