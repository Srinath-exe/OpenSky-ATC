// ============================================================
//  Shared MapLibre style — AirNav Radar look from OSM aeroway data.
//  Dark navy + desaturated satellite + black taxiway/runway ribbons.
//  Used by both the OsmRadar demo and the SkyControl ground view.
// ============================================================
export function buildOsmStyle(icao: string) {
  const src = `/maps/osm/${icao}.geojson`;
  const taxiW      = ['interpolate', ['linear'], ['zoom'], 11, 1.5, 13, 4,   14, 7,    15, 11,   16, 17,   17, 26,   18, 40] as any;
  const taxiCasing = ['interpolate', ['linear'], ['zoom'], 11, 4,   13, 6.5, 14, 9.5,  15, 13.5, 16, 19.5, 17, 28.5, 18, 42.5] as any;
  const rwyW       = ['interpolate', ['linear'], ['zoom'], 11, 4,   13, 11,  14, 19,   15, 32,   16, 52,   17, 80,   18, 124] as any;
  const rwyCasing  = ['interpolate', ['linear'], ['zoom'], 11, 6,   13, 13,  14, 21,   15, 34,   16, 54,   17, 82,   18, 126] as any;

  return {
    version: 8 as const,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      sat: { type: 'raster' as const, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: '© Esri' },
      osm: { type: 'geojson' as const, data: src },
    },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#070d18' } },
      { id: 'sat', type: 'raster' as const, source: 'sat', paint: { 'raster-opacity': 0.46, 'raster-saturation': -0.82, 'raster-brightness-max': 0.4, 'raster-brightness-min': 0.015, 'raster-hue-rotate': 198, 'raster-contrast': 0.06 } },
      { id: 'apron', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'apron'] as any, paint: { 'fill-color': '#0d1726', 'fill-opacity': 0.84 } },
      { id: 'hangar', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'hangar'] as any, paint: { 'fill-color': '#131e30', 'fill-opacity': 0.7 } },
      { id: 'terminal', type: 'fill' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'terminal'] as any, paint: { 'fill-color': '#1a2c47', 'fill-opacity': 0.94 } },
      { id: 'terminal-line', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'terminal'] as any, paint: { 'line-color': '#2a4466', 'line-width': 1 } },
      { id: 'taxiway-casing', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': '#1b2b43', 'line-width': taxiCasing } },
      { id: 'taxiway', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': '#04070e', 'line-width': taxiW } },
      { id: 'taxiway-cl', type: 'line' as const, source: 'osm', minzoom: 13.5, filter: ['==', ['get', 'aeroway'], 'taxiway'] as any, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const }, paint: { 'line-color': 'rgba(240,200,70,0.32)', 'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 0.4, 16, 1, 18, 1.6] as any } },
      // taxiway designator labels (A, B, K …) repeated along each taxiway, in a
      // black "sign" pill like real airport diagrams
      {
        id: 'taxiway-label', type: 'symbol' as const, source: 'osm', minzoom: 13.5,
        // only real taxiway designators (e.g. A, B1, N2E) — hide verbose OSM refs
        // like "Link 11" by requiring a short, space-free code.
        filter: ['all',
          ['==', ['get', 'aeroway'], 'taxiway'],
          ['!=', ['to-string', ['get', 'ref']], ''],
          ['<=', ['length', ['to-string', ['get', 'ref']]], 4],
          ['==', ['index-of', ' ', ['to-string', ['get', 'ref']]], -1],
        ] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'symbol-spacing': 220,
          'text-field': ['get', 'ref'] as any,
          'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 9, 16, 12, 18, 15] as any,
          'text-font': ['Open Sans Bold', 'Open Sans Regular'],
          'text-rotation-alignment': 'viewport' as const,
          'text-keep-upright': true,
        },
        paint: { 'text-color': '#0a0e16', 'text-halo-color': '#f6c43a', 'text-halo-width': 2.2 },
      },
      { id: 'runway-casing', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'runway'] as any, layout: { 'line-cap': 'butt' as const }, paint: { 'line-color': '#21354e', 'line-width': rwyCasing } },
      { id: 'runway', type: 'line' as const, source: 'osm', filter: ['==', ['get', 'aeroway'], 'runway'] as any, layout: { 'line-cap': 'butt' as const }, paint: { 'line-color': '#03050b', 'line-width': rwyW } },
      { id: 'runway-cl', type: 'line' as const, source: 'osm', minzoom: 12.5, filter: ['==', ['get', 'aeroway'], 'runway'] as any, paint: { 'line-color': 'rgba(220,230,245,0.5)', 'line-width': 1, 'line-dasharray': [4, 6] } },
      { id: 'runway-label', type: 'symbol' as const, source: 'osm', minzoom: 12, filter: ['==', ['get', 'aeroway'], 'runway'] as any, layout: { 'symbol-placement': 'line-center' as const, 'text-field': ['get', 'ref'] as any, 'text-size': 11, 'text-font': ['Open Sans Bold', 'Open Sans Regular'], 'text-letter-spacing': 0.1 }, paint: { 'text-color': 'rgba(210,225,245,0.85)', 'text-halo-color': '#04060c', 'text-halo-width': 1.4 } },
      { id: 'gate-dot', type: 'circle' as const, source: 'osm', minzoom: 13, filter: ['in', ['get', 'aeroway'], ['literal', ['gate', 'stand']]] as any, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.2, 16, 2.6, 18, 4.2] as any, 'circle-color': 'rgba(96,160,235,0.6)', 'circle-stroke-color': 'rgba(140,190,255,0.82)', 'circle-stroke-width': 0.6 } },
      { id: 'gate-label', type: 'symbol' as const, source: 'osm', minzoom: 14.5, filter: ['all', ['in', ['get', 'aeroway'], ['literal', ['gate', 'stand']]], ['!=', ['to-string', ['get', 'ref']], '']] as any, layout: { 'text-field': ['get', 'ref'] as any, 'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 7.5, 17, 10.5, 19, 13] as any, 'text-font': ['Open Sans Bold', 'Open Sans Regular'], 'text-offset': [0, 0.85] as any, 'text-anchor': 'top' as const, 'text-allow-overlap': false, 'text-optional': true }, paint: { 'text-color': ['case', ['==', ['get', 'aeroway'], 'gate'], 'rgba(180,210,250,0.95)', 'rgba(150,185,228,0.8)'] as any, 'text-halo-color': 'rgba(4,8,16,0.95)', 'text-halo-width': 1.4 } },
    ],
  };
}

