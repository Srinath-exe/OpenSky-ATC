'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildTaxiGraph, loadAirportBundle, planRoute, TaxiGraph, TaxiNode } from '@/lib/airportData';
import { GeoPosition } from '@/lib/geoUtils';

// ─── Airport configs ──────────────────────────────────────────────────────────
const AIRPORTS: Record<string, { center: [number, number]; zoom: number; pos: GeoPosition }> = {
  KLAX: { center: [-118.4081, 33.9416],   zoom: 13.5, pos: { lat: 33.9416,  lng: -118.4081 } },
  KSFO: { center: [-122.37896, 37.62175], zoom: 13.5, pos: { lat: 37.62175, lng: -122.37896 } },
  KJFK: { center: [-73.7781, 40.6413],    zoom: 13.2, pos: { lat: 40.6413,  lng: -73.7781 } },
  KBOS: { center: [-71.0052, 42.3656],    zoom: 13.5, pos: { lat: 42.3656,  lng: -71.0052 } },
  VIDP: { center: [77.1006, 28.5562],     zoom: 13.2, pos: { lat: 28.5562,  lng: 77.1006 } },
};

// ─── Map style: AirNav Radar aesthetic ───────────────────────────────────────
//  Layer order:
//   1. Dark navy #07101f background
//   2. ESRI satellite tiles — desaturated, darkened, hue-shifted to navy blue
//      (this creates the "dark satellite" look visible in AirNav Radar)
//   3. X-Plane pavement polygons on top:
//      - aprons/taxiways: dark charcoal (#131d2d)
//      - runways:         near-black (#080a12)  ← the signature AirNav look
//      - terminals:       dark navy blue
//   4. Gate labels, centerline guides
function buildStyle(icao: string) {
  const base = `/maps/xplane/${icao}/combined`;

  return {
    version: 8 as const,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster' as const,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri',
      },
      aprons:      { type: 'geojson' as const, data: `${base}/pavement_aprons.geojson` },
      taxiways:    { type: 'geojson' as const, data: `${base}/pavement_taxiways.geojson` },
      runways:     { type: 'geojson' as const, data: `${base}/pavement_runways.geojson` },
      terminals:   { type: 'geojson' as const, data: `${base}/terminals.geojson` },
      centerlines: { type: 'geojson' as const, data: `${base}/lines_centerlines.geojson` },
      gates:       { type: 'geojson' as const, data: `${base}/startup_locations.geojson` },
    },
    layers: [
      // 1. Very dark navy background (visible at the edges of the airport)
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#07101f' } },

      // 2. Satellite — heavy desaturation + darkening + blue hue shift
      //    Result: dark navy with faint terrain detail (buildings, roads barely visible)
      {
        id: 'satellite',
        type: 'raster' as const,
        source: 'satellite',
        paint: {
          'raster-opacity':         0.52,
          'raster-saturation':     -0.78,
          'raster-brightness-max':  0.44,
          'raster-brightness-min':  0.02,
          'raster-hue-rotate':      195,
          'raster-contrast':        0.06,
        },
      },

      // 3. Apron pavement (dark charcoal)
      {
        id: 'apron-fill', type: 'fill' as const, source: 'aprons',
        paint: { 'fill-color': '#121c2c', 'fill-opacity': 0.88 },
      },

      // 4. Taxiway pavement
      {
        id: 'taxiway-fill', type: 'fill' as const, source: 'taxiways',
        paint: { 'fill-color': '#131d2d', 'fill-opacity': 0.88 },
      },
      {
        id: 'taxiway-line', type: 'line' as const, source: 'taxiways',
        paint: { 'line-color': 'rgba(28,52,88,0.45)', 'line-width': 0.5 },
      },

      // 5. Runways — near-BLACK (signature AirNav look)
      {
        id: 'runway-fill', type: 'fill' as const, source: 'runways',
        paint: { 'fill-color': '#07090f', 'fill-opacity': 0.97 },
      },
      {
        id: 'runway-line', type: 'line' as const, source: 'runways',
        paint: { 'line-color': 'rgba(120,155,200,0.2)', 'line-width': 0.6 },
      },

      // 6. Terminal buildings
      {
        id: 'terminal-fill', type: 'fill' as const, source: 'terminals',
        paint: { 'fill-color': '#192b44', 'fill-opacity': 0.93 },
      },
      {
        id: 'terminal-line', type: 'line' as const, source: 'terminals',
        paint: { 'line-color': '#243e62', 'line-width': 0.9 },
      },

      // 7. Taxiway centerlines — barely-visible faint yellow
      {
        id: 'cl-yellow', type: 'line' as const, source: 'centerlines',
        minzoom: 13,
        filter: ['!', ['in', 'ILS', ['get', 'painted_line_type']]] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: {
          'line-color': 'rgba(255,195,30,0.13)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 15, 1, 17, 2] as any,
        },
      },

      // 8. Gate stand dots
      {
        id: 'gate-dots', type: 'circle' as const, source: 'gates',
        minzoom: 13,
        paint: {
          'circle-radius':       ['interpolate', ['linear'], ['zoom'], 13, 1.5, 15, 2.5, 17, 4] as any,
          'circle-color':        'rgba(100,158,235,0.72)',
          'circle-stroke-color': 'rgba(130,185,255,0.9)',
          'circle-stroke-width': 0.7,
        },
      },

      // 9. Gate number labels (zoom 15+)
      {
        id: 'gate-labels', type: 'symbol' as const, source: 'gates',
        minzoom: 15,
        filter: ['==', ['get', 'location_type'], 'gate'] as any,
        layout: {
          'text-field':         ['get', 'name'] as any,
          'text-size':          ['interpolate', ['linear'], ['zoom'], 15, 8, 17, 11, 19, 14] as any,
          'text-font':          ['Open Sans Bold', 'Open Sans Regular'],
          'text-offset':        [0, 1.1] as any,
          'text-anchor':        'top' as const,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color':      'rgba(162,198,242,0.88)',
          'text-halo-color': 'rgba(0,4,14,0.9)',
          'text-halo-width': 1.5,
        },
      },
    ],
  };
}

