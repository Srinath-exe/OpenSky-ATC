'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  loadOsmAirport, findPath, meters, bearingDeg,
  OsmAirport, OsmNode,
} from '@/lib/osmAirport';

// ─── Silence benign tile-abort rejections ────────────────────────────────────
//  MapLibre aborts in-flight tile fetches on every viewport change (zoom/pan).
//  Those surface as "AbortError: signal is aborted without reason". Next's dev
//  overlay registers its unhandledrejection handler at boot (before ours, at the
//  same target) so we can't out-order it. Instead we stop the abort from ever
//  becoming an *unhandled* rejection: wrap fetch so an aborted request resolves
//  to a never-settling promise. Real errors are re-thrown. Installed once.
if (typeof window !== 'undefined' && !(window as any).__abortFetchPatched) {
  (window as any).__abortFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    orig(input, init).catch((err: any) => {
      if (err?.name === 'AbortError') return new Promise<Response>(() => {});
      throw err;
    });
}

// ─── Airports ─────────────────────────────────────────────────────────────────
const AIRPORTS: Record<string, { center: [number, number]; zoom: number; name: string; city: string }> = {
  EGLL: { center: [-0.4543,   51.4700], zoom: 13.3, name: 'Heathrow',      city: 'London' },
  KLAX: { center: [-118.4081, 33.9416], zoom: 13.4, name: 'Los Angeles Intl', city: 'Los Angeles' },
  KSFO: { center: [-122.3790, 37.6213], zoom: 13.4, name: 'San Francisco Intl', city: 'San Francisco' },
  KJFK: { center: [-73.7781,  40.6413], zoom: 13.2, name: 'John F. Kennedy', city: 'New York' },
  KBOS: { center: [-71.0096,  42.3656], zoom: 13.4, name: 'Logan Intl',     city: 'Boston' },
  VIDP: { center: [77.1000,   28.5562], zoom: 13.0, name: 'Indira Gandhi',  city: 'Delhi' },
};

// ─── Flight identity pools ────────────────────────────────────────────────────
const AIRLINES = [
  { icao: 'BAW', iata: 'BA', name: 'British Airways' },
  { icao: 'UAL', iata: 'UA', name: 'United' },
  { icao: 'AAL', iata: 'AA', name: 'American' },
  { icao: 'DAL', iata: 'DL', name: 'Delta' },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa' },
  { icao: 'AFR', iata: 'AF', name: 'Air France' },
  { icao: 'KLM', iata: 'KL', name: 'KLM' },
  { icao: 'UAE', iata: 'EK', name: 'Emirates' },
  { icao: 'QTR', iata: 'QR', name: 'Qatar Airways' },
  { icao: 'SIA', iata: 'SQ', name: 'Singapore' },
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific' },
  { icao: 'QFA', iata: 'QF', name: 'Qantas' },
  { icao: 'SWR', iata: 'LX', name: 'Swiss' },
  { icao: 'EIN', iata: 'EI', name: 'Aer Lingus' },
  { icao: 'VIR', iata: 'VS', name: 'Virgin Atlantic' },
  { icao: 'AIC', iata: 'AI', name: 'Air India' },
];
const TYPES  = ['A320', 'A321', 'A319', 'A20N', 'B738', 'B739', 'B38M', 'A333', 'A359', 'B77W', 'B789', 'B788', 'E190'];
const CITIES = ['MUC', 'FRA', 'CDG', 'AMS', 'MAD', 'DXB', 'SIN', 'HKG', 'JFK', 'LAX', 'ORD', 'DEL', 'BOM', 'SYD', 'NRT', 'ICN', 'GVA', 'VIE', 'LIS', 'DUB', 'ZRH', 'IST', 'BOS', 'ATL'];
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const ri  = (n: number) => Math.floor(Math.random() * n);

const AMBER = '#fbbf24';

