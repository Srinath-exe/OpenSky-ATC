'use client';
import React, { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ============================================================
//  HiFi Multi-Airport Map — Dark Aeronautical Theme
//  Unified with /lax visual style: dark background, crisp layers.
// ============================================================

export interface AirportConfig {
  icao: string;
  name: string;
  center: [number, number];
  elevation: string;
  runways_info: string[];
  sources: Record<string, any>;
  layers: any[];
  demoPlanes: AircraftMarker[];
}

interface AircraftMarker {
  callsign: string;
  lng: number;
  lat: number;
  heading: number;
  color: string;
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

// ── Unified dark color palette (same as /lax) ──────────────────────────────
const C = {
  bg:        '#111827',
  boundary:  '#1f2937',
  apron:     '#374151',
  taxiway:   '#4b5563',
  runway:    '#0b0f19',
  runwayAsphalt: '#2c3038',
  runwayShoulder: '#1e2125',
  yellow:    '#facc15',
  holdRed:   '#ef4444',
  white:     '#f9fafb',
  signText:  '#facc15',
  gateBlue:  '#60a5fa',
  gateGrey:  '#9ca3af',
  panelBg:   '#1f2937',
  panelText: '#e5e7eb',
  terminal:  '#2d3748',
  jetbridge: '#3d5a80',
  jetbridgeAccent: '#718096',
};

function buildLayers(): any[] {
  return [
    // Background
    { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

    // Boundary
    {
      id: 'boundary-fill',
      type: 'fill',
      source: 'boundary',
      paint: { 'fill-color': C.boundary, 'fill-opacity': 1 },
    },

    // Aprons & Taxiways
    {
      id: 'apron-fill',
      type: 'fill',
      source: 'aprons',
      paint: { 'fill-color': C.apron, 'fill-opacity': 1 },
    },
    {
      id: 'taxiway-fill',
      type: 'fill',
      source: 'taxiways',
      paint: { 'fill-color': C.taxiway, 'fill-opacity': 1 },
    },

    // Terminal buildings
    {
      id: 'terminal-fill',
      type: 'fill',
      source: 'terminals',
      paint: { 'fill-color': C.terminal, 'fill-opacity': 0.92 },
    },
    {
      id: 'terminal-outline',
      type: 'line',
      source: 'terminals',
      layout: { 'line-join': 'miter', 'line-cap': 'butt' },
      paint: {
        'line-color': '#1a202c',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 1.2, 16, 1.8, 18, 2.5],
        'line-opacity': 0.85,
      },
    },

    // Taxiway lines
    {
      id: 'taxiway-edges',
      type: 'line',
      source: 'edges',
      filter: ['in', 'YELLOW', ['get', 'painted_line_type']],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': C.yellow,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 1, 16, 1.5, 18, 2.5],
      },
    },
    {
      id: 'taxiway-centerlines',
      type: 'line',
      source: 'centerlines',
      filter: ['!', ['in', 'ILS', ['get', 'painted_line_type']]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': C.yellow,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 0.8, 16, 1.2, 18, 2],
        'line-opacity': 0.8,
      },
    },

    // Runways
    {
      id: 'runway-shoulder',
      type: 'line',
      source: 'runways',
      layout: { 'line-cap': 'butt', 'line-join': 'miter' },
      paint: {
        'line-color': C.runwayShoulder,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          11, 4, 12, 6, 13, 11, 14, 18, 15, 30, 16, 50, 17, 80, 18, 128],
      },
    },
    {
      id: 'runway-pavement',
      type: 'line',
      source: 'runways',
      layout: { 'line-cap': 'butt', 'line-join': 'miter' },
      paint: {
        'line-color': C.runwayAsphalt,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          11, 3, 12, 4.5, 13, 8, 14, 14, 15, 22, 16, 38, 17, 60, 18, 96],
      },
    },
    {
      id: 'runway-edge-left',
      type: 'line',
      source: 'runways',
      minzoom: 13,
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': C.white,
        'line-width': 1.5,
        'line-offset': ['interpolate', ['linear'], ['zoom'],
          13, 4, 14, 6.5, 15, 10.5, 16, 17.5, 17, 28, 18, 45],
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
        'line-color': C.white,
        'line-width': 1.5,
        'line-offset': ['interpolate', ['linear'], ['zoom'],
          13, -4, 14, -6.5, 15, -10.5, 16, -17.5, 17, -28, 18, -45],
        'line-opacity': 0.95,
      },
    },
    {
      id: 'runway-centerline',
      type: 'line',
      source: 'runways',
      minzoom: 13,
      paint: {
        'line-color': C.white,
        'line-width': 1.5,
        'line-dasharray': [10, 7],
        'line-opacity': 0.90,
      },
    },

    // Markings
    {
      id: 'markings-white',
      type: 'line',
      source: 'otherLines',
      filter: ['any',
        ['==', ['get', 'painted_line_type'], 'SOLID_WHITE'],
        ['==', ['get', 'painted_line_type'], 'WIDE_SOLID_WHITE'],
      ],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': C.white,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1, 18, 1.5],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'markings-red',
      type: 'line',
      source: 'otherLines',
      filter: ['==', ['get', 'painted_line_type'], 'SOLID_RED'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': C.holdRed,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 16, 1.2, 18, 2],
        'line-opacity': 0.9,
      },
    },

    // Hold-short bars
    {
      id: 'hold-lines',
      type: 'line',
      source: 'holds',
      minzoom: 12,
      layout: { 'line-cap': 'square' },
      paint: {
        'line-color': C.holdRed,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 14, 2, 16, 3, 18, 5],
      },
    },

    // Jetbridges
    {
      id: 'jetbridge-line',
      type: 'line',
      source: 'jetbridges',
      minzoom: 14,
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': C.jetbridge,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          14, 2.0, 15, 2.8, 16, 3.8, 17, 5.0, 18, 6.5],
        'line-opacity': 0.9,
      },
    },
    {
      id: 'jetbridge-stripe',
      type: 'line',
      source: 'jetbridges',
      minzoom: 15,
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': C.jetbridgeAccent,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          15, 0.8, 16, 1.2, 17, 1.8, 18, 2.4],
        'line-opacity': 0.7,
      },
    },

    // Windsocks
    {
      id: 'windsock-dot',
      type: 'circle',
      source: 'windsocks',
      minzoom: 13,
      paint: {
        'circle-radius': 3,
        'circle-color': '#f97316',
        'circle-stroke-color': C.white,
        'circle-stroke-width': 1.5,
      },
    },

    // Gates
    {
      id: 'gates-circle',
      type: 'circle',
      source: 'gates',
      minzoom: 13,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 15, 3.5, 17, 5, 18, 7],
        'circle-color': [
          'match', ['get', 'location_type'],
          'gate',     C.gateBlue,
          'tie_down', C.gateGrey,
          C.gateGrey,
        ],
        'circle-stroke-color': C.bg,
        'circle-stroke-width': 1,
      },
    },

    // Labels
    {
      id: 'gates-label',
      type: 'symbol',
      source: 'gates',
      minzoom: 17,
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 18, 14],
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': C.signText,
        'text-halo-color': '#000000',
        'text-halo-width': 2,
      },
    },
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
        'text-color': '#e2e8f0',
        'text-halo-color': '#2d3748',
        'text-halo-width': 1.5,
      },
    },
  ];
}

