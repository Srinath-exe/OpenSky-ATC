'use client';
import React, { useEffect, useRef } from 'react';
import { sim, gsInterceptNM, NM } from '../simStore';
import { AircraftState } from '@/lib/sim/types';
import { isAirborne } from '@/lib/sim/aircraft';

const DEG = Math.PI / 180;
const alt100 = (ft: number) => String(Math.round(ft / 100)).padStart(3, '0');

// Endless-ATC-style vector radar scope over the shared sim state.
export default function ApproachView() {
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // camera: world metres at screen centre + pixels-per-NM
  const cam = useRef({ x: 0, y: 0, pxPerNM: 12, centeredOn: '' });
  const drag = useRef<{ x: number; y: number; camx: number; camy: number } | null>(null);
  const attentionPhase = useRef(0); // animates the flashing blue ring

  useEffect(() => {
    const canvas = cv.current!, ctx = canvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const w = wrap.current!.clientWidth, h = wrap.current!.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap.current!);

    const W = () => canvas.width, H = () => canvas.height;
    const toScreen = (x: number, y: number) => {
      const k = (cam.current.pxPerNM * dpr) / NM;
      return { x: W() / 2 + (x - cam.current.x) * k, y: H() / 2 - (y - cam.current.y) * k };
    };
    const toWorld = (sx: number, sy: number) => {
      const k = (cam.current.pxPerNM * dpr) / NM;
      return { x: cam.current.x + (sx * dpr - W() / 2) / k, y: cam.current.y - (sy * dpr - H() / 2) / k };
    };

    // Centre + fit the scope; re-centres whenever the airport changes.
    const initCam = () => {
      const r = sim.radar;
      if (!r) return;
      const key = `${r.centerXY.x.toFixed(0)},${r.centerXY.y.toFixed(0)}`;
      if (cam.current.centeredOn === key) return;
      cam.current.x = r.centerXY.x; cam.current.y = r.centerXY.y;
      const h = wrap.current!.clientHeight;
      cam.current.pxPerNM = (h * 0.92) / (2 * r.radiusM / NM);
      cam.current.centeredOn = key;
    };

    // ── input ──
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      cam.current.pxPerNM = Math.max(2, Math.min(140, cam.current.pxPerNM * f));
    };
    const onDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // hit test aircraft
      const eng = sim.engine; let hit: AircraftState | null = null, best = 16;
      if (eng) for (const a of eng.aircraft) { const s = toScreen(a.pos.x, a.pos.y); const d = Math.hypot(s.x / dpr - (e.clientX - rect.left), s.y / dpr - (e.clientY - rect.top)); if (d < best) { best = d; hit = a; } }
      if (hit) { sim.select(hit.id); return; }
      if (e.button === 0) { sim.select(null); drag.current = { x: e.clientX, y: e.clientY, camx: cam.current.x, camy: cam.current.y }; }
    };
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const k = (cam.current.pxPerNM) / NM;
      cam.current.x = drag.current.camx - (e.clientX - drag.current.x) / k;
      cam.current.y = drag.current.camy + (e.clientY - drag.current.y) / k;
    };
    const onUp = () => { drag.current = null; };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // ── colors ──
    const C = {
      bg: '#05080d', grid: 'rgba(90,150,120,0.16)', boundary: 'rgba(110,170,140,0.4)',
      ils: 'rgba(90,150,235,0.7)', ilsRange: 'rgba(90,150,235,0.45)', ilsCapture: 'rgba(130,200,255,0.9)',
      rwy: '#9fc3ff', beacon: 'rgba(150,190,170,0.85)', area: 'rgba(200,120,90,0.45)',
      ac: '#7CFC58', acGround: 'rgba(120,200,120,0.5)', sel: '#ffd24a',
      conflict: '#ff5252', entry: 'rgba(120,200,160,0.55)', text: '#9fe0b0',
      attention: '#60a5fa', trail: 'rgba(124,252,88,0.25)',
    };

    // ── draw ──
    const tick = (now: number) => {
      raf.current = requestAnimationFrame(tick);
      initCam();
      attentionPhase.current = now / 1000;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W(), H());
      const r = sim.radar; const eng = sim.engine;
      const selId = sim.selectedId;
      const k = (cam.current.pxPerNM * dpr) / NM;

      // boundary + range rings
      const center = r ? toScreen(r.centerXY.x, r.centerXY.y) : toScreen(0, 0);
      const radiusM = r ? r.radiusM : 30 * NM;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = C.boundary;
      ctx.beginPath(); ctx.arc(center.x, center.y, radiusM * k, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C.grid;
      for (let nm = 10; nm < (radiusM / NM); nm += 10) { ctx.beginPath(); ctx.arc(center.x, center.y, nm * NM * k, 0, Math.PI * 2); ctx.stroke(); }

      // range ring labels
      ctx.fillStyle = 'rgba(90,150,120,0.4)'; ctx.font = `${8 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'left';
      for (let nm = 10; nm < (radiusM / NM); nm += 10) {
        const ry = center.y - nm * NM * k;
        ctx.fillText(`${nm}NM`, center.x + 3 * dpr, ry);
      }

      // restricted areas
      if (r) for (const a of r.areas) {
        ctx.strokeStyle = C.area; ctx.lineWidth = 1; ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        if (a.shape === 'circle' && a.center && a.radiusM) ctx.arc(toScreen(a.center.x, a.center.y).x, toScreen(a.center.x, a.center.y).y, a.radiusM * k, 0, Math.PI * 2);
        else if (a.points.length) { a.points.forEach((p, i) => { const s = toScreen(p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); }
        ctx.stroke(); ctx.setLineDash([]);
      }

      // runways + ILS feathers + glideslope circles
      if (r) for (const rw of r.runways) {
        const thr = toScreen(rw.thr.x, rw.thr.y);
        const farX = rw.thr.x + Math.sin(rw.course * DEG) * rw.lengthM, farY = rw.thr.y + Math.cos(rw.course * DEG) * rw.lengthM;
        const far = toScreen(farX, farY);
        // runway bar
        ctx.strokeStyle = C.rwy; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(thr.x, thr.y); ctx.lineTo(far.x, far.y); ctx.stroke();

        // ILS localizer feather (approach side = reciprocal of course)
        const app = (rw.course + 180) % 360;
        const ilsM = Math.min(radiusM * 0.62, 18 * NM);
        const ix = rw.thr.x + Math.sin(app * DEG) * ilsM, iy = rw.thr.y + Math.cos(app * DEG) * ilsM;
        const ie = toScreen(ix, iy);

        // Check if any aircraft is established on this ILS — highlight if so
        const hasCapture = eng?.aircraft.some(a => a.assignedRunway === rw.name && (a.ilsCaptured || a.gsCaptured));
        ctx.strokeStyle = hasCapture ? C.ilsCapture : C.ils;
        ctx.lineWidth = hasCapture ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(thr.x, thr.y); ctx.lineTo(ie.x, ie.y); ctx.stroke();

        // ILS side-line "cone" to show capture zone (±30°)
        const coneM = ilsM * 0.6;
        for (const sign of [-1, 1]) {
          const ax = (rw.course + 180 + sign * 30) % 360;
          const cx2 = rw.thr.x + Math.sin(ax * DEG) * coneM, cy2 = rw.thr.y + Math.cos(ax * DEG) * coneM;
          const cs = toScreen(cx2, cy2);
          ctx.strokeStyle = 'rgba(90,150,235,0.18)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(thr.x, thr.y); ctx.lineTo(cs.x, cs.y); ctx.stroke();
        }

        // glideslope intercept circles 2000/3000/4000 ft
        for (const ft of [2000, 3000, 4000]) {
          const dM = gsInterceptNM(ft, rw.gsDeg) * NM;
          const px = rw.thr.x + Math.sin(app * DEG) * dM, py = rw.thr.y + Math.cos(app * DEG) * dM;
          const ps = toScreen(px, py);
          ctx.strokeStyle = C.ilsRange; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(ps.x, ps.y, 3.5 * dpr, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = 'rgba(90,150,235,0.45)'; ctx.font = `${7 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'right';
          ctx.fillText(`${ft / 1000}k`, ps.x - 5 * dpr, ps.y + 2 * dpr);
        }

        // runway label
        ctx.fillStyle = C.rwy; ctx.font = `${11 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'center';
        ctx.fillText(rw.name, thr.x, thr.y - 6 * dpr);
      }

      // entry points
      if (r) for (const ep of r.entries) {
        const s = toScreen(ep.x, ep.y);
        ctx.fillStyle = C.entry; ctx.font = `${9 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'center';
        ctx.beginPath(); ctx.moveTo(s.x, s.y - 5 * dpr); ctx.lineTo(s.x + 4 * dpr, s.y + 3 * dpr); ctx.lineTo(s.x - 4 * dpr, s.y + 3 * dpr); ctx.closePath(); ctx.fill();
        if (ep.beacon) ctx.fillText(ep.beacon, s.x, s.y - 9 * dpr);
      }

      // beacons / fixes
      if (r) for (const b of r.beacons) {
        const s = toScreen(b.x, b.y);
        ctx.strokeStyle = C.beacon; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(s.x, s.y - 4 * dpr); ctx.lineTo(s.x + 4 * dpr, s.y); ctx.lineTo(s.x, s.y + 4 * dpr); ctx.lineTo(s.x - 4 * dpr, s.y); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = C.text; ctx.font = `${9 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'left';
        ctx.fillText(b.id, s.x + 6 * dpr, s.y + 3 * dpr);
      }

      // ── hold pattern ovals ──
      if (eng) for (const a of eng.aircraft) {
        if (a.navMode !== 'hold' || !a.holdFix) continue;
        const fixS = toScreen(a.holdFix.x, a.holdFix.y);
        const inHdg = a.holdInboundHdg;
        const sideSign = a.holdTurnDir === 'R' ? 1 : -1; // +1=right turns oval below inbound in rotated frame

        // Estimate dimensions from current speed
        const speedMps = (a.speed || 200) * 0.514444;
        const rM = speedMps / (3 * DEG);    // standard rate turn radius (m)
        const legM2 = speedMps * 60;        // 1-minute outbound leg
        const rPx = rM * k, legPx = legM2 * k;

        const isSel = a.id === selId;
        ctx.save();
        ctx.translate(fixS.x, fixS.y);
        // Rotate so inbound heading points rightward (canvas 0=east, compass→canvas: H-90)
        ctx.rotate((inHdg - 90) * DEG);

        // In this rotated frame:
        //   (0,0) = fix; rightward = inbound; leftward = outbound
        //   sideSign>0: hold is BELOW (right of inbound); sideSign<0: ABOVE (left)
        const acw = sideSign < 0;
        const startA = -Math.PI / 2 * sideSign;  // R: -π/2 (top), L: +π/2 (bottom)
        const endA   =  Math.PI / 2 * sideSign;  // R: +π/2 (bottom), L: -π/2 (top)

        ctx.strokeStyle = isSel ? 'rgba(255,210,74,0.55)' : 'rgba(120,180,255,0.32)';
        ctx.lineWidth = 1; ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.arc(0, sideSign * rPx, rPx, startA, endA, acw);       // near arc (at fix)
        ctx.lineTo(-legPx, sideSign * 2 * rPx);                    // outbound side
        ctx.arc(-legPx, sideSign * rPx, rPx, endA, startA, acw);  // far arc
        ctx.closePath();                                             // inbound side
        ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();

        // Fix diamond (in screen coords, no transform)
        const ds = 4 * dpr;
        ctx.strokeStyle = isSel ? 'rgba(255,210,74,0.8)' : 'rgba(120,180,255,0.6)';
        ctx.lineWidth = 1.2; ctx.beginPath();
        ctx.moveTo(fixS.x, fixS.y - ds); ctx.lineTo(fixS.x + ds, fixS.y);
        ctx.lineTo(fixS.x, fixS.y + ds); ctx.lineTo(fixS.x - ds, fixS.y);
        ctx.closePath(); ctx.stroke();
        if (a.holdFixName) {
          ctx.fillStyle = isSel ? 'rgba(255,210,74,0.9)' : 'rgba(120,180,255,0.7)';
          ctx.font = `${9 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'center';
          ctx.fillText(`HOLD ${a.holdFixName}`, fixS.x, fixS.y - 10 * dpr);
        }
      }

      // aircraft
      if (eng) for (const a of eng.aircraft) {
        const s = toScreen(a.pos.x, a.pos.y);
        const air = isAirborne(a);
        const isSel = a.id === selId;
        const col = a.conflict ? C.conflict : isSel ? C.sel : air ? C.ac : C.acGround;

        // ── attention ring (new aircraft, uncontrolled) ──
        if (a.attention && air) {
          const pulse = 0.5 + 0.5 * Math.sin(attentionPhase.current * Math.PI * 3);
          const alpha = 0.4 + 0.5 * pulse;
          ctx.strokeStyle = `rgba(96,165,250,${alpha})`;
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath(); ctx.arc(s.x, s.y, (10 + pulse * 4) * dpr, 0, Math.PI * 2); ctx.stroke();
        }

        // ── separation ring (3 NM for airborne) ──
        if (air) {
          ctx.strokeStyle = a.conflict ? 'rgba(255,82,82,0.8)' : 'rgba(120,200,120,0.14)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(s.x, s.y, 1.5 * NM * k, 0, Math.PI * 2); ctx.stroke();
        }

        // ── wake turbulence arc (H / S on final, drawn behind the aircraft) ──
        if (air && (a.perf.weightClass === 'H' || a.perf.weightClass === 'S') &&
            (a.phase === 'approach' || a.phase === 'landing' || a.ilsCaptured)) {
          const wakeNM = a.perf.weightClass === 'S' ? 6 : 4;
          const wakePx = wakeNM * NM * k;
          const trailHdg = (a.heading + 180) % 360;  // opposite of travel direction
          const startAng = (trailHdg - 35) * DEG - Math.PI / 2;
          const endAng = (trailHdg + 35) * DEG - Math.PI / 2;
          ctx.strokeStyle = a.perf.weightClass === 'S'
            ? 'rgba(255,140,50,0.45)'
            : 'rgba(255,180,80,0.30)';
          ctx.lineWidth = a.perf.weightClass === 'S' ? 2.5 : 1.5;
          ctx.beginPath(); ctx.arc(s.x, s.y, wakePx, startAng, endAng); ctx.stroke();
          // Label
          ctx.fillStyle = 'rgba(255,170,60,0.6)';
          ctx.font = `${8 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'center';
          const lbx = s.x + Math.sin(trailHdg * DEG) * wakePx;
          const lby = s.y - Math.cos(trailHdg * DEG) * wakePx;
          ctx.fillText(`WAKE ${wakeNM}NM`, lbx, lby - 4 * dpr);
        }

        // ── ILS intercept guide (selected airborne aircraft armed on ILS) ──
        if (isSel && air && a.ilsArmed && !a.ilsCaptured && r) {
          const rwy = r.runways.find(rw => rw.name === a.assignedRunway);
          if (rwy) {
            const app = (rwy.course + 180) % 360;
            const thrS = toScreen(rwy.thr.x, rwy.thr.y);
            const locEndX = rwy.thr.x + Math.sin(app * DEG) * 18 * NM;
            const locEndY = rwy.thr.y + Math.cos(app * DEG) * 18 * NM;
            // Draw dashed line from aircraft to localizer centreline nearest point
            const acX = a.pos.x, acY = a.pos.y;
            // Project aircraft onto localizer
            const dxL = locEndX - rwy.thr.x, dyL = locEndY - rwy.thr.y;
            const lenSq = dxL * dxL + dyL * dyL;
            const t = Math.max(0, ((acX - rwy.thr.x) * dxL + (acY - rwy.thr.y) * dyL) / lenSq);
            const footX = rwy.thr.x + t * dxL, footY = rwy.thr.y + t * dyL;
            const foot = toScreen(footX, footY);
            ctx.strokeStyle = 'rgba(130,190,255,0.55)'; ctx.lineWidth = 1;
            ctx.setLineDash([5 * dpr, 4 * dpr]);
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
            ctx.setLineDash([]);
          }
        }

        // ── direct-to line ──
        if (isSel && air && a.navMode === 'direct' && a.directTargetXY) {
          const ds = toScreen(a.directTargetXY.x, a.directTargetXY.y);
          ctx.strokeStyle = 'rgba(250,200,80,0.55)'; ctx.lineWidth = 1;
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ds.x, ds.y); ctx.stroke();
          ctx.setLineDash([]);
        }

        // ── position trail ──
        if (air && a.trail.length > 1) {
          ctx.strokeStyle = C.trail; ctx.lineWidth = 1;
          ctx.beginPath();
          const start = toScreen(a.trail[0].x, a.trail[0].y);
          ctx.moveTo(start.x, start.y);
          for (let i = 1; i < a.trail.length; i++) {
            const p = toScreen(a.trail[i].x, a.trail[i].y);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // ── leader / heading vector (~1 min of travel) ──
        if (air || a.speed > 5) {
          const distM = (a.speed / 60) * NM;
          const hx = a.pos.x + Math.sin(a.heading * DEG) * distM, hy = a.pos.y + Math.cos(a.heading * DEG) * distM;
          const he = toScreen(hx, hy);
          ctx.strokeStyle = col; ctx.lineWidth = isSel ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(he.x, he.y); ctx.stroke();
        }

        // ── selected ring ──
        if (isSel) {
          ctx.strokeStyle = C.sel; ctx.lineWidth = 1.5;
          const sz = (air ? 3 : 2) * dpr;
          ctx.strokeRect(s.x - sz - 3 * dpr, s.y - sz - 3 * dpr, (sz + 3 * dpr) * 2, (sz + 3 * dpr) * 2);
        }

        // ── target dot ──
        const sz = (air ? 3 : 2) * dpr;
        ctx.fillStyle = col; ctx.fillRect(s.x - sz, s.y - sz, sz * 2, sz * 2);

        // ── ILS established indicator (small cyan dot above target) ──
        if (a.ilsCaptured) {
          ctx.fillStyle = a.gsCaptured ? 'rgba(130,220,255,1)' : 'rgba(130,220,255,0.7)';
          ctx.beginPath(); ctx.arc(s.x, s.y - sz - 4 * dpr, 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
        }

        // ── data tag ──
        if (air || isSel) {
          // Line 1: callsign
          // Line 2: altitude with target arrow
          // Line 3: speed + weight + mode indicator
          const altStr = (a.cmdAltitude != null && Math.abs((a.cmdAltitude) - a.altitude) > 100)
            ? `${alt100(a.altitude)}${a.cmdAltitude > a.altitude ? '↑' : '↓'}${alt100(a.cmdAltitude)}`
            : alt100(a.altitude);
          const modeStr = a.ilsCaptured
            ? (a.gsCaptured ? 'ILS' : 'LOC')
            : a.navMode === 'hold'   ? `HLD${a.holdFixName ? ' ' + a.holdFixName : ''}`.slice(0, 7)
            : a.navMode === 'direct' ? `D${a.directTargetName ?? ''}`.slice(0, 5)
            : a.navMode === 'sid'    ? `SID${a.plan.fix ? ' ' + a.plan.fix : ''}`.slice(0, 7)
            : '';
          const spdStr = `${Math.round(a.speed)}${a.perf.weightClass !== 'M' ? a.perf.weightClass : ''}${modeStr ? ' ' + modeStr : ''}`;
          const lines = [a.callsign, altStr, spdStr];

          ctx.font = `${9.5 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'left';
          const lx = s.x + 8 * dpr, ly = s.y - 8 * dpr;
          ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 3 * dpr;
          lines.forEach((t, i) => ctx.strokeText(t, lx, ly + i * 11 * dpr));
          ctx.fillStyle = isSel ? C.sel : a.attention ? C.attention : col;
          lines.forEach((t, i) => ctx.fillText(t, lx, ly + i * 11 * dpr));
        }
      }

      // ── score HUD (bottom-right corner) ──
      if (eng) {
        const skill = eng.skill;
        const score = eng.score;
        ctx.font = `${10 * dpr}px ui-monospace,monospace`; ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,190,50,0.8)';
        ctx.fillText(`SCORE ${score}`, W() - 10 * dpr, H() - 24 * dpr);
        ctx.fillStyle = 'rgba(140,200,120,0.7)';
        ctx.fillText(`SKILL ${skill.toFixed(1)}`, W() - 10 * dpr, H() - 12 * dpr);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current); ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div ref={wrap} style={{ position: 'absolute', inset: 0, background: '#05080d', cursor: 'crosshair' }}>
      <canvas ref={cv} style={{ display: 'block' }} />
    </div>
  );
}
