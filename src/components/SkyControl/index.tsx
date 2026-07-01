'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildOsmStyle } from '@/lib/osmMapStyle';
import { buildOsmAirport } from '@/lib/osmAirport';
import { SimEngine } from '@/lib/sim/engine';
import { parseCommand } from '@/lib/sim/commands';
import { AircraftState } from '@/lib/sim/types';
import { DEG } from '@/lib/sim/projection';
import { isAirborne } from '@/lib/sim/aircraft';
import { getShape, drawShape } from '@/lib/sim/aircraftShapes';

// swallow MapLibre tile-abort rejections (see OsmRadar for the full rationale)
if (typeof window !== 'undefined' && !(window as any).__abortFetchPatched) {
  (window as any).__abortFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (i: RequestInfo | URL, init?: RequestInit) =>
    orig(i, init).catch((e: any) => { if (e?.name === 'AbortError') return new Promise<Response>(() => {}); throw e; });
}

const AIRPORTS: Record<string, { center: [number, number]; zoom: number; name: string; city: string }> = {
  EGLL: { center: [-0.4543, 51.4700], zoom: 13.4, name: 'Heathrow', city: 'London' },
  KLAX: { center: [-118.4081, 33.9416], zoom: 13.5, name: 'Los Angeles Intl', city: 'Los Angeles' },
  KSFO: { center: [-122.3790, 37.6213], zoom: 13.5, name: 'San Francisco Intl', city: 'San Francisco' },
  KJFK: { center: [-73.7781, 40.6413], zoom: 13.3, name: 'John F. Kennedy', city: 'New York' },
  KBOS: { center: [-71.0096, 42.3656], zoom: 13.5, name: 'Logan Intl', city: 'Boston' },
  VIDP: { center: [77.1000, 28.5562], zoom: 13.1, name: 'Indira Gandhi', city: 'Delhi' },
};

const PHASE_LABEL: Record<string, string> = {
  parked: 'PARKED', pushback: 'PUSHBACK', taxi: 'TAXIING', hold_short: 'HOLD SHORT',
  lineup: 'LINED UP', takeoff: 'TAKEOFF ROLL', climb: 'CLIMBING', cruise: 'CRUISE',
  descent: 'DESCENDING', approach: 'APPROACH', landing: 'ON FINAL', rollout: 'LANDING ROLL',
  arrived: 'AT GATE', departed: 'HANDED OFF',
};

interface RadioLine { who: 'ATC' | 'PILOT' | 'SYS'; text: string; key: number; }

