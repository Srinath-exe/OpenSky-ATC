#!/usr/bin/env python3
"""Fetch X-Plane Scenery Gateway data for multiple airports and convert to GeoJSON."""
import os
import json
from xplane_airports.gateway import scenery_pack
from xplane_apt_convert import ParsedAirport

AIRPORTS = [
    ('KSFO', 'San Francisco Intl'),
    ('KJFK', 'John F Kennedy Intl'),
    ('KLAX', 'Los Angeles Intl'),
    ('KBOS', 'Boston Logan Intl'),
    ('VIDP', 'Indira Gandhi Intl'),
]

base_dir = '/root/atc/public/maps/xplane'
os.makedirs(base_dir, exist_ok=True)

for icao, name in AIRPORTS:
    print(f"\n{'='*50}")
    print(f"Fetching {icao} — {name}...")
    print('='*50)
    
    out_dir = f'{base_dir}/{icao}'
    os.makedirs(out_dir, exist_ok=True)
    
    try:
        pack = scenery_pack(icao)
        apt = pack.apt
        p_apt = ParsedAirport(apt)
        
        print(f"  Airport: {apt.name}")
        print(f"  Runways: {apt.has_row_code(100)}")
        print(f"  Taxiways: {apt.has_taxiway}")
        print(f"  Markings: {apt.has_row_code(120)}")
        print(f"  Gates: {apt.has_row_code(1300)}")
        
        # Export all individual layers
        for layer_name in ['Runway', 'Taxiway', 'Apron', 'Marking', 'Gate', 'Sign', 'Boundary', 'Windsock']:
            out_path = f'{out_dir}/{icao}_{layer_name}.geojson'
            try:
                p_apt.export(out_path, driver='GeoJSON', layer=layer_name)
                if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
                    print(f"    {layer_name}: {os.path.getsize(out_path):,} bytes")
                else:
                    print(f"    {layer_name}: empty")
                    if os.path.exists(out_path):
                        os.remove(out_path)
            except Exception as e:
                print(f"    {layer_name}: ERROR - {e}")
        
        # Export combined all-features file
        p_apt.export(f'{out_dir}/{icao}_all.geojson', driver='GeoJSON')
        
        # Export specific geometry-based files if available
        for suffix in ['pavements', 'runways', 'linear_features', 'startup_locations', 'signs', 'windsocks', 'boundary']:
            try:
                fname = f'{out_dir}/{icao}_all.{suffix}.geojson'
                # The ParsedAirport export might create these as side files depending on version
                # Let's check if they exist after the all export
            except:
                pass
        
        print(f"  Done! Files in {out_dir}:")
        for f in sorted(os.listdir(out_dir)):
            fp = f'{out_dir}/{f}'
            if f.endswith('.geojson'):
                print(f"    {f}: {os.path.getsize(fp):,} bytes")
                
    except Exception as e:
        print(f"  FAILED: {e}")

print(f"\n{'='*50}")
print("All airports processed!")
