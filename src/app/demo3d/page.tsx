'use client';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { sim } from '@/components/atc/simStore';
import { isAirborne } from '@/lib/sim/aircraft';

const Ground3DView = dynamic(() => import('@/components/atc/Ground3DView'), { ssr: false });

function snapshot() {
  return sim.radio.length + (sim.selectedId ?? -1) * 1e6 + (sim.loading ? 1 : 0) * 1e9
    + Math.floor((sim.engine?.time ?? 0) * 2) * 13;
}
function useSim() { return useSyncExternalStore(cb => sim.subscribe(cb), snapshot, () => 0); }

const VIEWS = [
  { key: 'tower',  label: 'TOWER',   pitch: 72, bearing: -22 },
  { key: 'apron',  label: 'APRON',   pitch: 60, bearing: 40 },
  { key: 'ortho',  label: 'ORTHO',   pitch: 30, bearing: 0 },
  { key: 'flat',   label: 'FLAT',    pitch: 0,  bearing: 0 },
] as const;

export default function Demo3DPage() {
  useSim();
  const [view, setView] = useState<typeof VIEWS[number]['key']>('tower');
  const [follow, setFollow] = useState(false);

  useEffect(() => {
    if (!sim.engine && !sim.loading) sim.load('KSFO');
  }, []);

  const v = VIEWS.find(x => x.key === view)!;
  const e = sim.engine;
  const sel = e && sim.selectedId != null ? e.byId(sim.selectedId) : null;
  const stats = e ? e.stats() : { total: 0, air: 0, gnd: 0, conf: 0, dep: 0, arr: 0 };

  return (
    <>
      <style>{CSS}</style>
      <div className="d3-root">
        <Ground3DView pitch={v.pitch} bearing={v.bearing} follow={follow} />

        {sim.loading && <div className="d3-loading">Loading San Francisco Intl…</div>}

        <div className="d3-top">
          <Link href="/" className="d3-back">←</Link>
          <div>
            <div className="d3-title">SAN FRANCISCO INTL · KSFO</div>
            <div className="d3-sub">3D GROUND VIEW — TIER 1 PROTOTYPE</div>
          </div>
        </div>

        <div className="d3-panel">
          <div className="d3-label">CAMERA</div>
          <div className="d3-seg">
            {VIEWS.map(x => (
              <button key={x.key} className={`d3-segbtn${view === x.key ? ' d3-on' : ''}`} onClick={() => setView(x.key)}>{x.label}</button>
            ))}
          </div>

          <button className={`d3-follow${follow ? ' d3-on' : ''}`} onClick={() => setFollow(f => !f)}>
            {follow ? '● FOLLOWING SELECTED' : '○ FOLLOW SELECTED'}
          </button>

          <div className="d3-stats">
            <div><b>{stats.total}</b><span>TOTAL</span></div>
            <div><b style={{ color: '#4ade80' }}>{stats.air}</b><span>AIR</span></div>
            <div><b style={{ color: '#fbbf24' }}>{stats.gnd}</b><span>GND</span></div>
          </div>

          {sel && (
            <div className="d3-sel">
              <div className="d3-selcs">{sel.callsign}</div>
              <div className="d3-selrow"><span>{sel.perf.icaoCode}</span><span>{sel.perf.weightClass}</span></div>
              <div className="d3-selrow"><span>ALT</span><b>{Math.round(sel.altitude).toLocaleString()} ft</b></div>
              <div className="d3-selrow"><span>SPD</span><b>{Math.round(sel.speed)} kt</b></div>
              <div className="d3-selrow"><span>HDG</span><b>{String(Math.round(sel.heading) % 360).padStart(3, '0')}°</b></div>
              <div className="d3-selrow"><span>PHASE</span><b>{isAirborne(sel) ? 'AIRBORNE' : 'GROUND'}</b></div>
            </div>
          )}
          {!sel && <div className="d3-hint">Click an aircraft to select it.</div>}

          <div className="d3-note">
            Buildings extruded from OSM footprints · aircraft are live sim state
            rendered as real 3D bodies (altitude drives extrusion base).
          </div>
        </div>
      </div>
    </>
  );
}

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #05070a; }
  .d3-root { position: fixed; inset: 0; font-family: ui-sans-serif,system-ui,sans-serif; color: #cbd5e1; }

  .d3-loading {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: #05070a; z-index: 20; color: #64748b; font-size: 14px; letter-spacing: 1px;
  }

  .d3-top {
    position: absolute; top: 16px; left: 16px; z-index: 10;
    display: flex; align-items: center; gap: 12px;
    background: rgba(6,11,20,.86); backdrop-filter: blur(10px);
    border: 1px solid rgba(40,70,130,.4); border-radius: 12px; padding: 12px 18px 12px 12px;
  }
  .d3-back {
    width: 30px; height: 30px; border-radius: 8px; text-decoration: none;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(40,70,130,.4); color: #94a3b8; font-size: 15px;
  }
  .d3-back:hover { color: #fff; }
  .d3-title { font-size: 13px; font-weight: 800; letter-spacing: 2px; color: #e2e8f0; }
  .d3-sub { font-size: 8.5px; letter-spacing: 1.4px; color: #64748b; margin-top: 3px; }

  .d3-panel {
    position: absolute; top: 16px; right: 16px; width: 232px; z-index: 10;
    background: rgba(6,11,20,.86); backdrop-filter: blur(10px);
    border: 1px solid rgba(40,70,130,.4); border-radius: 12px; padding: 14px;
  }
  .d3-label { font-size: 8.5px; letter-spacing: 1.6px; color: #64748b; font-weight: 700; margin-bottom: 7px; }

  .d3-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 10px; }
  .d3-segbtn {
    font-family: inherit; font-size: 9.5px; font-weight: 700; letter-spacing: 1px;
    color: #64748b; background: rgba(10,20,35,.8); border: 1px solid rgba(40,70,130,.35);
    border-radius: 7px; padding: 8px 0; cursor: pointer;
  }
  .d3-on { color: #fff !important; background: linear-gradient(135deg,#2563eb,#1d4ed8) !important; border-color: rgba(96,165,250,.6) !important; }

  .d3-follow {
    width: 100%; font-family: inherit; font-size: 9.5px; font-weight: 700; letter-spacing: .8px;
    color: #64748b; background: rgba(10,20,35,.8); border: 1px solid rgba(40,70,130,.35);
    border-radius: 7px; padding: 9px 0; cursor: pointer; margin-bottom: 12px;
  }

  .d3-stats { display: flex; gap: 6px; margin-bottom: 12px; }
  .d3-stats > div {
    flex: 1; background: rgba(10,20,35,.7); border: 1px solid rgba(40,70,130,.3);
    border-radius: 8px; padding: 8px 0; text-align: center;
  }
  .d3-stats b { display: block; font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .d3-stats span { font-size: 7.5px; letter-spacing: 1px; color: #64748b; }

  .d3-sel { background: rgba(10,20,35,.7); border: 1px solid rgba(40,70,130,.3); border-radius: 9px; padding: 11px; }
  .d3-selcs { font-family: ui-monospace,monospace; font-size: 14px; font-weight: 700; color: #fde68a; margin-bottom: 8px; }
  .d3-selrow { display: flex; justify-content: space-between; font-size: 10.5px; padding: 3px 0; color: #64748b; }
  .d3-selrow b { color: #cbd5e1; font-variant-numeric: tabular-nums; font-family: ui-monospace,monospace; }
  .d3-hint { font-size: 10.5px; color: #475569; text-align: center; padding: 10px 0; }

  .d3-note { font-size: 9px; line-height: 1.5; color: #475569; margin-top: 12px; border-top: 1px solid rgba(40,70,130,.28); padding-top: 10px; }
`;
