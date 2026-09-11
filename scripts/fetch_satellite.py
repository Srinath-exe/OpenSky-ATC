#!/usr/bin/env python3
"""
Pre-fetch ONE static stitched satellite image per airport (Esri World Imagery
export endpoint) instead of live XYZ tiles.

Why: live raster tiles refetch from the network every time the map crosses a
zoom level, causing visible pop-in/reload while zooming. A single baked image
draped over the airport's bounding box scales as a GPU texture with the map —
no network activity during interaction.

Also bakes in a light blur + contrast/saturation trim so real parked aircraft
in the photography melt into the apron instead of visually competing with the
sim's own rendered aircraft.
"""
import json, math, os
import requests
from PIL import Image, ImageFilter, ImageEnhance
from io import BytesIO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSM_DIR = os.path.join(ROOT, 'public', 'maps', 'osm')
OUT_DIR = os.path.join(ROOT, 'public', 'maps', 'satellite')
os.makedirs(OUT_DIR, exist_ok=True)

AIRPORTS = ['EGLL', 'KLAX', 'KJFK', 'KSFO', 'KBOS', 'VIDP']
PAD = 0.35       # extra margin around the tightest OSM bbox (fraction of span)
MAX_DIM = 4096   # export image longest side, px — keeps close-in zoom levels sharp

# A second, much wider + softer image sits UNDER the detail one so a pitched 3D
# camera sees surrounding terrain instead of the detail image's hard edge.
# Still a static image => still zero tile refetching while zooming.
WIDE_PAD = 4.0
WIDE_DIM = 2048

def bbox_of(icao):
    with open(os.path.join(OSM_DIR, f'{icao}.geojson')) as f:
        d = json.load(f)
    minlng, minlat, maxlng, maxlat = 999.0, 999.0, -999.0, -999.0
    def visit(coords, depth):
        nonlocal minlng, minlat, maxlng, maxlat
        if depth == 0:
            lng, lat = coords[0], coords[1]
            minlng, maxlng = min(minlng, lng), max(maxlng, lng)
            minlat, maxlat = min(minlat, lat), max(maxlat, lat)
        else:
            for c in coords: visit(c, depth - 1)
    for ft in d['features']:
        g = ft['geometry']
        depth = {'Point': 0, 'LineString': 1, 'Polygon': 2, 'MultiPolygon': 3, 'MultiLineString': 2}.get(g['type'], 1)
        visit(g['coordinates'], depth)
    return minlng, minlat, maxlng, maxlat

def padded(bbox, pad):
    minlng, minlat, maxlng, maxlat = bbox
    w, h = maxlng - minlng, maxlat - minlat
    return (minlng - w * pad, minlat - h * pad, maxlng + w * pad, maxlat + h * pad)

MAX_AREA = 12_000_000   # Esri's export endpoint 500s above ~14M px total

def fetch(bbox, max_dim):
    minlng, minlat, maxlng, maxlat = bbox
    midlat = (minlat + maxlat) / 2
    # real-world aspect ratio: 1deg lng ≈ cos(lat) * 1deg lat in ground distance
    aspect = (maxlng - minlng) * math.cos(math.radians(midlat)) / (maxlat - minlat)
    if aspect >= 1: w, h = max_dim, round(max_dim / aspect)
    else:           w, h = round(max_dim * aspect), max_dim
    if w * h > MAX_AREA:
        scale = math.sqrt(MAX_AREA / (w * h))
        w, h = round(w * scale), round(h * scale)
    url = (
        'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export'
        f'?bbox={minlng},{minlat},{maxlng},{maxlat}&bboxSR=4326&imageSR=4326'
        f'&size={w},{h}&format=jpg&f=image'
    )
    print(f'  fetching {w}x{h}...')
    for attempt in range(3):
        try:
            res = requests.get(url, timeout=120)
            res.raise_for_status()
            return Image.open(BytesIO(res.content)).convert('RGB')
        except requests.exceptions.RequestException as e:
            if attempt == 2: raise
            print(f'  retry {attempt+1} after error: {e}')

