#!/usr/bin/env python3
"""
Fetch real airport geometry from OpenStreetMap (aeroway data) via the Overpass
API and write clean per-airport GeoJSON for the SkyControl ground radar.

This is the SAME data source AirNav Radar / FlightRadar24 use for their airport
diagrams. OSM taxiways are clean LineStrings that already share nodes at
intersections, so they form a connected, routable graph with no healing needed.

Output: public/maps/osm/<ICAO>.geojson   (one FeatureCollection per airport)

Usage:  python3 scripts/fetch_osm_airports.py [ICAO ...]
        (no args = fetch all in AIRPORTS below)
"""
import json, os, sys, time, urllib.request, urllib.parse

OVERPASS = "https://overpass-api.de/api/interpreter"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "maps", "osm")

# ICAO -> (lat, lng, half-box-degrees).  Half-box ~0.06deg ≈ 6.6 km radius.
AIRPORTS = {
    "KLAX": (33.9416, -118.4081, 0.055),
    "KSFO": (37.6213, -122.3790, 0.050),
    "KJFK": (40.6413,  -73.7781, 0.060),
    "KBOS": (42.3656,  -71.0096, 0.050),
    "VIDP": (28.5562,   77.1000, 0.060),
    "EGLL": (51.4700,   -0.4543, 0.070),   # London Heathrow — the AirNav example
}

# aeroway values we care about
LINE_TYPES = {"runway", "taxiway", "parking_position"}
AREA_TYPES = {"apron", "terminal", "hangar"}
POINT_TYPES = {"gate", "holding_position", "windsock"}
ALL_TYPES = LINE_TYPES | AREA_TYPES | POINT_TYPES


def overpass_query(lat, lng, half):
    s, w = lat - half, lng - half
    n, e = lat + half, lng + half
    bbox = f"{s},{w},{n},{e}"
    aeroway = "|".join(sorted(ALL_TYPES))
    return f"""
[out:json][timeout:60];
(
  way["aeroway"~"^({aeroway})$"]({bbox});
  node["aeroway"~"^({aeroway})$"]({bbox});
  relation["aeroway"~"^(apron|terminal)$"]({bbox});
);
out geom;
"""


def fetch(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS, data=data,
                                 headers={"User-Agent": "SkyControl/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def to_features(elements):
    feats = []
    for el in elements:
        tags = el.get("tags", {})
        aeroway = tags.get("aeroway")
        if aeroway not in ALL_TYPES:
            continue
        props = {
            "aeroway": aeroway,
            "ref": tags.get("ref"),
            "name": tags.get("name"),
            "surface": tags.get("surface"),
            "id": el.get("id"),
        }

        if el["type"] == "node":
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}

        elif el["type"] == "way":
            coords = [[p["lon"], p["lat"]] for p in el.get("geometry", [])]
            if len(coords) < 2:
                continue
            closed = coords[0] == coords[-1]
            if aeroway in AREA_TYPES and closed:
                geom = {"type": "Polygon", "coordinates": [coords]}
            else:
                geom = {"type": "LineString", "coordinates": coords}

        else:  # relation (multipolygon apron/terminal) — collect outer ways
            outers = []
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    ring = [[p["lon"], p["lat"]] for p in m["geometry"]]
                    if len(ring) >= 3:
                        outers.append([ring])
            if not outers:
                continue
            geom = {"type": "MultiPolygon", "coordinates": outers}

        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    return feats


def add_stands(feats):
    """Synthesise stand Points from parking_position (see derive_stands.py)."""
    out = [f for f in feats if f["properties"].get("aeroway") != "stand"]
    for f in list(out):
        if f["properties"].get("aeroway") != "parking_position":
            continue
        g = f["geometry"]
        pt = g["coordinates"] if g["type"] == "Point" else (g["coordinates"][-1] if g["coordinates"] else None)
        if not pt:
            continue
        out.append({
            "type": "Feature",
            "properties": {"aeroway": "stand", "ref": f["properties"].get("ref"), "id": f["properties"].get("id")},
            "geometry": {"type": "Point", "coordinates": pt},
        })
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = sys.argv[1:] or list(AIRPORTS.keys())
    for icao in targets:
        if icao not in AIRPORTS:
            print(f"!! {icao}: no bbox configured, skipping")
            continue
        lat, lng, half = AIRPORTS[icao]
        print(f"== {icao}: querying Overpass ...", flush=True)
        try:
            res = fetch(overpass_query(lat, lng, half))
        except Exception as e:
            print(f"!! {icao}: Overpass failed: {e}")
            continue
        feats = add_stands(to_features(res.get("elements", [])))
        counts = {}
        for f in feats:
            counts[f["properties"]["aeroway"]] = counts.get(f["properties"]["aeroway"], 0) + 1
        fc = {"type": "FeatureCollection", "icao": icao,
              "center": [lng, lat], "features": feats}
        out = os.path.abspath(os.path.join(OUT_DIR, f"{icao}.geojson"))
        with open(out, "w") as fh:
            json.dump(fc, fh)
        print(f"   {len(feats)} features -> {out}")
        print(f"   {counts}")
        time.sleep(1.5)  # be polite to Overpass


if __name__ == "__main__":
    main()
