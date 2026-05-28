#!/usr/bin/env python3
"""Export ASSET2 SFO data with proper link types for rendering.
Uses original unbroken links for visuals (full polylines, correct types)
and broken links only for node graph."""
import base64
if not hasattr(base64, 'encodestring'):
    base64.encodestring = base64.encodebytes

import sys
import json
import math

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

# Save original links BEFORE break_links mutates them
original_runways = list(surface.runways)
original_taxiways = list(surface.taxiways)
original_pushbacks = list(surface.pushback_ways)

# Break links for graph topology
surface.break_links()

print(f"Gates: {len(surface.gates)}, Spots: {len(surface.spots)}")
print(f"Runways: {len(surface.runways)}, Taxiways: {len(surface.taxiways)}, Pushbacks: {len(surface.pushback_ways)}")
print(f"Total nodes: {len(surface.nodes)}, Total links: {len(surface.links)}")

# Project to local Cartesian meters
center_lat = meta['center']['lat']
center_lng = meta['center']['lng']
to_rad = math.pi / 180
R = 6371000
cos_clat = math.cos(center_lat * to_rad)
scale_x = to_rad * R * cos_clat
scale_y = to_rad * R

def project(lat, lng):
    return {
        'x': round((lng - center_lng) * scale_x, 2),
        'y': round((lat - center_lat) * scale_y, 2),
    }

# Give stable IDs to all unique nodes
node_ids = {}
for i, node in enumerate(surface.nodes):
    node_ids[node] = f"N{i:05d}"

# Build output nodes
out_nodes = []
for node in surface.nodes:
    pos = project(node.geo_pos['lat'], node.geo_pos['lng'])
    ntype = 'node'
    name = node.name if node.name and not node.name.startswith('n-id-') else None
    if any(node == g for g in surface.gates):
        ntype = 'gate'
        for g in surface.gates:
            if node == g:
                name = g.name
                break
    elif any(node == s for s in surface.spots):
        ntype = 'spot'
        for s in surface.spots:
            if node == s:
                name = s.name
                break
    out_nodes.append({
        'id': node_ids[node],
        'name': name,
        'type': ntype,
        'lat': round(node.geo_pos['lat'], 7),
        'lng': round(node.geo_pos['lng'], 7),
        'x': pos['x'],
        'y': pos['y'],
    })

# Build RENDER links from ORIGINAL unbroken links (preserves types and full polylines)
def make_render_links(links, link_type):
    out = []
    for link in links:
        pts = [project(n.geo_pos['lat'], n.geo_pos['lng']) for n in link.nodes]
        from_id = node_ids.get(link.start)
        to_id = node_ids.get(link.end)
        length_ft = sum(link.nodes[i-1].get_distance_to(link.nodes[i]) for i in range(1, len(link.nodes)))
        out.append({
            'name': link.name,
            'type': link_type,
            'from': from_id,
            'to': to_id,
            'lengthFt': round(length_ft, 1),
            'points': [[round(p['x'], 2), round(p['y'], 2)] for p in pts],
        })
    return out

render_links = []
render_links += make_render_links(original_runways, 'runway')
render_links += make_render_links(original_taxiways, 'taxiway')
render_links += make_render_links(original_pushbacks, 'pushback')

# Build GRAPH links from broken links (for pathfinding)
graph_links = []
for link in surface.links:
    from_id = node_ids.get(link.start)
    to_id = node_ids.get(link.end)
    length_ft = sum(link.nodes[i-1].get_distance_to(link.nodes[i]) for i in range(1, len(link.nodes)))
    # Determine type by checking original lists
    link_type = 'link'
    if any(link == r for r in surface.runways):
        link_type = 'runway'
    elif any(link == t or link.name.startswith(t.name + '-') for t in surface.taxiways):
        link_type = 'taxiway'
    elif any(link == p or link.name.startswith(p.name + '-') for p in surface.pushback_ways):
        link_type = 'pushback'
    graph_links.append({
        'name': link.name,
        'type': link_type,
        'from': from_id,
        'to': to_id,
        'lengthFt': round(length_ft, 1),
    })

out_gates = [n for n in out_nodes if n['type'] == 'gate']
out_spots = [n for n in out_nodes if n['type'] == 'spot']

output = {
    'metadata': {
        'name': meta['name'],
        'icao': 'KSFO',
        'center': meta['center'],
    },
    'nodes': out_nodes,
    'renderLinks': render_links,
    'graphLinks': graph_links,
    'gates': out_gates,
    'spots': out_spots,
}

out_path = '/root/atc/public/maps/KSFO.json'
with open(out_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"\nWrote {out_path}")
print(f"Nodes: {len(output['nodes'])}")
print(f"Render links: {len(output['renderLinks'])} (runways: {len(surface.runways)}, taxiways: {len(surface.taxiways)}, pushbacks: {len(surface.pushback_ways)})")
print(f"Graph links: {len(output['graphLinks'])}")
print(f"Gates: {len(output['gates'])}, Spots: {len(output['spots'])}")
