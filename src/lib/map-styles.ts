import { StyleSpecification } from 'maplibre-gl';

const SOURCES = {
  runways: { type: 'geojson' as const, data: '/maps/geojson/sfo_runways.geojson', tolerance: 0.5 },
  taxiways: { type: 'geojson' as const, data: '/maps/geojson/sfo_taxiways.geojson', tolerance: 1.5 },
  pushbacks: { type: 'geojson' as const, data: '/maps/geojson/sfo_pushbacks.geojson', tolerance: 2 },
  gates: { type: 'geojson' as const, data: '/maps/geojson/sfo_gates.geojson', tolerance: 1 },
  spots: { type: 'geojson' as const, data: '/maps/geojson/sfo_spots.geojson', tolerance: 1 },
};

// Helper to build layers with given colors
function buildLayers(
  bg: string,
  runwayColor: string,
  runwayCenter: string,
  taxiwayColor: string,
  taxiwayCenter: string,
  pushbackColor: string,
  gateColor: string,
  spotColor: string,
  labelColor: string,
  labelHalo: string
) {
  return [
    { id: 'bg', type: 'background' as const, paint: { 'background-color': bg } },
    {
      id: 'runway-pavement', type: 'line' as const, source: 'runways',
      paint: {
        'line-color': runwayColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 5, 14, 8, 15, 12, 16, 20, 17, 32, 18, 50],
      },
    },
    {
      id: 'runway-center', type: 'line' as const, source: 'runways',
      paint: {
        'line-color': runwayCenter,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 1.5, 17, 2, 18, 2.5],
        'line-dasharray': [12, 10],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'taxiway-pavement', type: 'line' as const, source: 'taxiways',
      paint: {
        'line-color': taxiwayColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 14, 3.5, 15, 5, 16, 8, 17, 13, 18, 20],
      },
    },
    {
      id: 'taxiway-center', type: 'line' as const, source: 'taxiways',
      paint: {
        'line-color': taxiwayCenter,
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 15, 0.8, 16, 1, 17, 1.2, 18, 1.5],
        'line-dasharray': [4, 5],
        'line-opacity': 0.5,
      },
    },
    {
      id: 'pushback', type: 'line' as const, source: 'pushbacks',
      paint: {
        'line-color': pushbackColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 15, 1, 16, 1.5, 17, 2, 18, 2.5],
        'line-dasharray': [3, 3],
        'line-opacity': 0.5,
      },
    },
    {
      id: 'spots-circle', type: 'circle' as const, source: 'spots',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3, 15, 4, 16, 5, 17, 6, 18, 7],
        'circle-color': spotColor,
        'circle-stroke-color': labelHalo,
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
        'text-color': spotColor,
        'text-halo-color': labelHalo,
        'text-halo-width': 2,
      },
    },
    {
      id: 'gates-circle', type: 'circle' as const, source: 'gates',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 14, 4, 15, 5, 16, 6, 17, 7, 18, 8],
        'circle-color': gateColor,
        'circle-stroke-color': labelHalo,
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
        'text-color': labelColor,
        'text-halo-color': labelHalo,
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
        'text-color': labelColor,
        'text-halo-color': labelHalo,
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
        'text-color': labelColor,
        'text-halo-color': labelHalo,
        'text-halo-width': 2,
      },
    },
  ];
}

export interface MapStyle {
  id: string;
  name: string;
  description: string;
  style: StyleSpecification;
}

export const STYLES: MapStyle[] = [
  {
    id: 'dark',
    name: 'Dark Aeronautical',
    description: 'Default dark theme with ASSET2 colors',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#090f1a', '#475569', '#e2e8f0', '#1e3a2f', '#fde047', '#334155', '#f472b6', '#fbbf24', '#fde047', '#000'),
    } as any,
  },
  {
    id: 'icao',
    name: 'ICAO Standard',
    description: 'Official ICAO chart colors',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#1e3a5f', '#5c7a99', '#ffffff', '#1a472a', '#4ade80', '#334155', '#e11d48', '#f59e0b', '#fbbf24', '#0f172a'),
    } as any,
  },
  {
    id: 'jeppesen',
    name: 'Jeppesen Chart',
    description: 'Classic paper chart style',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#f5f0e6', '#d4c5a9', '#8b7355', '#c8d6af', '#5a7d3a', '#a0a0a0', '#c41e3a', '#d97706', '#1a1a1a', '#f5f0e6'),
    } as any,
  },
  {
    id: 'night',
    name: 'Night Ops',
    description: 'Black background for night operations',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#050505', '#2d3748', '#a0aec0', '#065f46', '#34d399', '#1f2937', '#ec4899', '#fbbf24', '#fbbf24', '#000'),
    } as any,
  },
  {
    id: 'neon',
    name: 'Neon Cyber',
    description: 'High contrast cyberpunk style',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#0a0a1a', '#7c3aed', '#c4b5fd', '#059669', '#a7f3d0', '#475569', '#f43f5e', '#22d3ee', '#22d3ee', '#000'),
    } as any,
  },
  {
    id: 'military',
    name: 'Tactical Military',
    description: 'Olive drab military display',
    style: {
      version: 8,
      sources: SOURCES,
      layers: buildLayers('#1a1f16', '#4a5d23', '#8fbc8f', '#2f4f2f', '#9acd32', '#3d4035', '#ff4500', '#ffd700', '#adff2f', '#1a1f16'),
    } as any,
  },
];
