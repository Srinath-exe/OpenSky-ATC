#!/usr/bin/env python3
"""Generate Endless-ATC-format airspace files from the OSM runway geometry.

  python3 scripts/gen_airspace.py            # all generated airports + EGLL check
  python3 scripts/gen_airspace.py KLAX KSFO  # a subset

Generated airports (KLAX, KJFK, KSFO, KBOS, VIDP) get a complete file:
  [airspace]   radius / centre / magnetic variation / altitudes / 8 boundary
               fixes (synthetic 5-letter names: ICAO core + compass sector)
  [airport1]   one `runways` row per runway END, oriented with the SAME rule as
               src/lib/osmAirport.ts (via scripts/osm_runways.py): the end whose
               designator ×10 matches the magnetic bearing from that end to the
               other gets that name. Coordinates are the physical pavement end;
               ILS localizer course = runway true heading; displaced thresholds
               (when OSM way splits reveal them) fill columns 7/8.
  [departureN] one section per runway end: a SID to every boundary fix
               (`{FIX}1{letter}`), first waypoint = departure end of runway with
               the initial climb altitude, then a straight-ahead point, then the fix
  [approachN]  one section per runway end: a STAR from every boundary fix
               (`{FIX}2{letter}`) to a 10 NM final-intercept point, via a
               downwind/base leg when the fix lies behind the runway

EGLL.txt is an authored community file and is NOT regenerated. This script
validates its 27L/27R rows against the OSM geometry and (idempotently) appends
a marked block with: [airport3] = the easterly ends 09L/09R (ILS derived from
the OSM geometry, displaced thresholds from the authored 27 rows), mirrored
easterly SIDs, and STARs from the four entry beacons to all four ends.

Runway-row column order (as read by src/lib/airspace/eairport.ts):
  id, name, lat, lng, trueHdg, lengthFt, displacedThisFt, displacedOppFt,
  elevFt, glideslopeDeg, locCourse, 0, 0, 0, 0, 0, towerFreq
"""
import math, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osm_runways import runways_for, advance, bearing, dist_m, ang_diff  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'public', 'airspace')
NM = 1852.0
FT = 0.3048

# Airport metadata. magvar is degrees EAST-positive (Endless ATC `magneticvar`).
AIRPORTS = {
    'KLAX': {'name': 'Los Angeles Intl', 'elev': 128, 'radius': 25, 'magvar': 11.5, 'tower': 120.95, 'climb': 5000, 'core': 'LAX'},
    'KJFK': {'name': 'John F. Kennedy Intl', 'elev': 13, 'radius': 25, 'magvar': -12.7, 'tower': 119.1, 'climb': 5000, 'core': 'JFK'},
    'KSFO': {'name': 'San Francisco Intl', 'elev': 13, 'radius': 25, 'magvar': 13.2, 'tower': 120.5, 'climb': 5000, 'core': 'SFO'},
    'KBOS': {'name': 'Boston Logan Intl', 'elev': 20, 'radius': 25, 'magvar': -14.2, 'tower': 128.8, 'climb': 5000, 'core': 'BOS'},
    'VIDP': {'name': 'Indira Gandhi Intl', 'elev': 777, 'radius': 25, 'magvar': 0.9, 'tower': 118.1, 'climb': 6000, 'core': 'IDP'},
    'VHHH': {'name': 'Hong Kong Intl', 'elev': 28, 'radius': 25, 'magvar': -3.4, 'tower': 118.2, 'climb': 5000, 'core': 'HKG'},
    'YSSY': {'name': 'Sydney Kingsford Smith', 'elev': 21, 'radius': 25, 'magvar': 12.7, 'tower': 120.5, 'climb': 5000, 'core': 'SSY'},
    'LFPG': {'name': 'Paris Charles de Gaulle', 'elev': 392, 'radius': 25, 'magvar': 2.0, 'tower': 119.25, 'climb': 5000, 'core': 'CDG'},
    'WSSS': {'name': 'Singapore Changi', 'elev': 22, 'radius': 25, 'magvar': 0.2, 'tower': 118.6, 'climb': 5000, 'core': 'SIN'},
    'RJTT': {'name': 'Tokyo Haneda', 'elev': 21, 'radius': 25, 'magvar': -7.7, 'tower': 118.1, 'climb': 5000, 'core': 'HND'},
    'OMDB': {'name': 'Dubai Intl', 'elev': 62, 'radius': 25, 'magvar': 2.0, 'tower': 118.75, 'climb': 5000, 'core': 'DXB'},
}
SECTORS = [('NO', 0), ('NE', 45), ('EA', 90), ('SE', 135), ('SO', 180), ('SW', 225), ('WE', 270), ('NW', 315)]
SECTOR_WORDS = {'NO': 'north', 'NE': 'north east', 'EA': 'east', 'SE': 'south east', 'SO': 'south', 'SW': 'south west', 'WE': 'west', 'NW': 'north west'}
PRON = {}   # fix name -> spoken form (filled per airport)
END_LETTERS = 'ABCDEFGHJKLMNP'


