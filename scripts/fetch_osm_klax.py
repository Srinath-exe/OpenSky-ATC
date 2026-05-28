#!/usr/bin/env python3
"""
Fetch OSM aeroway data for KLAX using osmnx and save as GeoJSON.
This gets the REAL jetways and terminals from OSM to match Image 2's structure.
Outputs to /root/atc/public/maps/lax_experiment/
"""
import osmnx as ox
import json
import os
import shutil
import warnings

# Suppress osmnx warnings about deprecation
warnings.filterwarnings('ignore')

OUT_DIR = '/root/atc/public/maps/lax_experiment'
os.makedirs(OUT_DIR, exist_ok=True)

# KLAX bounding box (North, South, East, West)
BBOX = (33.966, 33.919, -118.380, -118.432)

def fetch_and_save(tags, filename, geom_type_filter=None):
    print(f"Fetching {tags}...")
    try:
        gdf = ox.features_from_bbox(BBOX, tags=tags)
        
        if geom_type_filter:
            # e.g. filter to only Polygons/MultiPolygons
            gdf = gdf[gdf.geometry.type.isin(geom_type_filter)]
            
        if len(gdf) == 0:
            print(f"  No valid geometries found for {tags}")
            return
            
        # Convert to GeoJSON, dropping unnecessary columns that might cause serialization issues
        # Keep 'name', 'aeroway', 'building', 'ref'
        cols_to_keep = ['geometry']
        for col in ['name', 'aeroway', 'building', 'ref', 'gate:type', 'iata', 'icao']:
            if col in gdf.columns:
                cols_to_keep.append(col)
                
        gdf_clean = gdf[cols_to_keep].copy()
        
        # Save to file
        path = f"{OUT_DIR}/{filename}"
        gdf_clean.to_file(path, driver='GeoJSON')
        print(f"  ✓ Saved {len(gdf_clean)} features to {filename}")
        
    except Exception as e:
        print(f"  ERROR fetching {tags}: {e}")

print("="*60)
print("Fetching KLAX OSM Data via OSMnx...")
print("="*60)

# Fetch OSM Jetways (real geometry, not synthesized!)
fetch_and_save({'aeroway': 'jetway'}, 'osm_jetbridges.geojson')

# Fetch OSM Terminals
fetch_and_save({'aeroway': 'terminal'}, 'osm_terminals.geojson')
fetch_and_save({'building': 'terminal'}, 'osm_terminals_bldg.geojson', geom_type_filter=['Polygon', 'MultiPolygon'])

# Fetch OSM Gates
fetch_and_save({'aeroway': 'gate'}, 'osm_gates.geojson', geom_type_filter=['Point'])
fetch_and_save({'aeroway': 'parking_position'}, 'osm_parking.geojson', geom_type_filter=['Point'])

# Fetch OSM Aprons
fetch_and_save({'aeroway': 'apron'}, 'osm_aprons.geojson', geom_type_filter=['Polygon', 'MultiPolygon'])

print("Done with OSM data.")

# We also need to copy the X-Plane data to make sure it's available
print("\nCopying X-Plane data layers...")
XPLANE = '/root/atc/public/maps/xplane/KLAX/combined'
xplane_layers = [
    'pavement_taxiways', 'pavement_aprons', 'pavement_runways',
    'lines_edges', 'lines_centerlines', 'lines_holds', 'lines_other',
    'signs', 'startup_locations', 'windsocks', 'boundary', 'runways',
]
for layer in xplane_layers:
    src = f'{XPLANE}/{layer}.geojson'
    dst = f'{OUT_DIR}/xp_{layer}.geojson'
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print(f"  ✓ Copied xp_{layer}.geojson")

print("="*60)
print("All data prepared for LAX experiment!")