// ─── Map style — AirNav Radar look from OSM aeroway data ─────────────────────
function buildStyle(icao: string) {
  const src = `/maps/osm/${icao}.geojson`;
  const taxiW      = ['interpolate', ['linear'], ['zoom'], 11, 1.5, 13, 4,   14, 7,    15, 11,   16, 17,   17, 26,   18, 40] as any;
  const taxiCasing = ['interpolate', ['linear'], ['zoom'], 11, 4,   13, 6.5, 14, 9.5,  15, 13.5, 16, 19.5, 17, 28.5, 18, 42.5] as any;
  const rwyW       = ['interpolate', ['linear'], ['zoom'], 11, 4,   13, 11,  14, 19,   15, 32,   16, 52,   17, 80,   18, 124] as any;
  const rwyCasing  = ['interpolate', ['linear'], ['zoom'], 11, 6,   13, 13,  14, 21,   15, 34,   16, 54,   17, 82,   18, 126] as any;

  return {
    version: 8 as const,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      sat: {
        type: 'raster' as const,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256, maxzoom: 19, attribution: '© Esri',
      },
      osm: { type: 'geojson' as const, data: src },
    },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#070d18' } },
      {
        id: 'sat', type: 'raster' as const, source: 'sat',
        paint: {
          'raster-opacity': 0.46, 'raster-saturation': -0.82,
          'raster-brightness-max': 0.4, 'raster-brightness-min': 0.015,
          'raster-hue-rotate': 198, 'raster-contrast': 0.06,
        },
      },
      { id: 'apron', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'apron'] as any, paint: { 'fill-color': '#0d1726', 'fill-opacity': 0.84 } },
      { id: 'hangar', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'hangar'] as any, paint: { 'fill-color': '#131e30', 'fill-opacity': 0.7 } },
      { id: 'terminal', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'terminal'] as any, paint: { 'fill-color': '#1a2c47', 'fill-opacity': 0.94 } },
      { id: 'terminal-line', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'terminal'] as any, paint: { 'line-color': '#2a4466', 'line-width': 1 } },

      // taxiways — thick black ribbons
      { id: 'taxiway-casing', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': '#1b2b43', 'line-width': taxiCasing } },
      { id: 'taxiway', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': '#04070e', 'line-width': taxiW } },
      { id: 'taxiway-cl', type: 'line' as const, source: 'osm', minzoom: 13.5, filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': 'rgba(240,200,70,0.32)', 'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 0.4, 16, 1, 18, 1.6] as any } },

      // runways — thicker black strips
      { id: 'runway-casing', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'runway'] as any, layout: { 'line-cap': 'butt' as const }, paint: { 'line-color': '#21354e', 'line-width': rwyCasing } },
      { id: 'runway', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'runway'] as any, layout: { 'line-cap': 'butt' as const }, paint: { 'line-color': '#03050b', 'line-width': rwyW } },
      { id: 'runway-cl', type: 'line' as const, source: 'osm', minzoom: 12.5, filter: ['==', ['get', 'aeroway'], 'runway'] as any, paint: { 'line-color': 'rgba(220,230,245,0.5)', 'line-width': 1, 'line-dasharray': [4, 6] } },
      {
        id: 'runway-label', type: 'symbol' as const, source: 'osm', minzoom: 12,
        filter: ['==', ['get', 'aeroway'], 'runway'] as any,
        layout: { 'symbol-placement': 'line-center' as const, 'text-field': ['get', 'ref'] as any, 'text-size': 11, 'text-font': ['Open Sans Bold', 'Open Sans Regular'], 'text-letter-spacing': 0.1 },
        paint: { 'text-color': 'rgba(210,225,245,0.85)', 'text-halo-color': '#04060c', 'text-halo-width': 1.4 },
      },

      // parking stands (gate + derived)
      {
        id: 'gate-dot', type: 'circle' as const, source: 'osm', minzoom: 13,
        filter: ['in', ['get', 'aeroway'], ['literal', ['gate', 'stand']]] as any,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.2, 16, 2.6, 18, 4.2] as any,
          'circle-color': 'rgba(96,160,235,0.6)',
          'circle-stroke-color': 'rgba(140,190,255,0.82)', 'circle-stroke-width': 0.6,
        },
      },
      {
        id: 'gate-label', type: 'symbol' as const, source: 'osm', minzoom: 14.5,
        filter: ['all', ['in', ['get', 'aeroway'], ['literal', ['gate', 'stand']]], ['!=', ['to-string', ['get', 'ref']], '']] as any,
        layout: { 'text-field': ['get', 'ref'] as any, 'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 7.5, 17, 10.5, 19, 13] as any, 'text-font': ['Open Sans Bold', 'Open Sans Regular'], 'text-offset': [0, 0.85] as any, 'text-anchor': 'top' as const, 'text-allow-overlap': false, 'text-optional': true },
        paint: { 'text-color': ['case', ['==', ['get', 'aeroway'], 'gate'], 'rgba(180,210,250,0.95)', 'rgba(150,185,228,0.8)'] as any, 'text-halo-color': 'rgba(4,8,16,0.95)', 'text-halo-width': 1.4 },
      },
    ],
  };
}

// ─── Aircraft sim ─────────────────────────────────────────────────────────────
interface Ac {
  id: number;
  callsign: string;          // BAW117
  flight: string;            // BA117
  airline: string;           // British Airways
  type: string;              // A320
  kind: 'departure' | 'arrival';
  city: string;              // dest (dep) / origin (arr)
  fromLabel: string;
  toLabel: string;
  nodes: OsmNode[]; seg: number; t: number;
  speed: number;             // m/s
  lng: number; lat: number; heading: number;
  trail: [number, number][]; done: boolean;
}