def fmt_lat(lat):
    return f"N{abs(lat):.6f}" if lat >= 0 else f"S{abs(lat):.6f}"


def fmt_lng(lng):
    return f"E{abs(lng):.6f}" if lng >= 0 else f"W{abs(lng):.6f}"


def ll(lat, lng):
    return f"{fmt_lat(lat)}, {fmt_lng(lng)}"


def rid(name):
    return name.lower()


def spell(fix):
    return PRON.get(fix, ' '.join(fix.lower()))


def runway_rows(runways, elev, tower):
    rows = []
    for rw in runways:
        e0, e1 = rw['ends']
        length_ft = round(rw['lengthM'] / FT, 2)
        for e, opp in ((e0, e1), (e1, e0)):
            rows.append(f"\t{rid(e['name'])}, {e['name']}, {ll(e['lat'], e['lng'])}, {e['hdg']:.2f}, {length_ft}, "
                        f"{round(e['displacedM'] / FT, 1)}, {round(opp['displacedM'] / FT, 1)}, {elev}, 3, {e['hdg']:.2f}, 0, 0, 0, 0, 0, {tower}")
    return rows


def sid_routes(rw_end, other_end, fixes, climb_alt, letter, start_no):
    """SIDs from one runway end to every fix. Returns (lines, next_route_no)."""
    lines = []
    n = start_no
    der = (other_end['lng'], other_end['lat'])             # departure end of runway
    hdg = rw_end['hdg']
    ahead = advance(der[0], der[1], hdg, 3 * NM)            # straight ahead 3 NM (noise / initial climb)
    for fix, (flng, flat) in fixes:
        lines.append(f"route{n} =")
        lines.append(f"\t{fix}1{letter}, {spell(fix)} one {PHONETIC[letter]}")
        lines.append(f"\t{ll(der[1], der[0])}, {climb_alt}")
        lines.append(f"\t{ll(ahead[1], ahead[0])}")
        # a fix behind the departure needs an intermediate turn point 8 NM abeam on the fix's side
        brg_fix = bearing(der[0], der[1], flng, flat)
        if ang_diff(brg_fix, hdg) > 100:
            side = 1 if ((brg_fix - hdg + 360) % 360) < 180 else -1
            turn = advance(ahead[0], ahead[1], (hdg + 90 * side) % 360, 8 * NM)
            lines.append(f"\t{ll(turn[1], turn[0])}")
        lines.append(f"\t{ll(flat, flng)}")
        lines.append('')
        n += 1
    return lines, n


