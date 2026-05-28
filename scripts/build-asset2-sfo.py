#!/usr/bin/env python3
"""Convert ASSET2 SFO data to a clean projected JSON for the SkyControl renderer."""
import json
import math
from pathlib import Path

FEET_PER_METER = 3.28084
CLOSE_NODE_THRESHOLD_FT = 30
CLOSE_NODE_LINK_THRESHOLD_FT = 30

def haversine_ft(lat1, lng1, lat2, lng2):
    R = 6371000
    to_rad = math.pi / 180
    dlat = (lat2 - lat1) * to_rad
    dlng = (lng2 - lng1) * to_rad
    a = math.sin(dlat/2)**2 + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(dlng/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c * FEET_PER_METER

class NodeObj:
    def __init__(self, name, lat, lng, node_type):
        self.name = name
        self.lat = lat
        self.lng = lng
        self.type = node_type
        self.hash = f"{name}#{lat:.5f}#{lng:.5f}"
    def __hash__(self): return hash(self.hash)
    def __eq__(self, other): return isinstance(other, NodeObj) and self.hash == other.hash
    def is_close_to(self, other): return haversine_ft(self.lat, self.lng, other.lat, other.lng) < CLOSE_NODE_THRESHOLD_FT
    def dist_to(self, other): return haversine_ft(self.lat, self.lng, other.lat, other.lng)

class LinkObj:
    def __init__(self, name, nodes, link_type):
        self.name = name
        self.nodes = nodes  # list of [lng, lat]
        self.type = link_type
    def start_node(self): return NodeObj("tmp", self.nodes[0][1], self.nodes[0][0], "tmp")
    def end_node(self): return NodeObj("tmp", self.nodes[-1][1], self.nodes[-1][0], "tmp")
    def contains_node(self, node):
        if self.start_node().is_close_to(node) or self.end_node().is_close_to(node):
            return False
        return self.contains_node_at(node) is not None
    def contains_node_at(self, node):
        for i in range(len(self.nodes) - 1):
            src, dst = self.nodes[i], self.nodes[i+1]
            d1 = haversine_ft(src[1], src[0], node.lat, node.lng)
            d2 = haversine_ft(node.lat, node.lng, dst[1], dst[0])
            dt = haversine_ft(src[1], src[0], dst[1], dst[0])
            if d1 + d2 - dt < CLOSE_NODE_LINK_THRESHOLD_FT:
                return i
        return None
    def break_at(self, node, marker):
        first = self.nodes[:marker+1] + [[node.lng, node.lat]]
        second = [[node.lng, node.lat]] + self.nodes[marker+1:]
        return [LinkObj(self.name + "-b1", first, self.type), LinkObj(self.name + "-b2", second, self.type)]

def break_links(links, all_nodes):
    result = list(links)
    index = 0
    while index < len(all_nodes):
        node = all_nodes[index]
        found = False
        for i, link in enumerate(result):
            if link.type == 'runway':
                continue
            if link.contains_node(node):
                marker = link.contains_node_at(node)
                new_links = link.break_at(node, marker)
                result[i:i+1] = new_links
                found = True
                break
        if found:
            continue
        index += 1
    return result

def main():
    base = Path('/root/atc/refrence/airport-simulation/data/sfo/build')
    out = Path('/root/atc/public/maps/sfo-asset2.json')

    with open(base / 'airport-metadata.json') as f:
        metadata = json.load(f)
    with open(base / 'gates.json') as f:
        gates_raw = json.load(f)
    with open(base / 'spots.json') as f:
        spots_raw = json.load(f)
    with open(base / 'runways.json') as f:
        runways_raw = json.load(f)
    with open(base / 'taxiways.json') as f:
        taxiways_raw = json.load(f)
    with open(base / 'pushback_ways.json') as f:
        pushback_raw = json.load(f)

    center_lat = metadata['center']['lat']
    center_lng = metadata['center']['lng']

    to_rad = math.pi / 180
    R = 6371000
    cos_clat = math.cos(center_lat * to_rad)
    scale_x = to_rad * R * cos_clat
    scale_y = to_rad * R

    def project(lat, lng):
        return [(lng - center_lng) * scale_x, (lat - center_lat) * scale_y]

    # Build gate/spot nodes
    gates = [NodeObj(g['name'], g['lat'], g['lng'], 'gate') for g in gates_raw]
    spots = [NodeObj(s['name'], s['lat'], s['lng'], 'spot') for s in spots_raw]

    # Build links
    runways = [LinkObj(r['name'], r['nodes'], 'runway') for r in runways_raw]
    taxiways = [LinkObj(t['name'], t['nodes'], 'taxiway') for t in taxiways_raw]
    pushbacks = [LinkObj(p['name'], p['nodes'], 'pushback') for p in pushback_raw]

    # Build all nodes for breakLinks (spots + every link start/end)
    all_nodes = spots[:]
    for link in runways + taxiways + pushbacks:
        all_nodes.append(NodeObj(f"ep_{link.name}_s", link.nodes[0][1], link.nodes[0][0], 'link_endpoint'))
        all_nodes.append(NodeObj(f"ep_{link.name}_e", link.nodes[-1][1], link.nodes[-1][0], 'link_endpoint'))

    # Break taxiways and pushbacks (skip runways)
    broken = break_links(taxiways + pushbacks, all_nodes)
    final_links = runways + broken

    # Collect all unique nodes
    node_set = set()
    for n in gates: node_set.add(n)
    for n in spots: node_set.add(n)
    for link in final_links:
        for pt in link.nodes:
            node_set.add(NodeObj("pt", pt[1], pt[0], 'link_node'))

    # Give stable IDs
    node_list = list(node_set)
    for i, n in enumerate(node_list):
        n.id = f"N{i:05d}"

    def find_node(lat, lng):
        target = NodeObj("", lat, lng, "")
        for n in node_list:
            if n.is_close_to(target):
                return n
        # fallback: closest
        best, best_d = None, float('inf')
        for n in node_list:
            d = n.dist_to(target)
            if d < best_d:
                best_d, best = d, n
        return best

    # Build output nodes
    out_nodes = []
    for n in node_list:
        pos = project(n.lat, n.lng)
        out_nodes.append({
            'id': n.id, 'name': n.name, 'type': n.type,
            'lat': n.lat, 'lng': n.lng,
            'x': round(pos[0], 2), 'y': round(pos[1], 2),
        })

    # Build output links (polyline rendering + graph edge)
    out_links = []
    for link in final_links:
        start_n = find_node(link.nodes[0][1], link.nodes[0][0])
        end_n = find_node(link.nodes[-1][1], link.nodes[-1][0])
        points = [project(pt[1], pt[0]) for pt in link.nodes]
        length_ft = sum(
            haversine_ft(link.nodes[i][1], link.nodes[i][0], link.nodes[i+1][1], link.nodes[i+1][0])
            for i in range(len(link.nodes) - 1)
        )
        out_links.append({
            'name': link.name,
            'type': link.type,
            'from': start_n.id if start_n else None,
            'to': end_n.id if end_n else None,
            'lengthFt': round(length_ft, 1),
            'points': [[round(p[0], 2), round(p[1], 2)] for p in points],
        })

    # Graph edges: consecutive points along each link (for fine rendering/pathfinding)
    out_edges = []
    edge_id = 0
    for link in out_links:
        pts = link['points']
        for i in range(len(pts) - 1):
            out_edges.append({
                'id': f"E{edge_id:06d}",
                'fromNode': None,  # We'll fill these if we build a full graph
                'toNode': None,
                'name': link['name'],
                'type': link['type'],
                'points': [pts[i], pts[i+1]],
            })
            edge_id += 1

    # Simpler: just keep the polyline links
    output = {
        'metadata': {
            'name': metadata['name'],
            'icao': 'KSFO',
            'center': metadata['center'],
        },
        'nodes': out_nodes,
        'links': out_links,
        'gates': [next((o for o in out_nodes if o['name'] == g.name and o['type'] == 'gate'), None) for g in gates],
        'spots': [next((o for o in out_nodes if o['name'] == s.name and o['type'] == 'spot'), None) for s in spots],
    }
    output['gates'] = [g for g in output['gates'] if g]
    output['spots'] = [s for s in output['spots'] if s]

    with open(out, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {out}")
    print(f"Nodes: {len(output['nodes'])}, Links: {len(output['links'])}, Gates: {len(output['gates'])}, Spots: {len(output['spots'])}")

if __name__ == '__main__':
    main()