bounds_out = {}

for icao in AIRPORTS:
    path = os.path.join(OSM_DIR, f'{icao}.geojson')
    if not os.path.exists(path):
        print(f'{icao}: no OSM geojson, skipping'); continue
    raw = bbox_of(icao)
    print(f'{icao}:')

    # ── detail image (sharp, over the airport itself)
    box = padded(raw, PAD)
    img = fetch(box, MAX_DIM)
    # Melt small high-contrast objects (parked aircraft, ground vehicles) into
    # the surrounding pavement so they don't visually clash with sim aircraft.
    img = img.filter(ImageFilter.GaussianBlur(radius=1.4))
    img = ImageEnhance.Contrast(img).enhance(0.90)
    img = ImageEnhance.Color(img).enhance(0.82)
    img = ImageEnhance.Brightness(img).enhance(1.03)
    out_path = os.path.join(OUT_DIR, f'{icao}.jpg')
    img.save(out_path, 'JPEG', quality=87)
    print(f'  detail -> {icao}.jpg ({img.width}x{img.height}, {os.path.getsize(out_path)//1024} KB)')

    # ── wide backdrop (soft, fills the horizon under a pitched 3D camera)
    wbox = padded(raw, WIDE_PAD)
    wimg = fetch(wbox, WIDE_DIM)
    wimg = wimg.filter(ImageFilter.GaussianBlur(radius=2.2))
    wimg = ImageEnhance.Color(wimg).enhance(0.7)
    wimg = ImageEnhance.Brightness(wimg).enhance(0.86)
    wout = os.path.join(OUT_DIR, f'{icao}_wide.jpg')
    wimg.save(wout, 'JPEG', quality=80)
    print(f'  wide   -> {icao}_wide.jpg ({wimg.width}x{wimg.height}, {os.path.getsize(wout)//1024} KB)')

    bounds_out[icao] = {
        'minLng': box[0], 'minLat': box[1], 'maxLng': box[2], 'maxLat': box[3],
        'wideMinLng': wbox[0], 'wideMinLat': wbox[1], 'wideMaxLng': wbox[2], 'wideMaxLat': wbox[3],
    }

with open(os.path.join(OUT_DIR, 'bounds.json'), 'w') as f:
    json.dump(bounds_out, f, indent=2)
print(f'\nWrote {os.path.join(OUT_DIR, "bounds.json")}')

# Also emit a TS module so the app can import bounds synchronously (no fetch needed).
ts_path = os.path.join(ROOT, 'src', 'lib', 'satelliteBounds.ts')
lines = [
    '// AUTO-GENERATED by scripts/fetch_satellite.py — do not edit by hand.',
    '// Bounding boxes (EPSG:4326) for the pre-baked static satellite images in',
    '// public/maps/satellite/{ICAO}.jpg, used as MapLibre `image` sources so the',
    '// ground view never refetches tiles while zooming/panning.',
    '// `wide*` is the soft, far-padded backdrop drawn beneath the detail image so',
    '// a pitched 3D camera sees terrain instead of the detail image\'s hard edge.',
    'export interface SatBounds {',
    '  minLng: number; minLat: number; maxLng: number; maxLat: number;',
    '  wideMinLng: number; wideMinLat: number; wideMaxLng: number; wideMaxLat: number;',
    '}',
    'export const SATELLITE_BOUNDS: Record<string, SatBounds> = {',
]
for icao, b in bounds_out.items():
    lines.append(
        f"  {icao}: {{ minLng: {b['minLng']}, minLat: {b['minLat']}, maxLng: {b['maxLng']}, maxLat: {b['maxLat']},"
        f" wideMinLng: {b['wideMinLng']}, wideMinLat: {b['wideMinLat']}, wideMaxLng: {b['wideMaxLng']}, wideMaxLat: {b['wideMaxLat']} }},"
    )
lines.append('};')
with open(ts_path, 'w') as f:
    f.write('\n'.join(lines) + '\n')
print(f'Wrote {ts_path}')
print('Done.')