def star_routes(rw_end, fixes, letter, start_no):
    """STARs from every fix to a 10 NM final for one landing end. Returns (lines, next_route_no)."""
    lines = []
    n = start_no
    thr = (rw_end['lng'], rw_end['lat'])
    hdg = rw_end['hdg']
    final10 = advance(thr[0], thr[1], (hdg + 180) % 360, 10 * NM)
    final14 = advance(thr[0], thr[1], (hdg + 180) % 360, 14 * NM)
    for fix, (flng, flat) in fixes:
        lines.append(f"route{n} =")
        lines.append(f"\t{fix}2{letter}, {spell(fix)} two {PHONETIC[letter]}")
        lines.append(f"\t{ll(flat, flng)}, 11000")
        brg_from_thr = bearing(thr[0], thr[1], flng, flat)
        approach_dir = (hdg + 180) % 360                    # direction from threshold to the final
        if ang_diff(brg_from_thr, approach_dir) > 70:
            # downwind abeam the airport 7 NM to the fix's side, then base, then the final
            side = 1 if ((brg_from_thr - approach_dir + 360) % 360) < 180 else -1
            abeam = advance(thr[0], thr[1], (approach_dir + 90 * side) % 360, 7 * NM)
            downwind_end = advance(abeam[0], abeam[1], approach_dir, 12 * NM)
            lines.append(f"\t{ll(abeam[1], abeam[0])}, 6000")
            lines.append(f"\t{ll(downwind_end[1], downwind_end[0])}, 4000")
        lines.append(f"\t{ll(final14[1], final14[0])}, 4000")
        lines.append(f"\t{ll(final10[1], final10[0])}, 3000, 180")
        lines.append('')
        n += 1
    return lines, n


PHONETIC = {'A': 'alpha', 'B': 'bravo', 'C': 'charlie', 'D': 'delta', 'E': 'echo', 'F': 'foxtrot', 'G': 'golf', 'H': 'hotel',
            'J': 'juliett', 'K': 'kilo', 'L': 'lima', 'M': 'mike', 'N': 'november', 'P': 'papa'}


def generate(icao, meta):
    runways = [rw for rw in runways_for(icao, meta['magvar']) if rw['lengthM'] / FT >= 3000]
    if not runways:
        print(f'{icao}: no runways found, skipping')
        return
    for rw in runways:
        if rw['ambiguous']:
            print(f'!! {icao} {rw["ref"]}: AMBIGUOUS orientation — check the OSM data')
    lats = [e['lat'] for rw in runways for e in rw['ends']]
    lngs = [e['lng'] for rw in runways for e in rw['ends']]
    clat, clng = sum(lats) / len(lats), sum(lngs) / len(lngs)
    radius = meta['radius']

    fixes = []
    for code, brg in SECTORS:
        p = advance(clng, clat, brg, 18 * NM)
        fixes.append((meta['core'] + code, (p[0], p[1])))
        PRON[meta['core'] + code] = f"{meta['core'].lower()} {SECTOR_WORDS[code]}"

    L = [
        '# AUTO-GENERATED by scripts/gen_airspace.py from public/maps/osm/%s.geojson — do not edit by hand.' % icao,
        '# Runway ends oriented by geometry (same rule as src/lib/osmAirport.ts); fixes, SIDs and STARs are',
        '# synthetic (ICAO core + compass sector) — real procedures can replace them without changing the format.',
        '[airspace]',
        f'elevation = {meta["elev"]}',
        f'radius = {radius}',
        f'center = {ll(clat, clng)}',
        f'magneticvar = {meta["magvar"]}',
        'floor = 1500',
        'descendaltitude = 9000',
        'ceiling = 11000',
        'above = 13000',
        'transitionaltitude = 18000',
        'localizerspeed = 10, 160',
        'separation = 3',
        f'name = {icao} approach, {meta["name"].lower()} approach',
        '',
        'beacons =',
    ]
    for (fix, (flng, flat)), (code, brg) in zip(fixes, SECTORS):
        L.append(f"\t{fix}, {ll(flat, flng)}, {int((brg + 180) % 360)}, {spell(fix)}")
    L += ['', '[airport1]', f'name = {meta["name"]}', f'code = {icao}', 'runways =']
    L += runway_rows(runways, meta['elev'], meta['tower'])
    L += ['', 'entrypoints =']
    for (fix, _), (code, brg) in zip(fixes, SECTORS):
        L.append(f"\t{int((brg + 180) % 360):03d}, {fix}, 9000")
    L += ['', f'climbaltitude = {meta["climb"]}', '']

    ends = [(rw, e) for rw in runways for e in rw['ends']]
    dep_sec = 1
    route_no = 1
    for i, (rw, e) in enumerate(ends):
        other = rw['ends'][1] if e is rw['ends'][0] else rw['ends'][0]
        letter = END_LETTERS[i]
        L += [f'[departure{dep_sec}]', f'runway = {rid(e["name"])}']
        lines, route_no = sid_routes(e, other, fixes, meta['climb'], letter, route_no)
        L += lines
        dep_sec += 1
    app_sec = 1
    for i, (rw, e) in enumerate(ends):
        letter = END_LETTERS[i]
        L += [f'[approach{app_sec}]', f'runway = {rid(e["name"])}']
        lines, route_no = star_routes(e, fixes, letter, route_no)
        L += lines
        app_sec += 1

    out_path = os.path.join(OUT_DIR, f'{icao}.txt')
    with open(out_path, 'w') as f:
        f.write('\n'.join(L).rstrip('\n') + '\n')
    print(f'{icao}: wrote {out_path} ({len(ends)} runway ends, {len(fixes)} fixes, {len(ends) * len(fixes)} SIDs, {len(ends) * len(fixes)} STARs)')


