// ============================================================
//  Ground map style (MapLibre) — SKYCONTROL design 01 §5 / A10 / A21.
//
//  Two themes over the same OSM aeroway GeoJSON:
//    • satellite — the pre-baked static image (no tile refetch) pulled toward a
//      monochrome grey-green terrain (raster-saturation -0.55, brightness-max .62,
//      contrast .15) under a dark veil; only hairline pavement outlines remain so
//      the imagery reads through.
//    • chart     — vector "chart" theme: --chart-ground, runways --gnd-runway with a
//      1px --gnd-runway-edge, taxiways --gnd-taxiway, aprons / terminals / hangars
//      as flat blocks, no strokes. Labels are drawn by the overlay canvas (DM Sans),
//      so no glyph server is needed.
//
//  Every colour comes from the design tokens (read once from :root with
//  readMapPalette()); no literal colour appears in this file.
// ============================================================
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from 'maplibre-gl';
import { SATELLITE_BOUNDS } from './satelliteBounds';

export type GroundTheme = 'chart' | 'satellite';

/** Token values the style needs (all resolved from CSS custom properties on :root). */
export interface MapPalette {
  bg0: string;
  chartGround: string;
  chartBlock: string;
  chartBlock2: string;
  chartStreet: string;
  gndRunway: string;
  gndRunwayEdge: string;
  gndTaxiway: string;
  gndApron: string;
  gndTerminal: string;
  limeMarker: string;
  lime50: string;
  w14: string;
  w35: string;
  mapVeil: string;
}

const TOKEN_KEYS: Record<keyof MapPalette, string> = {
  bg0: '--bg-0',
  chartGround: '--chart-ground',
  chartBlock: '--chart-block',
  chartBlock2: '--chart-block-2',
  chartStreet: '--chart-street',
  gndRunway: '--gnd-runway',
  gndRunwayEdge: '--gnd-runway-edge',
  gndTaxiway: '--gnd-taxiway',
  gndApron: '--gnd-apron',
  gndTerminal: '--gnd-terminal',
  limeMarker: '--lime-marker',
  lime50: '--lime-50',
  w14: '--w-14',
  w35: '--w-35',
  mapVeil: '--map-veil',
};

/** Read the palette from the document tokens. Browser only (the map itself is browser only). */
export function readMapPalette(root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null): MapPalette {
  const cs = root ? getComputedStyle(root) : null;
  const out = {} as MapPalette;
  for (const k of Object.keys(TOKEN_KEYS) as Array<keyof MapPalette>) {
    const v = cs ? cs.getPropertyValue(TOKEN_KEYS[k]).trim() : '';
    out[k] = v || 'transparent';
  }
  return out;
}

/** Metres per CSS pixel at zoom 15 for a latitude (Web Mercator, 512px tiles). */
function metresPerPxAtZ15(latDeg: number): number {
  return (2 * Math.PI * 6378137 * Math.cos((latDeg * Math.PI) / 180)) / (512 * 2 ** 15);
}

/** True-scale line width: `metres` wide on the ground at every zoom (exponential base 2 around z15). */
function trueScaleWidth(metres: number, latDeg: number, minPx = 0.5): ExpressionSpecification {
  const pxAt15 = Math.max(minPx, metres / metresPerPxAtZ15(latDeg));
  return ['interpolate', ['exponential', 2], ['zoom'], 7, Math.max(minPx, pxAt15 / 256), 15, pxAt15, 23, pxAt15 * 256];
}

const RUNWAY_WIDTH_M = 46;
const TAXIWAY_WIDTH_M = 23;
const LEAD_IN_WIDTH_M = 6;

const aeroway = (kind: string): ExpressionSpecification => ['==', ['get', 'aeroway'], kind];
const aerowayIn = (kinds: string[]): ExpressionSpecification => ['in', ['get', 'aeroway'], ['literal', kinds]];
const isPolygon: ExpressionSpecification = ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']];
const isLine: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];

/**
 * Build the MapLibre style for one airport.
 * @param icao     airport (data + satellite bounds lookup)
 * @param theme    'satellite' | 'chart'
 * @param palette  token values from readMapPalette()
 * @param latDeg   airport latitude (true-scale pavement widths); defaults to the satellite bounds centre
 */
