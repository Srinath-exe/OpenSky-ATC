#!/usr/bin/env python3
"""
Bake a procedural "world" for the 3D airport map (src/components/atc/WorldMap):
  public/world/<ICAO>/height.png   heightmap, 16-bit value split over R/G bytes (h = hMin + v * (hMax-hMin)/65535)
  public/world/<ICAO>/land.png     RGBA land data: R = vegetation 0..255, G = brightness 0..255, B = water 0..255 (feathered), A = warmth (red minus blue, 128 neutral: tan scrub / bare soil above, grey urban / rock below)
  public/world/<ICAO>/vectors.json roads (by class), rail, water polygons, buildings near the field — lng/lat polylines
  public/world/<ICAO>/meta.json    bbox, grid size, elevation range, centre

Sources (all free / no key): AWS terrain tiles (Mapzen terrarium, SRTM/Copernicus), the baked Esri wide imagery
(public/maps/satellite/<ICAO>_wide.jpg) used ONLY as a land-cover classifier, OpenStreetMap via Overpass.
The renderer never shows the photo: every pixel is shaded from the height + land values.

Usage: python3 scripts/bake_world.py KSFO [--grid 1024] [--land-only]
       then python3 scripts/pack_world.py KSFO   (the .webp the game actually downloads; bump WORLD_ASSET_VERSION)
"""
import io, json, math, sys, time, os
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
OVERPASS = 'https://lz4.overpass-api.de/api/interpreter'
CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.scratch-e2e', 'world_cache')

def wide_bbox(icao):
    """Parse the wide bbox from src/lib/satelliteBounds.ts (kept in one place for the 2D map too)."""
    import re
    src = open(os.path.join(ROOT, 'src/lib/satelliteBounds.ts')).read()
    m = re.search(icao + r':\s*\{[^}]*wideMinLng:\s*([-\d.]+),\s*wideMinLat:\s*([-\d.]+),\s*wideMaxLng:\s*([-\d.]+),\s*wideMaxLat:\s*([-\d.]+)', src)
    if not m: raise SystemExit(f'no wide bounds for {icao}')
    return tuple(float(v) for v in m.groups())

