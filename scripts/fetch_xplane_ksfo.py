#!/usr/bin/env python3
"""Fetch KSFO from X-Plane Scenery Gateway and convert to GeoJSON polygons."""
import os
from xplane_airports.gateway import scenery_pack
from xplane_apt_convert import ParsedAirport

os.makedirs('/root/atc/public/maps/xplane', exist_ok=True)

print("Fetching KSFO from X-Plane Scenery Gateway...")
pack = scenery_pack('KSFO')
apt = pack.apt

print(f"Airport: {apt.name} ({apt.id})")
print(f"Has runways: {apt.has_row_code(100)}")
print(f"Has taxiways: {apt.has_taxiway}")
print(f"Has markings: {apt.has_row_code(120)}")
print(f"Has gates: {apt.has_row_code(1300)}")

p_apt = ParsedAirport(apt)
out_dir = '/root/atc/public/maps/xplane'

# Export individual feature layers
for layer_name in ['Runway', 'Taxiway', 'Apron', 'Marking', 'Gate', 'Sign', 'Boundary', 'Windsock']:
    out_path = f'{out_dir}/KSFO_{layer_name}.geojson'
    try:
        p_apt.export(out_path, driver='GeoJSON', layer=layer_name)
        # Check if file was actually written
        if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
            print(f"  {layer_name}: {os.path.getsize(out_path)} bytes")
        else:
            print(f"  {layer_name}: empty or small")
            # Remove empty files
            if os.path.exists(out_path):
                os.remove(out_path)
    except Exception as e:
        print(f"  {layer_name}: ERROR - {e}")

# Also export the combined file
p_apt.export(f'{out_dir}/KSFO_all.geojson', driver='GeoJSON')
print(f"\nCombined export: {os.path.getsize(f'{out_dir}/KSFO_all.geojson')} bytes")

# List all generated files
print(f"\nFiles in {out_dir}:")
for f in sorted(os.listdir(out_dir)):
    fp = f'{out_dir}/{f}'
    if f.endswith('.geojson'):
        print(f"  {f}: {os.path.getsize(fp):,} bytes")