function makePlaneSVG(color: string, heading: number) {
  return `
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"
      style="transform: rotate(${heading - 90}deg); transform-origin: center;"
    >
      <circle cx="14" cy="14" r="13" fill="none" stroke="#000000" stroke-width="2.5" opacity="0.6"/>
      <path d="M14 3 C15 8, 15 10, 15 14 L15 22 L13 22 L13 14 C13 10, 13 8, 14 3 Z" fill="${color}"/>
      <path d="M14 12 L6 18 L8 20 L14 14 L20 20 L22 18 L14 12 Z" fill="${color}"/>
      <path d="M12 20 L11 25 L14 24 L17 25 L16 20 Z" fill="${color}"/>
      <circle cx="14" cy="4" r="1.5" fill="#ffffff" opacity="0.5"/>
    </svg>
  `;
}

function getLastWord(name: string) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  return parts[parts.length - 1];
}

function buildAirportConfig(
  icao: string,
  name: string,
  center: [number, number],
  elevation: string,
  runways_info: string[],
  demoPlanes: AircraftMarker[]
): AirportConfig {
  return {
    icao,
    name,
    center,
    elevation,
    runways_info,
    sources: buildSources(icao),
    layers: buildLayers(),
    demoPlanes,
  };
}

const TOP_AIRPORTS: AirportConfig[] = [
  buildAirportConfig('KSFO', 'San Francisco Intl',   [-122.37895905, 37.62175045], '13 FT',  ['10L/28R', '10R/28L', '01L/19R', '01R/19L'], []),
  buildAirportConfig('KJFK', 'New York JFK',          [-73.7781,       40.6413],    '13 FT',  ['04L/22R', '04R/22L', '13L/31R', '13R/31L'], []),
  buildAirportConfig('KLAX', 'Los Angeles Intl',      [-118.4081,      33.9416],    '128 FT', ['06L/24R', '06R/24L', '07L/25R', '07R/25L'], []),
  buildAirportConfig('KBOS', 'Boston Logan',          [-71.0052,       42.3656],    '20 FT',  ['04L/22R', '04R/22L', '09/27',   '15R/33L', '14/32'], []),
  buildAirportConfig('VIDP', 'Delhi Indira Gandhi',   [77.1006,        28.5562],    '777 FT', ['09L/27R', '09R/27L', '10/28',   '11/29'], []),
  buildAirportConfig('EGKK', 'London Gatwick',        [-0.1876,        51.1516],    '202 FT', ['08L/26R', '08R/26L'], []),
];

