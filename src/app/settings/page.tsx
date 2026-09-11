'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { sim, LS_KEYS } from '@/components/atc/simStore';

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  return v == null ? fallback : v === '1';
}
function readStr<T extends string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  return (localStorage.getItem(key) as T) ?? fallback;
}

export default function SettingsPage() {
  const [tts, setTts] = useState(() => readBool(LS_KEYS.tts, false));
  const [autoTower, setAutoTower] = useState(() => readBool(LS_KEYS.autoTower, true));
  const [groundTheme, setGroundTheme] = useState<'chart' | 'satellite'>(() => readStr(LS_KEYS.groundTheme, 'satellite'));
  const [highScore, setHighScore] = useState(() => {
    if (typeof window === 'undefined') return 0;
    return parseInt(localStorage.getItem(LS_KEYS.score) ?? '0', 10);
  });
  const [resetMsg, setResetMsg] = useState('');

  const toggleTts = () => {
    const next = !tts;
    setTts(next);
    localStorage.setItem(LS_KEYS.tts, next ? '1' : '0');
    sim.tts = next; // keep the live singleton in sync if a sim is already running
  };
  const toggleAutoTower = () => {
    const next = !autoTower;
    setAutoTower(next);
    localStorage.setItem(LS_KEYS.autoTower, next ? '1' : '0');
    if (sim.engine) sim.engine.autoTower = next;
  };
  const setTheme = (t: 'chart' | 'satellite') => {
    setGroundTheme(t);
    localStorage.setItem(LS_KEYS.groundTheme, t);
  };
  const resetScore = () => {
    localStorage.setItem(LS_KEYS.score, '0');
    setHighScore(0);
    sim.highScore = 0;
    setResetMsg('High score reset.');
    setTimeout(() => setResetMsg(''), 2000);
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="set-root">
        <header className="set-header">
          <Link href="/" className="set-brand">
            <div className="set-brand-mark">◆</div>
            <div>
              <div className="set-brand-name">SKYCONTROL</div>
              <div className="set-brand-sub">SETTINGS</div>
            </div>
          </Link>
          <Link href="/" className="set-back">← Home</Link>
        </header>

        <main className="set-main">
          <section className="set-section">
            <div className="set-section-title">SIMULATION</div>

            <div className="set-row">
              <div>
                <div className="set-row-label">Auto-tower</div>
                <div className="set-row-hint">Automatically clears waiting departures when the runway is free.</div>
              </div>
              <button className={`set-toggle${autoTower ? ' set-toggle-on' : ''}`} onClick={toggleAutoTower}>
                <span className="set-toggle-knob" />
              </button>
            </div>

            <div className="set-row">
              <div>
                <div className="set-row-label">Pilot text-to-speech</div>
                <div className="set-row-hint">Speaks pilot readbacks aloud using your browser's voice synthesis.</div>
              </div>
              <button className={`set-toggle${tts ? ' set-toggle-on' : ''}`} onClick={toggleTts}>
                <span className="set-toggle-knob" />
              </button>
            </div>

            <div className="set-row">
              <div>
                <div className="set-row-label">Default ground map look</div>
                <div className="set-row-hint">Which style the Ground view opens in — can still be changed per-session.</div>
              </div>
              <div className="seg-ctrl">
                <button className={`seg-btn${groundTheme === 'satellite' ? ' seg-active' : ''}`} onClick={() => setTheme('satellite')}>SATELLITE</button>
                <button className={`seg-btn${groundTheme === 'chart' ? ' seg-active' : ''}`} onClick={() => setTheme('chart')}>CHART</button>
              </div>
            </div>
          </section>

          <section className="set-section">
            <div className="set-section-title">DATA</div>
            <div className="set-row">
              <div>
                <div className="set-row-label">High score</div>
                <div className="set-row-hint">Best score reached across all sessions: <b>{highScore}</b></div>
              </div>
              <button className="set-danger-btn" onClick={resetScore}>Reset</button>
            </div>
            {resetMsg && <div className="set-confirm">{resetMsg}</div>}
          </section>

          <Link href="/" className="set-start-link">← Back to airport selection</Link>
        </main>
      </div>
    </>
  );
}