def tile_xy(lng, lat, z):
    n = 2 ** z
    x = (lng + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def fetch_dem(bbox, z=12):
    """Mosaic terrarium tiles covering bbox; returns (heights[m] array in tile pixel space, and a lng/lat -> pixel mapper)."""
    minlng, minlat, maxlng, maxlat = bbox
    x0, y1 = tile_xy(minlng, minlat, z); x1, y0 = tile_xy(maxlng, maxlat, z)
    tx0, tx1, ty0, ty1 = int(x0), int(x1), int(y0), int(y1)
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    mosaic = np.zeros((H, W), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            for attempt in range(4):
                r = requests.get(TERRARIUM.format(z=z, x=tx, y=ty), timeout=30)
                if r.status_code == 200: break
                time.sleep(1.5)
            px = np.asarray(Image.open(io.BytesIO(r.content)).convert('RGB'), np.float32)
            h = px[..., 0] * 256 + px[..., 1] + px[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = h
    def to_px(lng, lat):
        x, y = tile_xy(lng, lat, z)
        return (x - tx0) * 256, (y - ty0) * 256
    return mosaic, to_px

def resample_grid(mosaic, to_px, bbox, grid):
    """Sample the mosaic on an equirectangular grid over bbox (row 0 = north)."""
    minlng, minlat, maxlng, maxlat = bbox
    lngs = np.linspace(minlng, maxlng, grid)
    lats = np.linspace(maxlat, minlat, grid)
    out = np.zeros((grid, grid), np.float32)
    H, W = mosaic.shape
    for i, lat in enumerate(lats):
        xs, ys = zip(*(to_px(lng, lat) for lng in lngs))
        xs = np.clip(np.array(xs), 0, W - 1.001); ys = np.clip(np.array(ys), 0, H - 1.001)
        x0 = xs.astype(int); y0 = ys.astype(int); fx = xs - x0; fy = ys - y0
        out[i] = (mosaic[y0, x0] * (1 - fx) * (1 - fy) + mosaic[y0, x0 + 1] * fx * (1 - fy)
                  + mosaic[y0 + 1, x0] * (1 - fx) * fy + mosaic[y0 + 1, x0 + 1] * fx * fy)
    return out

def overpass(query, tries=3):
    import hashlib
    os.makedirs(CACHE, exist_ok=True)
    cf = os.path.join(CACHE, hashlib.md5(query.encode()).hexdigest() + '.json')
    if os.path.exists(cf): return json.load(open(cf))['elements']
    # the public Overpass instances time out under load: rotate through the mirrors, back off between rounds
    mirrors = [OVERPASS, 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
    status = None
    for i in range(tries * len(mirrors)):
        url = mirrors[i % len(mirrors)]
        try:
            r = requests.post(url, data={'data': query}, timeout=240, headers={'User-Agent': 'skycontrol-bake/1.0 (atc sim; contact: dev@skycontrol.local)'})
            status = r.status_code
            if r.status_code == 200 and r.text.lstrip().startswith('{'):
                open(cf, 'w').write(r.text)
                return r.json()['elements']
        except requests.RequestException as e:
            status = str(e)[:60]
        print('  overpass', status, 'retrying on the next mirror'); time.sleep(6 + 6 * (i // len(mirrors)))
    raise SystemExit(f'overpass failed: {status}')

def land_from_imagery(icao, bbox, grid, height):
    """Land-cover values from the wide Esri image: vegetation (excess green), brightness, water (dark + low-lying)."""
    img = Image.open(os.path.join(ROOT, f'public/maps/satellite/{icao}_wide.jpg')).convert('RGB').resize((grid, grid), Image.LANCZOS)
    px = np.asarray(img, np.float32) / 255
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    bright = (0.299 * r + 0.587 * g + 0.114 * b)
    exg = np.clip((2 * g - r - b) * 2.2 + 0.05, 0, 1)                      # vegetation amount
    # water: low-lying and dark / bluish; the bay + ocean sit at <= ~1 m in the DEM
    dark = bright < 0.34
    bluish = (b >= r - 0.02)
    water = (height <= 1.2) & dark & bluish
    # tidy the mask: close small gaps, drop specks
    wm = Image.fromarray((water * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    water = np.asarray(wm) > 127
    warm = np.clip((r - b) * 4 + 0.5, 0.2, 1)                                # dry scrub and soil read warm, streets and roofs grey
    return exg, bright, water, warm

def rasterize_polys(polys, bbox, grid):
    minlng, minlat, maxlng, maxlat = bbox
    im = Image.new('L', (grid, grid), 0); d = ImageDraw.Draw(im)
    for poly in polys:
        pts = [((p[0] - minlng) / (maxlng - minlng) * grid, (maxlat - p[1]) / (maxlat - minlat) * grid) for p in poly]
        if len(pts) >= 3: d.polygon(pts, fill=255)
    return np.asarray(im) > 127

def simplify(pts, tol):
    """Douglas-Peucker in degrees."""
    if len(pts) < 3: return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a; L = np.dot(ab, ab) or 1e-12
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i]); t = np.clip(np.dot(p - a, ab) / L, 0, 1); d = np.linalg.norm(p - (a + t * ab))
        if d > dmax: dmax, idx = d, i
    if dmax > tol:
        return simplify(pts[:idx + 1], tol)[:-1] + simplify(pts[idx:], tol)
    return [pts[0], pts[-1]]

def main():
    icao = sys.argv[1].upper()
    grid = int(sys.argv[sys.argv.index('--grid') + 1]) if '--grid' in sys.argv else 1024
    bbox = wide_bbox(icao)
    minlng, minlat, maxlng, maxlat = bbox
    out = os.path.join(ROOT, 'public/world', icao); os.makedirs(out, exist_ok=True)
    print('bbox', bbox, 'grid', grid)

    print('DEM …')
    demf = os.path.join(CACHE, f'{icao}_dem_{grid}.npy'); os.makedirs(CACHE, exist_ok=True)
    if os.path.exists(demf): height = np.load(demf)
    else:
        mosaic, to_px = fetch_dem(bbox); height = resample_grid(mosaic, to_px, bbox, grid); np.save(demf, height)
    height = np.maximum(height, -5)
    # soften SRTM noise a touch (keeps ridges, kills the 1 m stair-steps on the flats)
    from scipy.ndimage import gaussian_filter
    height = gaussian_filter(height, 0.8).astype(np.float32)

    print('land …')
    lgrid = grid * 2   # land detail at ~16 m; the height field stays at `grid`
    from scipy.ndimage import zoom as _zoom
    height_l = _zoom(height, 2, order=1)
    veg, bright, water, warm = land_from_imagery(icao, bbox, lgrid, height_l)
    if '--land-only' in sys.argv:   # re-classify the imagery only (no Overpass): land.png from the existing height.png
        water_f = gaussian_filter(water.astype(np.float32), 1.0)
        land = np.stack([veg * 255, bright * 255, water_f * 255, warm * 255], -1).astype(np.uint8)
        Image.fromarray(land, 'RGBA').save(os.path.join(out, 'land.png'), optimize=True)
        print('land.png rewritten (veg', round(float(veg.mean()), 2), 'warm', round(float(warm.mean()), 2), ')'); return

    print('OSM water / roads / rail / buildings …')
    bb = f'{minlat},{minlng},{maxlat},{maxlng}'
    els = overpass(f'[out:json][timeout:170];(way["natural"="water"]({bb});relation["natural"="water"]({bb}););out geom;')
    lakes = []
    for e in els:
        if e['type'] == 'way' and 'geometry' in e:
            lakes.append([(p['lon'], p['lat']) for p in e['geometry']])
        elif e['type'] == 'relation':
            for m in e.get('members', []):
                if m.get('role') == 'outer' and 'geometry' in m: lakes.append([(p['lon'], p['lat']) for p in m['geometry']])
    water |= rasterize_polys(lakes, bbox, lgrid)

    els = overpass(f'[out:json][timeout:170];(way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link)$"]({bb});way["railway"="rail"]({bb}););out geom;')
    roads = {'motorway': [], 'trunk': [], 'primary': [], 'secondary': [], 'rail': []}
    tol = 0.00012  # ~12 m
    for e in els:
        if 'geometry' not in e: continue
        tags = e.get('tags', {})
        cls = 'rail' if tags.get('railway') == 'rail' else tags.get('highway', '').replace('_link', '')
        if cls not in roads: continue
        pts = simplify([(round(p['lon'], 5), round(p['lat'], 5)) for p in e['geometry']], tol)
        if len(pts) >= 2: roads[cls].append(pts)

    # buildings within ~4 km of the field centre (terminals, hangars, the industrial belt) — the rest of the city is shading
    clat, clng = (minlat + maxlat) / 2, (minlng + maxlng) / 2
    dlat, dlng = 4000 / 111320, 4000 / (111320 * math.cos(math.radians(clat)))
    els = overpass(f'[out:json][timeout:170];(way["building"]({clat - dlat},{clng - dlng},{clat + dlat},{clng + dlng}););out geom;')
    buildings = []
    for e in els:
        if 'geometry' not in e or len(e['geometry']) < 4: continue
        t = e.get('tags', {})
        h = None
        try:
            if 'height' in t: h = float(str(t['height']).split()[0])
            elif 'building:levels' in t: h = float(t['building:levels']) * 3.4
        except ValueError: h = None
        poly = [(round(p['lon'], 6), round(p['lat'], 6)) for p in e['geometry']]
        kind = 'terminal' if t.get('aeroway') == 'terminal' else 'hangar' if t.get('building') == 'hangar' else 'b'
        # keep the file small: near the field every building >= 200 m², further out only large ones
        px = [p[0] for p in poly]; py = [p[1] for p in poly]
        cxm = (sum(px) / len(px) - clng) * 111320 * math.cos(math.radians(clat)); cym = (sum(py) / len(py) - clat) * 111320
        a2 = abs(sum(px[i] * py[i + 1] - px[i + 1] * py[i] for i in range(len(poly) - 1))) / 2 * 111320 * 111320 * math.cos(math.radians(clat))
        if not ((math.hypot(cxm, cym) < 2500 and a2 >= 200) or a2 >= 900 or kind != 'b'): continue
        buildings.append({'p': poly, 'h': h, 'k': kind})
    print(f'  lakes {len(lakes)}  roads {sum(len(v) for v in roads.values())}  buildings {len(buildings)}')

    # ── write ──
    hmin, hmax = float(height.min()), float(height.max())
    scale = 65535 / max(1.0, hmax - hmin)
    # 16-bit height split over R (high byte) / G (low byte): browsers flatten 16-bit greys to 8 bits, RGB stays exact
    h16 = ((height - hmin) * scale).astype(np.uint16)
    hrgb = np.stack([h16 >> 8, h16 & 255, np.zeros_like(h16)], -1).astype(np.uint8)
    Image.fromarray(hrgb, 'RGB').save(os.path.join(out, 'height.png'), optimize=True)
    water_f = gaussian_filter(water.astype(np.float32), 1.0)   # feathered shoreline
    land = np.stack([veg * 255, bright * 255, water_f * 255, warm * 255], -1).astype(np.uint8)
    Image.fromarray(land, 'RGBA').save(os.path.join(out, 'land.png'), optimize=True)
    json.dump({'roads': roads, 'buildings': buildings}, open(os.path.join(out, 'vectors.json'), 'w'), separators=(',', ':'))
    json.dump({'icao': icao, 'bbox': {'minLng': minlng, 'minLat': minlat, 'maxLng': maxlng, 'maxLat': maxlat}, 'grid': grid, 'landGrid': lgrid,
               'hMin': hmin, 'hMax': hmax, 'center': {'lng': clng, 'lat': clat}}, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
    print('elevation', round(hmin, 1), '..', round(hmax, 1), 'm  water', round(float(water.mean()) * 100, 1), '%  veg', round(float(veg.mean()), 2))
    print('wrote', out)

if __name__ == '__main__':
    main()