// Shared aircraft silhouette painter (realistic top-down airliner).
// `ctx` is expected to already be translated+rotated to the aircraft; draws at origin.
export function paintAirframe(ctx: CanvasRenderingContext2D, s: number, fill: string, selected: boolean) {
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.8; ctx.lineJoin = 'round'; ctx.fillStyle = fill;
  if (selected) { ctx.shadowColor = 'rgba(251,191,36,0.8)'; ctx.shadowBlur = 12; }
  // wings
  ctx.beginPath();
  ctx.moveTo(s * 0.13, -s * 0.18); ctx.lineTo(s * 1.62, s * 0.70); ctx.lineTo(s * 1.60, s * 0.84);
  ctx.lineTo(s * 0.12, s * 0.40); ctx.lineTo(-s * 0.12, s * 0.40); ctx.lineTo(-s * 1.60, s * 0.84);
  ctx.lineTo(-s * 1.62, s * 0.70); ctx.lineTo(-s * 0.13, -s * 0.18); ctx.closePath(); ctx.fill();
  // tailplane
  ctx.beginPath();
  ctx.moveTo(s * 0.10, s * 1.16); ctx.lineTo(s * 0.66, s * 1.52); ctx.lineTo(s * 0.64, s * 1.62);
  ctx.lineTo(s * 0.08, s * 1.42); ctx.lineTo(-s * 0.08, s * 1.42); ctx.lineTo(-s * 0.64, s * 1.62);
  ctx.lineTo(-s * 0.66, s * 1.52); ctx.lineTo(-s * 0.10, s * 1.16); ctx.closePath(); ctx.fill();
  // fuselage
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.62);
  ctx.bezierCurveTo(s * 0.17, -s * 1.42, s * 0.185, -s * 0.85, s * 0.185, -s * 0.15);
  ctx.lineTo(s * 0.165, s * 0.95);
  ctx.bezierCurveTo(s * 0.15, s * 1.32, s * 0.08, s * 1.55, 0, s * 1.72);
  ctx.bezierCurveTo(-s * 0.08, s * 1.55, -s * 0.15, s * 1.32, -s * 0.165, s * 0.95);
  ctx.lineTo(-s * 0.185, -s * 0.15);
  ctx.bezierCurveTo(-s * 0.185, -s * 0.85, -s * 0.17, -s * 1.42, 0, -s * 1.62);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  // engines
  ctx.fillStyle = selected ? 'rgba(60,40,2,0.92)' : 'rgba(38,26,2,0.9)';
  for (const ex of [s * 0.82, -s * 0.82]) {
    const x = ex - s * 0.11, y = s * 0.16, w = s * 0.22, h = s * 0.5, r = s * 0.08;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
  }
}
