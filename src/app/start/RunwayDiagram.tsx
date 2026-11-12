'use client';
/*
  The airfield from above, to scale: every runway between its real thresholds, the ends in use lit with chevrons in the
  direction traffic flows (landing and taking off toward the end's heading), each end's label a switch, and the wind
  on a small compass. Hovering a runway here or in the list lights both.
*/
import * as React from 'react';
import type { RunwayPair } from '@/lib/runwayManifest';
import s from './home.module.css';

const W = 360, H = 300, PAD = 46;

export function RunwayDiagram({ runways, on, wind, hover, onHover, onToggle }: {
  runways: RunwayPair[]; on: (end: string) => boolean; wind: { dir: number; kts: number };
  hover: string | null; onHover: (ref: string | null) => void; onToggle: (end: string) => void;
}) {
  const geo = React.useMemo(() => {
    const pts = runways.flatMap((r) => r.ends.map((e) => e.thr));
    const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng0 = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    const xy = (p: { lat: number; lng: number }) => ({ x: (p.lng - lng0) * 111320 * k, y: -(p.lat - lat0) * 110540 });
    const all = pts.map(xy);
    const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x)), minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
    const sc = Math.min((W - 2 * PAD) / Math.max(1, maxX - minX), (H - 2 * PAD) / Math.max(1, maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const map = (p: { lat: number; lng: number }) => { const q = xy(p); return { x: W / 2 + (q.x - cx) * sc, y: H / 2 + (q.y - cy) * sc }; };
    return { map, sc };
  }, [runways]);

  const windTo = (wind.dir + 180) * Math.PI / 180;
  return (
    <svg className={s.diagram} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Runway layout, ends in use and wind">
      <defs>
        <pattern id="rd-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeOpacity="0.05" /></pattern>
      </defs>
      <rect width={W} height={H} fill="url(#rd-grid)" className={s.diagramGrid} />
      {runways.map((r) => {
        const a = geo.map(r.ends[0].thr), b = geo.map(r.ends[1].thr);
        const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const width = Math.max(7, 45 * geo.sc);
        const live = r.ends.filter((e) => on(e.name));
        const lit = hover === r.ref;
        return (
          <g key={r.ref} onMouseEnter={() => onHover(r.ref)} onMouseLeave={() => onHover(null)} data-active={live.length > 0} className={s.diagramRwy} data-hover={lit || undefined}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={width} className={s.rwyBody} strokeLinecap="butt" />
            <line x1={a.x + ux * 6} y1={a.y + uy * 6} x2={b.x - ux * 6} y2={b.y - uy * 6} strokeWidth={1} strokeDasharray="6 6" className={s.rwyCentre} />
            {live.map((e) => {
              // traffic on end E rolls from E's threshold toward the other: chevrons pointing that way
              const fromA = e.name === r.ends[0].name; const dx = fromA ? ux : -ux, dy = fromA ? uy : -uy; const o = fromA ? a : b;
              return [0.3, 0.5, 0.7].map((t) => {
                const px = o.x + dx * len * t, py = o.y + dy * len * t, nx = -dy, ny = dx, c = width * 0.42;
                return <path key={`${e.name}-${t}`} d={`M${px - dx * c + nx * c} ${py - dy * c + ny * c} L${px} ${py} L${px - dx * c - nx * c} ${py - dy * c - ny * c}`} className={s.rwyFlow} />;
              });
            })}
            {r.ends.map((e, i) => {
              const p = i === 0 ? a : b; const out = i === 0 ? -1 : 1;
              // parallels share a threshold line: L sits to the left of the direction of travel, R to the right
              const hx = -ux * out, hy = -uy * out; const side = /L$/.test(e.name) ? 1 : /R$/.test(e.name) ? -1 : 0;
              const lx = p.x + ux * out * 22 + hy * side * 13, ly = p.y + uy * out * 22 - hx * side * 13;
              const active = on(e.name);
              return (
                <g key={e.name} className={s.endTag} data-on={active || undefined} role="button" tabIndex={0} aria-pressed={active} aria-label={`Runway ${e.name} ${active ? 'in use' : 'not in use'}`}
                  onClick={() => onToggle(e.name)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(e.name); } }} data-testid={`diagram-end-${e.name}`}>
                  <rect x={lx - 18} y={ly - 10} width={36} height={20} rx={10} />
                  <text x={lx} y={ly + 4} textAnchor="middle">{e.name}</text>
                </g>
              );
            })}
          </g>
        );
      })}
      <g transform={`translate(${W - 34} 34)`} className={s.compass} aria-hidden="true">
        <circle r="22" />
        <text y="-26" textAnchor="middle" className={s.compassN}>N</text>
        {wind.kts > 0 ? <path d={`M${-Math.sin(windTo) * 16} ${Math.cos(windTo) * 16} L${Math.sin(windTo) * 16} ${-Math.cos(windTo) * 16}`} className={s.windArrow} markerEnd="url(#rd-arrow)" /> : <circle r="3" className={s.windCalm} />}
        <defs><marker id="rd-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" className={s.windHead} /></marker></defs>
      </g>
      <text x={W - 34} y={74} textAnchor="middle" className={s.compassLabel}>{wind.kts > 0 ? `${String(wind.dir).padStart(3, '0')}° ${wind.kts} kt` : 'Calm'}</text>
    </svg>
  );
}
