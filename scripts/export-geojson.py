#!/usr/bin/env python3
"""Export ASSET2 SFO data as GeoJSON for MapLibre GL rendering."""
import base64
if not hasattr(base64, 'encodestring'):
    base64.encodestring = base64.encodebytes

import sys
import json

sys.path.insert(0, '/root/atc/refrence/airport-simulation')

from surface import Surface, Gate, Spot, Runway, Taxiway, PushbackWay, RunwayNode

base = '/root/atc/refrence/airport-simulation/data/sfo/build/'

with open(base + 'airport-metadata.json') as f:
    meta = json.load(f)
with open(base + 'gates.json') as f:
    gates_raw = json.load(f)
with open(base + 'spots.json') as f:
    spots_raw = json.load(f)
with open(base + 'runways.json') as f:
    runways_raw = json.load(f)
with open(base + 'taxiways.json') as f:
    taxiways_raw = json.load(f)
with open(base + 'pushback_ways.json') as f:
    pushbacks_raw = json.load(f)

surface = Surface(meta['center'], meta['corners'], base + 'airport.jpg')

for g in gates_raw:
    surface.gates.append(Gate(g['name'], {'lat': g['lat'], 'lng': g['lng']}))
for s in spots_raw:
    surface.spots.append(Spot(s['name'], {'lat': s['lat'], 'lng': s['lng']}))
for r in runways_raw:
    nodes = [RunwayNode({'lat': n[1], 'lng': n[0]}) for n in r['nodes']]
    surface.runways.append(Runway(r['name'], nodes))
for t in taxiways_raw:
    nodes = [RunwayNode({'lat': n[1], 'lng': n[0]}) for n in t['nodes']]
    surface.taxiways.append(Taxiway(t['name'], nodes))
for p in pushbacks_raw:
    nodes = [RunwayNode({'lat': n[1], 'lng': n[0]}) for n in p['nodes']]
    surface.pushback_ways.append(PushbackWay(p['name'], nodes))

surface.break_links()

# Build GeoJSON feature collections by type

def make_line_feature(link, link_type):
    coords = [[round(n.geo_pos['lng'], 7), round(n.geo_pos['lat'], 7)] for n in link.nodes]
    return {
        'type': 'Feature',
        'properties': {
            'type': link_type,
            'name': link.name,
            'lengthFt': round(sum(link.nodes[i-1].get_distance_to(link.nodes[i]) for i in range(1, len(link.nodes))), 1),
        },
        'geometry': {
            'type': 'LineString',
            'coordinates': coords,
        }
    }

def make_point_feature(node, node_type, name):
    return {
        'type': 'Feature',
        'properties': {
            'type': node_type,
            'name': name or node.name or '',
        },
        'geometry': {
            'type': 'Point',
            'coordinates': [round(node.geo_pos['lng'], 7), round(node.geo_pos['lat'], 7)],
        }
    }

# Save originals before break_links mutated them
original_runways = list(surface.runways)
original_taxiways = list(surface.taxiways)
original_pushbacks = list(surface.pushback_ways)

# GeoJSON collections
runway_fc = {
    'type': 'FeatureCollection',
    'features': [make_line_feature(r, 'runway') for r in original_runways]
}
taxiway_fc = {
    'type': 'FeatureCollection',
    'features': [make_line_feature(t, 'taxiway') for t in original_taxiways]
}
pushback_fc = {
    'type': 'FeatureCollection',
    'features': [make_line_feature(p, 'pushback') for p in original_pushbacks]
}
gate_fc = {
    'type': 'FeatureCollection',
    'features': [make_point_feature(g, 'gate', g.name) for g in surface.gates]
}
spot_fc = {
    'type': 'FeatureCollection',
    'features': [make_point_feature(s, 'spot', s.name) for s in surface.spots]
}

# Write each as a separate geojson file
out_dir = '/root/atc/public/maps/geojson'
import os
os.makedirs(out_dir, exist_ok=True)

for name, fc in [
    ('runways', runway_fc),
    ('taxiways', taxiway_fc),
    ('pushbacks', pushback_fc),
    ('gates', gate_fc),
    ('spots', spot_fc),
]:
    with open(f'{out_dir}/sfo_{name}.geojson', 'w') as f:
        json.dump(fc, f)

# Also write a combined metadata JSON
meta_out = {
    'name': meta['name'],
    'icao': 'KSFO',
    'center': meta['center'],
    'bounds': meta['corners'],
    'files': {
        'runways': '/maps/geojson/sfo_runways.geojson',
        'taxiways': '/maps/geojson/sfo_taxiways.geojson',
        'pushbacks': '/maps/geojson/sfo_pushbacks.geojson',
        'gates': '/maps/geojson/sfo_gates.geojson',
        'spots': '/maps/geojson/sfo_spots.geojson',
    }
}
with open(f'{out_dir}/manifest.json', 'w') as f:
    json.dump(meta_out, f)

print(f"Exported to {out_dir}:")
print(f"  Runways: {len(runway_fc['features'])}")
print(f"  Taxiways: {len(taxiway_fc['features'])}")
print(f"  Pushbacks: {len(pushback_fc['features'])}")
print(f"  Gates: {len(gate_fc['features'])}")
print(f"  Spots: {len(spot_fc['features'])}")