// ─── Simulation types ─────────────────────────────────────────────────────────
interface SimAc {
  id: number;
  callsign: string;
  color: string;
  pathNodes: TaxiNode[];
  seg: number;
  t: number;
  speedMps: number;
  pos: GeoPosition;
  heading: number;     // compass degrees: 0=N 90=E 180=S 270=W
  trail: GeoPosition[];
  done: boolean;
}

const CALLSIGNS = ['AAL123','UAL456','DAL789','SWA654','JBU987','BAW321','QTR111','UAE555','DLH222','JAI777','SIA888','QFA031'];
const COLORS    = ['#facc15','#fb923c','#a78bfa','#34d399','#60a5fa','#f472b6','#fde68a','#86efac','#fca5a5','#c4b5fd','#fdba74','#6ee7b7'];
function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Geo helpers ──────────────────────────────────────────────────────────────
function geoDist(a: GeoPosition, b: GeoPosition): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const mid  = (a.lat + b.lat) / 2 * Math.PI / 180;
  return Math.hypot(dLat * R, dLng * R * Math.cos(mid));
}

function compassBearing(from: GeoPosition, to: GeoPosition): number {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat  * Math.PI / 180;
  const y    = Math.sin(dLng) * Math.cos(lat2);
  const x    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function project(map: maplibregl.Map, pos: GeoPosition) {
  const pt    = map.project([pos.lng, pos.lat]);
  const scale = map.getCanvas().width / map.getContainer().clientWidth;
  return { x: pt.x * scale, y: pt.y * scale };
}

function drawTrail(ctx: CanvasRenderingContext2D, map: maplibregl.Map, ac: SimAc) {
  if (ac.trail.length < 2) return;
  for (let i = 1; i < ac.trail.length; i++) {
    const a = project(map, ac.trail[i - 1]);
    const b = project(map, ac.trail[i]);
    const alpha = 0.06 + (i / ac.trail.length) * 0.94;
    ctx.strokeStyle = `rgba(239,68,68,${alpha.toFixed(2)})`;
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawPathAhead(ctx: CanvasRenderingContext2D, map: maplibregl.Map, ac: SimAc) {
  if (ac.seg >= ac.pathNodes.length - 1) return;
  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  const cur = project(map, ac.pos);
  ctx.moveTo(cur.x, cur.y);
  for (let i = ac.seg + 1; i < ac.pathNodes.length; i++) {
    const p = project(map, ac.pathNodes[i].position);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

// Aircraft icon drawn with nose pointing UP (north) at angle=0.
// canvas.rotate(heading * π/180) then points the nose in the compass direction.
function drawPlane(ctx: CanvasRenderingContext2D, map: maplibregl.Map, ac: SimAc) {
  const { x, y } = project(map, ac.pos);
  const angle = ac.heading * Math.PI / 180;
  const s     = 15;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  ctx.fillStyle   = ac.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth   = 1.5;

  // Fuselage (nose at y = -s*1.55, pointing up)
  ctx.beginPath();
  ctx.moveTo(0,          -s * 1.55);
  ctx.bezierCurveTo( s * 0.28, -s * 0.95,  s * 0.22,  s * 0.55,  s * 0.20,  s * 1.05);
  ctx.lineTo(-s * 0.20,  s * 1.05);
  ctx.bezierCurveTo(-s * 0.22,  s * 0.55, -s * 0.28, -s * 0.95, 0, -s * 1.55);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Main wings
  ctx.beginPath();
  ctx.moveTo( s * 0.08, -s * 0.15);
  ctx.lineTo( s * 1.55,  s * 0.58);
  ctx.lineTo( s * 1.25,  s * 0.85);
  ctx.lineTo( s * 0.18,  s * 0.38);
  ctx.lineTo(-s * 0.18,  s * 0.38);
  ctx.lineTo(-s * 1.25,  s * 0.85);
  ctx.lineTo(-s * 1.55,  s * 0.58);
  ctx.lineTo(-s * 0.08, -s * 0.15);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Horizontal stabiliser
  ctx.beginPath();
  ctx.moveTo( s * 0.06,  s * 0.72);
  ctx.lineTo( s * 0.62,  s * 1.32);
  ctx.lineTo(-s * 0.62,  s * 1.32);
  ctx.lineTo(-s * 0.06,  s * 0.72);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.restore();

  // Label
  const kts = Math.round(ac.speedMps * 1.944);
  const hdg = Math.round(ac.heading);
  const lx  = x + 20, ly = y - 6;

  ctx.font      = 'bold 10px "Courier New",monospace';
  ctx.textAlign = 'left';

  // Shadow stroke behind text
  ctx.strokeStyle = 'rgba(0,0,0,0.95)';
  ctx.lineWidth   = 3.5;
  ctx.strokeText(ac.callsign,        lx, ly);
  ctx.strokeText(`${kts}kt ${hdg}°`, lx, ly + 13);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(ac.callsign, lx, ly);
  ctx.fillStyle = '#facc15';
  ctx.fillText(`${kts}kt ${hdg}°`, lx, ly + 13);

  // Centre dot
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle   = ac.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth   = 1;
  ctx.stroke();
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function GroundRadar() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const mapRef          = useRef<maplibregl.Map | null>(null);
  const graphRef        = useRef<TaxiGraph | null>(null);
  const aircraftsRef    = useRef<SimAc[]>([]);
  const lastTimeRef     = useRef(performance.now());
  const idRef           = useRef(0);
  const rafRef          = useRef(0);

  const [icao,      setIcao]      = useState('KLAX');
  const [acCount,   setAcCount]   = useState(0);
  const [nodeCount, setNodeCount] = useState(0);
  const [status,    setStatus]    = useState('Loading…');

  // ── spawn one aircraft ──────────────────────────────────────────────────────
  const spawnRandom = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || aircraftsRef.current.length >= 14) return;

    const gates = Array.from(graph.gates.values()).filter(g => g.type === 'gate');
    const rwIds = Array.from(new Set(
      Array.from(graph.runways.values()).flatMap(r => [r.name1, r.name2])
    ));
    if (!gates.length || !rwIds.length) return;

    const gate  = pickRandom(gates);
    const rwId  = pickRandom(rwIds);
    const route = planRoute(
      graph,
      { type: 'gate',   id: gate.name },
      { type: 'runway', id: rwId, operation: 'departure' },
    );
    if (!route || route.path.length < 2) return;

    const nodes = [route.path[0].fromNode, ...route.path.map(s => s.toNode)];
    const id    = ++idRef.current;

    aircraftsRef.current.push({
      id,
      callsign:  CALLSIGNS[id % CALLSIGNS.length],
      color:     COLORS[id % COLORS.length],
      pathNodes: nodes,
      seg:       0,
      t:         0,
      speedMps:  4 + Math.random() * 5,
      pos:       { ...nodes[0].position },
      heading:   ((gate.heading % 360) + 360) % 360,
      trail:     [{ ...nodes[0].position }],
      done:      false,
    });
    setAcCount(aircraftsRef.current.length);
  }, []);

  const clearAll = useCallback(() => {
    aircraftsRef.current = [];
    setAcCount(0);
  }, []);

  // ── load airport ────────────────────────────────────────────────────────────
  const loadAirport = useCallback(async (newIcao: string) => {
    setIcao(newIcao);
    setStatus(`Building graph for ${newIcao}…`);
    setNodeCount(0);
    clearAll();
    graphRef.current = null;

    const m = mapRef.current;
    if (m) {
      const cfg = AIRPORTS[newIcao];
      m.flyTo({ center: cfg.center, zoom: cfg.zoom, speed: 1.5 });

      const base    = `/maps/xplane/${newIcao}/combined`;
      const srcMap: Record<string, string> = {
        aprons:      'pavement_aprons.geojson',
        taxiways:    'pavement_taxiways.geojson',
        runways:     'pavement_runways.geojson',
        terminals:   'terminals.geojson',
        centerlines: 'lines_centerlines.geojson',
        gates:       'startup_locations.geojson',
      };
      for (const [key, file] of Object.entries(srcMap)) {
        const src = m.getSource(key) as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(`${base}/${file}`);
      }
    }

    try {
      const bundle = await loadAirportBundle(newIcao);
      const cfg    = AIRPORTS[newIcao];
      const graph  = buildTaxiGraph(bundle, cfg.pos, newIcao);
      graphRef.current = graph;
      setNodeCount(graph.nodes.size);
      setStatus(`${newIcao} · ${graph.nodes.size} nodes · ${graph.gates.size} gates`);
      setTimeout(() => { for (let i = 0; i < 4; i++) spawnRandom(); }, 500);
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  }, [clearAll, spawnRandom]);

  // ── init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const m = new maplibregl.Map({
      container:          mapContainerRef.current,
      style:              buildStyle('KLAX') as any,
      center:             AIRPORTS.KLAX.center,
      zoom:               AIRPORTS.KLAX.zoom,
      minZoom:            11,
      maxZoom:            19,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    m.on('load', () => loadAirport('KLAX'));
    mapRef.current = m;
    return () => { cancelAnimationFrame(rafRef.current); m.remove(); mapRef.current = null; };
  }, [loadAirport]);

  // ── RAF animation loop ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function resize() {
      const m = mapRef.current;
      if (!m || !canvas) return;
      const mc            = m.getCanvas();
      canvas.width        = mc.width;
      canvas.height       = mc.height;
      canvas.style.width  = `${m.getContainer().clientWidth}px`;
      canvas.style.height = `${m.getContainer().clientHeight}px`;
    }

    function tick(now: number) {
      rafRef.current = requestAnimationFrame(tick);
      const map = mapRef.current;
      if (!map || !canvas) return;

      resize();
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1);
      lastTimeRef.current = now;

      // Physics
      let changed = false;
      for (const ac of aircraftsRef.current) {
        if (ac.done) continue;
        if (ac.seg >= ac.pathNodes.length - 1) { ac.done = true; changed = true; continue; }

        const from   = ac.pathNodes[ac.seg].position;
        const to     = ac.pathNodes[ac.seg + 1].position;
        const segLen = geoDist(from, to);

        if (segLen < 0.5) { ac.seg++; ac.t = 0; continue; }

        ac.t += (ac.speedMps * dt) / segLen;

        if (ac.t >= 1) {
          ac.t = 0;
          ac.seg++;
          if (ac.seg >= ac.pathNodes.length - 1) { ac.done = true; changed = true; continue; }
        }

        const f  = ac.pathNodes[ac.seg].position;
        const t2 = ac.pathNodes[ac.seg + 1].position;
        ac.pos = {
          lat: f.lat + (t2.lat - f.lat) * ac.t,
          lng: f.lng + (t2.lng - f.lng) * ac.t,
        };
        ac.heading = compassBearing(f, t2);

        const last = ac.trail[ac.trail.length - 1];
        if (geoDist(last, ac.pos) > 5) {
          ac.trail.push({ ...ac.pos });
          if (ac.trail.length > 150) ac.trail.shift();
        }
      }

      if (changed) {
        aircraftsRef.current = aircraftsRef.current.filter(a => !a.done);
        setAcCount(aircraftsRef.current.length);
      }

      // Draw
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const ac of aircraftsRef.current) drawPathAhead(ctx, map, ac);
      for (const ac of aircraftsRef.current) drawTrail(ctx, map, ac);
      for (const ac of aircraftsRef.current) drawPlane(ctx, map, ac);
    }

    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── UI ────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#07101f',
      position: 'relative', overflow: 'hidden',
      fontFamily: "'Courier New', monospace",
    }}>
      <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }} />

      {/* HUD */}
      <div style={{
        position: 'absolute', top: 14, left: 14, zIndex: 20,
        background: 'rgba(3,8,20,0.88)',
        border: '1px solid rgba(30,60,100,0.7)',
        borderRadius: 10, padding: '12px 16px', minWidth: 220,
        backdropFilter: 'blur(12px)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', letterSpacing: 3, color: '#facc15', marginBottom: 1 }}>SKYCONTROL</div>
        <div style={{ fontSize: 8, color: '#1e3a5e', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10 }}>Ground Radar System</div>
        <HudRow label="Airport"  value={icao} />
        <HudRow label="Aircraft" value={String(acCount)} />
        <HudRow label="Nodes"    value={String(nodeCount)} />
        <div style={{ fontSize: 8.5, color: '#1e3a5e', marginTop: 3, marginBottom: 10, lineHeight: 1.5 }}>{status}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <PanelBtn label="+ Spawn" onClick={spawnRandom} accent />
          <PanelBtn label="Clear"   onClick={clearAll} />
        </div>
      </div>

      {/* Airport switcher */}
      <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {Object.keys(AIRPORTS).map(a => (
          <button key={a} onClick={() => loadAirport(a)} style={{
            padding: '6px 16px', fontSize: 10, fontFamily: 'inherit',
            letterSpacing: 2, textTransform: 'uppercase', borderRadius: 6,
            cursor: 'pointer', fontWeight: 'bold',
            background: a === icao ? 'rgba(22,50,100,0.95)' : 'rgba(3,8,20,0.85)',
            color:      a === icao ? '#facc15' : '#1e3a5e',
            border:     `1px solid ${a === icao ? 'rgba(40,80,140,0.8)' : 'rgba(20,40,70,0.6)'}`,
            transition: 'all 0.15s',
          }}>{a}</button>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 32, left: 14, zIndex: 20,
        background: 'rgba(3,8,20,0.85)',
        border: '1px solid rgba(20,45,80,0.6)',
        borderRadius: 8, padding: '8px 12px',
      }}>
        {[
          { color: '#ef4444', label: 'Trail (past path)', thick: true },
          { color: '#22c55e', label: 'Route ahead',       thick: true },
          { color: '#facc15', label: 'Aircraft',          dot: true },
          { color: 'rgba(100,158,235,0.72)', label: 'Gate stand', dot: true },
        ].map(({ color, label, thick, dot }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {dot   && <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />}
            {thick && <div style={{ width: 22, height: 3, background: color, borderRadius: 2, flexShrink: 0 }} />}
            <span style={{ fontSize: 9, color: '#1e3a5e' }}>{label}</span>
          </div>
        ))}
      </div>

      <style>{`
        .maplibregl-ctrl-attrib { display: none !important; }
        .maplibregl-ctrl-group {
          background: rgba(3,8,20,0.88) !important;
          border: 1px solid rgba(25,55,95,0.7) !important;
          border-radius: 8px !important;
          box-shadow: 0 2px 10px rgba(0,0,0,0.4) !important;
        }
        .maplibregl-ctrl-group button { background: transparent !important; border-color: rgba(25,55,95,0.5) !important; }
        .maplibregl-ctrl-group button span { filter: invert(0.35) sepia(1) saturate(0.5) hue-rotate(190deg); }
        .maplibregl-ctrl-scale {
          background: rgba(3,8,20,0.85) !important;
          border-color: rgba(25,55,95,0.7) !important;
          color: #1e3a5e !important;
          font-size: 9px !important;
          padding: 2px 6px !important;
          border-radius: 4px !important;
        }
      `}</style>
    </div>
  );
}

function HudRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 9.5, color: '#1e3a5e', marginBottom: 3 }}>
      {label}:&nbsp;<b style={{ color: '#2d5a9e' }}>{value}</b>
    </div>
  );
}

function PanelBtn({ label, onClick, accent }: { label: string; onClick: () => void; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '6px 0', fontSize: 9,
      fontFamily: 'inherit', letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 'bold',
      background: accent ? 'rgba(22,50,100,0.9)' : 'rgba(3,8,20,0.8)',
      color:      accent ? '#facc15' : '#1e3a5e',
      border:     `1px solid ${accent ? 'rgba(40,80,140,0.8)' : 'rgba(20,40,70,0.6)'}`,
      borderRadius: 5, cursor: 'pointer',
    }}>{label}</button>
  );
}