# ── EGLL: validate the authored file and append the easterly block ─────────────
EGLL_MARK_BEGIN = '# ---- BEGIN generated by scripts/gen_airspace.py (easterly runways, STARs) ----'
EGLL_MARK_END = '# ---- END generated by scripts/gen_airspace.py ----'


def parse_authored_runways(text):
    """Return {name: {lat, lng, hdg, lengthFt, dispThis, dispOpp, elev, gs, loc, tower}} from the FIRST [airport1] section."""
    out = {}
    sec = None
    in_rows = False
    for raw in text.split('\n'):
        line = raw.rstrip()
        m = re.match(r'^\[([^\]]+)\]$', line.strip())
        if m:
            sec = m.group(1).lower(); in_rows = False; continue
        if sec != 'airport1':
            continue
        if re.match(r'^runways\s*=\s*$', line):
            in_rows = True; continue
        if in_rows:
            if not line.startswith(('\t', ' ')):
                in_rows = False; continue
            cols = [c.strip() for c in line.strip().split(',')]
            if len(cols) < 11:
                continue

            def deg(tok):
                t = tok.strip()
                sign = -1 if t[0] in 'SW' else 1
                return sign * float(t[1:])

            out[cols[1]] = {'id': cols[0], 'lat': deg(cols[2]), 'lng': deg(cols[3]), 'hdg': float(cols[4]), 'lengthFt': float(cols[5]),
                            'dispThis': float(cols[6]), 'dispOpp': float(cols[7]), 'elev': float(cols[8]), 'gs': float(cols[9]),
                            'loc': float(cols[10]), 'tower': cols[-1]}
    return out


def parse_beacons(text):
    out = {}
    in_b = False
    for raw in text.split('\n'):
        line = raw.rstrip()
        if re.match(r'^beacons\s*=\s*$', line):
            in_b = True; continue
        if in_b:
            if not line.startswith(('\t', ' ')):
                if line.strip() == '':
                    in_b = False
                continue
            cols = [c.strip() for c in line.strip().split(',')]
            if len(cols) >= 3:
                def deg(tok):
                    sign = -1 if tok[0] in 'SW' else 1
                    return sign * float(tok[1:])
                out[cols[0]] = (deg(cols[2]), deg(cols[1]))   # (lng, lat)
    return out


