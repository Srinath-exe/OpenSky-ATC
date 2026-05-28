'use client';
import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Asset2Airport } from '@/lib/asset2-types';

interface Props {
  airport: Asset2Airport;
}

const SOURCES = {
  runways: { type: 'geojson' as const, data: '/maps/geojson/sfo_runways.geojson', tolerance: 0.5 },
  taxiways: { type: 'geojson' as const, data: '/maps/geojson/sfo_taxiways.geojson', tolerance: 1.5 },
  pushbacks: { type: 'geojson' as const, data: '/maps/geojson/sfo_pushbacks.geojson', tolerance: 2 },
  gates: { type: 'geojson' as const, data: '/maps/geojson/sfo_gates.geojson', tolerance: 1 },
  spots: { type: 'geojson' as const, data: '/maps/geojson/sfo_spots.geojson', tolerance: 1 },
};

const DARK_AERO_LAYERS = [
  { id: 'bg', type: 'background' as const, paint: { 'background-color': '#090f1a' } },
  {
    id: 'taxiway-pavement', type: 'line' as const, source: 'taxiways',
    paint: {
      'line-color': '#475569',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 14, 3.5, 15, 5, 16, 8, 17, 13, 18, 20],
    },
  },
  {
    id: 'taxiway-center', type: 'line' as const, source: 'taxiways',
    paint: {
      'line-color': '#e2e8f0',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 15, 0.8, 16, 1, 17, 1.2, 18, 1.5],
      'line-dasharray': [4, 5],
      'line-opacity': 0.8,
    },
  },
  {
    id: 'pushback', type: 'line' as const, source: 'pushbacks',
    paint: {
      'line-color': '#334155',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 15, 1, 16, 1.5, 17, 2, 18, 2.5],
      'line-dasharray': [3, 3],
      'line-opacity': 0.5,
    },
  },
  {
    id: 'runway-pavement', type: 'line' as const, source: 'runways',
    paint: {
      'line-color': '#334155',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 5, 14, 8, 15, 12, 16, 20, 17, 32, 18, 50],
    },
  },
  {
    id: 'runway-center', type: 'line' as const, source: 'runways',
    paint: {
      'line-color': '#e2e8f0',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 1.5, 17, 2, 18, 2.5],
      'line-dasharray': [12, 10],
      'line-opacity': 0.8,
    },
  },
  {
    id: 'spots-circle', type: 'circle' as const, source: 'spots',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3, 15, 4, 16, 5, 17, 6, 18, 7],
      'circle-color': '#fbbf24',
      'circle-stroke-color': '#000',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.9,
    },
  },
  {
    id: 'spots-label', type: 'symbol' as const, source: 'spots', minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': 10,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#fbbf24',
      'text-halo-color': '#000',
      'text-halo-width': 2,
    },
  },
  {
    id: 'gates-circle', type: 'circle' as const, source: 'gates',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 14, 4, 15, 5, 16, 6, 17, 7, 18, 8],
      'circle-color': '#f472b6',
      'circle-stroke-color': '#000',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.95,
    },
  },
  {
    id: 'gates-label', type: 'symbol' as const, source: 'gates', minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 17, 11, 18, 12],
      'text-offset': [0, -1.2],
      'text-anchor': 'bottom',
    },
    paint: {
      'text-color': '#fde047',
      'text-halo-color': '#000',
      'text-halo-width': 2,
    },
  },
  {
    id: 'taxiway-labels', type: 'symbol' as const, source: 'taxiways', minzoom: 16,
    filter: ['all', ['>', ['get', 'lengthFt'], 250], ['!', ['in', '-b', ['get', 'name']]]],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': 9,
      'symbol-placement': 'line',
      'text-rotation-alignment': 'map',
    },
    paint: {
      'text-color': '#fde047',
      'text-halo-color': '#000',
      'text-halo-width': 2,
    },
  },
  {
    id: 'runway-labels', type: 'symbol' as const, source: 'runways', minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 12, 18, 14],
      'symbol-placement': 'line',
      'text-rotation-alignment': 'map',
    },
    paint: {
      'text-color': '#f8fafc',
      'text-halo-color': '#000',
      'text-halo-width': 2,
    },
  },
];

const PLANE_COLORS: Record<string, string> = {
  C172: '#94a3b8', B738: '#38bdf8', A320: '#818cf8',
  B77W: '#f472b6', A388: '#fbbf24', F18: '#ef4444',
};

interface Aircraft {
  id: string; callsign: string;
  type: 'C172'|'B738'|'A320'|'B77W'|'A388'|'F18';
  lng: number; lat: number; heading: number;
  state: 'parked'|'taxiing'|'holding'|'takeoff';
}

export default function AirportMap({ airport }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [zoom, setZoom] = useState(14);

  useEffect(() => {
    if (!mapContainer.current) return;

    const c = airport.metadata.center;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: { version: 8, sources: SOURCES, layers: DARK_AERO_LAYERS } as any,
      center: [c.lng, c.lat],
      zoom: 14,
      minZoom: 12,
      maxZoom: 18,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    m.on('zoom', () => setZoom(Math.round(m.getZoom() * 10) / 10));

    const aircraftList: Aircraft[] = airport.gates.slice(0, 15).map((g, i) => {
      const types: Aircraft['type'][] = ['B738', 'A320', 'B77W', 'A388', 'C172', 'F18'];
      const cs = ['AIC101','IGO456','UAE201','JBU89','QTR55','BAW142','DLH760','N172SP','VIPER1','AF1','THY45','SEJ112','UAL857','DAL11','ACA730'];
      return {
        id: `p${i+1}`, callsign: cs[i % cs.length], type: types[i % types.length],
        lng: g.lng, lat: g.lat, heading: 180, state: 'parked',
      };
    });

    aircraftList.forEach((plane) => {
      const el = document.createElement('div');
      el.style.width = '28px';
      el.style.height = '28px';
      el.style.position = 'relative';
      const color = PLANE_COLORS[plane.type];
      el.innerHTML = `
        <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;transform:rotate(${plane.heading - 90}deg);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L14 10H20L12 22L4 10H10L12 2Z" fill="${color}" stroke="${color}" stroke-width="1.5"/>
          </svg>
        </div>
        <div style="position:absolute;top:28px;left:50%;transform:translateX(-50%);background:rgba(6,10,20,0.9);color:#e2e8f0;font:9px monospace;padding:1px 4px;border-radius:3px;white-space:nowrap;pointer-events:none;">${plane.callsign}</div>
      `;
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([plane.lng, plane.lat])
        .addTo(m);
      markers.current.push(marker);
    });

    return () => {
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      m.remove();
    };
  }, [airport]);

  return (
    <div className="w-full h-screen flex flex-col">
      <div className="flex items-center gap-3 p-3 border-b border-slate-800 bg-slate-900 z-10">
        <span className="text-sm text-slate-300 font-mono">
          {airport.metadata.icao} — {airport.metadata.name}
        </span>
        <span className="text-xs text-slate-500 font-mono ml-auto">Zoom: {zoom}</span>
      </div>
      <div ref={mapContainer} className="flex-1 w-full relative" />
    </div>
  );
}
