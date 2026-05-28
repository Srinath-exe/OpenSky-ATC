#!/usr/bin/env python3
"""Visualize ASSET2 SFO airport data using matplotlib (no Google Maps needed).
Bypasses SurfaceFactory gates_spots requirement for pure visualization."""
import base64
if not hasattr(base64, 'encodestring'):
    base64.encodestring = base64.encodebytes

import sys
import os
import json
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

sys.path.insert(0, '/root/atc/refrence/airport-simulation')

from surface import Surface, Gate, Spot, Runway, RunwayNode, Taxiway, PushbackWay
from node import Node
from link import Link

# Load raw data
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

# Build surface manually
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

# Now run break_links manually to get the graph
surface.break_links()

print(f"Gates: {len(surface.gates)}")
print(f"Spots: {len(surface.spots)}")
print(f"Runways: {len(surface.runways)}")
print(f"Taxiways: {len(surface.taxiways)}")
print(f"Pushback ways: {len(surface.pushback_ways)}")
print(f"Total nodes after break: {len(surface.nodes)}")
print(f"Total links: {len(surface.links)}")

# Compute bounds
def draw_airport(ax, show_labels=True, show_nodes=False):
    ax.set_facecolor('#0e1929')
    
    # Draw runways
    for rwy in surface.runways:
        pts = [(n.geo_pos['lng'], n.geo_pos['lat']) for n in rwy.nodes]
        lats = [p[1] for p in pts]
        lngs = [p[0] for p in pts]
        ax.plot(lngs, lats, color='#9fa8da', linewidth=7, solid_capstyle='round')
        ax.plot(lngs, lats, color='white', linewidth=1, linestyle='--', dashes=(8,6))
    
    # Draw taxiways
    for twy in surface.taxiways:
        pts = [(n.geo_pos['lng'], n.geo_pos['lat']) for n in twy.nodes]
        lats = [p[1] for p in pts]
        lngs = [p[0] for p in pts]
        ax.plot(lngs, lats, color='#6ae4a4', linewidth=2.2, solid_capstyle='round', alpha=0.9)
    
    # Draw pushback ways
    for pbw in surface.pushback_ways:
        pts = [(n.geo_pos['lng'], n.geo_pos['lat']) for n in pbw.nodes]
        lats = [p[1] for p in pts]
        lngs = [p[0] for p in pts]
        ax.plot(lngs, lats, color='#90a4ae', linewidth=1.2, solid_capstyle='round', alpha=0.6)
    
    # Draw gates
    for gate in surface.gates:
        ax.plot(gate.geo_pos['lng'], gate.geo_pos['lat'], 'o', color='#f472b6', markersize=4)
        if show_labels:
            ax.annotate(gate.name, (gate.geo_pos['lng'], gate.geo_pos['lat']),
                        color='#e2e8f0', fontsize=5, xytext=(3, 3), textcoords='offset points')
    
    # Draw spots
    for spot in surface.spots:
        ax.plot(spot.geo_pos['lng'], spot.geo_pos['lat'], 's', color='#facc15', markersize=3)
        if show_labels:
            ax.annotate(spot.name, (spot.geo_pos['lng'], spot.geo_pos['lat']),
                        color='#facc15', fontsize=5, xytext=(3, 3), textcoords='offset points')
    
    if show_nodes:
        for node in surface.nodes:
            if node not in surface.gates and node not in surface.spots:
                ax.plot(node.geo_pos['lng'], node.geo_pos['lat'], '.', color='#475569', markersize=1)

    ax.set_aspect('equal')
    ax.axis('off')

# Full airport
fig, ax = plt.subplots(1, 1, figsize=(22, 22))
fig.patch.set_facecolor('#0e1929')
draw_airport(ax, show_labels=False, show_nodes=False)
ax.set_title('SFO Airport Surface (ASSET2 Data)', color='white', fontsize=18, pad=20)

# Add legend
legend_elements = [
    plt.Line2D([0], [0], color='#9fa8da', lw=7, label='Runway'),
    plt.Line2D([0], [0], color='#6ae4a4', lw=2.2, label='Taxiway'),
    plt.Line2D([0], [0], color='#90a4ae', lw=1.2, label='Pushback Way'),
    plt.Line2D([0], [0], marker='o', color='w', markerfacecolor='#f472b6', markersize=6, label='Gate'),
    plt.Line2D([0], [0], marker='s', color='w', markerfacecolor='#facc15', markersize=5, label='Spot'),
]
ax.legend(handles=legend_elements, loc='upper left', facecolor='#0e1929', edgecolor='#334155',
          labelcolor='white', fontsize=11)

plt.tight_layout()
out_path = '/root/atc/public/sfo-asset2-full.png'
plt.savefig(out_path, dpi=200, bbox_inches='tight', facecolor='#0e1929')
print(f"Saved full airport to {out_path}")

# Terminal area detail (zoom in)
fig2, ax2 = plt.subplots(1, 1, figsize=(18, 18))
fig2.patch.set_facecolor('#0e1929')
draw_airport(ax2, show_labels=True, show_nodes=False)
ax2.set_xlim(-122.40, -122.36)
ax2.set_ylim(37.60, 37.64)
ax2.set_title('SFO Terminal Area Detail', color='white', fontsize=18, pad=20)
plt.tight_layout()
out_path2 = '/root/atc/public/sfo-asset2-detail.png'
plt.savefig(out_path2, dpi=200, bbox_inches='tight', facecolor='#0e1929')
print(f"Saved detail to {out_path2}")

# Node density visualization
fig3, ax3 = plt.subplots(1, 1, figsize=(22, 22))
fig3.patch.set_facecolor('#0e1929')
draw_airport(ax3, show_labels=False, show_nodes=True)
ax3.set_title(f'SFO Airport with All {len(surface.nodes)} Nodes', color='white', fontsize=18, pad=20)
plt.tight_layout()
out_path3 = '/root/atc/public/sfo-asset2-nodes.png'
plt.savefig(out_path3, dpi=200, bbox_inches='tight', facecolor='#0e1929')
print(f"Saved nodes to {out_path3}")