export default function OsmRadar() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const air = useRef<OsmAirport | null>(null);
  const acs = useRef<Ac[]>([]);
  const last = useRef(performance.now());
  const idc = useRef(0);
  const raf = useRef(0);
  const frame = useRef(0);
  const selRef = useRef<number | null>(null);
  const paused = useRef(false);

  const [icao, setIcao] = useState('EGLL');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, dep: 0, arr: 0 });
  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<null | { callsign: string; flight: string; airline: string; type: string; kind: string; city: string; fromLabel: string; toLabel: string; kt: number; hdg: number; pct: number }>(null);
  const [clock, setClock] = useState('--:--:--');
  const [view, setView] = useState({ zoom: 13.3, lat: 51.47, lng: -0.4543 });
  const [isPaused, setIsPaused] = useState(false);

  const icaoRef = useRef('EGLL');
  useEffect(() => { icaoRef.current = icao; }, [icao]);
  useEffect(() => { selRef.current = selId; }, [selId]);

  const refreshStats = useCallback(() => {
    const a = acs.current;
    setStats({ total: a.length, dep: a.filter(x => x.kind === 'departure').length, arr: a.filter(x => x.kind === 'arrival').length });
  }, []);

  // UTC clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`);
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);

  const spawn = useCallback(() => {
    const a = air.current;
    if (!a || acs.current.length >= 16) return;
    if (!a.gates.length || !a.runways.length) return;

    const kind: 'departure' | 'arrival' = Math.random() < 0.45 ? 'arrival' : 'departure';
    const gate = rnd(a.gates);
    const rw = rnd(a.runways);
    const end = rnd(rw.ends);
    const startId = kind === 'departure' ? gate.nodeId : end.nodeId;
    const goalId  = kind === 'departure' ? end.nodeId : gate.nodeId;
    const path = findPath(a, startId, goalId);
    if (!path || path.length < 2) return;

    const nodes = path.map(id => a.nodes.get(id)!);
    const airline = rnd(AIRLINES);
    const fno = 1 + ri(998);
    const id = ++idc.current;
    acs.current.push({
      id,
      callsign: `${airline.icao}${fno}`,
      flight: `${airline.iata}${fno}`,
      airline: airline.name,
      type: rnd(TYPES),
      kind,
      city: rnd(CITIES),
      fromLabel: kind === 'departure' ? `Stand ${gate.ref}` : `RWY ${end.name}`,
      toLabel:   kind === 'departure' ? `RWY ${end.name}` : `Stand ${gate.ref}`,
      nodes, seg: 0, t: 0, speed: 4.5 + Math.random() * 6,
      lng: nodes[0].lng, lat: nodes[0].lat,
      heading: bearingDeg(nodes[0].lng, nodes[0].lat, nodes[1].lng, nodes[1].lat),
      trail: [[nodes[0].lng, nodes[0].lat]], done: false,
    });
    refreshStats();
  }, [refreshStats]);

  const clear = useCallback(() => { acs.current = []; setSelId(null); setSel(null); refreshStats(); }, [refreshStats]);

  const togglePause = useCallback(() => {
    paused.current = !paused.current;
    setIsPaused(paused.current);
  }, []);

  const load = useCallback(async (ic: string) => {
    setIcao(ic);
    setLoading(true);
    setSelId(null); setSel(null);
    acs.current = []; refreshStats();
    air.current = null;
    const m = map.current;
    if (m) {
      const cfg = AIRPORTS[ic];
      m.flyTo({ center: cfg.center, zoom: cfg.zoom, speed: 1.6 });
      const s = m.getSource('osm') as maplibregl.GeoJSONSource | undefined;
      if (s) s.setData(`/maps/osm/${ic}.geojson`);
    }
    try {
      const a = await loadOsmAirport(ic);
      if (!map.current || icaoRef.current !== ic) return;
      air.current = a;
      setLoading(false);
      setTimeout(() => { if (map.current && icaoRef.current === ic) for (let i = 0; i < 7; i++) spawn(); }, 500);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setLoading(false);
    }
  }, [refreshStats, spawn]);

  // init map
  useEffect(() => {
    if (!mapDiv.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapDiv.current,
      style: buildStyle('EGLL') as any,
      center: AIRPORTS.EGLL.center, zoom: AIRPORTS.EGLL.zoom,
      minZoom: 11, maxZoom: 19, attributionControl: false, dragRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

    const syncView = () => setView({ zoom: m.getZoom(), lat: m.getCenter().lat, lng: m.getCenter().lng });
    m.on('moveend', syncView);
    m.on('load', () => { if (map.current === m) { load('EGLL'); syncView(); } });

    // click to select nearest aircraft
    const hit = (pt: maplibregl.Point): Ac | null => {
      let best: Ac | null = null, bestD = 22;
      for (const ac of acs.current) {
        const p = m.project([ac.lng, ac.lat]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = ac; }
      }
      return best;
    };
    m.on('click', (e) => {
      const ac = hit(e.point);
      setSelId(ac ? ac.id : null);
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = hit(e.point) ? 'pointer' : '';
    });

    map.current = m;
    return () => { cancelAnimationFrame(raf.current); map.current = null; m.remove(); };
  }, [load]);

  // animation loop
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;

    const project = (lng: number, lat: number) => {
      const m = map.current!;
      const p = m.project([lng, lat]);
      const s = m.getCanvas().width / m.getContainer().clientWidth;
      return { x: p.x * s, y: p.y * s, dpr: s };
    };

    const tick = (now: number) => {
      raf.current = requestAnimationFrame(tick);
      const m = map.current;
      if (!m || !cv) return;
      frame.current++;

      const mc = m.getCanvas();
      if (cv.width !== mc.width || cv.height !== mc.height) {
        cv.width = mc.width; cv.height = mc.height;
        cv.style.width = `${m.getContainer().clientWidth}px`;
        cv.style.height = `${m.getContainer().clientHeight}px`;
      }

      const dt = Math.min((now - last.current) / 1000, 0.1);
      last.current = now;

      // physics
      if (!paused.current) {
        let changed = false;
        for (const ac of acs.current) {
          if (ac.done) continue;
          if (ac.seg >= ac.nodes.length - 1) { ac.done = true; changed = true; continue; }
          const f = ac.nodes[ac.seg], t = ac.nodes[ac.seg + 1];
          const len = meters(f.lng, f.lat, t.lng, t.lat);
          if (len < 0.5) { ac.seg++; ac.t = 0; continue; }
          ac.t += (ac.speed * dt) / len;
          if (ac.t >= 1) {
            ac.t = 0; ac.seg++;
            if (ac.seg >= ac.nodes.length - 1) { ac.done = true; changed = true; continue; }
          }
          const f2 = ac.nodes[ac.seg], t2 = ac.nodes[ac.seg + 1];
          ac.lng = f2.lng + (t2.lng - f2.lng) * ac.t;
          ac.lat = f2.lat + (t2.lat - f2.lat) * ac.t;
          // smooth heading toward travel direction
          const target = bearingDeg(f2.lng, f2.lat, t2.lng, t2.lat);
          let diff = ((target - ac.heading + 540) % 360) - 180;
          ac.heading = (ac.heading + diff * Math.min(1, dt * 6) + 360) % 360;
          const lp = ac.trail[ac.trail.length - 1];
          if (meters(lp[0], lp[1], ac.lng, ac.lat) > 6) {
            ac.trail.push([ac.lng, ac.lat]);
            if (ac.trail.length > 180) ac.trail.shift();
          }
        }
        if (changed) {
          const removed = acs.current.filter(a => a.done).map(a => a.id);
          acs.current = acs.current.filter(a => !a.done);
          if (selRef.current && removed.includes(selRef.current)) { setSelId(null); setSel(null); }
          refreshStats();
          if (acs.current.length < 7) setTimeout(spawn, 400);
        }
      }

      const selectedId = selRef.current;

      // draw
      ctx.clearRect(0, 0, cv.width, cv.height);

      // routes ahead (green; selected brighter)
      for (const ac of acs.current) {
        if (ac.seg >= ac.nodes.length - 1) continue;
        const isSel = ac.id === selectedId;
        ctx.save();
        ctx.strokeStyle = isSel ? '#4ade80' : '#22c55e';
        ctx.lineWidth = isSel ? 4 : 2.6;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalAlpha = isSel ? 0.95 : 0.7;
        if (isSel) { ctx.shadowColor = 'rgba(74,222,128,0.6)'; ctx.shadowBlur = 8; }
        ctx.beginPath();
        const c = project(ac.lng, ac.lat); ctx.moveTo(c.x, c.y);
        for (let i = ac.seg + 1; i < ac.nodes.length; i++) {
          const p = project(ac.nodes[i].lng, ac.nodes[i].lat); ctx.lineTo(p.x, p.y);
        }
        ctx.stroke(); ctx.restore();
      }

      // trails (red, fading)
      for (const ac of acs.current) {
        const isSel = ac.id === selectedId;
        for (let i = 1; i < ac.trail.length; i++) {
          const a = project(ac.trail[i - 1][0], ac.trail[i - 1][1]);
          const b = project(ac.trail[i][0], ac.trail[i][1]);
          const al = (0.05 + i / ac.trail.length * 0.9) * (isSel ? 1 : 0.85);
          ctx.strokeStyle = `rgba(239,68,68,${al.toFixed(2)})`;
          ctx.lineWidth = isSel ? 4 : 3.2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // aircraft + labels
      for (const ac of acs.current) {
        const p = project(ac.lng, ac.lat);
        drawPlane(ctx, p, ac, ac.id === selectedId, p.dpr);
      }

      // push live detail of selected aircraft to the side panel (~5x/sec)
      if (frame.current % 12 === 0 && selectedId) {
        const ac = acs.current.find(a => a.id === selectedId);
        if (ac) {
          setSel({
            callsign: ac.callsign, flight: ac.flight, airline: ac.airline, type: ac.type,
            kind: ac.kind, city: ac.city, fromLabel: ac.fromLabel, toLabel: ac.toLabel,
            kt: Math.round(ac.speed * 1.944), hdg: Math.round(ac.heading),
            pct: Math.round((ac.seg / Math.max(1, ac.nodes.length - 1)) * 100),
          });
        }
      }

      function drawPlane(ctx: CanvasRenderingContext2D, pt: { x: number; y: number }, ac: Ac, selected: boolean, dpr: number) {
        const s = (selected ? 16.5 : 14.5);
        const ang = ac.heading * Math.PI / 180;

        // selection ring
        if (selected) {
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.beginPath();
          ctx.arc(0, 0, s * 1.95, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(96,165,250,0.9)'; ctx.lineWidth = 2;
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.lineDashOffset = -(frame.current * 0.5);
          ctx.stroke();
          ctx.restore();
        }

        ctx.save();
        ctx.translate(pt.x, pt.y); ctx.rotate(ang);
        const fill = selected ? '#fde68a' : AMBER;
        const edge = selected ? '#facc15' : '#c98a0a';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.8;
        ctx.lineJoin = 'round'; ctx.fillStyle = fill;
        if (selected) { ctx.shadowColor = 'rgba(251,191,36,0.8)'; ctx.shadowBlur = 12; }

        // ── main wings (swept back) ──
        ctx.beginPath();
        ctx.moveTo( s * 0.13, -s * 0.18);          // right root leading edge
        ctx.lineTo( s * 1.62,  s * 0.70);          // right wingtip leading
        ctx.lineTo( s * 1.60,  s * 0.84);          // wingtip trailing
        ctx.lineTo( s * 0.12,  s * 0.40);          // right root trailing
        ctx.lineTo(-s * 0.12,  s * 0.40);
        ctx.lineTo(-s * 1.60,  s * 0.84);
        ctx.lineTo(-s * 1.62,  s * 0.70);
        ctx.lineTo(-s * 0.13, -s * 0.18);
        ctx.closePath(); ctx.fill();

        // ── horizontal stabiliser (tailplane) ──
        ctx.beginPath();
        ctx.moveTo( s * 0.10,  s * 1.16);
        ctx.lineTo( s * 0.66,  s * 1.52);
        ctx.lineTo( s * 0.64,  s * 1.62);
        ctx.lineTo( s * 0.08,  s * 1.42);
        ctx.lineTo(-s * 0.08,  s * 1.42);
        ctx.lineTo(-s * 0.64,  s * 1.62);
        ctx.lineTo(-s * 0.66,  s * 1.52);
        ctx.lineTo(-s * 0.10,  s * 1.16);
        ctx.closePath(); ctx.fill();

        // ── fuselage (nose up, drawn over wing roots) ──
        ctx.beginPath();
        ctx.moveTo(0, -s * 1.62);                                   // nose tip
        ctx.bezierCurveTo( s * 0.17, -s * 1.42,  s * 0.185, -s * 0.85,  s * 0.185, -s * 0.15);
        ctx.lineTo( s * 0.165, s * 0.95);                           // body to aft
        ctx.bezierCurveTo( s * 0.15, s * 1.32,  s * 0.08, s * 1.55, 0, s * 1.72);  // taper to tailcone
        ctx.bezierCurveTo(-s * 0.08, s * 1.55, -s * 0.15, s * 1.32, -s * 0.165, s * 0.95);
        ctx.lineTo(-s * 0.185, -s * 0.15);
        ctx.bezierCurveTo(-s * 0.185, -s * 0.85, -s * 0.17, -s * 1.42, 0, -s * 1.62);
        ctx.closePath(); ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        // ── engine nacelles (darker pods under the wings) ──
        ctx.fillStyle = selected ? 'rgba(60,40,2,0.92)' : 'rgba(38,26,2,0.9)';
        for (const ex of [s * 0.82, -s * 0.82]) {
          roundRect(ctx, ex - s * 0.11, s * 0.16, s * 0.22, s * 0.5, s * 0.08);
          ctx.fill();
        }

        // subtle wing edge highlight for definition
        ctx.strokeStyle = edge; ctx.lineWidth = 0.6; ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo( s * 0.13, -s * 0.18); ctx.lineTo( s * 1.62, s * 0.70);
        ctx.moveTo(-s * 0.13, -s * 0.18); ctx.lineTo(-s * 1.62, s * 0.70);
        ctx.stroke(); ctx.globalAlpha = 1;
        ctx.restore();

        // ── AirNav-style label block ──
        const lx = pt.x + s * 1.5 + 6;
        const ly = pt.y - 7;
        const arrow = ac.kind === 'departure' ? '→' : '←';
        const line1 = ac.callsign;
        const line2 = `${arrow} ${ac.city}`;
        ctx.font = 'bold 11px ui-monospace,"SF Mono","Courier New",monospace';
        const w1 = ctx.measureText(line1).width;
        ctx.font = '10px ui-monospace,"SF Mono","Courier New",monospace';
        const w2 = ctx.measureText(line2).width;
        const bw = Math.max(w1, w2) + 12;
        const bh = 28;

        // leader line
        ctx.strokeStyle = 'rgba(120,150,190,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pt.x + s * 0.5, pt.y); ctx.lineTo(lx - 3, ly + bh / 2); ctx.stroke();

        // chip
        roundRect(ctx, lx - 3, ly - 2, bw, bh, 4);
        ctx.fillStyle = selected ? 'rgba(20,32,54,0.96)' : 'rgba(8,14,26,0.82)';
        ctx.fill();
        ctx.strokeStyle = selected ? 'rgba(96,165,250,0.9)' : 'rgba(40,64,104,0.7)';
        ctx.lineWidth = selected ? 1.4 : 1; ctx.stroke();

        // accent bar
        ctx.fillStyle = ac.kind === 'departure' ? '#fbbf24' : '#38bdf8';
        ctx.fillRect(lx - 3, ly - 2, 2.5, bh);

        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = 'bold 11px ui-monospace,"SF Mono","Courier New",monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line1, lx + 5, ly + 9);
        ctx.font = '10px ui-monospace,"SF Mono","Courier New",monospace';
        ctx.fillStyle = ac.kind === 'departure' ? '#fcd34d' : '#7dd3fc';
        ctx.fillText(line2, lx + 5, ly + 22);
      }

      function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }
    };

    last.current = performance.now();
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [spawn, refreshStats]);

  const cfg = AIRPORTS[icao];

  return (
    <div style={S.root}>
      <div ref={mapDiv} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvas} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }} />
      <div style={S.vignette} />

      {/* ── Top app bar ── */}
      <header style={S.topbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={S.logoMark}>◆</div>
          <div>
            <div style={S.brand}>SKYCONTROL</div>
            <div style={S.brandSub}>GROUND RADAR</div>
          </div>
        </div>

        <div style={S.switcher}>
          {Object.keys(AIRPORTS).map(a => (
            <button key={a} onClick={() => load(a)} style={S.switchBtn(a === icao)}>{a}</button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={S.apName}>{cfg.name}</div>
            <div style={S.apSub}>{cfg.city} · {icao}</div>
          </div>
          <div style={S.clock}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            <span style={S.utc}>UTC</span>
          </div>
        </div>
      </header>

      {/* ── Left control rail ── */}
      <div style={S.leftRail}>
        <div style={S.panel}>
          <div style={S.panelTitle}>TRAFFIC</div>
          <div style={S.statRow}>
            <Stat label="Active"  value={stats.total} color="#e5edf7" />
            <Stat label="Departures" value={stats.dep} color="#fbbf24" />
            <Stat label="Arrivals"   value={stats.arr} color="#38bdf8" />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button onClick={spawn} style={S.actBtn('#1a3a6e', '#fbbf24')}>+ Add flight</button>
            <button onClick={togglePause} style={S.actBtn('rgba(8,16,30,0.9)', '#9fb6d6')}>{isPaused ? '▶' : '❚❚'}</button>
            <button onClick={clear} style={S.actBtn('rgba(8,16,30,0.9)', '#7891b5')}>✕</button>
          </div>
        </div>

        <div style={S.panel}>
          <div style={S.panelTitle}>LEGEND</div>
          {[
            ['line', '#ef4444', 'Travelled path'],
            ['line', '#22c55e', 'Cleared route'],
            ['plane', AMBER, 'Aircraft'],
            ['dot', '#fbbf24', 'Departure'],
            ['dot', '#38bdf8', 'Arrival'],
            ['dot', 'rgba(96,160,235,0.7)', 'Parking stand'],
          ].map(([k, c, l]) => (
            <div key={l as string} style={S.legendRow}>
              {k === 'line' ? <div style={{ width: 20, height: 3, background: c as string, borderRadius: 2 }} />
                : k === 'plane' ? <span style={{ color: c as string, fontSize: 12, lineHeight: '8px' }}>▲</span>
                : <div style={{ width: 8, height: 8, borderRadius: '50%', background: c as string }} />}
              <span style={S.legendLabel}>{l as string}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Selected aircraft detail card ── */}
      {sel && selId && (
        <div style={S.detail}>
          <div style={S.detailHead}>
            <div>
              <div style={S.detailCall}>{sel.callsign}</div>
              <div style={S.detailAirline}>{sel.airline}</div>
            </div>
            <button onClick={() => { setSelId(null); setSel(null); }} style={S.closeBtn}>✕</button>
          </div>
          <div style={S.badgeRow}>
            <span style={S.badge(sel.kind === 'departure' ? '#fbbf24' : '#38bdf8')}>{sel.kind.toUpperCase()}</span>
            <span style={S.typeBadge}>{sel.type}</span>
          </div>
          <div style={S.route}>
            <div style={S.routeEnd}>
              <div style={S.routeLabel}>FROM</div>
              <div style={S.routeVal}>{sel.fromLabel}</div>
            </div>
            <div style={S.routeArrow}>{sel.kind === 'departure' ? '→' : '→'}</div>
            <div style={{ ...S.routeEnd, textAlign: 'right' }}>
              <div style={S.routeLabel}>TO</div>
              <div style={S.routeVal}>{sel.toLabel}</div>
            </div>
          </div>
          <div style={S.detailGrid}>
            <Field label="GND SPEED" value={`${sel.kt} kt`} />
            <Field label="HEADING" value={`${String(sel.hdg).padStart(3, '0')}°`} />
            <Field label={sel.kind === 'departure' ? 'DEST' : 'ORIGIN'} value={sel.city} />
            <Field label="TAXI PROGRESS" value={`${sel.pct}%`} />
          </div>
          <div style={S.progressTrack}>
            <div style={{ ...S.progressFill, width: `${sel.pct}%`, background: sel.kind === 'departure' ? '#fbbf24' : '#38bdf8' }} />
          </div>
        </div>
      )}

      {/* ── Bottom telemetry bar ── */}
      <footer style={S.bottombar}>
        <span style={S.telItem}><b style={S.telKey}>APT</b> {icao}</span>
        <span style={S.telItem}><b style={S.telKey}>LAT</b> {view.lat.toFixed(4)}</span>
        <span style={S.telItem}><b style={S.telKey}>LON</b> {view.lng.toFixed(4)}</span>
        <span style={S.telItem}><b style={S.telKey}>ZOOM</b> {view.zoom.toFixed(1)}</span>
        <span style={{ flex: 1 }} />
        <span style={S.telItem}><span style={S.live} /> LIVE SIMULATION</span>
        <span style={S.telItem}>{stats.total} ACFT ON GROUND</span>
      </footer>

      {/* ── Loading overlay ── */}
      {loading && (
        <div style={S.loadOverlay}>
          <div style={S.spinner} />
          <div style={S.loadText}>BUILDING TAXIWAY NETWORK</div>
          <div style={S.loadSub}>{cfg.name} · {icao}</div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        * { box-sizing: border-box; }
        .maplibregl-ctrl-attrib { display: none !important; }
        .maplibregl-ctrl-bottom-right { bottom: 34px !important; }
        .maplibregl-ctrl-bottom-left { bottom: 34px !important; }
        .maplibregl-ctrl-group { background: rgba(7,13,24,0.92) !important; border: 1px solid rgba(30,56,96,0.7) !important; border-radius: 8px !important; box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important; }
        .maplibregl-ctrl-group button { background: transparent !important; }
        .maplibregl-ctrl-group button span { filter: invert(0.4) sepia(1) saturate(0.6) hue-rotate(185deg); }
        .maplibregl-ctrl-scale { background: rgba(7,13,24,0.85) !important; border-color: rgba(30,56,96,0.7) !important; color: #5577a0 !important; font-size: 9px !important; border-radius: 4px !important; font-family: ui-monospace,monospace !important; }
      `}</style>
    </div>
  );
}

// ─── small components ─────────────────────────────────────────────────────────
function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 7.5, color: '#4a6a90', letterSpacing: 1, marginTop: 3, textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 7.5, letterSpacing: 1, color: '#557', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#dce7f4', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────
const mono = "ui-monospace,'SF Mono','Courier New',monospace";
const S: Record<string, any> = {
  root: { width: '100vw', height: '100vh', background: '#070d18', position: 'relative', overflow: 'hidden', fontFamily: mono, userSelect: 'none' },
  vignette: { position: 'absolute', inset: 0, zIndex: 11, pointerEvents: 'none', boxShadow: 'inset 0 0 200px 40px rgba(0,0,0,0.55)' },

  topbar: { position: 'absolute', top: 0, left: 0, right: 0, height: 52, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', background: 'linear-gradient(180deg, rgba(6,11,21,0.95) 0%, rgba(6,11,21,0.78) 100%)', borderBottom: '1px solid rgba(30,56,96,0.6)', backdropFilter: 'blur(10px)' },
  logoMark: { width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,#1e3a6e,#0c1830)', border: '1px solid rgba(80,130,200,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fbbf24', fontSize: 14 },
  brand: { fontSize: 13, fontWeight: 800, letterSpacing: 3, color: '#eaf1fb', lineHeight: 1 },
  brandSub: { fontSize: 7.5, letterSpacing: 2.5, color: '#4f719c', marginTop: 2 },

  switcher: { display: 'flex', gap: 3, background: 'rgba(6,12,22,0.7)', padding: 3, borderRadius: 9, border: '1px solid rgba(28,52,90,0.6)' },
  switchBtn: (on: boolean) => ({ padding: '6px 13px', fontSize: 10, fontFamily: mono, letterSpacing: 1.5, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none', background: on ? 'linear-gradient(180deg,#1e457f,#15315c)' : 'transparent', color: on ? '#fde68a' : '#5577a0', boxShadow: on ? '0 2px 8px rgba(20,50,100,0.5)' : 'none', transition: 'all .15s' }),

  apName: { fontSize: 12, fontWeight: 700, color: '#dce7f4', lineHeight: 1 },
  apSub: { fontSize: 8.5, color: '#4f719c', marginTop: 3, letterSpacing: 0.5 },
  clock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', background: 'rgba(6,12,22,0.7)', border: '1px solid rgba(28,52,90,0.6)', borderRadius: 8, padding: '5px 10px' },
  utc: { fontSize: 7, letterSpacing: 2, color: '#4f719c', marginTop: 1 },

  leftRail: { position: 'absolute', top: 66, left: 14, zIndex: 25, display: 'flex', flexDirection: 'column', gap: 10, width: 210 },
  panel: { background: 'rgba(7,13,24,0.86)', border: '1px solid rgba(30,56,96,0.55)', borderRadius: 11, padding: '11px 13px', backdropFilter: 'blur(12px)', boxShadow: '0 6px 22px rgba(0,0,0,0.4)' },
  panelTitle: { fontSize: 8.5, letterSpacing: 2.5, color: '#4f719c', fontWeight: 700, marginBottom: 9 },
  statRow: { display: 'flex', gap: 6 },

  actBtn: (bg: string, fg: string) => ({ flex: '1 1 auto', padding: '8px 0', fontSize: 10, fontFamily: mono, fontWeight: 700, letterSpacing: 1, color: fg, background: bg, border: '1px solid rgba(40,70,120,0.5)', borderRadius: 7, cursor: 'pointer' }),

  legendRow: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 },
  legendLabel: { fontSize: 9.5, color: '#7a93b6' },

  detail: { position: 'absolute', top: 66, right: 14, zIndex: 26, width: 248, background: 'rgba(7,13,24,0.93)', border: '1px solid rgba(50,90,150,0.6)', borderRadius: 13, padding: 14, backdropFilter: 'blur(14px)', boxShadow: '0 10px 36px rgba(0,0,0,0.55)' },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  detailCall: { fontSize: 19, fontWeight: 800, color: '#fff', letterSpacing: 1, lineHeight: 1 },
  detailAirline: { fontSize: 10, color: '#6f8db4', marginTop: 4 },
  closeBtn: { background: 'rgba(30,50,80,0.5)', border: 'none', color: '#8aa6c8', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  badgeRow: { display: 'flex', gap: 6, marginBottom: 12 },
  badge: (c: string) => ({ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#07101e', background: c, padding: '3px 9px', borderRadius: 5 }),
  typeBadge: { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: '#bcd0ea', background: 'rgba(30,52,86,0.8)', padding: '3px 9px', borderRadius: 5, border: '1px solid rgba(50,80,130,0.6)' },
  route: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(4,9,18,0.6)', borderRadius: 9, padding: '9px 11px', marginBottom: 12 },
  routeEnd: { flex: 1, minWidth: 0 },
  routeLabel: { fontSize: 7.5, letterSpacing: 1.5, color: '#557', marginBottom: 3 },
  routeVal: { fontSize: 12, fontWeight: 700, color: '#e2ebf6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  routeArrow: { color: '#fbbf24', fontSize: 16, fontWeight: 700 },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 10px', marginBottom: 12 },
  progressTrack: { height: 5, background: 'rgba(20,34,56,0.9)', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width .3s ease' },

  bottombar: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 26, zIndex: 30, display: 'flex', alignItems: 'center', gap: 18, padding: '0 14px', background: 'rgba(6,11,21,0.94)', borderTop: '1px solid rgba(30,56,96,0.6)', fontSize: 9.5, color: '#6f8db4', letterSpacing: 0.5 },
  telItem: { display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' },
  telKey: { color: '#3f5f8a', fontWeight: 700, letterSpacing: 1 },
  live: { width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e', animation: 'pulse 1.6s infinite' },

  loadOverlay: { position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'rgba(5,10,18,0.72)', backdropFilter: 'blur(3px)' },
  spinner: { width: 42, height: 42, borderRadius: '50%', border: '3px solid rgba(60,100,160,0.25)', borderTopColor: '#fbbf24', animation: 'spin 0.9s linear infinite' },
  loadText: { fontSize: 12, letterSpacing: 3, color: '#cdddf2', fontWeight: 700 },
  loadSub: { fontSize: 10, letterSpacing: 1, color: '#5f7da6' },
};