// Layer groups for toggling
const LAYER_GROUPS: Record<string, string[]> = {
  taxiways:   ['taxiway-fill', 'taxiway-edges', 'taxiway-centerlines', 'apron-fill'],
  terminals:  ['terminal-fill', 'terminal-outline', 'terminal-label'],
  runways:    ['runway-shoulder', 'runway-pavement', 'runway-centerline', 'runway-edge-left', 'runway-edge-right'],
  edges:      ['markings-white', 'markings-red', 'hold-lines'],
  jetbridges: ['jetbridge-line', 'jetbridge-stripe'],
  gates:      ['gates-circle', 'gates-label'],
  signs:      ['windsock-dot'],
};

// ============================================================
//  MAIN COMPONENT
// ============================================================
export default function HiFiMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const planeMarkers = useRef<maplibregl.Marker[]>([]);

  const [activeIndex,       setActiveIndex]       = useState(0);
  const [zoom,              setZoom]              = useState(14);
  const [ready,             setReady]             = useState(false);
  const [loadStatus,        setLoadStatus]        = useState('Initializing...');
  const [errorMsg,          setErrorMsg]          = useState<string | null>(null);
  const [activeTab,         setActiveTab]         = useState<'airports' | 'charts' | 'layers'>('airports');
  const [chartMode,         setChartMode]         = useState<'HIGH IFR' | 'LOW IFR' | 'VFR'>('HIGH IFR');
  const [selectedGate,      setSelectedGate]      = useState<any | null>(null);

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

  // ── Helpers ──────────────────────────────────────────────────────────────
  function clearPlaneMarkers() {
    planeMarkers.current.forEach((mk) => mk.remove());
    planeMarkers.current = [];
  }

  function addPlaneMarkers(m: maplibregl.Map, planes: AircraftMarker[]) {
    clearPlaneMarkers();
    planes.forEach((plane) => {
      const el = document.createElement('div');
      el.style.width = '28px';
      el.style.height = '28px';
      el.innerHTML = makePlaneSVG(plane.color, plane.heading);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([plane.lng, plane.lat])
        .addTo(m);
      planeMarkers.current.push(marker);
    });
  }

  function loadDynamicLabels(m: maplibregl.Map, icao: string) {
    const base = `/maps/xplane/${icao}/combined`;

    // Remove previous dynamic layers FIRST (before their sources)
    ['runway-label-start', 'runway-label-end', 'taxiway-labels-layer'].forEach((lid) => {
      if (m.getLayer(lid)) m.removeLayer(lid);
    });
    // Then remove the sources
    ['runway-labels-start', 'runway-labels-end', 'taxiway-labels'].forEach((sid) => {
      if (m.getSource(sid)) m.removeSource(sid);
    });

    // Runway threshold labels
    fetch(`${base}/runways.geojson`)
      .then((r) => r.json())
      .then((data: any) => {
        const starts: any[] = [];
        const ends: any[] = [];
        data.features.forEach((f: any) => {
          const coords = f.geometry.coordinates;
          if (!coords || coords.length < 2) return;
          starts.push({ type: 'Feature', properties: { label: f.properties.name_1 }, geometry: { type: 'Point', coordinates: coords[0] } });
          ends.push({ type: 'Feature', properties: { label: f.properties.name_2 }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } });
        });
        m.addSource('runway-labels-start', { type: 'geojson', data: { type: 'FeatureCollection', features: starts } });
        m.addSource('runway-labels-end',   { type: 'geojson', data: { type: 'FeatureCollection', features: ends } });
        m.addLayer({
          id: 'runway-label-start', type: 'symbol', source: 'runway-labels-start', minzoom: 13,
          layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': true },
          paint: { 'text-color': C.white, 'text-halo-color': C.runway, 'text-halo-width': 2 },
        });
        m.addLayer({
          id: 'runway-label-end', type: 'symbol', source: 'runway-labels-end', minzoom: 13,
          layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': true },
          paint: { 'text-color': C.white, 'text-halo-color': C.runway, 'text-halo-width': 2 },
        });
      })
      .catch((err) => console.error('Failed runway labels:', err));

    // Taxiway name labels from signs
    fetch(`${base}/signs.geojson`)
      .then((r) => r.json())
      .then((data: any) => {
        const taxiwaySigns = data.features.filter((f: any) => {
          const label = f.properties?.label || '';
          return /^[A-Z]([0-9]?[A-Z]?)?$/.test(label) && label.length <= 3;
        });
        if (taxiwaySigns.length > 0) {
          m.addSource('taxiway-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: taxiwaySigns } });
          m.addLayer({
            id: 'taxiway-labels-layer', type: 'symbol', source: 'taxiway-labels', minzoom: 13,
            layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': false },
            paint: { 'text-color': C.signText, 'text-halo-color': '#000000', 'text-halo-width': 3 },
          });
        }
      })
      .catch((err) => console.error('Failed taxiway labels:', err));
  }

  function setupGateInteractions(m: maplibregl.Map) {
    m.on('click', (e) => {
      const features = m.queryRenderedFeatures(e.point, { layers: ['gates-circle'] });
      if (features && features.length > 0) {
        const f = features[0];
        setSelectedGate({
          name: f.properties.name,
          type: f.properties.location_type,
          heading: f.properties.heading,
          width: f.properties.width_code,
          airlines: f.properties.airline_codes,
          operation: f.properties.operation_type,
          airplaneTypes: f.properties.airplane_types,
          coords: (f.geometry as any).coordinates,
        });
      } else {
        setSelectedGate(null);
      }
    });

    m.on('mousemove', (e) => {
      const features = m.queryRenderedFeatures(e.point, { layers: ['gates-circle'] });
      m.getCanvas().style.cursor = features.length ? 'pointer' : '';
    });
  }

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

    m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    m.on('zoom',  () => setZoom(Math.round(m.getZoom() * 10) / 10));

    m.on('load',  () => {
      setReady(true);
      setLoadStatus('Chart Ready');
      setTimeout(() => m.resize(), 50);
      addPlaneMarkers(m, active.demoPlanes);
      loadDynamicLabels(m, active.icao);
      setupGateInteractions(m);
    });

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
    return () => { clearTimeout(forceTimer); clearPlaneMarkers(); m.remove(); mapRef.current = null; };
  }, []);

  // ── Switch airport ────────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !m.loaded()) return;

    setReady(false);
    setSelectedGate(null);
    setLoadStatus(`Loading ${active.icao}...`);

    Object.keys(active.sources).forEach(id => {
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src && 'setData' in src) (src as any).setData(active.sources[id].data);
    });

    m.flyTo({ center: active.center, zoom: 14, speed: 1.2 });

    const t = setTimeout(() => {
      setReady(true);
      setLoadStatus('Chart Ready');
      addPlaneMarkers(m, active.demoPlanes);
      loadDynamicLabels(m, active.icao);
    }, 800);

    return () => clearTimeout(t);
  }, [active]);

  // ── Toggle layers ─────────────────────────────────────────────────────────
  const toggleLayer = (key: keyof typeof layersVis) => {
    const m = mapRef.current;
    if (!m) return;
    const newVal = !layersVis[key];
    setLayersVis(prev => ({ ...prev, [key]: newVal }));
    (LAYER_GROUPS[key] || []).forEach(id => {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', newVal ? 'visible' : 'none');
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-screen flex overflow-hidden select-none" style={{ fontFamily: "'Inter', system-ui, sans-serif", background: C.bg }}>

      {/* ═════════════════════════════════════════════════════════════════════
          ICON BAR — far-left dark sidebar
          ═════════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 flex flex-col items-center py-4 justify-between z-30" style={{ width: 62, background: '#13161c', borderRight: '1px solid #242830' }}>
        <div className="flex flex-col gap-0.5 items-center w-full">
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

        <SideIconBtn active={false} onClick={()=>{}} label="Settings" icon={
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        }/>
      </div>

      {/* ═════════════════════════════════════════════════════════════════════
          CONSOLE PANEL
          ═════════════════════════════════════════════════════════════════════ */}
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
                { key:'taxiways',   label:'Taxiway Pavements',    swatch:'#4b5563', icon:'▪' },
                { key:'terminals',  label:'Terminal Buildings',    swatch:'#2d3748', icon:'■' },
                { key:'runways',    label:'Runway Assets',         swatch:'#2c3038', icon:'▬' },
                { key:'edges',      label:'Edge & Guidance Lines', swatch:'#facc15', icon:'—' },
                { key:'jetbridges', label:'Jetbridges',            swatch:'#3d5a80', icon:'╌' },
                { key:'gates',      label:'Parking Stands',        swatch:'#60a5fa', icon:'●' },
                { key:'signs',      label:'Taxiway Signs',         swatch:'#f97316', icon:'■' },
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
            <span style={{color:'#4b5563'}}>Aero Charts</span>
            <span style={{color:'#374151'}}>v1.0</span>
          </div>
          <p className="text-[8px] font-mono text-center mt-1" style={{ color:'#cc3300', borderTop:'1px solid #2b303b', paddingTop:4, marginTop:4, letterSpacing:'0.05em' }}>
            NOT FOR REAL-WORLD NAVIGATION
          </p>
        </div>
      </div>

      {/* ═════════════════════════════════════════════════════════════════════
          MAIN MAP AREA
          ═════════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 relative overflow-hidden" style={{ background: C.bg }}>

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
        <div ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {/* Loading overlay — DARK themed */}
        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20" style={{ background: C.bg }}>
            <div className="relative mb-5">
              <div className="w-16 h-16 rounded-full" style={{ border:'3px solid #374151', borderTopColor:'#f5c800', animation:'spin 1s linear infinite' }}/>
              <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black font-mono" style={{ color:'#f5c800' }}>{active.icao}</div>
            </div>
            <div className="text-sm font-semibold" style={{ color:'#d1d5db' }}>Loading Chart</div>
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

        {/* Gate info panel */}
        {selectedGate && (
          <div className="absolute top-20 left-4 z-40 w-64 rounded-lg border border-gray-700 shadow-xl overflow-hidden" style={{ background: C.panelBg }}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <h3 className="font-bold text-base" style={{ color: C.panelText }}>
                {getLastWord(selectedGate.name)}
              </h3>
              <button
                onClick={() => setSelectedGate(null)}
                className="text-gray-400 hover:text-white text-lg leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="px-4 py-3 space-y-2 text-sm" style={{ color: C.panelText }}>
              <div className="flex justify-between">
                <span className="text-gray-400">Type</span>
                <span className="capitalize">{selectedGate.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Heading</span>
                <span>{Math.round(selectedGate.heading)}&deg;</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Width</span>
                <span>{selectedGate.width || 'N/A'}</span>
              </div>
              {selectedGate.airlines && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Airlines</span>
                  <span className="uppercase">{selectedGate.airlines}</span>
                </div>
              )}
              {selectedGate.airplaneTypes && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Aircraft</span>
                  <span className="capitalize">{selectedGate.airplaneTypes.replace(/\|/g, ', ')}</span>
                </div>
              )}
              {selectedGate.operation && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Operation</span>
                  <span className="capitalize">{selectedGate.operation}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Watermark */}
        <div className="absolute bottom-8 right-4 z-10 text-right pointer-events-none">
          <div className="text-[10px] font-semibold" style={{ color:'#6b7280' }}>© Aero Charts | X-Plane Data</div>
          <div className="text-[9px] font-mono mt-0.5" style={{ color:'#cc3300' }}>NOT FOR NAVIGATIONAL USE</div>
        </div>

        {/* Legend — dark themed, matching /lax */}
        <div className="absolute bottom-10 left-4 z-10 rounded-xl p-3 space-y-1.5" style={{ background:'rgba(19,22,28,.88)', backdropFilter:'blur(8px)', border:'1px solid rgba(43,48,59,.8)' }}>
          <p className="text-[8px] font-black tracking-widest uppercase mb-2" style={{ color:'#4b5563' }}>Legend</p>
          {[
            { color:'#60a5fa', label:'Passenger Gate' },
            { color:'#9ca3af', label:'Cargo / Tie-down' },
            { color:'#4b5563', label:'Taxiway Pavement' },
            { color:'#374151', label:'Apron / Ramp' },
            { color:'#facc15', label:'Taxiway Lines' },
            { color:'#ef4444', label:'Hold Short' },
            { color:'#2d3748', label:'Terminal Buildings' },
            { color:'#3d5a80', label:'Jetbridges' },
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
