'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import RadarCanvasOverlay from '@/components/RadarCanvasOverlay';
import AircraftPopup from '@/components/AircraftPopup';
import GroundTrafficPanel from '@/components/GroundTrafficPanel';
import { useGroundTraffic } from '@/context/GroundTrafficContext';
import { useSimLoop } from '@/hooks/useSimLoop';
import { buildTaxiGraph, loadAirportBundle, planRoute, findNearestNode, findNearestGate, type TaxiGraph, type RouteEndpoint } from '@/lib/airportData';
import { spawnAircraft, commandTaxiTo, commandTaxiToGate, commandTakeoff, commandLineUp, grantClearance, transitionState, emptyRouteProgress, type SimAircraft } from '@/lib/aircraft';
import { startDeparture, startArrival, pickFreeGate, resetScheduler } from '@/lib/autoScheduler';
import type { GeoPosition } from '@/lib/geoUtils';

const ICAO = 'KLAX';
const BASE = `/maps/xplane/${ICAO}/combined`;
const AIRPORT_CENTER: GeoPosition = { lat: 33.9416, lng: -118.4081 };

const SOURCES: Record<string, any> = {
  boundary:    { type: 'geojson', data: `${BASE}/boundary.geojson` },
  aprons:      { type: 'geojson', data: `${BASE}/pavement_aprons.geojson` },
  taxiways:    { type: 'geojson', data: `${BASE}/pavement_taxiways.geojson` },
  runways:     { type: 'geojson', data: `${BASE}/runways.geojson` },
  holds:       { type: 'geojson', data: `${BASE}/lines_holds.geojson` },
  centerlines: { type: 'geojson', data: `${BASE}/lines_centerlines.geojson` },
  edges:       { type: 'geojson', data: `${BASE}/lines_edges.geojson` },
  otherLines:  { type: 'geojson', data: `${BASE}/lines_other.geojson` },
  gates:       { type: 'geojson', data: `${BASE}/startup_locations.geojson` },
  windsocks:   { type: 'geojson', data: `${BASE}/windsocks.geojson` },
};

const C = {
  bg: '#111827', boundary: '#1f2937', apron: '#374151', taxiway: '#4b5563',
  runway: '#0b0f19', yellow: '#facc15', holdRed: '#ef4444', white: '#f9fafb',
  signText: '#facc15', gateBlue: '#60a5fa', gateGrey: '#9ca3af',
  panelBg: '#1f2937', panelText: '#e5e7eb',
};

