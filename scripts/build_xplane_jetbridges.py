#!/usr/bin/env python3
"""Generate jet bridges from X-Plane gate positions to nearest terminal building edge.
Uses pavement polygons to find building edges.
Processes all configured airports and writes directly to their combined directory."""
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

base_root = '/root/atc/public/maps/xplane'

def point_to_segment_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    len_sq = dx*dx + dy*dy
    if len_sq == 0:
        return math.hypot(px-ax, py-ay), (ax, ay)
    t = max(0, min(1, ((px-ax)*dx + (py-ay)*dy) / len_sq))
    projx = ax + t * dx
    projy = ay + t * dy
    return math.hypot(px-projx, py-projy), (projx, projy)

def nearest_point_on_polygon(px, py, polygon):
    best_d = float('inf')
    best_pt = polygon[0]
    for i in range(len(polygon) - 1):
        d, pt = point_to_segment_dist(px, py, polygon[i][0], polygon[i][1], polygon[i+1][0], polygon[i+1][1])
        if d < best_d:
            best_d = d
            best_pt = pt
    return best_pt, best_d

for icao, name in AIRPORTS:
    print(f"\n{'='*50}")
    print(f"Generating Jet Bridges for {icao} — {name}...")
    print('='*50)
    
    base = f'{base_root}/{icao}'
    out_dir = f'{base}/combined'
    os.makedirs(out_dir, exist_ok=True)
    
    startup_path = f'{base}/{icao}_all.startup_locations.geojson'
    pavements_path = f'{base}/{icao}_all.pavements.geojson'
    
    if not os.path.exists(startup_path) or not os.path.exists(pavements_path):
        print(f"  Skipping {icao} - missing source files")
        continue

    # Load gates and pavements
    with open(startup_path) as f:
        gates = json.load(f)

    with open(pavements_path) as f:
        pavements = json.load(f)

    # Filter actual gates (skip tie downs / ramps that aren't defined as gates)
    gate_features = [
        g for g in gates['features']
        if g['properties'].get('location_type', '').lower() == 'gate'
    ]
    print(f"  Total startup locations: {len(gates['features'])}")
    print(f"  Passenger gates: {len(gate_features)}")

    # Build terminal polygons from large pavement areas
    term_polys = []
    for p in pavements['features']:
        geom = p.get('geometry', {})
        gtype = geom.get('type', '')
        coords_list = geom.get('coordinates', [])
        
        if not coords_list:
            continue
            
        # Get outer ring coordinates
        if gtype == 'Polygon':
            outer_ring = coords_list[0]
        elif gtype == 'MultiPolygon':
            outer_ring = coords_list[0][0]
        else:
            continue
            
        # Compute area using the Shoelace formula
        area = 0.0
        n = len(outer_ring)
        for i in range(n):
            j = (i + 1) % n
            area += outer_ring[i][0] * outer_ring[j][1]
            area -= outer_ring[j][0] * outer_ring[i][1]
        area = abs(area) / 2.0
        
        # Large polygons (> some threshold) represent terminals
        if area > 0.000001:  # rough threshold (~12,000m^2)
            term_polys.append({
                'polygon': outer_ring,
                'area': area,
                'properties': p['properties'],
            })

    print(f"  Terminal building polygons identified: {len(term_polys)}")

    # For each gate, find nearest point on any terminal polygon to build a jet bridge link
    jetbridges = []
    for gate in gate_features:
        gcoords = gate['geometry']['coordinates']
        gx, gy = gcoords[0], gcoords[1]
        
        # Find nearest terminal polygon
        best_d = float('inf')
        best_pt = None
        for term in term_polys:
            pt, d = nearest_point_on_polygon(gx, gy, term['polygon'])
            if d < best_d:
                best_d = d
                best_pt = pt
        
        # Threshold: gate must be within ~100m of a terminal building to spawn a jet bridge
        if best_pt and best_d < 0.001:  
            # Extend slightly from building toward gate by 0.00002 deg (~2 meters)
            dx, dy = gx - best_pt[0], gy - best_pt[1]
            dist = math.hypot(dx, dy)
            if dist > 0:
                extend = 0.00002
                start = [best_pt[0] + (dx/dist)*extend, best_pt[1] + (dy/dist)*extend]
                jetbridges.append({
                    'type': 'Feature',
                    'properties': {
                        'gate': gate['properties'].get('name', ''),
                        'location_type': gate['properties'].get('location_type', ''),
                    },
                    'geometry': {
                        'type': 'LineString',
                        'coordinates': [start, [gx, gy]],
                    }
                })

    print(f"  Jet bridges generated: {len(jetbridges)}")

    # Save to combined directory for MapLibre dynamic serving
    out_path = f'{out_dir}/jetbridges.geojson'
    with open(out_path, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': jetbridges}, f)

    print(f"  Wrote {out_path}")

print(f"\n{'='*50}")
print("ALL AIRPORT JET BRIDGES GENERATED!")
print('='*50)
