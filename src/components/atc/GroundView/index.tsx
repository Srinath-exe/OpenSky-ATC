'use client';
import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildOsmStyle } from '@/lib/osmMapStyle';
import { getShape, drawShape } from '@/lib/sim/aircraftShapes';
import { isAirborne } from '@/lib/sim/aircraft';
import { DEG } from '@/lib/sim/projection';
import { sim, ATC_AIRPORTS } from '../simStore';

// abort-rejection swallow (see OsmRadar rationale)
if (typeof window !== 'undefined' && !(window as any).__abortFetchPatched) {
  (window as any).__abortFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (i: RequestInfo | URL, init?: RequestInit) => orig(i, init).catch((e: any) => { if (e?.name === 'AbortError') return new Promise<Response>(() => {}); throw e; });
}

// Ground map renderer over the SHARED sim engine (the store owns the sim loop).
export default function GroundView({ theme = 'chart' }: { theme?: 'chart' | 'satellite' }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const raf = useRef(0);
  const lastIcao = useRef('');
  const lastTheme = useRef(theme);

  useEffect(() => {
    if (!mapDiv.current || map.current) return;
    const start = ATC_AIRPORTS[sim.icao] ?? ATC_AIRPORTS.EGLL;
    const m = new maplibregl.Map({
      container: mapDiv.current, style: buildOsmStyle(sim.icao || 'EGLL', theme) as any,
      center: start.center, zoom: start.groundZoom, minZoom: 11, maxZoom: 19, attributionControl: false, dragRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.current = m; lastIcao.current = sim.icao; lastTheme.current = theme;

    const hit = (pt: maplibregl.Point) => {
      const e = sim.engine; if (!e) return null;
      let best: any = null, bd = 22;
      for (const a of e.aircraft) { const ll = e.proj.toLngLat(a.pos.x, a.pos.y); const p = m.project([ll.lng, ll.lat]); const d = Math.hypot(p.x - pt.x, p.y - pt.y); if (d < bd) { bd = d; best = a; } }
      return best;
    };
    m.on('click', ev => { const a = hit(ev.point); sim.select(a ? a.id : null); });
    m.on('mousemove', ev => { m.getCanvas().style.cursor = hit(ev.point) ? 'pointer' : ''; });

    const cv = canvas.current!, ctx = cv.getContext('2d')!;
    const tick = () => {
      raf.current = requestAnimationFrame(tick);
      const e = sim.engine; if (!e) return;
      // follow airport switches
      if (sim.icao && sim.icao !== lastIcao.current) {
        lastIcao.current = sim.icao;
        const cfg = ATC_AIRPORTS[sim.icao];
        if (cfg) m.flyTo({ center: cfg.center, zoom: cfg.groundZoom, speed: 1.6 });
        const src = m.getSource('osm') as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(`/maps/osm/${sim.icao}.geojson`);
      }
      const mc = m.getCanvas();
      if (cv.width !== mc.width || cv.height !== mc.height) { cv.width = mc.width; cv.height = mc.height; cv.style.width = `${m.getContainer().clientWidth}px`; cv.style.height = `${m.getContainer().clientHeight}px`; }
      const dpr = mc.width / m.getContainer().clientWidth;
      const toScreen = (x: number, y: number) => { const ll = e.proj.toLngLat(x, y); const p = m.project([ll.lng, ll.lat]); return { x: p.x * dpr, y: p.y * dpr }; };
      const o0 = toScreen(0, 0), o1 = toScreen(100, 0); const pxPerM = Math.hypot(o1.x - o0.x, o1.y - o0.y) / 100;
      const sel = sim.selectedId;
      ctx.clearRect(0, 0, cv.width, cv.height);

      // route ahead (green) for ground movers
      for (const a of e.aircraft) {
        const path = a.path; if (!path) continue;
        let i = 0; while (i < path.cum.length && path.cum[i] < a.distAlong) i++;
        if (i >= path.pts.length) continue;
        const isSel = a.id === sel;
        ctx.save(); ctx.strokeStyle = isSel ? '#4ade80' : '#22c55e'; ctx.lineWidth = isSel ? 3.5 : 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = isSel ? 0.95 : 0.5;
        ctx.beginPath(); const c = toScreen(a.pos.x, a.pos.y); ctx.moveTo(c.x, c.y);
        for (; i < path.pts.length; i++) { const p = toScreen(path.pts[i].x, path.pts[i].y); ctx.lineTo(p.x, p.y); }
        ctx.stroke(); ctx.restore();
      }
      // trails (red)
      for (const a of e.aircraft) { const isSel = a.id === sel; for (let i = 1; i < a.trail.length; i++) { const p0 = toScreen(a.trail[i - 1].x, a.trail[i - 1].y), p1 = toScreen(a.trail[i].x, a.trail[i].y); ctx.strokeStyle = `rgba(239,68,68,${((0.05 + i / a.trail.length * 0.9) * (isSel ? 1 : 0.8)).toFixed(2)})`; ctx.lineWidth = isSel ? 4 : 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke(); } }
      // aircraft — per-type shapes true-to-scale (clamped)
      const MIN = 22 * dpr, MAX = 460 * dpr;
      for (const a of e.aircraft) {
        const p = toScreen(a.pos.x, a.pos.y); const isSel = a.id === sel; const air = isAirborne(a);
        const shape = getShape(a.perf.icaoCode);
        let lenPx = shape.lengthM * pxPerM; if (air) lenPx *= 1 + Math.min(0.7, a.altitude / 10000);
        lenPx = Math.max(MIN, Math.min(MAX, lenPx)); if (isSel) lenPx *= 1.1;
        const eff = lenPx / shape.lengthM; const radPx = (shape.spanM / 2) * eff;
        if (air && a.altitude > 5) { const off = Math.min(30, a.altitude / 200); ctx.save(); ctx.translate(p.x + off, p.y + off); ctx.rotate(a.heading * DEG); ctx.globalAlpha = 0.3; drawShape(ctx, shape, eff, '#000', '#000'); ctx.restore(); }
        if (isSel) { ctx.save(); ctx.translate(p.x, p.y); ctx.beginPath(); ctx.arc(0, 0, radPx + 8 * dpr, 0, Math.PI * 2); ctx.strokeStyle = a.conflict ? 'rgba(239,68,68,0.95)' : 'rgba(96,165,250,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.stroke(); ctx.restore(); }
        const body = a.conflict ? '#ef4444' : air ? '#86c8f5' : (isSel ? '#fde68a' : '#fbbf24');
        const eng = a.conflict ? '#7f1d1d' : (isSel ? '#5a3d08' : '#26200a');
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a.heading * DEG); drawShape(ctx, shape, eff, body, eng); ctx.restore();
        // compact label
        const off = Math.max(radPx, MIN * 0.5), lx = p.x + off + 6, ly = p.y - 6;
        ctx.font = `bold ${11}px ui-monospace,monospace`; ctx.textAlign = 'left';
        ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 3; ctx.strokeText(a.callsign, lx, ly);
        ctx.fillStyle = isSel ? '#fde68a' : '#e6eefb'; ctx.fillText(a.callsign, lx, ly);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf.current); map.current = null; m.remove(); };
  }, []);

  // Swap chart ↔ satellite look without recreating the map (keeps camera position).
  useEffect(() => {
    const m = map.current;
    if (!m || lastTheme.current === theme) return;
    lastTheme.current = theme;
    m.setStyle(buildOsmStyle(sim.icao || 'EGLL', theme) as any);
  }, [theme]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={mapDiv} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvas} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 5 }} />
    </div>
  );
}
