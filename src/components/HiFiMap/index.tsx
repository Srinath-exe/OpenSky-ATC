'use client';
import React, { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ============================================================
//  TYPE DEFINITIONS
// ============================================================
export interface AirportConfig {
  icao: string;
  name: string;
  center: [number, number];
  elevation: string;
  runways_info: string[];
  sources: Record<string, any>;
  layers: any[];
}

function buildSources(icao: string): Record<string, any> {
  const base = `/maps/xplane/${icao}/combined`;
  return {
    boundary:    { type: 'geojson', data: `${base}/boundary.geojson` },
    aprons:      { type: 'geojson', data: `${base}/pavement_aprons.geojson` },
    taxiways:    { type: 'geojson', data: `${base}/pavement_taxiways.geojson` },
    terminals:   { type: 'geojson', data: `${base}/terminals.geojson` },
    runways:     { type: 'geojson', data: `${base}/runways.geojson` },
    holds:       { type: 'geojson', data: `${base}/lines_holds.geojson` },
    centerlines: { type: 'geojson', data: `${base}/lines_centerlines.geojson` },
    edges:       { type: 'geojson', data: `${base}/lines_edges.geojson` },
    otherLines:  { type: 'geojson', data: `${base}/lines_other.geojson` },
    signs:       { type: 'geojson', data: `${base}/signs.geojson` },
    gates:       { type: 'geojson', data: `${base}/startup_locations.geojson` },
    windsocks:   { type: 'geojson', data: `${base}/windsocks.geojson` },
    jetbridges:  { type: 'geojson', data: `${base}/jetbridges.geojson` },
  };
}

// ============================================================
//  NAVIGRAPH JEPPESEN CHART STYLE — Light "Enroute High" Theme
//
//  Colors extracted directly from Navigraph Charts v5:
//  - Land/paper background:  #dde1e6   (cool light grey-blue)
//  - Airport boundary fill:  #ccd0d6   (slightly darker paper)
//  - Apron pavement:         #b8bcbf   (warm medium grey)
//  - Taxiway pavement:       #a8acaf   (cooler darker grey)
//  - Terminal buildings:     #4e5d78   (Navigraph dark navy blue)
//  - Runway asphalt:         #27292e   (near-black dark charcoal)
//  - Taxiway edge lines:     #f5c800   (vivid Navigraph yellow)
//  - Centerlines:            #f5c800   (same yellow, thinner)
//  - Hold-short lines:       #cc3300   (bright red-orange)
//  - Sign labels:            black on #f5c800 yellow box
//  - Jetbridges:             #3d5a80   (muted steel blue)
//  - Gate dots (PAX):        #c94090   (Navigraph magenta-pink)
//  - Gate dots (cargo):      #6c757d   (muted grey)
// ============================================================

const NAVIGRAPH_LAYERS = [
  // ── 1. Land/paper background ─────────────────────────────────────────────
  {
    id: 'bg',
    type: 'background',
    paint: { 'background-color': '#dde1e6' },
  },

  // ── 2. Airport boundary area (tinted paper zone) ─────────────────────────
  {
    id: 'boundary-fill',
    type: 'fill',
    source: 'boundary',
    paint: {
      'fill-color': '#ccd0d5',
      'fill-opacity': 1.0,
    },
  },
  {
    id: 'boundary-line',
    type: 'line',
    source: 'boundary',
    paint: {
      'line-color': '#9aa0a8',
      'line-width': 1.0,
      'line-opacity': 0.6,
    },
  },

  // ── 3. Apron / ramp pavement ─────────────────────────────────────────────
  {
    id: 'apron-fill',
    type: 'fill',
    source: 'aprons',
    paint: {
      'fill-color': '#b6babe',
      'fill-opacity': 1.0,
    },
  },
  {
    id: 'apron-outline',
    type: 'line',
    source: 'aprons',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#9aa0a8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 16, 0.8, 18, 1.5],
      'line-opacity': 0.5,
    },
  },

  // ── 4. Taxiway pavement ───────────────────────────────────────────────────
  {
    id: 'taxiway-fill',
    type: 'fill',
    source: 'taxiways',
    paint: {
      'fill-color': '#a8acb0',
      'fill-opacity': 1.0,
    },
  },
  {
    id: 'taxiway-outline',
    type: 'line',
    source: 'taxiways',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#8a9098',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.6, 16, 1.0, 18, 1.8],
      'line-opacity': 0.5,
    },
  },

  // ── 5. TERMINAL BUILDINGS (Navigraph dark navy/indigo) ───────────────────
  // This is the defining visual element — large dark blue structures
  {
    id: 'terminal-fill',
    type: 'fill',
    source: 'terminals',
    paint: {
      'fill-color': '#4a5568',   // Dark navy blue — exact Navigraph terminal tone
      'fill-opacity': 0.92,
    },
  },
  {
    id: 'terminal-outline',
    type: 'line',
    source: 'terminals',
    layout: { 'line-join': 'miter', 'line-cap': 'butt' },
    paint: {
      'line-color': '#2d3748',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 1.2, 16, 1.8, 18, 2.5],
      'line-opacity': 0.85,
    },
  },

  // ── 6. Runway — wide pitch-black asphalt band ─────────────────────────────
  {
    id: 'runway-shoulder',
    type: 'line',
    source: 'runways',
    layout: { 'line-cap': 'butt', 'line-join': 'miter' },
    paint: {
      'line-color': '#1e2125',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        11, 3, 12, 5, 13, 9, 14, 16, 15, 28, 16, 46, 17, 74, 18, 118],
      'line-opacity': 1.0,
    },
  },
  {
    id: 'runway-pavement',
    type: 'line',
    source: 'runways',
    layout: { 'line-cap': 'butt', 'line-join': 'miter' },
    paint: {
      'line-color': '#2c3038',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        11, 2, 12, 3.5, 13, 6, 14, 12, 15, 20, 16, 34, 17, 54, 18, 88],
    },
  },

  // ── 7. Runway edge stripes (white) ───────────────────────────────────────
  {
    id: 'runway-edge-left',
    type: 'line',
    source: 'runways',
    minzoom: 13,
    layout: { 'line-cap': 'butt' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 14, 1.0, 15, 1.4, 16, 2.0, 18, 3.2],
      'line-offset': ['interpolate', ['linear'], ['zoom'],
        13, 3.5, 14, 6, 15, 10, 16, 16, 17, 26, 18, 42],
      'line-opacity': 0.95,
    },
  },
  {
    id: 'runway-edge-right',
    type: 'line',
    source: 'runways',
    minzoom: 13,
    layout: { 'line-cap': 'butt' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 14, 1.0, 15, 1.4, 16, 2.0, 18, 3.2],
      'line-offset': ['interpolate', ['linear'], ['zoom'],
        13, -3.5, 14, -6, 15, -10, 16, -16, 17, -26, 18, -42],
      'line-opacity': 0.95,
    },
  },

  // ── 8. Runway centerline dashes (white) ──────────────────────────────────
  {
    id: 'runway-centerline',
    type: 'line',
    source: 'runways',
    minzoom: 14,
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.7, 15, 1.0, 16, 1.5, 18, 2.6],
      'line-dasharray': [12, 8],
      'line-opacity': 0.90,
    },
  },

  // ── 9. Taxiway EDGE lines — vivid Navigraph yellow ───────────────────────
  {
    id: 'taxiway-edge-main',
    type: 'line',
    source: 'edges',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#f5c800',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        11, 0.4, 12, 0.6, 13, 0.9, 14, 1.1, 15, 1.5, 16, 2.0, 17, 2.6, 18, 3.4],
      'line-opacity': 1.0,
    },
  },

  // ── 10. Taxiway CENTERLINES — thinner yellow ─────────────────────────────
  {
    id: 'centerline-main',
    type: 'line',
    source: 'centerlines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#f5c800',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        11, 0.3, 12, 0.5, 13, 0.7, 14, 0.9, 15, 1.1, 16, 1.4, 17, 1.8, 18, 2.4],
      'line-opacity': 0.95,
    },
  },

  // ── 11. White painted markings ────────────────────────────────────────────
  {
    id: 'other-line-white',
    type: 'line',
    source: 'otherLines',
    filter: ['any',
      ['==', ['get', 'painted_line_type'], 'SOLID_WHITE'],
      ['==', ['get', 'painted_line_type'], 'WIDE_SOLID_WHITE'],
    ],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1.0, 16, 1.6, 18, 2.5],
      'line-opacity': 0.85,
    },
  },

  // ── 12. Red painted markings ─────────────────────────────────────────────
  {
    id: 'other-line-red',
    type: 'line',
    source: 'otherLines',
    filter: ['==', ['get', 'painted_line_type'], 'SOLID_RED'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#cc3300',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 15, 1.2, 16, 1.8, 18, 3.0],
      'line-opacity': 0.9,
    },
  },

  // ── 13. Hold-short lines — solid red-orange double bars ──────────────────
  {
    id: 'hold-lines',
    type: 'line',
    source: 'holds',
    minzoom: 12,
    layout: { 'line-cap': 'square' },
    paint: {
      'line-color': '#cc3300',
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.0, 13, 1.5, 14, 2.2, 15, 3.0, 16, 4.2, 18, 6.5],
      'line-opacity': 1.0,
    },
  },

  // ── 14. JETBRIDGES — steel-blue connectors (terminal edge → gate) ─────────
  // Styled to match Navigraph's thin dark connector lines
  {
    id: 'jetbridge-line',
    type: 'line',
    source: 'jetbridges',
    minzoom: 14,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': '#2d3748',        // Dark navy matching terminal outline
      'line-width': ['interpolate', ['linear'], ['zoom'],
        14, 2.0, 15, 2.8, 16, 3.8, 17, 5.0, 18, 6.5],
      'line-opacity': 0.9,
    },
  },
  // Bright accent stripe on the jetbridge (lighter centre line)
  {
    id: 'jetbridge-stripe',
    type: 'line',
    source: 'jetbridges',
    minzoom: 15,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': '#718096',        // Lighter steel blue accent
      'line-width': ['interpolate', ['linear'], ['zoom'],
        15, 0.8, 16, 1.2, 17, 1.8, 18, 2.4],
      'line-opacity': 0.7,
    },
  },

  // ── 15. Windsock positions ───────────────────────────────────────────────
  {
    id: 'windsock-icon',
    type: 'circle',
    source: 'windsocks',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 15, 4.5, 18, 6],
      'circle-color': '#e07b00',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  },

  // ── 16. Gate / parking stand circles ────────────────────────────────────
  // PAX gates = Navigraph magenta-pink; cargo/other = grey
  {
    id: 'gates-circle',
    type: 'circle',
    source: 'gates',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        12, 1.2, 13, 2.0, 14, 3.2, 15, 4.5, 16, 6.0, 17, 7.5, 18, 9.5],
      'circle-color': [
        'match', ['get', 'location_type'],
        'gate',     '#c94090',    // Navigraph PAX pink/magenta
        'tie_down', '#6c757d',    // GA / ramp — grey
        '#9b59b6'                 // fallback purple
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1.0, 15, 1.5, 18, 2.0],
      'circle-opacity': 0.95,
    },
  },

  // ── 17. Gate labels ──────────────────────────────────────────────────────
  {
    id: 'gates-label',
    type: 'symbol',
    source: 'gates',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 8, 16, 10, 17, 11.5, 18, 13],
      'text-offset': [0, -1.5],
      'text-anchor': 'bottom',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#1a202c',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2.0,
    },
  },

  // ── 18. Taxiway guidance signs ───────────────────────────────────────────
  // Classic Jeppesen/Navigraph yellow box with black text
  // Replicated with a thick yellow text-halo around black text
  {
    id: 'sign-label',
    type: 'symbol',
    source: 'signs',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 7.5, 14, 9, 15, 10.5, 16, 12, 17, 13.5, 18, 15],
      'text-anchor': 'center',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#000000',         // black text
      'text-halo-color': '#f5c800',    // vivid yellow "box" background
      'text-halo-width': 5.5,          // thick halo = sign box
    },
  },

  // ── 19. Runway designation labels (10L/28R) ──────────────────────────────
  {
    id: 'runway-label',
    type: 'symbol',
    source: 'runways',
    minzoom: 13,
    layout: {
      'text-field': ['concat', ['get', 'name_1'], '/', ['get', 'name_2']],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 14, 11, 15, 13, 16, 15, 18, 18],
      'symbol-placement': 'line',
      'text-rotation-alignment': 'map',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#1a202c',
      'text-halo-width': 3.0,
    },
  },

  // ── 20. Terminal name labels (shown on the dark terminal buildings) ────────
  {
    id: 'terminal-label',
    type: 'symbol',
    source: 'terminals',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 15, 10.5, 16, 12, 18, 14],
      'text-anchor': 'center',
      'text-allow-overlap': false,
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#e2e8f0',         // Light text on dark terminal
      'text-halo-color': '#2d3748',
      'text-halo-width': 1.5,
    },
  },
];

