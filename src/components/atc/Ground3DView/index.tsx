'use client';
import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { build3DStyle } from '@/lib/osm3dStyle';
import { getShape } from '@/lib/sim/aircraftShapes';
import { isAirborne } from '@/lib/sim/aircraft';
import { sim, ATC_AIRPORTS } from '../simStore';
import type { AircraftState } from '@/lib/sim/types';

const DEG = Math.PI / 180;
const FT_TO_M = 0.3048;

// Body thickness (metres) by weight class — enough to catch the extrusion light.
const THICKNESS: Record<string, number> = { L: 3, M: 5, H: 7, S: 8 };

// Rotate a shape point (local metres, nose at -y) into world XY offsets.
// World XY is x=east, y=north; heading is compass degrees.
function rotate(lx: number, ly: number, hdg: number): [number, number] {
  const c = Math.cos(hdg * DEG), s = Math.sin(hdg * DEG);
  const e0 = lx, n0 = -ly;           // flip: local "up" (-y) is north
  return [e0 * c + n0 * s, -e0 * s + n0 * c];
}

// Build a GeoJSON FeatureCollection of aircraft footprints, extruded from
// `base` (= current altitude) to `top`, so airborne traffic really flies.
function aircraftFC(selectedId: number | null) {
  const e = sim.engine;
  const features: any[] = [];
  if (!e) return { type: 'FeatureCollection', features };

  for (const a of e.aircraft as AircraftState[]) {
    const shape = getShape(a.perf.icaoCode);
    const air = isAirborne(a);
    const baseM = air ? a.altitude * FT_TO_M : 0;
    const thick = THICKNESS[a.perf.weightClass] ?? 5;
    const isSel = a.id === selectedId;

    for (const part of shape.parts) {
      const ring: [number, number][] = part.pts.map(([lx, ly]) => {
        const [dx, dy] = rotate(lx, ly, a.heading);
        const ll = e.proj.toLngLat(a.pos.x + dx, a.pos.y + dy);
        return [ll.lng, ll.lat];
      });
      ring.push(ring[0]);

      const color = a.conflict ? '#ef4444'
        : isSel ? '#fde68a'
        : part.role === 'engine' ? '#243044'
        : air ? '#9ec9ee' : '#e2b23c';

      features.push({
        type: 'Feature',
        properties: {
          color,
          base: baseM,
          top: baseM + (part.role === 'engine' ? thick * 0.75 : thick),
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export interface Ground3DViewProps {
  pitch?: number;
  bearing?: number;
  /** Keep the camera locked on the selected aircraft. */
  follow?: boolean;
}

export default function Ground3DView({ pitch = 60, bearing = -18, follow = false }: Ground3DViewProps) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const raf = useRef(0);
  const lastIcao = useRef('');
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    if (!mapDiv.current || map.current) return;
    const start = ATC_AIRPORTS[sim.icao] ?? ATC_AIRPORTS.KSFO;
    const m = new maplibregl.Map({
      container: mapDiv.current,
      style: build3DStyle(sim.icao || 'KSFO') as any,
      center: start.center,
      zoom: 14.6,
      pitch, bearing,
      minZoom: 11, maxZoom: 19.5,
      attributionControl: false,
      maxPitch: 78,
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.current = m;
    lastIcao.current = sim.icao;

    // click-to-select against the live aircraft list
    m.on('click', ev => {
      const e = sim.engine; if (!e) return;
      let best: AircraftState | null = null, bd = 26;
      for (const a of e.aircraft) {
        const ll = e.proj.toLngLat(a.pos.x, a.pos.y);
        const p = m.project([ll.lng, ll.lat]);
        const d = Math.hypot(p.x - ev.point.x, p.y - ev.point.y);
        if (d < bd) { bd = d; best = a; }
      }
      sim.select(best ? best.id : null);
    });

    let frame = 0;
    const tick = () => {
      raf.current = requestAnimationFrame(tick);
      const e = sim.engine; if (!e || !m.isStyleLoaded()) return;

      if (sim.icao && sim.icao !== lastIcao.current) {
        lastIcao.current = sim.icao;
        m.setStyle(build3DStyle(sim.icao) as any);
        const cfg = ATC_AIRPORTS[sim.icao];
        if (cfg) m.flyTo({ center: cfg.center, zoom: 14.6, speed: 1.6 });
        return;
      }

      // Aircraft geometry at ~20 Hz — plenty smooth, a third of the setData cost.
      if (++frame % 3 === 0) {
        const src = m.getSource('acft') as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(aircraftFC(sim.selectedId) as any);
      }

      if (followRef.current && sim.selectedId != null) {
        const a = e.byId(sim.selectedId);
        if (a) {
          const ll = e.proj.toLngLat(a.pos.x, a.pos.y);
          m.easeTo({ center: [ll.lng, ll.lat], bearing: a.heading - 180, duration: 260, essential: true });
        }
      }
    };
    raf.current = requestAnimationFrame(tick);

    return () => { cancelAnimationFrame(raf.current); map.current = null; m.remove(); };
  }, []);

  // live camera controls from the parent
  useEffect(() => { map.current?.easeTo({ pitch, duration: 400 }); }, [pitch]);
  useEffect(() => { if (!follow) map.current?.easeTo({ bearing, duration: 400 }); }, [bearing, follow]);

  return <div ref={mapDiv} style={{ position: 'absolute', inset: 0 }} />;
}
