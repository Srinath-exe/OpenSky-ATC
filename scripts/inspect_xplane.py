#!/usr/bin/env python3
"""Inspect X-Plane generated GeoJSON layers for KSFO."""
import json
import os

base = '/root/atc/public/maps/xplane'
for f in sorted(os.listdir(base)):
    if f.endswith('.geojson'):
        path = f'{base}/{f}'
        with open(path) as fh:
            data = json.load(fh)
        features = data.get('features', [])
        if not features:
            print(f"{f}: EMPTY")
            continue
        geom_types = set()
        for feat in features[:5]:
            geom_types.add(feat.get('geometry', {}).get('type', 'unknown'))
        print(f"{f}: {len(features)} features, types: {geom_types}")
        # Show sample properties
        if features:
            print(f"  Sample props: {list(features[0].get('properties', {}).keys())}")