function buildAirportConfig(
  icao: string,
  name: string,
  center: [number, number],
  elevation: string,
  runways_info: string[]
): AirportConfig {
  return {
    icao,
    name,
    center,
    elevation,
    runways_info,
    sources: buildSources(icao),
    layers: NAVIGRAPH_LAYERS,
  };
}

const TOP_AIRPORTS: AirportConfig[] = [
  buildAirportConfig('KSFO', 'San Francisco Intl',   [-122.37895905, 37.62175045], '13 FT',  ['10L/28R', '10R/28L', '01L/19R', '01R/19L']),
  buildAirportConfig('KJFK', 'New York JFK',          [-73.7781,       40.6413],    '13 FT',  ['04L/22R', '04R/22L', '13L/31R', '13R/31L']),
  buildAirportConfig('KLAX', 'Los Angeles Intl',      [-118.4081,      33.9416],    '128 FT', ['06L/24R', '06R/24L', '07L/25R', '07R/25L']),
  buildAirportConfig('KBOS', 'Boston Logan',          [-71.0052,       42.3656],    '20 FT',  ['04L/22R', '04R/22L', '09/27',   '15R/33L', '14/32']),
  buildAirportConfig('VIDP', 'Delhi Indira Gandhi',   [77.1006,        28.5562],    '777 FT', ['09L/27R', '09R/27L', '10/28',   '11/29']),
];

