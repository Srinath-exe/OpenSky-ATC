'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ATC_AIRPORTS } from '@/components/atc/simStore';
import { RUNWAY_MANIFEST } from '@/lib/runwayManifest';
import type { WeightClass } from '@/lib/sim/aircraftDB';

const START_CFG_KEY = 'skycontrol_start_config';
const WEIGHTS: WeightClass[] = ['L', 'M', 'H', 'S'];
const WEIGHT_LABEL: Record<WeightClass, string> = { L: 'Light', M: 'Medium', H: 'Heavy', S: 'Super' };

function defaultWeights(lengthFt: number): Set<WeightClass> {
  if (lengthFt >= 10000) return new Set(['L', 'M', 'H', 'S']);
  if (lengthFt >= 7500) return new Set(['L', 'M', 'H']);
  if (lengthFt >= 5500) return new Set(['L', 'M']);
  return new Set(['L']);
}

interface RunwayCfg { ends: Record<string, boolean>; weights: Set<WeightClass>; }

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8z" fill="currentColor" opacity="0.9" />
      <circle cx="12" cy="10" r="3" fill="#05080d" />
    </svg>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [icao, setIcao] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Record<string, RunwayCfg>>({});

  const runways = icao ? (RUNWAY_MANIFEST[icao] ?? []) : [];

  const selectAirport = (code: string) => {
    setIcao(code);
    const rws = RUNWAY_MANIFEST[code] ?? [];
    const next: Record<string, RunwayCfg> = {};
    for (const r of rws) {
      next[r.ref] = {
        ends: { [r.ends[0].name]: true, [r.ends[1].name]: true },
        weights: defaultWeights(r.lengthFt),
      };
    }
    setCfg(next);
  };

  const toggleEnd = (ref: string, end: string) => {
    setCfg(c => ({ ...c, [ref]: { ...c[ref], ends: { ...c[ref].ends, [end]: !c[ref].ends[end] } } }));
  };
  const toggleWeight = (ref: string, w: WeightClass) => {
    setCfg(c => {
      const cur = new Set(c[ref].weights);
      if (cur.has(w)) cur.delete(w); else cur.add(w);
      return { ...c, [ref]: { ...c[ref], weights: cur } };
    });
  };

  const anyOpen = icao && runways.some(r => Object.values(cfg[r.ref]?.ends ?? {}).some(Boolean));

  const start = () => {
    if (!icao) return;
    const ends: string[] = [];
    const weights: Record<string, WeightClass[]> = {};
    for (const r of runways) {
      const c = cfg[r.ref]; if (!c) continue;
      for (const e of r.ends) {
        if (c.ends[e.name]) { ends.push(e.name); weights[e.name] = Array.from(c.weights); }
      }
    }
    localStorage.setItem(START_CFG_KEY, JSON.stringify({ icao, ends, weights }));
    router.push('/atc');
  };

  const info = icao ? ATC_AIRPORTS[icao] : null;

  return (
    <>
      <style>{CSS}</style>
      <div className="home-root">
        <header className="home-header">
          <div className="home-brand">
            <div className="home-brand-mark">◆</div>
            <div>
              <div className="home-brand-name">SKYCONTROL</div>
              <div className="home-brand-sub">AIR TRAFFIC CONTROL SIMULATOR</div>
            </div>
          </div>
          <Link href="/settings" className="home-settings-link">⚙ Settings</Link>
        </header>

        <main className="home-main">
          {!icao && (
            <>
              <h1 className="home-title">Choose an airport</h1>
              <p className="home-subtitle">Pick a field, set your active runways, and take control.</p>
              <div className="airport-grid">
                {Object.entries(ATC_AIRPORTS).map(([code, a]) => (
                  <button key={code} className="airport-card" onClick={() => selectAirport(code)}>
                    <div className="airport-card-img" style={{ backgroundImage: `url(/maps/satellite/${code}.jpg)` }} />
                    <div className="airport-card-body">
                      <div className="airport-card-name">{a.name}</div>
                      <div className="airport-card-loc"><PinIcon />{a.city}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {icao && info && (
            <div className="detail-panel">
              <button className="back-link" onClick={() => setIcao(null)}>← Change airport</button>

              <div className="detail-hero" style={{ backgroundImage: `url(/maps/satellite/${icao}.jpg)` }}>
                <div className="detail-hero-fade" />
                <div className="detail-hero-text">
                  <div className="detail-title">{info.name}</div>
                  <div className="detail-loc"><PinIcon />{info.city} · {icao}</div>
                </div>
              </div>

              <div className="rwy-section">
                <div className="rwy-section-title">ACTIVE RUNWAYS</div>
                <div className="rwy-section-hint">Toggle each direction on/off, and pick which aircraft weight classes may use it.</div>

                <div className="rwy-list">
                  {runways.map(r => {
                    const c = cfg[r.ref]; if (!c) return null;
                    return (
                      <div key={r.ref} className="rwy-row">
                        <button
                          className={`rwy-end${c.ends[r.ends[0].name] ? ' rwy-end-active' : ''}`}
                          onClick={() => toggleEnd(r.ref, r.ends[0].name)}
                        >{r.ends[0].name}</button>

                        <div className="rwy-weights">
                          {WEIGHTS.map(w => (
                            <button
                              key={w}
                              className={`rwy-weight${c.weights.has(w) ? ' rwy-weight-active' : ''}`}
                              title={WEIGHT_LABEL[w]}
                              onClick={() => toggleWeight(r.ref, w)}
                            >{w}</button>
                          ))}
                        </div>

                        <button
                          className={`rwy-end${c.ends[r.ends[1].name] ? ' rwy-end-active' : ''}`}
                          onClick={() => toggleEnd(r.ref, r.ends[1].name)}
                        >{r.ends[1].name}</button>

                        <span className="rwy-length">{r.lengthFt.toLocaleString()} ft</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <button className="start-btn" disabled={!anyOpen} onClick={start}>
                {anyOpen ? 'START SIMULATION' : 'OPEN AT LEAST ONE RUNWAY'}
              </button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

const CSS = `
  :root {
    --bg: #05080d; --panel: #0a0f1a; --panel2: #0c1420;
    --border: rgba(40,70,130,.28); --border2: rgba(40,70,130,.5);
    --text: #cbd5e1; --muted: #64748b; --dim: #1e3a5f;
    --blue: #3b82f6; --green: #22c55e;
    --ui-font: ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono: ui-monospace,'JetBrains Mono','Fira Code','SF Mono',monospace;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  .home-root { min-height: 100vh; background: radial-gradient(ellipse at 50% 0%, #0b1526 0%, #05080d 55%); font-family: var(--ui-font); color: var(--text); }

  .home-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 32px; border-bottom: 1px solid var(--border);
  }
  .home-brand { display: flex; align-items: center; gap: 12px; }
  .home-brand-mark {
    width: 36px; height: 36px; border-radius: 10px;
    background: linear-gradient(145deg,#152a5c,#0a1530);
    border: 1px solid rgba(80,130,240,.3);
    display: flex; align-items: center; justify-content: center;
    color: #f59e0b; font-size: 15px; box-shadow: 0 0 14px rgba(59,130,246,.15);
  }
  .home-brand-name { font-size: 15px; font-weight: 800; letter-spacing: 3px; color: var(--text); line-height: 1.3; }
  .home-brand-sub { font-size: 9px; letter-spacing: 1.5px; color: var(--muted); }
  .home-settings-link {
    color: var(--muted); text-decoration: none; font-size: 13px;
    padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px;
    transition: color .15s, border-color .15s;
  }
  .home-settings-link:hover { color: var(--text); border-color: var(--border2); }

  .home-main { max-width: 1080px; margin: 0 auto; padding: 48px 32px 80px; }
  .home-title { font-size: 32px; font-weight: 800; margin: 0 0 8px; letter-spacing: -0.5px; }
  .home-subtitle { color: var(--muted); font-size: 15px; margin: 0 0 32px; }

  .airport-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 18px; }
  .airport-card {
    position: relative; height: 170px; border-radius: 14px; overflow: hidden;
    border: 1px solid var(--border); background: var(--panel); cursor: pointer;
    padding: 0; text-align: left; transition: border-color .15s, transform .15s;
  }
  .airport-card:hover { border-color: var(--blue); transform: translateY(-2px); }
  .airport-card-img {
    position: absolute; inset: 0; background-size: cover; background-position: center;
    filter: saturate(1.05) brightness(0.75);
  }
  .airport-card-body {
    position: absolute; inset: auto 0 0 0; padding: 14px 16px;
    background: linear-gradient(0deg, rgba(4,7,13,.95) 10%, rgba(4,7,13,0) 100%);
  }
  .airport-card-name { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px; }
  .airport-card-loc { font-size: 12px; color: #b8c4d9; display: flex; align-items: center; gap: 5px; }

  .detail-panel { animation: fadein .25s ease; }
  @keyframes fadein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .back-link {
    background: none; border: none; color: var(--muted); font-size: 13px; cursor: pointer;
    padding: 0; margin-bottom: 16px; font-family: var(--ui-font);
  }
  .back-link:hover { color: var(--text); }

  .detail-hero {
    position: relative; height: 220px; border-radius: 16px; overflow: hidden;
    background-size: cover; background-position: center; border: 1px solid var(--border);
    margin-bottom: 28px;
  }
  .detail-hero-fade { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(4,7,13,.92) 15%, rgba(4,7,13,.15) 100%); }
  .detail-hero-text { position: absolute; inset: auto 0 0 0; padding: 20px 24px; }
  .detail-title { font-size: 26px; font-weight: 800; color: #fff; letter-spacing: -0.4px; }
  .detail-loc { font-size: 13px; color: #b8c4d9; display: flex; align-items: center; gap: 6px; margin-top: 4px; }

  .rwy-section-title { font-size: 11px; letter-spacing: 2px; color: var(--muted); font-weight: 700; margin-bottom: 4px; }
  .rwy-section-hint { font-size: 12.5px; color: var(--muted); margin-bottom: 16px; }

  .rwy-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 32px; }
  .rwy-row {
    display: flex; align-items: center; gap: 10px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 14px;
  }
  .rwy-end {
    font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: 0.5px;
    color: var(--muted); background: rgba(10,20,35,.7); border: 1px solid var(--border);
    border-radius: 7px; padding: 7px 12px; cursor: pointer; min-width: 52px; text-align: center;
    transition: all .15s;
  }
  .rwy-end-active { color: #fff; background: linear-gradient(135deg,#1d4ed8,#1e40af); border-color: rgba(96,165,250,.6); box-shadow: 0 0 10px rgba(59,130,246,.25); }

  .rwy-weights { display: flex; gap: 5px; flex: 1; justify-content: center; }
  .rwy-weight {
    font-family: var(--mono); font-size: 11px; font-weight: 700;
    color: var(--muted); background: rgba(10,20,35,.7); border: 1px solid var(--border);
    border-radius: 6px; width: 28px; height: 28px; cursor: pointer; transition: all .15s;
  }
  .rwy-weight-active { color: #05080d; background: #f59e0b; border-color: #f59e0b; }

  .rwy-length { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 64px; text-align: right; }

  .start-btn {
    width: 100%; padding: 16px; border-radius: 12px; border: none; cursor: pointer;
    font-family: var(--ui-font); font-size: 14px; font-weight: 800; letter-spacing: 2px;
    background: linear-gradient(135deg,#2563eb,#1d4ed8); color: #fff;
    box-shadow: 0 4px 20px rgba(37,99,235,.35); transition: transform .15s, opacity .15s;
  }
  .start-btn:hover:not(:disabled) { transform: translateY(-1px); }
  .start-btn:disabled { background: var(--panel2); color: var(--muted); box-shadow: none; cursor: not-allowed; }
`;