const CSS = `
  :root {
    --bg: #05080d; --panel: #0a0f1a; --panel2: #0c1420;
    --border: rgba(40,70,130,.28); --border2: rgba(40,70,130,.5);
    --text: #cbd5e1; --muted: #64748b;
    --blue: #3b82f6; --red: #ef4444;
    --ui-font: ui-sans-serif,system-ui,-apple-system,sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  .set-root { min-height: 100vh; background: radial-gradient(ellipse at 50% 0%, #0b1526 0%, #05080d 55%); font-family: var(--ui-font); color: var(--text); }

  .set-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 32px; border-bottom: 1px solid var(--border); }
  .set-brand { display: flex; align-items: center; gap: 12px; text-decoration: none; }
  .set-brand-mark {
    width: 36px; height: 36px; border-radius: 10px;
    background: linear-gradient(145deg,#152a5c,#0a1530);
    border: 1px solid rgba(80,130,240,.3);
    display: flex; align-items: center; justify-content: center;
    color: #f59e0b; font-size: 15px; box-shadow: 0 0 14px rgba(59,130,246,.15);
  }
  .set-brand-name { font-size: 15px; font-weight: 800; letter-spacing: 3px; color: var(--text); line-height: 1.3; }
  .set-brand-sub { font-size: 9px; letter-spacing: 1.5px; color: var(--muted); }
  .set-back { color: var(--muted); text-decoration: none; font-size: 13px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; transition: color .15s, border-color .15s; }
  .set-back:hover { color: var(--text); border-color: var(--border2); }

  .set-main { max-width: 720px; margin: 0 auto; padding: 40px 32px 80px; }
  .set-section { margin-bottom: 36px; }
  .set-section-title { font-size: 11px; letter-spacing: 2px; color: var(--muted); font-weight: 700; margin-bottom: 14px; }

  .set-row {
    display: flex; align-items: center; justify-content: space-between; gap: 20px;
    padding: 16px 18px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; margin-bottom: 8px;
  }
  .set-row-label { font-size: 14px; font-weight: 600; color: var(--text); }
  .set-row-hint { font-size: 12.5px; color: var(--muted); margin-top: 3px; max-width: 420px; }

  .set-toggle {
    width: 44px; height: 26px; border-radius: 13px; border: 1px solid var(--border);
    background: rgba(10,20,35,.8); cursor: pointer; position: relative; flex-shrink: 0;
    transition: background .15s, border-color .15s;
  }
  .set-toggle-on { background: linear-gradient(135deg,#2563eb,#1d4ed8); border-color: rgba(96,165,250,.6); }
  .set-toggle-knob {
    position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
    background: #cbd5e1; transition: transform .15s;
  }
  .set-toggle-on .set-toggle-knob { transform: translateX(18px); background: #fff; }

  .seg-ctrl { display: flex; gap: 3px; background: rgba(5,10,20,.8); border: 1px solid var(--border); border-radius: 8px; padding: 3px; }
  .seg-btn { font-family: var(--ui-font); font-size: 10.5px; font-weight: 700; letter-spacing: 0.5px; color: var(--muted); background: none; border: none; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
  .seg-active { color: #fff; background: linear-gradient(135deg,#2563eb,#1d4ed8); }

  .set-danger-btn {
    font-family: var(--ui-font); font-size: 12.5px; font-weight: 700; color: var(--red);
    background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.3); border-radius: 8px;
    padding: 9px 16px; cursor: pointer; flex-shrink: 0; transition: background .15s;
  }
  .set-danger-btn:hover { background: rgba(239,68,68,.16); }
  .set-confirm { font-size: 12px; color: var(--blue); margin-top: -2px; padding-left: 4px; }

  .set-start-link { display: inline-block; color: var(--muted); text-decoration: none; font-size: 13px; margin-top: 8px; }
  .set-start-link:hover { color: var(--text); }
`;
