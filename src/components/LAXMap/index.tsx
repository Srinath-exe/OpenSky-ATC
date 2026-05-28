'use client';
import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ============================================================
//  KLAX EXPERIMENT — Hybrid OSM + X-Plane Map
//
//  Styled exactly after the "Image 2" reference (OSM Carto style):
//   - Beige/tan terminal buildings
//   - White jetways with red-dashed borders
//   - Clean, light background
//   - X-Plane geo data for aprons and taxiway lines
// ============================================================

const BASE = '/maps/lax_experiment';

const SOURCES: Record<string, any> = {
  osmTerminals:  { type: 'geojson', data: `${BASE}/osm_terminals.geojson` },
  osmGates:      { type: 'geojson', data: `${BASE}/osm_gates.geojson` },
  osmJetbridges: { type: 'geojson', data: `${BASE}/osm_jetbridges.geojson` },
  xpAprons:      { type: 'geojson', data: `${BASE}/xp_pavement_aprons.geojson` },
  xpTaxiways:    { type: 'geojson', data: `${BASE}/xp_pavement_taxiways.geojson` },
  xpRunways:     { type: 'geojson', data: `${BASE}/xp_runways.geojson` },
  xpEdges:       { type: 'geojson', data: `${BASE}/xp_lines_edges.geojson` },
  xpCenterlines: { type: 'geojson', data: `${BASE}/xp_lines_centerlines.geojson` },
  xpSigns:       { type: 'geojson', data: `${BASE}/xp_signs.geojson` },
};

// ── Palette (Image 2 Match) ────────────────────────────────────────────────
const C = {
  bg:             '#f2efe9',  // light beige background
  apron:          '#e9e5dc',  // very subtle apron difference
  taxiway:        '#e0dcd3',  // slightly darker for taxiways
  terminalFill:   '#d4c3b3',  // tan/beige terminal (like Image 2)
  terminalStroke: '#c4b19e',  // darker tan border
  jetwayFill:     '#ffffff',  // white jetway interior
  jetwayStroke:   '#e57373',  // red/pink dashed border
  runway:         '#555555',  // dark grey runway
  yellowLine:     '#fbbc04',  // x-plane lines
  textGray:       '#5c5c5c',  // gate label text
};

const LAYERS: any[] = [
  // 1. Background
  { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

  // 2. X-Plane Aprons & Taxiways (Subtle)
  { id: 'xp-apron', type: 'fill', source: 'xpAprons', paint: { 'fill-color': C.apron, 'fill-opacity': 1 } },
  { id: 'xp-taxiway', type: 'fill', source: 'xpTaxiways', paint: { 'fill-color': C.taxiway, 'fill-opacity': 1 } },
  { id: 'xp-taxiway-outline', type: 'line', source: 'xpTaxiways', paint: { 'line-color': '#d2cec6', 'line-width': 1 } },

  // 3. X-Plane Runways
  { id: 'xp-runway', type: 'line', source: 'xpRunways', layout: { 'line-cap': 'butt' }, 
    paint: { 'line-color': C.runway, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 8, 15, 24, 18, 100] } },

  // 4. X-Plane Lines
  { id: 'xp-edges', type: 'line', source: 'xpEdges', paint: { 'line-color': C.yellowLine, 'line-width': 1.5, 'line-opacity': 0.6 } },
  { id: 'xp-centerlines', type: 'line', source: 'xpCenterlines', paint: { 'line-color': C.yellowLine, 'line-width': 1.2, 'line-opacity': 0.8 } },

  // 5. OSM Terminal Buildings (Beige/Tan)
  {
    id: 'osm-terminal-fill',
    type: 'fill',
    source: 'osmTerminals',
    paint: {
      'fill-color': C.terminalFill,
      'fill-opacity': 1.0,
    },
  },
  {
    id: 'osm-terminal-outline',
    type: 'line',
    source: 'osmTerminals',
    paint: {
      'line-color': C.terminalStroke,
      'line-width': 1.5,
    },
  },

  // 6. Jetbridges (White body with Red Dashed Borders like Image 2)
  // We use 3 layers to achieve the red-dashed borders on a white polygon look
  {
    id: 'osm-jetway-base',
    type: 'line',
    source: 'osmJetbridges',
    layout: { 'line-cap': 'square' },
    paint: {
      'line-color': C.jetwayFill, // White base
      'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 16, 5, 17, 8, 18, 12],
    },
  },
  {
    id: 'osm-jetway-border-left',
    type: 'line',
    source: 'osmJetbridges',
    layout: { 'line-cap': 'butt' },
    paint: {
      'line-color': C.jetwayStroke,
      'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 18, 1.5],
      'line-dasharray': [3, 2],
      'line-offset': ['interpolate', ['linear'], ['zoom'], 15, -1.5, 16, -2.5, 17, -4, 18, -6],
    },
  },
  {
    id: 'osm-jetway-border-right',
    type: 'line',
    source: 'osmJetbridges',
    layout: { 'line-cap': 'butt' },
    paint: {
      'line-color': C.jetwayStroke,
      'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 18, 1.5],
      'line-dasharray': [3, 2],
      'line-offset': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 16, 2.5, 17, 4, 18, 6],
    },
  },

  // 7. Gate Labels (No dots, just small grey text at the end of the jetway)
  {
    id: 'osm-gates-label',
    type: 'symbol',
    source: 'osmGates',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 17, 11, 18, 13],
      'text-offset': [0, 0],
      'text-anchor': 'center',
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': C.textGray,
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
    },
  },

  // 8. Terminal Labels (e.g., "Terminal 1" in grey)
  {
    id: 'osm-terminal-label',
    type: 'symbol',
    source: 'osmTerminals',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 14,
      'text-anchor': 'center',
    },
    paint: {
      'text-color': '#737373',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1,
    },
  },
];

