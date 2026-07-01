'use client';
import { useEffect, useRef, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import { useGroundTraffic } from '@/context/GroundTrafficContext';
import type { SimAircraft } from '@/lib/aircraft';

// ── Aircraft SVG by type (wingspan scaled) ────────────────────────────────
function aircraftSVG(type: string, color: string, size: number): string {
  const s = size;
  const half = s / 2;
  return `
    <svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${half}" cy="${half}" r="${half - 1}" fill="none" stroke="#000000" stroke-width="1.5" opacity="0.5"/>
      <path d="M${half} ${half - half*0.8} C${half + half*0.15} ${half - half*0.2}, ${half + half*0.15} ${half}, ${half + half*0.12} ${half + half*0.3} L${half + half*0.12} ${half + half*0.6} L${half - half*0.12} ${half + half*0.6} L${half - half*0.12} ${half + half*0.3} C${half - half*0.15} ${half}, ${half - half*0.15} ${half - half*0.2}, ${half} ${half - half*0.8} Z" fill="${color}"/>
      <path d="M${half} ${half + half*0.1} L${half - half*0.5} ${half + half*0.35} L${half - half*0.35} ${half + half*0.5} L${half} ${half + half*0.25} L${half + half*0.35} ${half + half*0.5} L${half + half*0.5} ${half + half*0.35} Z" fill="${color}" opacity="0.8"/>
      <circle cx="${half}" cy="${half - half*0.55}" r="${half*0.08}" fill="#ffffff" opacity="0.6"/>
    </svg>
  `;
}

function aircraftSize(type: string): number {
  if (type === 'A388') return 36;
  if (type === 'B77W') return 30;
  if (['A320', 'B738', 'A321'].includes(type)) return 22;
  return 14;
}

function stateLabelShort(state: string): string {
  switch (state) {
    case 'PARKED': return 'PARK';
    case 'PUSHBACK_OUT': return 'PUSH';
    case 'PUSHBACK_COMPLETE': return 'READY';
    case 'TAXIING': return 'TAXI';
    case 'TAXIING_TO_GATE': return 'TAXI';
    case 'HOLDING': return 'HOLD';
    case 'RUNWAY_ENTRY': return 'ENT';
    case 'LINE_UP': return 'LINE';
    case 'TAKEOFF_ROLL': return 'ROLL';
    case 'ROTATE': return 'ROT';
    case 'AIRBORNE_CLIMB': return 'CLIMB';
    case 'HANDED_OFF': return 'OFF';
    case 'ARRIVING_RUNWAY': return 'LAND';
    case 'LANDED': return 'LDG';
    case 'ARRIVED_GATE': return 'ARR';
    case 'DEPARTING': return 'DEP';
    default: return state.slice(0, 4);
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'PARKED': return '#6b7280';
    case 'PUSHBACK_OUT': return '#3b82f6';
    case 'PUSHBACK_COMPLETE': return '#60a5fa';
    case 'TAXIING':
    case 'TAXIING_TO_GATE': return '#22c55e';
    case 'HOLDING': return '#eab308';
    case 'RUNWAY_ENTRY': return '#f97316';
    case 'LINE_UP': return '#a855f7';
    case 'TAKEOFF_ROLL':
    case 'ROTATE':
    case 'AIRBORNE_CLIMB': return '#ef4444';
    case 'HANDED_OFF': return '#4b5563';
    case 'ARRIVING_RUNWAY':
    case 'LANDED': return '#a855f7';
    case 'ARRIVED_GATE': return '#10b981';
    default: return '#6b7280';
  }
}

// ── Main Overlay ──────────────────────────────────────────────────────────
interface AircraftOverlayProps {
  map: maplibregl.Map;
}

interface MarkerBundle {
  marker: maplibregl.Marker;
  iconEl: HTMLDivElement;     // the rotating icon
  labelEl: HTMLDivElement;    // the datablock
  lastState?: string;
  lastColor?: string;
  lastType?: string;
}

export default function AircraftOverlay({ map }: AircraftOverlayProps) {
  const { state, dispatch } = useGroundTraffic();
  const markersRef = useRef<Map<string, MarkerBundle>>(new Map());

  // Update / create markers when aircrafts change
  useEffect(() => {
    const markers = markersRef.current;
    const activeIds = new Set<string>();

    for (const ac of state.aircrafts.values()) {
      activeIds.add(ac.id);
      let bundle = markers.get(ac.id);

      if (!bundle) {
        // Create new marker: a wrapper containing icon + label
        const size = aircraftSize(ac.aircraftType);
        const wrapper = document.createElement('div');
        wrapper.style.position = 'relative';
        wrapper.style.width = `${size}px`;
        wrapper.style.height = `${size}px`;
        wrapper.style.cursor = 'pointer';

        const iconEl = document.createElement('div');
        iconEl.style.position = 'absolute';
        iconEl.style.inset = '0';
        iconEl.style.display = 'flex';
        iconEl.style.alignItems = 'center';
        iconEl.style.justifyContent = 'center';
        iconEl.style.transition = 'transform 0.12s linear';
        iconEl.innerHTML = aircraftSVG(ac.aircraftType, ac.color, size);

        const labelEl = document.createElement('div');
        labelEl.style.position = 'absolute';
        labelEl.style.left = '50%';
        labelEl.style.top = '100%';
        labelEl.style.transform = 'translateX(-50%)';
        labelEl.style.marginTop = '2px';
        labelEl.style.background = 'rgba(6,10,20,0.85)';
        labelEl.style.color = '#e2e8f0';
        labelEl.style.font = '9px monospace';
        labelEl.style.padding = '1px 4px';
        labelEl.style.borderRadius = '3px';
        labelEl.style.whiteSpace = 'nowrap';
        labelEl.style.pointerEvents = 'none';
        labelEl.style.border = '1px solid rgba(100,116,139,0.6)';
        labelEl.style.textAlign = 'center';

        wrapper.appendChild(iconEl);
        wrapper.appendChild(labelEl);

        const marker = new maplibregl.Marker({ element: wrapper, anchor: 'center' });
        marker.setLngLat([ac.position.lng, ac.position.lat]);
        marker.addTo(map);

        wrapper.addEventListener('click', (e) => {
          e.stopPropagation();
          dispatch({ type: 'SELECT', id: ac.id });
        });

        bundle = { marker, iconEl, labelEl };
        markers.set(ac.id, bundle);
      }

      // Update position (MapLibre handles the marker move)
      bundle.marker.setLngLat([ac.position.lng, ac.position.lat]);

      // Rotate the icon smoothly via CSS transition (don't rebuild SVG)
      const heading = ac.heading - 90; // SVG points right by default
      bundle.iconEl.style.transform = `rotate(${heading}deg)`;

      // Refresh icon only if type or color changed
      if (bundle.lastType !== ac.aircraftType || bundle.lastColor !== ac.color) {
        const size = aircraftSize(ac.aircraftType);
        bundle.iconEl.innerHTML = aircraftSVG(ac.aircraftType, ac.color, size);
        bundle.lastType = ac.aircraftType;
        bundle.lastColor = ac.color;
      }

      // Update label / datablock
      if (bundle.lastState !== ac.state) {
        const col = stateColor(ac.state);
        const stLbl = stateLabelShort(ac.state);
        const speedKt = Math.round(ac.speed * 1.94384);
        const altPart = ac.altitude > 0 ? `${Math.round(ac.altitude)}` : `${speedKt}`;
        bundle.labelEl.innerHTML = `<span style="color:${col}">●</span> ${ac.callsign}<br/><span style="color:#9ca3af">${stLbl} ${altPart}</span>`;
        bundle.lastState = ac.state;
      } else {
        // Update just speed/alt numbers without recreating the whole label
        const speedKt = Math.round(ac.speed * 1.94384);
        const altPart = ac.altitude > 0 ? `${Math.round(ac.altitude)}` : `${speedKt}`;
        const col = stateColor(ac.state);
        const stLbl = stateLabelShort(ac.state);
        bundle.labelEl.innerHTML = `<span style="color:${col}">●</span> ${ac.callsign}<br/><span style="color:#9ca3af">${stLbl} ${altPart}</span>`;
      }

      // Selection ring
      const wrapper = bundle.marker.getElement();
      wrapper.style.filter = state.selectedId === ac.id ? 'drop-shadow(0 0 6px #ffffff)' : 'none';
    }

    // Remove markers for despawned aircraft
    for (const [id, bundle] of markers) {
      if (!activeIds.has(id)) {
        bundle.marker.remove();
        markers.delete(id);
      }
    }
  }, [state.aircrafts, state.selectedId, map, dispatch]);

  // Render route line for selected aircraft
  const routeGeoJSON = useMemo(() => {
    if (!state.selectedId) return null;
    const ac = state.aircrafts.get(state.selectedId);
    if (!ac || !ac.route) return null;
    const coords = ac.route.path.map(seg => [seg.fromNode.position.lng, seg.fromNode.position.lat]);
    const last = ac.route.path[ac.route.path.length - 1];
    if (last) coords.push([last.toNode.position.lng, last.toNode.position.lat]);
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: coords },
    };
  }, [state.selectedId, state.aircrafts]);

  useEffect(() => {
    if (!routeGeoJSON) {
      if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'none');
      return;
    }
    if (!map.getSource('route-source')) {
      map.addSource('route-source', { type: 'geojson', data: routeGeoJSON });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route-source',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#facc15',
          'line-width': 2.5,
          'line-dasharray': [4, 3],
          'line-opacity': 0.9,
        },
      });
    } else {
      (map.getSource('route-source') as maplibregl.GeoJSONSource).setData(routeGeoJSON);
      map.setLayoutProperty('route-line', 'visibility', 'visible');
    }
    return () => {
      if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'none');
    };
  }, [routeGeoJSON, map]);

  // Click on map (not on marker) deselects
  useEffect(() => {
    const onClick = () => dispatch({ type: 'SELECT', id: null });
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [map, dispatch]);

  return null;
}