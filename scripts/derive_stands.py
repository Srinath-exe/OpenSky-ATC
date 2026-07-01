#!/usr/bin/env python3
"""
Derive aircraft-stand POINTS from OSM `aeroway=parking_position` features.

OSM stores parking stands two ways:
  - aeroway=gate            → terminal gate points (sparse)
  - aeroway=parking_position → the actual aircraft stands (dense; usually the
                               lead-in guidance LINE, sometimes a point)

X-Plane's `startup_locations` correspond to parking_position, so to match that
density we synthesise a Point ("aeroway":"stand") for every parking_position.
For a LineString we use the endpoint farthest from the apron edge (the nose-stop
end) as the stand location.

Runs locally on already-fetched files — no network. Idempotent: it strips any
previously-derived "stand" features before re-adding.

Usage:  python3 scripts/derive_stands.py
"""
import json, os, glob, math

OSM_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "maps", "osm")


def meters(a, b):
    R = 6371000
    dlat = math.radians(b[1] - a[1])
    dlng = math.radians(b[0] - a[0])
    mid = math.radians((a[1] + b[1]) / 2)
    return math.hypot(dlat * R, dlng * R * math.cos(mid))


def stand_point(geom):
    """Return [lng,lat] for a parking_position geometry."""
    if geom["type"] == "Point":
        return geom["coordinates"]
    cs = geom["coordinates"]
    if not cs:
        return None
    # LineString: use the endpoint, picking the one whose neighbourhood is the
    # "tip" of the stand. Heuristic: the longer overall, the nose-stop is an end;
    # we just take the last vertex (parking end in most OSM data).
    return cs[-1]


def process(path):
    with open(path) as f:
        fc = json.load(f)
    feats = [f for f in fc["features"] if f["properties"].get("aeroway") != "stand"]

    stands = 0
    for f in list(feats):
        if f["properties"].get("aeroway") != "parking_position":
            continue
        pt = stand_point(f["geometry"])
        if not pt:
            continue
        feats.append({
            "type": "Feature",
            "properties": {
                "aeroway": "stand",
                "ref": f["properties"].get("ref"),
                "id": f["properties"].get("id"),
            },
            "geometry": {"type": "Point", "coordinates": pt},
        })
        stands += 1

    fc["features"] = feats
    with open(path, "w") as f:
        json.dump(fc, f)
    icao = os.path.basename(path).replace(".geojson", "")
    gates = sum(1 for x in feats if x["properties"].get("aeroway") == "gate")
    print(f"  {icao}: +{stands} stands  ({gates} gates + {stands} stands = {gates + stands} parking points)")


def main():
    files = sorted(glob.glob(os.path.join(OSM_DIR, "*.geojson")))
    if not files:
        print("No OSM files found — run fetch_osm_airports.py first.")
        return
    print("Deriving stands from parking_position …")
    for p in files:
        process(p)


if __name__ == "__main__":
    main()
