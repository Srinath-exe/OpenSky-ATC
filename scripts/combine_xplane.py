import json
import os

# Merge all X-Plane layers into combined feature collections per geometry type
base = '/root/atc/public/maps/xplane'
out = '/root/atc/public/maps/xplane/combined'
os.makedirs(out, exist_ok=True)

# Load all files
with open(f'{base}/KSFO_all.pavements.geojson') as f:
    pavements = json.load(f)
with open(f'{base}/KSFO_all.runways.geojson') as f:
    runways = json.load(f)
with open(f'{base}/KSFO_all.linear_features.geojson') as f:
    lines = json.load(f)
with open(f'{base}/KSFO_all.startup_locations.geojson') as f:
    startups = json.load(f)
with open(f'{base}/KSFO_all.signs.geojson') as f:
    signs = json.load(f)
with open(f'{base}/KSFO_all.windsocks.geojson') as f:
    windsocks = json.load(f)
with open(f'{base}/KSFO_all.boundary.geojson') as f:
    boundary = json.load(f)

# Categorize pavements into runways, taxiways, aprons
runway_names = set()
for r in runways['features']:
    runway_names.add(r['properties'].get('name_1', ''))
    runway_names.add(r['properties'].get('name_2', ''))

runway_polys = []
taxiway_polys = []
apron_polys = []

for p in pavements['features']:
    name = p['properties'].get('name', '')
    # If name matches a runway, it's a runway shoulder/apron
    if any(name.startswith(r) for r in runway_names if r):
        runway_polys.append(p)
    elif name and any(c.isalpha() for c in name):
        # Named with letters = taxiway
        taxiway_polys.append(p)
    else:
        apron_polys.append(p)

print(f"Pavements: {len(runway_polys)} runway, {len(taxiway_polys)} taxiway, {len(apron_polys)} apron")

# Categorize lines
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
    else:
        other_lines.append(l)

print(f"Lines: {len(hold_lines)} holds, {len(centerlines)} centerlines, {len(edge_lines)} edges, {len(other_lines)} other")

# Write combined files
for name, data in [
    ('pavement_runways', {'type': 'FeatureCollection', 'features': runway_polys}),
    ('pavement_taxiways', {'type': 'FeatureCollection', 'features': taxiway_polys}),
    ('pavement_aprons', {'type': 'FeatureCollection', 'features': apron_polys}),
    ('lines_holds', {'type': 'FeatureCollection', 'features': hold_lines}),
    ('lines_centerlines', {'type': 'FeatureCollection', 'features': centerlines}),
    ('lines_edges', {'type': 'FeatureCollection', 'features': edge_lines}),
    ('lines_other', {'type': 'FeatureCollection', 'features': other_lines}),
    ('runways', runways),
    ('startup_locations', startups),
    ('signs', signs),
    ('windsocks', windsocks),
    ('boundary', boundary),
]:
    with open(f'{out}/{name}.geojson', 'w') as f:
        json.dump(data, f)
    print(f"  {name}: {len(data['features'])} features")

print(f"\nAll combined files written to {out}")