export default function LAXMap() {
  const mapEl  = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    try {
      const m = new maplibregl.Map({
        container: mapEl.current,
        style: {
          version: 8,
          glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
          sources: SOURCES,
          layers: LAYERS,
        } as any,
        center: [-118.4081, 33.9416], // KLAX Center
        zoom: 15, // Zoomed in to see gates
        minZoom: 12,
        maxZoom: 19,
        attributionControl: false,
      });

      m.on('error', (e) => console.error('[MapLibre Error]', e));
      m.on('load', () => console.log('[MapLibre] Map loaded successfully!'));

      m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');

      mapRef.current = m;
    } catch (err: any) {
      console.error(err);
      setInitError(err.message || String(err));
    }
    
    return () => { 
      if (mapRef.current) {
        mapRef.current.remove(); 
        mapRef.current = null; 
      }
    };
  }, []);

  return (
    <div className="w-full h-screen flex relative bg-[#f2efe9]">
      {initError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-8 bg-white/80">
          <div className="bg-red-50 text-red-600 p-6 rounded-xl border border-red-200 max-w-lg">
            <h2 className="font-bold text-lg mb-2">Map Initialization Error</h2>
            <pre className="text-sm whitespace-pre-wrap">{initError}</pre>
          </div>
        </div>
      )}
      <div ref={mapEl} className="absolute inset-0" />
      
      {/* Small UI Overlay to match "experiment" vibe */}
      <div className="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur-md p-4 rounded-xl shadow-lg border border-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <h1 className="text-lg font-bold text-slate-800">KLAX Hybrid Map</h1>
        <p className="text-xs text-slate-500 mt-1">OSM Terminal/Jetways + X-Plane Pavement</p>
        
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-sm border" style={{ background: C.terminalFill, borderColor: C.terminalStroke }} />
            <span className="text-xs font-medium text-slate-700">OSM Terminal</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 flex flex-col justify-between overflow-hidden">
              <div className="h-0.5 w-full bg-red-400" />
              <div className="h-2 w-full bg-white" />
              <div className="h-0.5 w-full bg-red-400" />
            </div>
            <span className="text-xs font-medium text-slate-700">OSM Jetways (Synthesized geometry)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-1 bg-yellow-400" />
            <span className="text-xs font-medium text-slate-700">X-Plane Lines</span>
          </div>
        </div>
      </div>
    </div>
  );
}