const LAYERS: any[] = [
  { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
  { id: 'boundary-fill', type: 'fill', source: 'boundary', paint: { 'fill-color': C.boundary, 'fill-opacity': 1 } },
  { id: 'apron-fill', type: 'fill', source: 'aprons', paint: { 'fill-color': C.apron, 'fill-opacity': 1 } },
  { id: 'taxiway-fill', type: 'fill', source: 'taxiways', paint: { 'fill-color': C.taxiway, 'fill-opacity': 1 } },
  { id: 'taxiway-edges', type: 'line', source: 'edges', filter: ['in', 'YELLOW', ['get', 'painted_line_type']], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.yellow, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 1, 16, 1.5, 18, 2.5] } },
  { id: 'taxiway-centerlines', type: 'line', source: 'centerlines', filter: ['!', ['in', 'ILS', ['get', 'painted_line_type']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.yellow, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 0.8, 16, 1.2, 18, 2], 'line-opacity': 0.8 } },
  { id: 'runway-shoulder', type: 'line', source: 'runways', layout: { 'line-cap': 'butt', 'line-join': 'miter' }, paint: { 'line-color': '#1e2125', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 12, 6, 13, 11, 14, 18, 15, 30, 16, 50, 17, 80, 18, 128] } },
  { id: 'runway-pavement', type: 'line', source: 'runways', layout: { 'line-cap': 'butt', 'line-join': 'miter' }, paint: { 'line-color': '#2c3038', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 12, 4.5, 13, 8, 14, 14, 15, 22, 16, 38, 17, 60, 18, 96] } },
  { id: 'runway-edge-left', type: 'line', source: 'runways', minzoom: 13, layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-offset': ['interpolate', ['linear'], ['zoom'], 13, 4, 14, 6.5, 15, 10.5, 16, 17.5, 17, 28, 18, 45], 'line-opacity': 0.95 } },
  { id: 'runway-edge-right', type: 'line', source: 'runways', minzoom: 13, layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-offset': ['interpolate', ['linear'], ['zoom'], 13, -4, 14, -6.5, 15, -10.5, 16, -17.5, 17, -28, 18, -45], 'line-opacity': 0.95 } },
  { id: 'runway-centerline', type: 'line', source: 'runways', minzoom: 13, paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [10, 7], 'line-opacity': 0.90 } },
  { id: 'markings-white', type: 'line', source: 'otherLines', filter: ['any', ['==', ['get', 'painted_line_type'], 'SOLID_WHITE'], ['==', ['get', 'painted_line_type'], 'WIDE_SOLID_WHITE']], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.white, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1, 18, 1.5], 'line-opacity': 0.8 } },
  { id: 'markings-red', type: 'line', source: 'otherLines', filter: ['==', ['get', 'painted_line_type'], 'SOLID_RED'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.holdRed, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 16, 1.2, 18, 2], 'line-opacity': 0.9 } },
  { id: 'hold-lines', type: 'line', source: 'holds', minzoom: 12, layout: { 'line-cap': 'square' }, paint: { 'line-color': C.holdRed, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 14, 2, 16, 3, 18, 5] } },
  { id: 'windsock-dot', type: 'circle', source: 'windsocks', minzoom: 13, paint: { 'circle-radius': 3, 'circle-color': '#f97316', 'circle-stroke-color': C.white, 'circle-stroke-width': 1.5 } },
  { id: 'gates-circle', type: 'circle', source: 'gates', minzoom: 13, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 15, 3.5, 17, 5, 18, 7], 'circle-color': ['match', ['get', 'location_type'], 'gate', C.gateBlue, 'tie_down', C.gateGrey, C.gateGrey], 'circle-stroke-color': C.bg, 'circle-stroke-width': 1 } },
  { id: 'gates-label', type: 'symbol', source: 'gates', minzoom: 17, layout: { 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 18, 14], 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-allow-overlap': false }, paint: { 'text-color': C.signText, 'text-halo-color': '#000000', 'text-halo-width': 2 } },
];

const AIRCRAFT_TYPES = ['B738', 'A320', 'B77W', 'A388'];
const AIRLINES = ['AAL', 'UAL', 'DAL', 'BAW', 'UAE', 'JBU', 'QTR', 'AIC', 'DLH', 'SWA'];

function getLastWord(name: string) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  return parts[parts.length - 1];
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

let flightNumCounter = 100;
function nextFlightNumber(): number {
  return ++flightNumCounter;
}