def parse_departure_routes(text):
    """[departureN] sections of the authored file → {runwayId: [(name, pron, [(lat, lng, alt?), ...]), ...]}"""
    out = {}
    sec = None; rw = None; cur = None
    for raw in text.split('\n'):
        line = raw.rstrip()
        m = re.match(r'^\[([^\]]+)\]$', line.strip())
        if m:
            sec = m.group(1).lower(); rw = None; cur = None; continue
        if not sec or not sec.startswith('departure'):
            continue
        mr = re.match(r'^runway\s*=\s*(.+)$', line)
        if mr:
            rw = mr.group(1).split(',')[0].strip(); continue
        if re.match(r'^route\d+\s*=\s*$', line):
            cur = None; continue
        if line.startswith(('\t', ' ')) and rw:
            cols = [c.strip() for c in line.strip().split(',')]
            if cur is None:
                cur = (cols[0], cols[1] if len(cols) > 1 else '', [])
                out.setdefault(rw, []).append(cur)
            else:
                def deg(tok):
                    sign = -1 if tok[0] in 'SW' else 1
                    return sign * float(tok[1:])
                cur[2].append((deg(cols[0]), deg(cols[1]), cols[2] if len(cols) > 2 else None))
    return out


def egll_block(text, osm_runways):
    authored = parse_authored_runways(text)
    beacons = parse_beacons(text)
    deps = parse_departure_routes(text)
    # validate the authored 27L/27R rows against OSM (name at the right end, position, heading)
    ok = True
    for name, row in authored.items():
        found = None
        for rw in osm_runways:
            for e in rw['ends']:
                if e['name'] == name:
                    found = (rw, e)
        if not found:
            print(f'!! EGLL: authored runway {name} not in OSM data'); ok = False; continue
        rw, e = found
        d = dist_m(row['lng'], row['lat'], e['lng'], e['lat'])
        dh = ang_diff(row['hdg'], e['hdg'])
        status = 'OK' if d <= 60 and dh <= 2 else 'MISMATCH'
        if status != 'OK':
            ok = False
        print(f'   EGLL {name}: authored thr {d:.0f} m from OSM end, heading diff {dh:.2f} deg -> {status}')
    if not ok:
        print('!! EGLL: authored file disagrees with OSM geometry; the generated block still uses the OSM ends')

    # easterly ends from OSM geometry
    lines = [EGLL_MARK_BEGIN,
             '# 09L/09R (easterly operations) derived from OSM geometry: ILS localizer = runway true heading, GS 3 deg.',
             '# Displaced thresholds copied from the authored 27L/27R rows (column 8 = opposite end).',
             '[airport3]', 'name = Heathrow', 'code = EGLW', 'runways =']
    east_ids = {}
    for rw in osm_runways:
        for e in rw['ends']:
            if not e['name'].startswith('09'):
                continue
            opp = rw['ends'][1] if e is rw['ends'][0] else rw['ends'][0]
            arow = authored.get(opp['name'])
            # displaced threshold of this (easterly) end: authored column 8 of the 27 row when given, else OSM
            disp_this = arow['dispOpp'] if arow and arow['dispOpp'] > 0 else round(e['displacedM'] / FT, 1)
            disp_opp = arow['dispThis'] if arow else round(opp['displacedM'] / FT, 1)
            elev = int(arow['elev']) if arow else 80
            tower = arow['tower'] if arow else '118.505'
            length_ft = round(arow['lengthFt'], 2) if arow else round(rw['lengthM'] / FT, 2)
            rwid = 'lle' if e['name'] == '09L' else 'llw'
            east_ids[e['name']] = rwid
            lines.append(f"\t{rwid}, {e['name']}, {ll(e['lat'], e['lng'])}, {e['hdg']:.2f}, {length_ft}, {disp_this}, {disp_opp}, {elev}, 3, {e['hdg']:.2f}, 0, 0, 0, 0, 0, {tower}")
    lines.append('')

    # mirrored easterly SIDs: 09R <- lls (27L) routes with letter J, 09L <- lln (27R) routes with letter K
    mirror = {'09R': ('lls', 'J', 'juliett'), '09L': ('lln', 'K', 'kilo')}
    ends = {e['name']: (rw, e) for rw in osm_runways for e in rw['ends']}
    sec = 4
    route_no = 100
    for east, (west_id, letter, pron_letter) in mirror.items():
        rw, e = ends[east]
        other = rw['ends'][1] if e is rw['ends'][0] else rw['ends'][0]
        der = (other['lng'], other['lat'])
        ahead = advance(der[0], der[1], e['hdg'], 2.5 * NM)
        seen = set()
        lines += [f'[departure{sec}]', f'runway = {east_ids[east]}']
        for name, pron, wps in deps.get(west_id, []):
            base = re.sub(r'\d[A-Z]$', '', name)          # BPK7G -> BPK
            if base in seen:
                continue
            seen.add(base)
            new_name = f'{base}1{letter}'
            new_pron = re.sub(r'\s+\S+\s+\S+$', f' one {pron_letter}', pron) if pron else ''
            fix = wps[-1]                                  # the SID's terminal fix (lat, lng)
            lines.append(f'route{route_no} =')
            lines.append(f'\t{new_name}, {new_pron}')
            lines.append(f'\t{ll(der[1], der[0])}, 6000')
            lines.append(f'\t{ll(ahead[1], ahead[0])}')
            brg_fix = bearing(der[0], der[1], fix[1], fix[0])
            if ang_diff(brg_fix, e['hdg']) > 100:
                # fix behind the departure: turn toward its side (south for CPT/GOGSI, north for UMLAT) and
                # join the westerly route's outer legs (those more than 9 NM from the airport)
                side = 1 if ((brg_fix - e['hdg'] + 360) % 360) < 180 else -1
                turn = advance(ahead[0], ahead[1], (e['hdg'] + 90 * side) % 360, 6 * NM)
                lines.append(f'\t{ll(turn[1], turn[0])}')
                outer = [w for w in wps[1:] if dist_m(w[1], w[0], der[0], der[1]) > 9 * NM]
                for w in outer:
                    lines.append(f'\t{ll(w[0], w[1])}')
            else:
                lines.append(f'\t{ll(fix[0], fix[1])}')
            lines.append('')
            route_no += 1
        sec += 1

    # STARs from the four entry beacons to every end
    entry = [b for b in ('BIG', 'OCK', 'LAM', 'BNN') if b in beacons]
    fixes = [(b, beacons[b]) for b in entry]
    letters = {'27L': 'A', '27R': 'B', '09L': 'C', '09R': 'D'}
    ids = {'27L': 'lls', '27R': 'lln', '09L': 'lle', '09R': 'llw'}
    app = 1
    for name in ('27L', '27R', '09L', '09R'):
        if name not in ends:
            continue
        rw, e = ends[name]
        lines += [f'[approach{app}]', f'runway = {ids[name]}']
        block, route_no = star_routes(e, fixes, letters[name], route_no)
        lines += block
        app += 1
    lines.append(EGLL_MARK_END)
    return '\n'.join(lines)


