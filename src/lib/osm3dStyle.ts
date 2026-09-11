// ============================================================
//  3D ("Tier 1") MapLibre style — the flat OSM aeroway data lifted into
//  extruded geometry, over the pre-baked satellite ground image.
//
//  No new dependencies and no new source data: building heights are derived
//  in-style from `aeroway` + the OSM `name` tag via a data-driven expression,
//  so this works for every airport we already ship.
// ============================================================
import { SATELLITE_BOUNDS } from './satelliteBounds';

// Heights in metres. OSM gives us no `height`/`building:levels` for any of our
// six airports, so these are category + name estimates. Swap this expression
// for ['get','height'] the day we re-query Overpass with those tags.
const nameHas = (s: string) => ['!=', ['index-of', s, ['coalesce', ['get', 'name'], '']], -1] as any;

const BUILDING_HEIGHT: any = [
  'case',
  ['==', ['get', 'aeroway'], 'hangar'], 24,
  nameHas('Main Hall'), 26,
  nameHas('Control'), 55,
  nameHas('Tower'), 55,
  nameHas('International'), 21,
  nameHas('Boarding Area'), 13,
  nameHas('Concourse'), 13,
  nameHas('Terminal'), 17,
  15,
];

// Jetways/piers sit lower than the halls they hang off — gives the roofline
// some variation instead of one flat slab.
const BUILDING_BASE: any = ['case', nameHas('Boarding Area'), 0, 0];

export function build3DStyle(icao: string) {
  const src = `/maps/osm/${icao}.geojson`;
  const b = SATELLITE_BOUNDS[icao];

  const imageSource = (url: string, minLng: number, minLat: number, maxLng: number, maxLat: number) => ({
    type: 'image' as const,
    url,
    coordinates: [
      [minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat],
    ] as [number, number][],
  });

  const satSource = b
    ? imageSource(`/maps/satellite/${icao}.jpg`, b.minLng, b.minLat, b.maxLng, b.maxLat)
    : { type: 'raster' as const, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 };
  const wideSource = b ? imageSource(`/maps/satellite/${icao}_wide.jpg`, b.wideMinLng, b.wideMinLat, b.wideMaxLng, b.wideMaxLat) : null;

  return {
    version: 8 as const,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    // Sun position drives the extrusion shading — low-ish angle reads as 3D.
    light: { anchor: 'viewport' as const, position: [1.4, 210, 42] as [number, number, number], intensity: 0.42 },
    // MapLibre 5: sky is a root-level property, not a layer.
    sky: {
      'sky-color': '#0d1b2e', 'horizon-color': '#1c3252', 'fog-color': '#0a1220',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.05,
    },
    sources: {
      ...(wideSource ? { satWide: wideSource } : {}),
      sat: satSource,
      osm: { type: 'geojson' as const, data: src },
      // Live aircraft footprints, refreshed by Ground3DView each frame.
      acft: { type: 'geojson' as const, data: { type: 'FeatureCollection', features: [] } as any },
    },
    layers: [
      // No opaque background layer here — it would paint over the sky above the
      // horizon once the camera is pitched.
      ...(wideSource ? [{ id: 'sat-wide', type: 'raster' as const, source: 'satWide', paint: { 'raster-opacity': 1 } }] : []),
      { id: 'sat', type: 'raster' as const, source: 'sat', paint: { 'raster-opacity': 1, 'raster-contrast': 0.04 } },

      // ── ground markings: kept thin so the satellite pavement reads through
      { id: 'runway-cl', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'runway'] as any, paint: { 'line-color': 'rgba(255,255,255,.85)', 'line-width': 1.4, 'line-dasharray': [4, 6] } },
      { id: 'taxiway-cl', type: 'line' as const, source: 'osm', minzoom: 13, filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, paint: { 'line-color': 'rgba(250,205,70,.75)', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1.2, 18, 2] as any } },

      // ── extruded buildings
      {
        id: 'terminal-3d', type: 'fill-extrusion' as const, source: 'osm',
        filter: ['all', ['==', ['get', 'aeroway'], 'terminal'], ['==', ['geometry-type'], 'Polygon']] as any,
        paint: {
          // taller halls read lighter, so the massing is legible from above
          'fill-extrusion-color': ['interpolate', ['linear'], BUILDING_HEIGHT, 12, '#334d6a', 18, '#3f5a7c', 26, '#4d6b8e'] as any,
          'fill-extrusion-height': BUILDING_HEIGHT,
          'fill-extrusion-base': BUILDING_BASE,
          'fill-extrusion-opacity': 0.97,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'hangar-3d', type: 'fill-extrusion' as const, source: 'osm',
        filter: ['all', ['==', ['get', 'aeroway'], 'hangar'], ['==', ['geometry-type'], 'Polygon']] as any,
        paint: { 'fill-extrusion-color': '#2c4059', 'fill-extrusion-height': BUILDING_HEIGHT, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.97, 'fill-extrusion-vertical-gradient': true },
      },

      // ── aircraft as real 3D bodies (base = altitude, so they fly)
      {
        id: 'acft-3d', type: 'fill-extrusion' as const, source: 'acft',
        paint: {
          'fill-extrusion-color': ['get', 'color'] as any,
          'fill-extrusion-height': ['get', 'top'] as any,
          'fill-extrusion-base': ['get', 'base'] as any,
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      },

      // ── labels
      {
        id: 'runway-label', type: 'symbol' as const, source: 'osm', minzoom: 12,
        filter: ['==', ['get', 'aeroway'], 'runway'] as any,
        layout: { 'symbol-placement': 'line-center' as const, 'text-field': ['get', 'ref'] as any, 'text-size': 12, 'text-font': ['Open Sans Bold', 'Open Sans Regular'], 'text-letter-spacing': 0.12, 'text-rotation-alignment': 'viewport' as const },
        paint: { 'text-color': 'rgba(225,238,255,.95)', 'text-halo-color': '#04060c', 'text-halo-width': 1.6 },
      },
    ],
  };
}