// ============================================================
//  MAIN COMPONENT
// ============================================================
export default function HiFiMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);

  const [activeIndex,       setActiveIndex]       = useState(0);
  const [zoom,              setZoom]              = useState(14);
  const [ready,             setReady]             = useState(false);
  const [loadStatus,        setLoadStatus]        = useState('Initializing...');
  const [errorMsg,          setErrorMsg]          = useState<string | null>(null);
  const [activeTab,         setActiveTab]         = useState<'airports' | 'charts' | 'layers'>('airports');
  const [chartMode,         setChartMode]         = useState<'HIGH IFR' | 'LOW IFR' | 'VFR'>('HIGH IFR');

  const [layersVis, setLayersVis] = useState({
    taxiways: true,
    terminals: true,
    runways: true,
    edges: true,
    gates: true,
    signs: true,
    jetbridges: true,
  });

  const active = useMemo(() => TOP_AIRPORTS[activeIndex], [activeIndex]);

  // ── Create map once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    setLoadStatus('Loading Chart Engine...');

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: active.sources,
        layers:  active.layers,
      } as any,
      center:  active.center,
      zoom:    14,
      minZoom: 11,
      maxZoom: 18,
      pitch:   0,
      bearing: 0,
      attributionControl: false,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    m.on('zoom',  () => setZoom(Math.round(m.getZoom() * 10) / 10));
    m.on('load',  () => { setReady(true); setLoadStatus('Chart Ready'); setTimeout(() => m.resize(), 50); });
    m.on('error', (e: any) => {
      const msg = e?.error?.message || JSON.stringify(e?.error) || 'Unknown error';
      console.error('[HiFiMap]', msg);
      setErrorMsg(msg);
      setReady(true);
    });

    const forceTimer = setTimeout(() => {
      setReady(curr => {
        if (!curr) { setLoadStatus('Timeout'); setTimeout(() => m.resize(), 50); return true; }
        return curr;
      });
    }, 8000);

    mapRef.current = m;
    return () => { clearTimeout(forceTimer); m.remove(); mapRef.current = null; };
  }, []);

  // ── Switch airport ─────────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !m.loaded()) return;

    setReady(false);
    setLoadStatus(`Loading ${active.icao}...`);

    Object.keys(active.sources).forEach(id => {
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src && 'setData' in src) (src as any).setData(active.sources[id].data);
    });

    m.flyTo({ center: active.center, zoom: 14, speed: 1.2 });

    const t = setTimeout(() => { setReady(true); setLoadStatus('Chart Ready'); }, 800);
    return () => clearTimeout(t);
  }, [active]);

  // ── Toggle layers ──────────────────────────────────────────────────────────
  const toggleLayer = (key: keyof typeof layersVis) => {
    const m = mapRef.current;
    if (!m) return;
    const newVal = !layersVis[key];
    setLayersVis(prev => ({ ...prev, [key]: newVal }));
    const groups: Record<string, string[]> = {
      taxiways:   ['taxiway-fill', 'taxiway-outline', 'apron-fill', 'apron-outline'],
      terminals:  ['terminal-fill', 'terminal-outline', 'terminal-label'],
      runways:    ['runway-shoulder', 'runway-pavement', 'runway-centerline', 'runway-edge-left', 'runway-edge-right', 'runway-label'],
      edges:      ['taxiway-edge-main', 'centerline-main', 'other-line-white', 'other-line-red', 'hold-lines'],
      gates:      ['gates-circle', 'gates-label'],
      signs:      ['sign-label', 'windsock-icon'],
      jetbridges: ['jetbridge-line', 'jetbridge-stripe'],
    };
    (groups[key] || []).forEach(id => {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', newVal ? 'visible' : 'none');
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-screen flex overflow-hidden select-none" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ══════════════════════════════════════════════════════════════════
          ICON BAR — far-left dark sidebar
          ══════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 flex flex-col items-center py-4 justify-between z-30" style={{ width: 62, background: '#13161c', borderRight: '1px solid #242830' }}>
        {/* Top nav items */}
        <div className="flex flex-col gap-0.5 items-center w-full">
          {/* Logo */}
          <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 cursor-pointer" style={{ background: 'linear-gradient(135deg,#1e6fd9,#0d4fa3)', boxShadow: '0 4px 16px rgba(30,111,217,.35)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="white"/>
            </svg>
          </div>

          <SideIconBtn active={activeTab==='airports'} onClick={()=>setActiveTab('airports')} label="Search" icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
            </svg>
          }/>
          <SideIconBtn active={activeTab==='charts'} onClick={()=>setActiveTab('charts')} label="Flights" icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 2-3.5 3.5L7 11 .8 9.2c-.5-.1-.5-.8.1-1l20-5.9a.6.6 0 0 1 .7.7l-5.9 20c-.2.6-.9.6-1-.1z"/>
            </svg>
          }/>
          <SideIconBtn active={false} onClick={()=>{}} label="Airports" icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 8v4l3 3"/>
            </svg>
          }/>
          <SideIconBtn active={activeTab==='layers'} onClick={()=>setActiveTab('layers')} label="Layers" icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 3-10 5 10 5 10-5-10-5Z"/>
              <path d="m2 17 10 5 10-5"/>
              <path d="m2 12 10 5 10-5"/>
            </svg>
          }/>
        </div>

        {/* Bottom: Settings */}
        <SideIconBtn active={false} onClick={()=>{}} label="Settings" icon={
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        }/>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          CONSOLE PANEL — airport list / chart info / layer toggles
          ══════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 flex flex-col z-20" style={{ width: 272, background: '#1b1f28', borderRight: '1px solid #242830' }}>

        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid #2b303b', background: '#161a22' }}>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: '#6b7280' }}>
              {activeTab === 'airports' && 'Airport Charts'}
              {activeTab === 'charts'   && 'Chart Mode'}
              {activeTab === 'layers'   && 'Map Overlays'}
            </span>
          </div>
          {/* HIGH IFR pill — matches reference image exactly */}
          <div className="flex flex-col items-center px-2 py-1 rounded cursor-pointer" style={{ background: '#0d1117', border: '1px solid #374151' }}>
            <span className="text-[9px] font-black tracking-widest leading-none" style={{ color: '#f3f4f6' }}>HIGH</span>
            <span className="text-[9px] font-black tracking-widest leading-none" style={{ color: '#f3f4f6' }}>IFR</span>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">

          {/* ── AIRPORTS TAB ── */}
          {activeTab === 'airports' && (
            <div className="space-y-2">
              <p className="text-[9px] font-bold tracking-widest uppercase px-1" style={{ color: '#4b5563' }}>Select Airfield</p>
              {TOP_AIRPORTS.map((ap, idx) => {
                const isActive = idx === activeIndex;
                return (
                  <button key={ap.icao} onClick={() => setActiveIndex(idx)}
                    className="w-full text-left rounded-lg transition-all duration-150"
                    style={{ padding:'10px 12px', background: isActive ? '#252c3a' : '#1e2330', border: isActive ? '1px solid #3b82f6' : '1px solid #2b303b' }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-mono font-extrabold text-sm" style={{ color: '#f5c800', letterSpacing: '0.08em' }}>{ap.icao}</div>
                        <div className="text-[11px] mt-0.5 truncate" style={{ color: '#6b7280', maxWidth: 150 }}>{ap.name}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[10px] font-mono" style={{ color: '#4b5563' }}>{ap.elevation}</span>
                        {isActive && <span className="text-[9px] font-mono" style={{ color: '#34d399' }}>● ACTIVE</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── CHARTS TAB ── */}
          {activeTab === 'charts' && (
            <div className="space-y-3">
              <p className="text-[9px] font-bold tracking-widest uppercase px-1" style={{ color: '#4b5563' }}>Navigational Profile</p>
              <div className="grid grid-cols-3 gap-1 p-1 rounded-xl" style={{ background: '#12151c', border: '1px solid #2b303b' }}>
                {(['HIGH IFR', 'LOW IFR', 'VFR'] as const).map(mode => (
                  <button key={mode} onClick={() => setChartMode(mode)}
                    className="py-2 rounded-lg text-[9px] font-black tracking-wider uppercase transition-all"
                    style={{ background: chartMode===mode ? '#252c3a':'transparent', color: chartMode===mode ? '#60a5fa':'#4b5563', border: chartMode===mode ? '1px solid #3b4f6b':'1px solid transparent' }}
                  >{mode}</button>
                ))}
              </div>

              <div className="rounded-xl p-3 space-y-2" style={{ background: '#1e2330', border: '1px solid #2b303b' }}>
                <p className="font-mono text-[10px] font-bold pb-2" style={{ color: '#f5c800', borderBottom: '1px solid #2b303b' }}>Active Airfield</p>
                <div className="grid grid-cols-2 gap-y-2 text-[11px] font-mono">
                  <span style={{color:'#4b5563'}}>ICAO</span>
                  <span className="text-right font-bold" style={{color:'#60a5fa'}}>{active.icao}</span>
                  <span style={{color:'#4b5563'}}>Elevation</span>
                  <span className="text-right" style={{color:'#d1d5db'}}>{active.elevation}</span>
                  <span style={{color:'#4b5563'}}>Lat</span>
                  <span className="text-right text-[10px]" style={{color:'#6b7280'}}>{active.center[1].toFixed(5)}°N</span>
                  <span style={{color:'#4b5563'}}>Lon</span>
                  <span className="text-right text-[10px]" style={{color:'#6b7280'}}>{active.center[0].toFixed(5)}°E</span>
                </div>
                <div className="pt-2 space-y-1.5" style={{ borderTop:'1px solid #2b303b' }}>
                  <p className="text-[9px] font-mono" style={{color:'#4b5563'}}>Runways</p>
                  <div className="flex flex-wrap gap-1">
                    {active.runways_info.map(r => (
                      <span key={r} className="px-2 py-0.5 rounded text-[10px] font-mono" style={{ background:'#12151c', border:'1px solid #2b303b', color:'#d1d5db' }}>{r}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── LAYERS TAB ── */}
          {activeTab === 'layers' && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-bold tracking-widest uppercase px-1" style={{ color: '#4b5563' }}>Chart Overlays</p>
              {[
                { key:'taxiways',   label:'Taxiway Pavements',    swatch:'#a8acb0', icon:'▪' },
                { key:'terminals',  label:'Terminal Buildings',    swatch:'#4a5568', icon:'■' },
                { key:'runways',    label:'Runway Assets',         swatch:'#2c3038', icon:'▬' },
                { key:'edges',      label:'Edge & Guidance Lines', swatch:'#f5c800', icon:'—' },
                { key:'jetbridges', label:'Jetbridges',            swatch:'#2d3748', icon:'╌' },
                { key:'gates',      label:'Parking Stands',        swatch:'#c94090', icon:'●' },
                { key:'signs',      label:'Taxiway Signs',         swatch:'#f5c800', icon:'■' },
              ].map(({ key, label, swatch, icon }) => {
                const isOn = layersVis[key as keyof typeof layersVis];
                return (
                  <button key={key} onClick={() => toggleLayer(key as keyof typeof layersVis)}
                    className="w-full text-left rounded-lg transition-all duration-150"
                    style={{ padding:'8px 10px', background: isOn ? '#1e2330':'#171a22', border: isOn ? '1px solid #2b303b':'1px solid #1e2330', opacity: isOn ? 1 : 0.45 }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span style={{ color: swatch, fontFamily:'monospace', fontSize:14 }}>{icon}</span>
                        <span className="text-[11px] font-medium" style={{ color: isOn ? '#d1d5db':'#4b5563' }}>{label}</span>
                      </div>
                      <div className="relative w-7 h-3.5 rounded-full transition-colors" style={{ background: isOn ? '#2563eb':'#374151' }}>
                        <div className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform" style={{ transform: isOn ? 'translateX(15px)':'translateX(2px)' }}/>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Panel footer */}
        <div className="px-4 py-2.5 flex-shrink-0" style={{ borderTop:'1px solid #2b303b', background:'#161a22' }}>
          <div className="flex justify-between text-[10px] font-mono">
            <span style={{color:'#4b5563'}}>Navigraph Charts</span>
            <span style={{color:'#374151'}}>v5.24.0</span>
          </div>
          <p className="text-[8px] font-mono text-center mt-1" style={{ color:'#cc3300', borderTop:'1px solid #2b303b', paddingTop:4, marginTop:4, letterSpacing:'0.05em' }}>
            NOT FOR REAL-WORLD NAVIGATION
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          MAIN MAP AREA
          ══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 relative overflow-hidden">

        {/* Floating top header */}
        <div className="absolute top-3 left-3 right-20 z-10 flex items-center justify-between rounded-xl px-4 py-2.5" style={{ background:'rgba(19,22,28,.90)', backdropFilter:'blur(12px)', border:'1px solid rgba(43,48,59,.85)', boxShadow:'0 4px 28px rgba(0,0,0,.4)' }}>
          <div className="flex items-center gap-3">
            <div className="px-3 py-1.5 rounded-lg font-mono font-black text-xl tracking-widest" style={{ background:'#0d1117', border:'1px solid #2b303b', color:'#f5c800' }}>
              {active.icao}
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color:'#f3f4f6' }}>{active.name}</div>
              <div className="text-[10px] font-mono mt-0.5" style={{ color:'#4b5563' }}>
                {active.center[1].toFixed(5)}N &nbsp;|&nbsp; {active.center[0].toFixed(5)}E &nbsp;|&nbsp; ELEV {active.elevation}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background:'#0d1117', border:'1px solid #2b303b' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: ready ? '#10b981':'#f59e0b', boxShadow: ready ? '0 0 6px #10b981':'0 0 6px #f59e0b', animation:'pulse 2s infinite' }}/>
              <span className="text-[10px] font-mono font-bold tracking-wider uppercase" style={{ color:'#6b7280' }}>{loadStatus}</span>
            </div>
            <div className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold" style={{ background:'#0d1117', border:'1px solid #2b303b', color:'#d1d5db' }}>
              Z {zoom}
            </div>
          </div>
        </div>

        {/* Map canvas */}
        <div ref={mapContainer} className="absolute inset-0 w-full h-full"/>

        {/* Loading overlay */}
        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20" style={{ background:'#dde1e6' }}>
            <div className="relative mb-5">
              <div className="w-16 h-16 rounded-full" style={{ border:'3px solid #c8cdd4', borderTopColor:'#1e6fd9', animation:'spin 1s linear infinite' }}/>
              <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black font-mono" style={{ color:'#1e6fd9' }}>{active.icao}</div>
            </div>
            <div className="text-sm font-semibold" style={{ color:'#374151' }}>Loading Chart</div>
            <div className="text-[11px] font-mono mt-1" style={{ color:'#6b7280' }}>{loadStatus}</div>
          </div>
        )}

        {/* Error toast */}
        {errorMsg && (
          <div className="absolute bottom-4 left-4 right-20 p-3 rounded-xl z-30 flex items-center gap-3" style={{ background:'rgba(127,18,18,.9)', border:'1px solid #b91c1c', backdropFilter:'blur(8px)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div>
              <strong className="block text-[11px] font-bold" style={{ color:'#fca5a5' }}>Render Error</strong>
              <span className="text-[10px] font-mono" style={{ color:'#fecaca' }}>{errorMsg}</span>
            </div>
          </div>
        )}

        {/* Watermark */}
        <div className="absolute bottom-8 right-4 z-10 text-right pointer-events-none">
          <div className="text-[10px] font-semibold" style={{ color:'#6b7280' }}>© Navigraph | X-Plane Data</div>
          <div className="text-[9px] font-mono mt-0.5" style={{ color:'#cc3300' }}>NOT FOR NAVIGATIONAL USE</div>
        </div>

        {/* Legend — bottom left overlay showing layer color key */}
        <div className="absolute bottom-10 left-4 z-10 rounded-xl p-3 space-y-1.5" style={{ background:'rgba(19,22,28,.88)', backdropFilter:'blur(8px)', border:'1px solid rgba(43,48,59,.8)' }}>
          <p className="text-[8px] font-black tracking-widest uppercase mb-2" style={{ color:'#4b5563' }}>Legend</p>
          {[
            { color:'#4a5568', label:'Terminal Buildings' },
            { color:'#b6babe', label:'Apron / Ramp' },
            { color:'#a8acb0', label:'Taxiway Pavement' },
            { color:'#f5c800', label:'Taxiway Lines' },
            { color:'#cc3300', label:'Hold Short' },
            { color:'#c94090', label:'Passenger Gates' },
            { color:'#2d3748', label:'Jetbridges' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: color }}/>
              <span className="text-[9px] font-medium" style={{ color:'#9ca3af' }}>{label}</span>
            </div>
          ))}
        </div>

        <style>{`
          @keyframes spin  { to { transform: rotate(360deg); } }
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
          .maplibregl-ctrl-group {
            background:#13161c !important;
            border:1px solid #242830 !important;
            border-radius:10px !important;
            overflow:hidden;
          }
          .maplibregl-ctrl-group button {
            background:#13161c !important;
            color:#6b7280 !important;
            border-color:#242830 !important;
            width:32px !important;
            height:32px !important;
          }
          .maplibregl-ctrl-group button:hover { background:#1b1f28 !important; }
          .maplibregl-ctrl-group button span  { filter:invert(.6); }
          .maplibregl-ctrl-attrib { display:none !important; }
          .maplibregl-ctrl-scale {
            background:rgba(19,22,28,.8) !important;
            border-color:#3d5a80 !important;
            color:#6b7280 !important;
            font-size:10px !important;
            padding:2px 6px !important;
            border-radius:4px !important;
          }
        `}</style>
      </div>
    </div>
  );
}

// ── Sidebar icon button ────────────────────────────────────────────────────────
function SideIconBtn({ active, onClick, label, icon }: { active:boolean; onClick:()=>void; label:string; icon:React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="w-full flex flex-col items-center justify-center rounded-xl py-2.5 transition-all duration-150"
      style={{
        background: active ? '#252c3a' : hov ? '#1b1f28' : 'transparent',
        color:      active ? '#60a5fa' : hov ? '#9ca3af' : '#4b5563',
        border:     active ? '1px solid #3b4f6b' : '1px solid transparent',
        minHeight: 52,
      }}
    >
      {icon}
      <span className="text-[8px] font-bold tracking-widest uppercase mt-1">{label}</span>
    </button>
  );
}