export default function SkyControl() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const eng = useRef<SimEngine | null>(null);
  const raf = useRef(0);
  const last = useRef(performance.now());
  const frame = useRef(0);
  const nextSpawn = useRef(0);
  const selRef = useRef<number | null>(null);
  const rateRef = useRef(1);
  const pausedRef = useRef(false);
  const icaoRef = useRef('EGLL');
  const lineKey = useRef(0);

  const [icao, setIcao] = useState('EGLL');
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState('--:--:--');
  const [hud, setHud] = useState({ total: 0, dep: 0, arr: 0, air: 0, gnd: 0, conf: 0 });
  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [radio, setRadio] = useState<RadioLine[]>([]);
  const [cmd, setCmd] = useState('');
  const [rate, setRate] = useState(1);
  const [paused, setPaused] = useState(false);

  useEffect(() => { icaoRef.current = icao; }, [icao]);
  useEffect(() => { selRef.current = selId; }, [selId]);

  const pushRadio = useCallback((who: RadioLine['who'], text: string) => {
    setRadio(r => [...r.slice(-40), { who, text, key: ++lineKey.current }]);
  }, []);

  // UTC clock
  useEffect(() => {
    const t = () => { const d = new Date(); setClock(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`); };
    t(); const i = setInterval(t, 1000); return () => clearInterval(i);
  }, []);

  // HUD + selected snapshot refresh (decoupled from the 60fps draw loop)
  useEffect(() => {
    const i = setInterval(() => {
      const e = eng.current; if (!e) return;
      setHud(e.stats());
      const id = selRef.current;
      if (id != null) {
        const a = e.byId(id);
        if (a) setSel({
          callsign: a.callsign, flightNo: a.flightNo, airline: a.airline, type: a.perf.icaoCode,
          model: a.perf.modelName, wc: a.perf.weightClass, kind: a.plan.kind, phase: a.phase,
          runway: a.plan.runway, gate: a.plan.gateRef, fix: a.plan.fix,
          taxiRoute: a.plan.taxiRoute ?? [],
          kt: Math.round(a.speed), hdg: Math.round(a.heading), alt: Math.round(a.altitude),
          conflict: a.conflict,
        });
        else { setSel(null); setSelId(null); }
      }
    }, 350);
    return () => clearInterval(i);
  }, []);

  const submitCmd = useCallback((text: string) => {
    const e = eng.current; if (!e || !text.trim()) return;
    pushRadio('ATC', text.toUpperCase());
    const res = parseCommand(e, text);
    pushRadio(res.ok ? 'PILOT' : 'SYS', res.reply);
    setCmd('');
  }, [pushRadio]);

  const load = useCallback(async (ic: string) => {
    setIcao(ic); setLoading(true); setSelId(null); setSel(null); setRadio([]);
    const m = map.current;
    if (m) {
      const cfg = AIRPORTS[ic];
      m.flyTo({ center: cfg.center, zoom: cfg.zoom, speed: 1.6 });
      const s = m.getSource('osm') as maplibregl.GeoJSONSource | undefined;
      if (s) s.setData(`/maps/osm/${ic}.geojson`);
    }
    try {
      const fc = await (await fetch(`/maps/osm/${ic}.geojson`)).json();
      if (icaoRef.current !== ic) return;
      const air = buildOsmAirport(ic, fc);
      const engine = new SimEngine(air);
      eng.current = engine;
      nextSpawn.current = 0;
      setLoading(false);
      for (let i = 0; i < 6; i++) engine.spawnDeparture();
      pushRadio('SYS', `${AIRPORTS[ic].name} ground — ${air.gates.length} stands, ${air.runways.length} runways online`);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setLoading(false);
    }
  }, [pushRadio]);

  // init map
  useEffect(() => {
    if (!mapDiv.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapDiv.current, style: buildOsmStyle('EGLL') as any,
      center: AIRPORTS.EGLL.center, zoom: AIRPORTS.EGLL.zoom,
      minZoom: 11, maxZoom: 19, attributionControl: false, dragRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.on('load', () => { if (map.current === m) load('EGLL'); });

    const hit = (pt: maplibregl.Point): AircraftState | null => {
      const e = eng.current; if (!e) return null;
      let best: AircraftState | null = null, bestD = 24;
      for (const a of e.aircraft) {
        const ll = e.proj.toLngLat(a.pos.x, a.pos.y);
        const p = m.project([ll.lng, ll.lat]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = a; }
      }
      return best;
    };
    m.on('click', (e) => { const a = hit(e.point); setSelId(a ? a.id : null); });
    m.on('mousemove', (e) => { m.getCanvas().style.cursor = hit(e.point) ? 'pointer' : ''; });

    map.current = m;
    return () => { cancelAnimationFrame(raf.current); map.current = null; m.remove(); };
  }, [load]);

  // render + sim loop
  useEffect(() => {
    const cv = canvas.current; if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const EVENT_RADIO = new Set(['spawn', 'ground_conflict', 'separation_loss', 'airborne', 'touchdown', 'arrived', 'departed']);

    const tick = (now: number) => {
      raf.current = requestAnimationFrame(tick);
      const m = map.current, e = eng.current;
      const dt = Math.min((now - last.current) / 1000, 0.1); last.current = now;
      if (!m || !cv) return;

      const mc = m.getCanvas();
      if (cv.width !== mc.width || cv.height !== mc.height) {
        cv.width = mc.width; cv.height = mc.height;
        cv.style.width = `${m.getContainer().clientWidth}px`; cv.style.height = `${m.getContainer().clientHeight}px`;
      }
      frame.current++;
      const dpr = mc.width / m.getContainer().clientWidth;

      if (e && !pausedRef.current) {
        const events = e.update(dt * rateRef.current);
        for (const ev of events) if (EVENT_RADIO.has(ev.type)) pushRadio(ev.type === 'spawn' ? 'SYS' : (ev.type.includes('conflict') || ev.type.includes('separation') ? 'SYS' : 'PILOT'), ev.message);
        // auto traffic
        if (e.time >= nextSpawn.current && e.aircraft.length < 14) {
          if (Math.random() < 0.6) e.spawnDeparture(); else e.spawnArrival();
          nextSpawn.current = e.time + 5 + Math.random() * 6;
        }
      }

      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!e) return;
      const selId = selRef.current;
      const toScreen = (x: number, y: number) => {
        const ll = e.proj.toLngLat(x, y); const p = m.project([ll.lng, ll.lat]);
        return { x: p.x * dpr, y: p.y * dpr };
      };
      // device pixels per metre (for true-scale aircraft)
      const o0 = toScreen(0, 0), o1 = toScreen(100, 0);
      const pxPerM = Math.hypot(o1.x - o0.x, o1.y - o0.y) / 100;

      // routes ahead (green) — remaining smoothed path from current distance
      for (const a of e.aircraft) {
        const path = a.path; if (!path) continue;
        const isSel = a.id === selId;
        // find first path index beyond current distAlong
        let i = 0; while (i < path.cum.length && path.cum[i] < a.distAlong) i++;
        if (i >= path.pts.length) continue;
        ctx.save();
        ctx.strokeStyle = isSel ? '#4ade80' : '#22c55e'; ctx.lineWidth = isSel ? 3.5 : 2.2;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = isSel ? 0.95 : 0.5;
        ctx.beginPath();
        const c = toScreen(a.pos.x, a.pos.y); ctx.moveTo(c.x, c.y);
        for (; i < path.pts.length; i++) { const p = toScreen(path.pts[i].x, path.pts[i].y); ctx.lineTo(p.x, p.y); }
        ctx.stroke(); ctx.restore();
      }
      // trails (red)
      for (const a of e.aircraft) {
        const isSel = a.id === selId;
        for (let i = 1; i < a.trail.length; i++) {
          const p0 = toScreen(a.trail[i - 1].x, a.trail[i - 1].y), p1 = toScreen(a.trail[i].x, a.trail[i].y);
          ctx.strokeStyle = `rgba(239,68,68,${((0.05 + i / a.trail.length * 0.9) * (isSel ? 1 : 0.8)).toFixed(2)})`;
          ctx.lineWidth = isSel ? 4 : 3; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
      }
      // aircraft — per-type silhouette, true-to-scale with min/max clamp
      const MIN_LEN = 22 * dpr, MAX_LEN = 460 * dpr;
      for (const a of e.aircraft) {
        const p = toScreen(a.pos.x, a.pos.y);
        const isSel = a.id === selId;
        const airborne = isAirborne(a);
        const shape = getShape(a.perf.icaoCode);
        // true-scale: aircraft length in px, clamped so it's visible yet relative
        let lenPx = shape.lengthM * pxPerM;
        if (airborne) lenPx *= 1 + Math.min(0.7, a.altitude / 10000);   // grow toward camera
        lenPx = Math.max(MIN_LEN, Math.min(MAX_LEN, lenPx));
        if (isSel) lenPx *= 1.1;
        const effPxPerM = lenPx / shape.lengthM;
        const radPx = (shape.spanM / 2) * effPxPerM;

        // altitude shadow when airborne
        if (airborne && a.altitude > 5) {
          const off = Math.min(30, a.altitude / 200);
          ctx.save(); ctx.translate(p.x + off, p.y + off); ctx.rotate(a.heading * DEG);
          ctx.globalAlpha = 0.3; drawShape(ctx, shape, effPxPerM, '#000', '#000'); ctx.restore();
        }
        // selection ring
        if (isSel) {
          ctx.save(); ctx.translate(p.x, p.y);
          ctx.beginPath(); ctx.arc(0, 0, radPx + 8 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = a.conflict ? 'rgba(239,68,68,0.95)' : 'rgba(96,165,250,0.9)'; ctx.lineWidth = 2;
          ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineDashOffset = -frame.current * 0.5; ctx.stroke(); ctx.restore();
        }
        const body = a.conflict ? '#ef4444' : airborne ? '#86c8f5' : (isSel ? '#fde68a' : '#fbbf24');
        const engine = a.conflict ? '#7f1d1d' : (isSel ? '#5a3d08' : '#26200a');
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a.heading * DEG);
        drawShape(ctx, shape, effPxPerM, body, engine);
        ctx.restore();

        // label chip
        const off = Math.max(radPx, MIN_LEN * 0.5);
        const lx = p.x + off + 6, ly = p.y - 8;
        const arrow = a.plan.kind === 'departure' ? '→' : '←';
        const sub = airborne ? `${a.altitude.toFixed(0)}ft ${a.speed.toFixed(0)}kt` : `${arrow} ${a.plan.kind === 'departure' ? (a.plan.runway ?? a.plan.fix ?? '') : (a.plan.gateRef ? 'GATE ' + a.plan.gateRef : a.plan.runway ?? '')}`;
        ctx.font = 'bold 11px ui-monospace,monospace'; const w1 = ctx.measureText(a.callsign).width;
        ctx.font = '10px ui-monospace,monospace'; const w2 = ctx.measureText(sub).width;
        const bw = Math.max(w1, w2) + 12;
        ctx.strokeStyle = 'rgba(120,150,190,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x + off * 0.5, p.y); ctx.lineTo(lx - 3, ly + 12); ctx.stroke();
        rrect(ctx, lx - 3, ly - 2, bw, 28, 4);
        ctx.fillStyle = isSel ? 'rgba(20,32,54,0.96)' : 'rgba(8,14,26,0.8)'; ctx.fill();
        ctx.strokeStyle = isSel ? 'rgba(96,165,250,0.9)' : 'rgba(40,64,104,0.7)'; ctx.lineWidth = isSel ? 1.3 : 1; ctx.stroke();
        ctx.fillStyle = a.conflict ? '#ef4444' : a.plan.kind === 'departure' ? '#fbbf24' : '#38bdf8';
        ctx.fillRect(lx - 3, ly - 2, 2.5, 28);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = 'bold 11px ui-monospace,monospace'; ctx.fillStyle = '#fff'; ctx.fillText(a.callsign, lx + 5, ly + 9);
        ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = airborne ? '#7dd3fc' : (a.plan.kind === 'departure' ? '#fcd34d' : '#7dd3fc'); ctx.fillText(sub, lx + 5, ly + 22);
      }
    };
    last.current = performance.now();
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [pushRadio]);

  const setSimRate = (r: number) => { rateRef.current = r; setRate(r); };
  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };
  const quick = (verb: string) => { if (sel) submitCmd(`${sel.callsign} ${verb}`); };
  const cfg = AIRPORTS[icao];

  return (
    <div style={ST.root}>
      <div ref={mapDiv} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvas} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }} />
      <div style={ST.vignette} />

      {/* top bar */}
      <header style={ST.topbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={ST.logo}>◆</div>
          <div><div style={ST.brand}>SKYCONTROL</div><div style={ST.brandSub}>GROUND · TOWER</div></div>
        </div>
        <div style={ST.switcher}>
          {Object.keys(AIRPORTS).map(a => <button key={a} onClick={() => load(a)} style={ST.swBtn(a === icao)}>{a}</button>)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ textAlign: 'right' }}><div style={ST.apName}>{cfg.name}</div><div style={ST.apSub}>{cfg.city} · {icao}</div></div>
          <div style={ST.clock}><span style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</span><span style={ST.utc}>UTC</span></div>
        </div>
      </header>

      {/* left rail */}
      <div style={ST.leftRail}>
        <div style={ST.panel}>
          <div style={ST.pTitle}>TRAFFIC</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <St v={hud.total} l="Active" c="#e5edf7" />
            <St v={hud.gnd} l="Ground" c="#fbbf24" />
            <St v={hud.air} l="Airborne" c="#38bdf8" />
          </div>
          {hud.conf > 0 && <div style={ST.alert}>⚠ {hud.conf} CONFLICT{hud.conf > 1 ? 'S' : ''}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button onClick={() => eng.current?.spawnDeparture()} style={ST.aBtn('#1a3a6e', '#fbbf24')}>+ DEP</button>
            <button onClick={() => eng.current?.spawnArrival()} style={ST.aBtn('#13324f', '#38bdf8')}>+ ARR</button>
            <button onClick={togglePause} style={ST.aBtn('rgba(8,16,30,0.9)', '#9fb6d6')}>{paused ? '▶' : '❚❚'}</button>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {[1, 2, 4].map(r => <button key={r} onClick={() => setSimRate(r)} style={ST.rateBtn(rate === r)}>{r}×</button>)}
          </div>
        </div>
      </div>

      {/* selected detail */}
      {sel && (
        <div style={{ ...ST.detail, borderColor: sel.conflict ? 'rgba(239,68,68,0.8)' : 'rgba(50,90,150,0.6)' }}>
          <div style={ST.detailHead}>
            <div><div style={ST.dCall}>{sel.callsign}</div><div style={ST.dAir}>{sel.airline} · {sel.flightNo}</div></div>
            <button onClick={() => { setSelId(null); setSel(null); }} style={ST.close}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={ST.badge(sel.kind === 'departure' ? '#fbbf24' : '#38bdf8')}>{sel.kind.toUpperCase()}</span>
            <span style={ST.tBadge}>{sel.type} · {sel.wc}</span>
            <span style={ST.tBadge}>{PHASE_LABEL[sel.phase] ?? sel.phase}</span>
          </div>
          <div style={ST.grid}>
            <Fd l="SPEED" v={`${sel.kt} kt`} /><Fd l="HEADING" v={`${String(sel.hdg).padStart(3, '0')}°`} />
            <Fd l="ALTITUDE" v={`${sel.alt} ft`} /><Fd l={sel.kind === 'departure' ? 'RWY / DEST' : 'GATE'} v={sel.kind === 'departure' ? (sel.runway ?? sel.fix ?? '—') : (sel.gate ?? '—')} />
          </div>
          {sel.taxiRoute && sel.taxiRoute.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 7.5, letterSpacing: 1, color: '#557', marginBottom: 5 }}>TAXI ROUTE</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                {sel.taxiRoute.map((tw: string, i: number) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span style={{ color: '#3f5f8a', fontSize: 9 }}>›</span>}
                    <span style={ST.twChip}>{tw}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          <div style={ST.quickRow}>
            {sel.kind === 'departure'
              ? ['PUSHBACK', 'LINE UP', 'CLEARED TAKEOFF', 'HOLD SHORT'].map(v => <button key={v} onClick={() => quick(v)} style={ST.qBtn}>{v}</button>)
              : ['CLEARED LAND', 'TAXI TO GATE'].map(v => <button key={v} onClick={() => quick(v === 'TAXI TO GATE' && sel.gate ? `taxi ${sel.gate}` : v)} style={ST.qBtn}>{v}</button>)}
          </div>
        </div>
      )}

      {/* radio log + command console */}
      <div style={ST.console}>
        <div style={ST.radioLog} ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
          {radio.length === 0 && <div style={{ color: '#3f5f8a', fontSize: 10 }}>Radio quiet. Select an aircraft or type a command…</div>}
          {radio.map(l => (
            <div key={l.key} style={{ marginBottom: 3, fontSize: 11, lineHeight: 1.4 }}>
              <span style={{ color: l.who === 'ATC' ? '#fbbf24' : l.who === 'PILOT' ? '#7dd3fc' : '#6b8bb0', fontWeight: 700, marginRight: 6 }}>{l.who === 'ATC' ? '▸ ATC' : l.who === 'PILOT' ? '◂ PIL' : '• SYS'}</span>
              <span style={{ color: l.who === 'SYS' ? '#8aa6c8' : '#dce7f4' }}>{l.text}</span>
            </div>
          ))}
        </div>
        <form onSubmit={ev => { ev.preventDefault(); submitCmd(cmd); }} style={ST.cmdRow}>
          <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 12 }}>›</span>
          <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder={sel ? `${sel.callsign} taxi ${sel.runway ?? '27L'} via A B` : 'CALLSIGN TAXI 27L VIA A B'} style={ST.cmdInput} spellCheck={false} autoComplete="off" />
          <button type="submit" style={ST.sendBtn}>SEND</button>
        </form>
      </div>

      {/* telemetry */}
      <footer style={ST.bottom}>
        <span style={ST.tel}><b style={ST.telK}>APT</b> {icao}</span>
        <span style={ST.tel}><b style={ST.telK}>SIM</b> {rate}× {paused ? '⏸' : '▶'}</span>
        <span style={{ flex: 1 }} />
        <span style={ST.tel}><span style={ST.live} /> LIVE SIMULATION ENGINE</span>
        <span style={ST.tel}>{hud.total} ACFT · {hud.dep} DEP / {hud.arr} ARR</span>
      </footer>

      {loading && <div style={ST.load}><div style={ST.spin} /><div style={ST.loadT}>INITIALISING GROUND CONTROL</div><div style={ST.loadS}>{cfg.name} · {icao}</div></div>}

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
        *{box-sizing:border-box} .maplibregl-ctrl-attrib{display:none!important}
        .maplibregl-ctrl-bottom-right{bottom:60px!important;right:8px!important}
        .maplibregl-ctrl-group{background:rgba(7,13,24,.92)!important;border:1px solid rgba(30,56,96,.7)!important;border-radius:8px!important}
        .maplibregl-ctrl-group button{background:transparent!important}
        .maplibregl-ctrl-group button span{filter:invert(.4) sepia(1) saturate(.6) hue-rotate(185deg)}
        input::placeholder{color:#3f5f8a}
      `}</style>
    </div>
  );
}

function St({ v, l, c }: { v: number; l: string; c: string }) {
  return <div style={{ flex: 1 }}><div style={{ fontSize: 21, fontWeight: 800, color: c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{v}</div><div style={{ fontSize: 7.5, color: '#4a6a90', letterSpacing: 1, marginTop: 3 }}>{l.toUpperCase()}</div></div>;
}
function Fd({ l, v }: { l: string; v: string }) {
  return <div><div style={{ fontSize: 7.5, letterSpacing: 1, color: '#557', marginBottom: 2 }}>{l}</div><div style={{ fontSize: 13, fontWeight: 700, color: '#dce7f4', fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>;
}
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const mono = "ui-monospace,'SF Mono','Courier New',monospace";
const ST: Record<string, any> = {
  root: { width: '100vw', height: '100vh', background: '#070d18', position: 'relative', overflow: 'hidden', fontFamily: mono, userSelect: 'none' },
  vignette: { position: 'absolute', inset: 0, zIndex: 11, pointerEvents: 'none', boxShadow: 'inset 0 0 200px 40px rgba(0,0,0,0.55)' },
  topbar: { position: 'absolute', top: 0, left: 0, right: 0, height: 52, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', background: 'linear-gradient(180deg,rgba(6,11,21,.95),rgba(6,11,21,.78))', borderBottom: '1px solid rgba(30,56,96,.6)', backdropFilter: 'blur(10px)' },
  logo: { width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,#1e3a6e,#0c1830)', border: '1px solid rgba(80,130,200,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fbbf24', fontSize: 14 },
  brand: { fontSize: 13, fontWeight: 800, letterSpacing: 3, color: '#eaf1fb', lineHeight: 1 },
  brandSub: { fontSize: 7.5, letterSpacing: 2.5, color: '#4f719c', marginTop: 2 },
  switcher: { display: 'flex', gap: 3, background: 'rgba(6,12,22,.7)', padding: 3, borderRadius: 9, border: '1px solid rgba(28,52,90,.6)' },
  swBtn: (on: boolean) => ({ padding: '6px 13px', fontSize: 10, fontFamily: mono, letterSpacing: 1.5, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none', background: on ? 'linear-gradient(180deg,#1e457f,#15315c)' : 'transparent', color: on ? '#fde68a' : '#5577a0' }),
  apName: { fontSize: 12, fontWeight: 700, color: '#dce7f4', lineHeight: 1 },
  apSub: { fontSize: 8.5, color: '#4f719c', marginTop: 3 },
  clock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', background: 'rgba(6,12,22,.7)', border: '1px solid rgba(28,52,90,.6)', borderRadius: 8, padding: '5px 10px' },
  utc: { fontSize: 7, letterSpacing: 2, color: '#4f719c', marginTop: 1 },
  leftRail: { position: 'absolute', top: 66, left: 14, zIndex: 25, width: 210 },
  panel: { background: 'rgba(7,13,24,.86)', border: '1px solid rgba(30,56,96,.55)', borderRadius: 11, padding: '11px 13px', backdropFilter: 'blur(12px)', boxShadow: '0 6px 22px rgba(0,0,0,.4)' },
  pTitle: { fontSize: 8.5, letterSpacing: 2.5, color: '#4f719c', fontWeight: 700, marginBottom: 9 },
  alert: { marginTop: 8, fontSize: 10, fontWeight: 800, letterSpacing: 1, color: '#fff', background: 'rgba(190,30,30,0.85)', borderRadius: 6, padding: '5px 8px', textAlign: 'center', animation: 'pulse 1s infinite' },
  aBtn: (bg: string, fg: string) => ({ flex: 1, padding: '8px 0', fontSize: 10, fontFamily: mono, fontWeight: 700, letterSpacing: 1, color: fg, background: bg, border: '1px solid rgba(40,70,120,.5)', borderRadius: 7, cursor: 'pointer' }),
  rateBtn: (on: boolean) => ({ flex: 1, padding: '5px 0', fontSize: 9, fontFamily: mono, fontWeight: 700, color: on ? '#fde68a' : '#5577a0', background: on ? 'rgba(24,52,104,.9)' : 'rgba(8,16,30,.8)', border: '1px solid rgba(30,56,96,.6)', borderRadius: 6, cursor: 'pointer' }),
  detail: { position: 'absolute', top: 66, right: 14, zIndex: 26, width: 252, background: 'rgba(7,13,24,.93)', border: '1px solid rgba(50,90,150,.6)', borderRadius: 13, padding: 14, backdropFilter: 'blur(14px)', boxShadow: '0 10px 36px rgba(0,0,0,.55)' },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  dCall: { fontSize: 19, fontWeight: 800, color: '#fff', letterSpacing: 1, lineHeight: 1 },
  dAir: { fontSize: 10, color: '#6f8db4', marginTop: 4 },
  close: { background: 'rgba(30,50,80,.5)', border: 'none', color: '#8aa6c8', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  badge: (c: string) => ({ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#07101e', background: c, padding: '3px 9px', borderRadius: 5 }),
  tBadge: { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: '#bcd0ea', background: 'rgba(30,52,86,.8)', padding: '3px 9px', borderRadius: 5, border: '1px solid rgba(50,80,130,.6)' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 10px', marginBottom: 12 },
  twChip: { fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#f6c43a', background: 'rgba(40,32,6,0.9)', border: '1px solid rgba(120,95,20,0.7)', borderRadius: 4, padding: '2px 7px', fontFamily: mono },
  quickRow: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  qBtn: { fontSize: 9, fontFamily: mono, fontWeight: 700, letterSpacing: 0.5, color: '#cfe0f5', background: 'rgba(20,40,70,.85)', border: '1px solid rgba(50,85,140,.6)', borderRadius: 6, padding: '6px 8px', cursor: 'pointer' },
  console: { position: 'absolute', bottom: 34, left: 14, zIndex: 26, width: 340, background: 'rgba(6,11,21,.9)', border: '1px solid rgba(30,56,96,.6)', borderRadius: 12, overflow: 'hidden', backdropFilter: 'blur(12px)', boxShadow: '0 8px 28px rgba(0,0,0,.5)' },
  radioLog: { maxHeight: 168, overflowY: 'auto', padding: '10px 12px' },
  cmdRow: { display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid rgba(30,56,96,.6)', padding: '8px 10px', background: 'rgba(4,9,18,.6)' },
  cmdInput: { flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#eaf1fb', fontFamily: mono, fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase' },
  sendBtn: { fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#07101e', background: '#fbbf24', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer' },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 26, zIndex: 30, display: 'flex', alignItems: 'center', gap: 18, padding: '0 14px', background: 'rgba(6,11,21,.94)', borderTop: '1px solid rgba(30,56,96,.6)', fontSize: 9.5, color: '#6f8db4' },
  tel: { display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' },
  telK: { color: '#3f5f8a', fontWeight: 700, letterSpacing: 1 },
  live: { width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e', animation: 'pulse 1.6s infinite' },
  load: { position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'rgba(5,10,18,.72)', backdropFilter: 'blur(3px)' },
  spin: { width: 42, height: 42, borderRadius: '50%', border: '3px solid rgba(60,100,160,.25)', borderTopColor: '#fbbf24', animation: 'spin .9s linear infinite' },
  loadT: { fontSize: 12, letterSpacing: 3, color: '#cdddf2', fontWeight: 700 },
  loadS: { fontSize: 10, letterSpacing: 1, color: '#5f7da6' },
};