export default function LAXMap() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [selectedGate, setSelectedGate] = useState<any | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [trafficStarted, setTrafficStarted] = useState(false);
  const [graphReady, setGraphReady] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);

  const { state, dispatch } = useGroundTraffic();
  useSimLoop();

  // ── Map init ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    try {
      const m = new maplibregl.Map({
        container: mapEl.current,
        style: { version: 8, sources: SOURCES, layers: LAYERS } as any,
        center: [AIRPORT_CENTER.lng, AIRPORT_CENTER.lat], zoom: 14, minZoom: 11, maxZoom: 19,
        pitch: 0, bearing: 0, attributionControl: false,
      });
      m.on('error', (e: any) => console.error('[MapLibre]', e.error || e));
      m.on('load', () => {
        setTimeout(() => m.resize(), 100);
        setIsReady(true);
        fetch(`${BASE}/runways.geojson`).then(r => r.json()).then((data: any) => {
          const starts: any[] = [], ends: any[] = [];
          data.features.forEach((f: any) => {
            const c = f.geometry.coordinates;
            if (!c || c.length < 2) return;
            starts.push({ type: 'Feature', properties: { label: f.properties.name_1 }, geometry: { type: 'Point', coordinates: c[0] } });
            ends.push({ type: 'Feature', properties: { label: f.properties.name_2 }, geometry: { type: 'Point', coordinates: c[c.length - 1] } });
          });
          m.addSource('runway-labels-start', { type: 'geojson', data: { type: 'FeatureCollection', features: starts } });
          m.addSource('runway-labels-end', { type: 'geojson', data: { type: 'FeatureCollection', features: ends } });
          m.addLayer({ id: 'runway-label-start', type: 'symbol', source: 'runway-labels-start', minzoom: 13, layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': true }, paint: { 'text-color': C.white, 'text-halo-color': C.runway, 'text-halo-width': 2 } });
          m.addLayer({ id: 'runway-label-end', type: 'symbol', source: 'runway-labels-end', minzoom: 13, layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': true }, paint: { 'text-color': C.white, 'text-halo-color': C.runway, 'text-halo-width': 2 } });
        }).catch(console.error);
        fetch(`${BASE}/signs.geojson`).then(r => r.json()).then((data: any) => {
          const signs = data.features.filter((f: any) => { const l = f.properties?.label || ''; return /^[A-Z]([0-9]?[A-Z]?)?$/.test(l) && l.length <= 3; });
          if (signs.length) {
            m.addSource('taxiway-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: signs } });
            m.addLayer({ id: 'taxiway-labels-layer', type: 'symbol', source: 'taxiway-labels', minzoom: 13, layout: { 'text-field': ['get', 'label'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 15, 13, 18, 17], 'text-allow-overlap': false }, paint: { 'text-color': C.signText, 'text-halo-color': '#000000', 'text-halo-width': 3 } });
          }
        }).catch(console.error);
      });
      m.on('click', (e) => {
        const features = m.queryRenderedFeatures(e.point, { layers: ['gates-circle'] });
        if (features && features.length > 0) {
          const f = features[0];
          setSelectedGate({ name: f.properties.name, type: f.properties.location_type, heading: f.properties.heading, width: f.properties.width_code, airlines: f.properties.airline_codes, operation: f.properties.operation_type, coords: (f.geometry as any).coordinates });
        } else {
          setSelectedGate(null);
        }
      });
      m.on('mousemove', (e) => { m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point, { layers: ['gates-circle'] }).length ? 'pointer' : ''; });
      m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
      mapRef.current = m;
    } catch (err: any) { console.error(err); setInitError(err.message || String(err)); }
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  // ── Build the taxi graph (once, when map is ready) ────────────────
  const ensureGraph = useCallback(async () => {
    if (graphReady || loadingGraph) return;
    setLoadingGraph(true);
    try {
      const bundle = await loadAirportBundle(ICAO, BASE);
      const graph = buildTaxiGraph(bundle, AIRPORT_CENTER, ICAO);
      dispatch({ type: 'SET_GRAPH', graph });
      setGraphReady(true);
    } catch (err: any) {
      console.error('Graph build failed:', err);
      setInitError(`Graph build failed: ${err.message}`);
    } finally {
      setLoadingGraph(false);
    }
  }, [graphReady, loadingGraph, dispatch]);

  useEffect(() => {
    if (isReady) ensureGraph();
  }, [isReady, ensureGraph]);

  // ── Start Ground Traffic — spawn departures + arrivals ───────────
  const startTraffic = useCallback(async () => {
    if (trafficStarted) return;
    if (!graphReady || !state.taxiGraph) {
      await ensureGraph();
    }
    const graph = state.taxiGraph;
    if (!graph) return;
    setTrafficStarted(true);
    resetScheduler();

    const gateFeatures = Array.from(graph.gates.values()).filter(g => g.type === 'gate');
    const shuffled = [...gateFeatures].sort(() => Math.random() - 0.5);
    const selectedGates = shuffled.slice(0, Math.min(12, shuffled.length));
    const activeRunways = Array.from(graph.runways.values()).filter(rw => rw.runway.includes('/'));
    if (!activeRunways.length) return;
    const depRunway = activeRunways[0].name1; // e.g. "06L"
    const arrRunway = activeRunways[0].name2; // e.g. "24R"

    // Spawn departures at gates
    selectedGates.forEach((gate, i) => {
      const type = randomPick(AIRCRAFT_TYPES);
      const airline = randomPick(AIRLINES);
      const num = nextFlightNumber();
      const callsign = `${airline}${num}`;
      const ac = spawnAircraft({
        callsign,
        aircraftType: type,
        airlineCode: airline,
        position: gate.position,
        heading: gate.heading,
        assignedGate: gate.name,
        runwayOperation: 'departure',
        flightPlan: { operation: 'departure', originGate: gate.name, runway: depRunway, callsign },
      });
      dispatch({ type: 'SPAWN', aircraft: ac });
      // Stagger pushback start
      startDeparture(ac, graph, depRunway, 1500 + i * 4000);
    });

    // Schedule a few arrivals — spawn them at the arrival runway threshold
    for (let i = 0; i < 4; i++) {
      const type = randomPick(AIRCRAFT_TYPES);
      const airline = randomPick(AIRLINES);
      const num = nextFlightNumber();
      const callsign = `${airline}${num}`;
      const rw = graph.runways.get(arrRunway) || graph.runways.get(depRunway);
      if (!rw) continue;
      // Spawn at the arrival threshold
      const threshold = arrRunway === rw.name1 ? rw.threshold1 : rw.threshold2;
      const heading = rw.heading1to2;
      const occupiedGates = new Set(Array.from(state.aircrafts.values()).map(a => a.assignedGate || ''));
      const freeGate = pickFreeGate(graph, occupiedGates);
      if (!freeGate) continue;
      const ac = spawnAircraft({
        callsign,
        aircraftType: type,
        airlineCode: airline,
        position: threshold,
        heading,
        assignedRunway: arrRunway,
        assignedGate: freeGate,
        runwayOperation: 'arrival',
        flightPlan: { operation: 'arrival', destinationGate: freeGate, runway: arrRunway, callsign },
      });
      // Override to landed/arriving state
      const landed: SimAircraft = { ...ac, state: 'ARRIVING_RUNWAY', speed: 30, targetSpeed: 8 };
      dispatch({ type: 'SPAWN', aircraft: landed });
      startArrival(landed, graph, arrRunway, freeGate, 8000 + i * 12000);
    }

    dispatch({ type: 'SET_RUNNING', running: true });
  }, [trafficStarted, graphReady, state.taxiGraph, state.aircrafts, dispatch, ensureGraph]);

  // ── Selected aircraft + manual control ──────────────────────────
  const selectedAircraft = state.selectedId ? state.aircrafts.get(state.selectedId) : null;

  // ── Click on map to set destination taxi route for selected aircraft ──
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      if (!state.selectedId) return;
      const ac = state.aircrafts.get(state.selectedId);
      if (!ac) return;
      const clickedPos: GeoPosition = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const graph = state.taxiGraph;
      if (!graph) return;
      const toNodeId = findNearestNode(clickedPos, graph, 30);
      if (!toNodeId) return;
      const fromNodeId = findNearestNode(ac.position, graph, 40);
      if (!fromNodeId) return;
      const route = planRoute(graph, { type: 'node', id: fromNodeId }, { type: 'node', id: toNodeId });
      if (!route) return;
      const updated = commandTaxiTo(ac, route);
      dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
    };
    m.on('click', onMapClick);
    return () => { m.off('click', onMapClick); };
  }, [state.selectedId, state.aircrafts, state.taxiGraph, dispatch]);

  // ── Manual command buttons (issued from AircraftPopup) ──────────
  const issueCommand = useCallback((cmd: CommandBtn) => {
    if (!state.selectedId) return;
    const ac = state.aircrafts.get(state.selectedId);
    const graph = state.taxiGraph;
    if (!ac || !graph) return;
    switch (cmd.kind) {
      case 'pushback': {
        const updated = transitionState({ ...ac, clearances: { ...ac.clearances, pushback: true } }, 'PUSHBACK_OUT');
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        startDeparture(ac, graph, ac.assignedRunway || pickAnyRunway(graph), 0);
        break;
      }
      case 'taxi_runway': {
        const rw = cmd.runway || ac.assignedRunway || pickAnyRunway(graph);
        const fromId = findNearestNode(ac.position, graph, 40);
        if (!fromId || !rw) return;
        const route = planRoute(graph, { type: 'node', id: fromId }, { type: 'runway', id: rw, operation: 'departure' });
        if (!route) return;
        const updated = commandTaxiTo(ac, route, rw);
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        break;
      }
      case 'taxi_gate': {
        const gate = cmd.gate || findNearestGate(ac.position, graph, 1000)?.name;
        if (!gate) return;
        const fromId = findNearestNode(ac.position, graph, 40);
        if (!fromId) return;
        const route = planRoute(graph, { type: 'node', id: fromId }, { type: 'gate', id: gate });
        if (!route) return;
        const updated = commandTaxiToGate(ac, route, gate);
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        break;
      }
      case 'line_up': {
        const updated = commandLineUp(ac);
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        break;
      }
      case 'takeoff': {
        const rw = ac.assignedRunway || cmd.runway || pickAnyRunway(graph);
        const updated = commandTakeoff(ac, rw || '');
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        break;
      }
      case 'hold': {
        const updated = { ...ac, targetSpeed: 0, clearances: { ...ac.clearances, holdShort: ac.routeProgress.holdingAt || 'manual' } };
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: updated });
        break;
      }
      case 'continue': {
        const updated = grantClearance(ac, 'holdShort', ac.routeProgress.holdingAt || '');
        const resumed = { ...updated, routeProgress: { ...updated.routeProgress, holdingAt: null }, clearances: { ...updated.clearances, holdShort: null } };
        dispatch({ type: 'UPDATE_SINGLE', id: ac.id, aircraft: resumed });
        break;
      }
      case 'despawn': {
        dispatch({ type: 'DESPAWN', id: ac.id });
        break;
      }
    }
  }, [state.selectedId, state.aircrafts, state.taxiGraph, dispatch]);

  return (
    <div className="w-full h-screen relative" style={{ background: C.bg }}>
      {initError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-8">
          <div className="bg-red-900/80 text-red-200 p-6 rounded-xl border border-red-700 max-w-lg">
            <h2 className="font-bold text-lg mb-2">Map Error</h2>
            <pre className="text-sm whitespace-pre-wrap">{initError}</pre>
          </div>
        </div>
      )}

      <div ref={mapEl} className="absolute inset-0 w-full h-full" />

      {/* Aircraft Overlay */}
      {mapRef.current && <RadarCanvasOverlay map={mapRef.current} />}

      {/* Start Traffic Button */}
      {!trafficStarted && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50">
          <button
            onClick={startTraffic}
            disabled={!graphReady || loadingGraph}
            className="px-8 py-4 rounded-xl font-mono text-lg font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-2xl transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-wait"
          >
            {loadingGraph ? 'Building Taxi Graph...' : graphReady ? '▶ Start Ground Traffic' : 'Loading...'}
          </button>
          <p className="text-center text-gray-400 text-sm mt-2">
            {graphReady ? 'Spawns 12 departures + 4 arrivals' : 'Preparing airport data'}
          </p>
        </div>
      )}

      {/* Aircraft Popup */}
      {selectedAircraft && (
        <AircraftPopup
          aircraft={selectedAircraft}
          onClose={() => dispatch({ type: 'SELECT', id: null })}
          onCommand={issueCommand}
          graph={state.taxiGraph}
        />
      )}

      {/* Ground Traffic Sidebar */}
      <GroundTrafficPanel />

      {/* Speed controls */}
      {trafficStarted && (
        <div className="absolute top-4 right-4 z-40 flex gap-1">
          <button onClick={() => dispatch({ type: 'SET_SPEED', multiplier: 1 })} className={`px-2 py-1 rounded text-xs font-mono ${state.speedMultiplier === 1 ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}>1x</button>
          <button onClick={() => dispatch({ type: 'SET_SPEED', multiplier: 2 })} className={`px-2 py-1 rounded text-xs font-mono ${state.speedMultiplier === 2 ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}>2x</button>
          <button onClick={() => dispatch({ type: 'SET_SPEED', multiplier: 4 })} className={`px-2 py-1 rounded text-xs font-mono ${state.speedMultiplier === 4 ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}>4x</button>
          <button onClick={() => dispatch({ type: 'SET_RUNNING', running: !state.isRunning })} className="px-2 py-1 rounded text-xs font-mono bg-yellow-600 text-white">{state.isRunning ? '⏸' : '▶'}</button>
        </div>
      )}

      {/* Click hint */}
      {selectedAircraft && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-lg bg-blue-600/90 text-white text-sm font-semibold shadow-lg pointer-events-none">
          Click anywhere on a taxiway to set destination
        </div>
      )}

      {/* Gate info panel */}
      {selectedGate && (
        <div className="absolute top-4 left-4 z-40 w-64 rounded-lg border border-gray-700 shadow-xl overflow-hidden" style={{ background: C.panelBg }}>
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h3 className="font-bold text-base" style={{ color: C.panelText }}>{getLastWord(selectedGate.name)}</h3>
            <button onClick={() => setSelectedGate(null)} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
          </div>
          <div className="px-4 py-3 space-y-2 text-sm" style={{ color: C.panelText }}>
            <div className="flex justify-between"><span className="text-gray-400">Type</span><span className="capitalize">{selectedGate.type}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Heading</span><span>{Math.round(selectedGate.heading)}&deg;</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Width</span><span>{selectedGate.width || 'N/A'}</span></div>
            {selectedGate.airlines && <div className="flex justify-between"><span className="text-gray-400">Airlines</span><span className="uppercase">{selectedGate.airlines}</span></div>}
            {selectedGate.operation && <div className="flex justify-between"><span className="text-gray-400">Operation</span><span className="capitalize">{selectedGate.operation}</span></div>}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-30 rounded-md border border-gray-700 px-3 py-2 text-xs space-y-1.5" style={{ background: C.panelBg, color: C.panelText }}>
        <div className="font-semibold mb-1">Legend</div>
        <div className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-full" style={{ background: C.gateBlue }} /><span>Passenger Gate</span></div>
        <div className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-full" style={{ background: C.gateGrey }} /><span>Cargo / Tie-down</span></div>
        <div className="flex items-center gap-2"><span className="inline-block w-4 h-0.5" style={{ background: C.yellow }} /><span>Taxiway Line</span></div>
        <div className="flex items-center gap-2"><span className="inline-block w-4 h-0.5" style={{ background: C.holdRed }} /><span>Hold Short</span></div>
      </div>
    </div>
  );
}

function pickAnyRunway(graph: TaxiGraph): string {
  const rws = Array.from(graph.runways.values()).filter(rw => rw.runway.includes('/'));
  if (!rws.length) return '';
  return Math.random() < 0.5 ? rws[0].name1 : rws[0].name2;
}

export type CommandBtn =
  | { kind: 'pushback' }
  | { kind: 'taxi_runway'; runway?: string }
  | { kind: 'taxi_gate'; gate?: string }
  | { kind: 'line_up' }
  | { kind: 'takeoff'; runway?: string }
  | { kind: 'hold' }
  | { kind: 'continue' }
  | { kind: 'despawn' };