export function buildOsmStyle(icao: string, theme: GroundTheme, palette: MapPalette, latDeg?: number): StyleSpecification {
  const src = `/maps/osm/${icao}.geojson`;
  const sat = theme === 'satellite';
  const bounds = SATELLITE_BOUNDS[icao];
  const lat = latDeg ?? (bounds ? (bounds.minLat + bounds.maxLat) / 2 : 45);

  const imageSource = (url: string, minLng: number, minLat: number, maxLng: number, maxLat: number) => ({
    type: 'image' as const,
    url,
    coordinates: [[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat]] as [[number, number], [number, number], [number, number], [number, number]],
  });

  const sources: StyleSpecification['sources'] = {
    osm: { type: 'geojson', data: src },
  };
  if (sat && bounds) {
    sources.satWide = imageSource(`/maps/satellite/${icao}_wide.jpg`, bounds.wideMinLng, bounds.wideMinLat, bounds.wideMaxLng, bounds.wideMaxLat);
    sources.sat = imageSource(`/maps/satellite/${icao}.jpg`, bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat);
  }

  // 01 §5: raster-saturation -0.55, raster-brightness-max 0.62, raster-contrast 0.15
  const rasterPaint = { 'raster-opacity': 1, 'raster-saturation': -0.55, 'raster-brightness-max': 0.62, 'raster-brightness-min': 0, 'raster-contrast': 0.15, 'raster-fade-duration': 0 };

  const runwayW = trueScaleWidth(RUNWAY_WIDTH_M, lat, 2);
  const runwayCasingW = trueScaleWidth(RUNWAY_WIDTH_M + 2 * metresPerPxAtZ15(lat), lat, 3);
  const taxiW = trueScaleWidth(TAXIWAY_WIDTH_M, lat, 1);
  const leadInW = trueScaleWidth(LEAD_IN_WIDTH_M, lat, 0.5);

  const layers: LayerSpecification[] = [];
  layers.push({ id: 'bg', type: 'background', paint: { 'background-color': sat ? palette.bg0 : palette.chartGround } });
  if (sat && bounds) {
    layers.push({ id: 'sat-wide', type: 'raster', source: 'satWide', paint: rasterPaint });
    layers.push({ id: 'sat', type: 'raster', source: 'sat', paint: rasterPaint });
  }

  if (!sat) {
    // ── chart theme: flat blocks, no strokes ──
    layers.push({ id: 'apron', type: 'fill', source: 'osm', filter: ['all', aeroway('apron'), isPolygon], paint: { 'fill-color': palette.gndApron, 'fill-opacity': 1 } });
    layers.push({ id: 'hangar', type: 'fill', source: 'osm', filter: ['all', aeroway('hangar'), isPolygon], paint: { 'fill-color': palette.chartBlock2, 'fill-opacity': 1 } });
    layers.push({ id: 'terminal', type: 'fill', source: 'osm', filter: ['all', aeroway('terminal'), isPolygon], paint: { 'fill-color': palette.gndTerminal, 'fill-opacity': 1 } });
    layers.push({ id: 'lead-in', type: 'line', source: 'osm', minzoom: 14, filter: ['all', aeroway('parking_position'), isLine], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': palette.chartBlock2, 'line-width': leadInW, 'line-opacity': 0.9 } });
    layers.push({ id: 'taxiway', type: 'line', source: 'osm', filter: ['all', aeroway('taxiway'), isLine], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': palette.gndTaxiway, 'line-width': taxiW } });
    layers.push({ id: 'runway-casing', type: 'line', source: 'osm', filter: ['all', aeroway('runway'), isLine], layout: { 'line-cap': 'butt' }, paint: { 'line-color': palette.gndRunwayEdge, 'line-width': runwayCasingW } });
    layers.push({ id: 'runway', type: 'line', source: 'osm', filter: ['all', aeroway('runway'), isLine], layout: { 'line-cap': 'butt' }, paint: { 'line-color': palette.gndRunway, 'line-width': runwayW } });
  } else {
    // ── satellite theme: veil + hairline outlines only ──
    layers.push({ id: 'veil', type: 'background', paint: { 'background-color': palette.mapVeil } });
    layers.push({ id: 'terminal-line', type: 'line', source: 'osm', minzoom: 13, filter: ['all', aeroway('terminal'), isPolygon], paint: { 'line-color': palette.w14, 'line-width': 1 } });
    layers.push({ id: 'taxiway-edge', type: 'line', source: 'osm', minzoom: 15, filter: ['all', aeroway('taxiway'), isLine], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': palette.chartStreet, 'line-width': taxiW, 'line-opacity': 0.5 } });
    layers.push({ id: 'runway-casing', type: 'line', source: 'osm', filter: ['all', aeroway('runway'), isLine], layout: { 'line-cap': 'butt' }, paint: { 'line-color': palette.gndRunwayEdge, 'line-width': runwayCasingW, 'line-opacity': 0.9 } });
    layers.push({ id: 'runway', type: 'line', source: 'osm', filter: ['all', aeroway('runway'), isLine], layout: { 'line-cap': 'butt' }, paint: { 'line-color': palette.bg0, 'line-width': runwayW, 'line-opacity': 0.18 } });
  }

  // Shared: taxiway centreline (lime @ .5, never yellow) and runway centreline (white .35 dashed 12 8)
  layers.push({ id: 'taxiway-cl', type: 'line', source: 'osm', minzoom: 13.5, filter: ['all', aeroway('taxiway'), isLine], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': palette.lime50, 'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 0.5, 16, 1, 19, 1.4] } });
  layers.push({ id: 'runway-cl', type: 'line', source: 'osm', minzoom: 13, filter: ['all', aeroway('runway'), isLine], paint: { 'line-color': palette.w35, 'line-width': 1, 'line-dasharray': [12, 8] } });
  // Stand / gate points are drawn by the overlay (occupancy + reserved tint); keep a faint anchor so the base map is not empty at mid zoom.
  layers.push({ id: 'stand-anchor', type: 'circle', source: 'osm', minzoom: 14, maxzoom: 16, filter: aerowayIn(['gate', 'stand', 'parking_position']), paint: { 'circle-radius': 1, 'circle-color': palette.w14, 'circle-opacity': 0.6 } });

  return { version: 8, sources, layers };
}