def update_egll():
    path = os.path.join(OUT_DIR, 'EGLL.txt')
    if not os.path.exists(path):
        print('EGLL: no authored file, skipping')
        return
    with open(path) as f:
        text = f.read()
    # authored magnetic variation (east positive) for the orientation rule
    m = re.search(r'^magneticvar\s*=\s*([-\d.]+)', text, re.M)
    magvar = float(m.group(1)) if m else 0.0
    osm = runways_for('EGLL', magvar)
    block = egll_block(text, osm)
    if EGLL_MARK_BEGIN in text and EGLL_MARK_END in text:
        pre = text[:text.index(EGLL_MARK_BEGIN)]
        post = text[text.index(EGLL_MARK_END) + len(EGLL_MARK_END):]
        text = pre + block + post
    else:
        text = text.rstrip('\n') + '\n\n' + block + '\n'
    with open(path, 'w') as f:
        f.write(text)
    print(f'EGLL: validated and updated generated block in {path}')


if __name__ == '__main__':
    targets = sys.argv[1:] or (list(AIRPORTS) + ['EGLL'])
    for icao in targets:
        if icao == 'EGLL':
            update_egll()
        elif icao in AIRPORTS:
            generate(icao, AIRPORTS[icao])
        else:
            print(f'!! {icao}: unknown airport')
    print('Done.')
