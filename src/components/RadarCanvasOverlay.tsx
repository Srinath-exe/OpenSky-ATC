'use client';
import { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { useGroundTraffic } from '@/context/GroundTrafficContext';
import type { SimAircraft } from '@/lib/aircraft';
import type { TaxiGraph } from '@/lib/airportData';

// ============================================================
//  RadarCanvasOverlay — renders aircraft on a 2D canvas at 60fps
//
//  Replaces the DOM-marker approach. Canvas is synced to the
//  MapLibre map viewport every frame (project lng/lat → px).
//  Draws:
//   - aircraft silhouettes with heading vector
//   - route lines for selected aircraft
//   - datablock labels (callsign / state / speed)
//   - trail dots
//   - selection ring
// ============================================================

interface Props {
  map: maplibregl.Map;
}

const STATE_COLORS: Record<string, string> = {
  PARKED: '#6b7280',
  PUSHBACK_OUT: '#3b82f6',
  PUSHBACK_COMPLETE: '#60a5fa',
  TAXIING: '#22c55e',
  TAXIING_TO_GATE: '#22c55e',
  HOLDING: '#facc15',
  RUNWAY_ENTRY: '#f97316',
  LINE_UP: '#a855f7',
  TAKEOFF_ROLL: '#ef4444',
  ROTATE: '#ef4444',
  AIRBORNE_CLIMB: '#ef4444',
  HANDED_OFF: '#4b5563',
  ARRIVING_RUNWAY: '#a855f7',
  LANDED: '#a855f7',
  ARRIVED_GATE: '#10b981',
  DEPARTING: '#ef4444',
};

const STATE_SHORT: Record<string, string> = {
  PARKED: 'PARK', PUSHBACK_OUT: 'PUSH', PUSHBACK_COMPLETE: 'READY',
  TAXIING: 'TAXI', TAXIING_TO_GATE: 'TAXI', HOLDING: 'HOLD',
  RUNWAY_ENTRY: 'RWY', LINE_UP: 'LINE', TAKEOFF_ROLL: 'ROLL',
  ROTATE: 'ROT', AIRBORNE_CLIMB: 'CLMB', HANDED_OFF: 'OFF',
  ARRIVING_RUNWAY: 'LAND', LANDED: 'LDG', ARRIVED_GATE: 'ARR',
  DEPARTING: 'DEP',
};

const AIRCRAFT_SIZES: Record<string, number> = {
  C172: 7, A320: 12, B738: 12, B77W: 16, A388: 20,
};

export default function RadarCanvasOverlay({ map }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { state, dispatch } = useGroundTraffic();
  // Keep latest state in a ref so the RAF loop reads fresh data every frame
  const stateRef = useRef(state);
  stateRef.current = state;
  const mapRef = useRef(map);
  mapRef.current = map;

  // ── Resize canvas to match container ──────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const r = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── Main render loop ───────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;

    const render = () => {
      const m = mapRef.current;
      const s = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      // Reset transform to dpr scale every frame (in case of resize)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const aircrafts = Array.from(s.aircrafts.values());
      const selectedId = s.selectedId;
      const graph = s.taxiGraph;

      // ── 1. Draw route line for selected aircraft ──
      if (selectedId) {
        const sel = s.aircrafts.get(selectedId);
        if (sel && sel.route && sel.route.path.length > 0) {
          ctx.save();
          ctx.strokeStyle = 'rgba(250,204,21,0.85)';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          const first = sel.route.path[0].fromNode.position;
          const p0 = m.project([first.lng, first.lat]);
          ctx.moveTo(p0.x, p0.y);
          for (const seg of sel.route.path) {
            const p = m.project([seg.toNode.position.lng, seg.toNode.position.lat]);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      // ── 2. Draw trails ──
      for (const ac of aircrafts) {
        if (ac.trail.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = ac.color + '55';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < ac.trail.length; i++) {
          const p = m.project([ac.trail[i].lng, ac.trail[i].lat]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        // current position
        const cur = m.project([ac.position.lng, ac.position.lat]);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.restore();
      }

      // ── 3. Draw aircraft ──
      for (const ac of aircrafts) {
        const proj = m.project([ac.position.lng, ac.position.lat]);
        const px = proj.x;
        const py = proj.y;
        // Skip if off-screen with margin
        if (px < -50 || px > w + 50 || py < -50 || py > h + 50) continue;

        const size = AIRCRAFT_SIZES[ac.aircraftType] || 10;
        const color = ac.color;
        const sel = selectedId === ac.id;
        const stateColor = STATE_COLORS[ac.state] || '#6b7280';

        ctx.save();
        ctx.translate(px, py);

        // Selection ring
        if (sel) {
          ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(0, 0, size + 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        // Draw aircraft shape rotated to heading
        // MapLibre heading: 0=up, 90=right. Canvas rotate: 0=right.
        // We want nose pointing in heading direction.
        const headingRad = (ac.heading - 90) * Math.PI / 180;
        ctx.rotate(headingRad);

        // Aircraft silhouette: a simple plane shape
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;

        // Fuselage + wings (pointing right by default, before rotation)
        ctx.beginPath();
        // Nose
        ctx.moveTo(size, 0);
        // Top fuselage curve
        ctx.quadraticCurveTo(size * 0.6, -size * 0.15, size * 0.1, -size * 0.12);
        // Left wing leading edge
        ctx.lineTo(-size * 0.1, -size * 0.6);
        ctx.lineTo(-size * 0.3, -size * 0.6);
        // Tail
        ctx.lineTo(-size * 0.7, -size * 0.08);
        ctx.lineTo(-size * 0.7, size * 0.08);
        // Right wing trailing
        ctx.lineTo(-size * 0.3, size * 0.6);
        ctx.lineTo(-size * 0.1, size * 0.6);
        ctx.lineTo(size * 0.1, size * 0.12);
        ctx.quadraticCurveTo(size * 0.6, size * 0.15, size, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // State indicator dot (nose)
        ctx.fillStyle = stateColor;
        ctx.beginPath();
        ctx.arc(size, 0, 1.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore(); // undo rotation

        // ── Datablock (label box to the right) ──
        const speedKt = Math.round(ac.speed * 1.94384);
        const altLabel = ac.altitude > 0 ? `${Math.round(ac.altitude)}` : `${speedKt}`;
        const stShort = STATE_SHORT[ac.state] || ac.state.slice(0, 4);
        const line1 = ac.callsign;
        const line2 = `${stShort} ${altLabel}`;

        ctx.save();
        ctx.font = 'bold 10px monospace';
        const w1 = ctx.measureText(line1).width;
        const w2 = ctx.measureText(line2).width;
        const boxW = Math.max(w1, w2) + 8;
        const boxH = 26;
        const boxX = px + size + 4;
        const boxY = py - boxH / 2;

        // Background (manual rounded rect for compatibility)
        const r = 3;
        ctx.fillStyle = 'rgba(6,10,20,0.88)';
        ctx.strokeStyle = stateColor + '99';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(boxX + r, boxY);
        ctx.lineTo(boxX + boxW - r, boxY);
        ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
        ctx.lineTo(boxX + boxW, boxY + boxH - r);
        ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
        ctx.lineTo(boxX + r, boxY + boxH);
        ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
        ctx.lineTo(boxX, boxY + r);
        ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Connector line
        ctx.strokeStyle = 'rgba(100,116,139,0.5)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(px + size, py);
        ctx.lineTo(boxX, py);
        ctx.stroke();

        // Text
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(line1, boxX + 4, boxY + 8);
        ctx.fillStyle = stateColor;
        ctx.font = '9px monospace';
        ctx.fillText(line2, boxX + 4, boxY + 18);
        ctx.restore();
      }

      // ── 4. Draw HUD info ──
      const acCount = aircrafts.length;
      const movingCount = aircrafts.filter(a => a.speed > 0.5).length;
      ctx.save();
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = 'rgba(100,116,139,0.7)';
      ctx.textAlign = 'right';
      ctx.fillText(`${acCount} AC · ${movingCount} moving`, w - 12, h - 16);
      ctx.restore();

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Click handling on canvas (hit-test aircraft) ───────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    const m = mapRef.current;
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!m || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Hit-test: find closest aircraft within 20px
    let best: string | null = null;
    let bestDist = 20;
    for (const ac of s.aircrafts.values()) {
      const proj = m.project([ac.position.lng, ac.position.lat]);
      const d = Math.hypot(proj.x - cx, proj.y - cy);
      if (d < bestDist) { bestDist = d; best = ac.id; }
    }
    dispatch({ type: 'SELECT', id: best });
  }, [dispatch]);

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-auto" style={{ cursor: 'crosshair' }}>
      <canvas ref={canvasRef} onClick={handleClick} className="absolute inset-0" />
    </div>
  );
}