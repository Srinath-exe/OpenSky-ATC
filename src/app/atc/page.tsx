'use client';
import React, { useEffect, useRef, useState, useSyncExternalStore, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { sim, ATC_AIRPORTS } from '@/components/atc/simStore';
import { isAirborne } from '@/lib/sim/aircraft';
import type { AircraftState } from '@/lib/sim/types';

const GroundView   = dynamic(() => import('@/components/atc/GroundView'),   { ssr: false });
const ApproachView = dynamic(() => import('@/components/atc/ApproachView'), { ssr: false });

// Shallow snapshot for useSyncExternalStore — recomputes on any meaningful change.
// Math.floor(time*2) changes twice per sim-second → sidebar ALT/SPD/HDG stay live.
function snapshot() {
  return (
    sim.radio.length +
    (sim.selectedId ?? -1) * 1e6 +
    (sim.loading ? 1 : 0) * 1e9 +
    (sim.paused  ? 1 : 0) * 5e8 +
    sim.rate * 1e7 +
    Math.floor((sim.engine?.time ?? 0) * 2) * 13
  );
}
function useSim() { return useSyncExternalStore(cb => sim.subscribe(cb), snapshot, () => 0); }

const PAD = (n: number) => String(n).padStart(2, '0');
const FMT = (n: number) => Math.round(n).toLocaleString('en');
const HDG = (n: number) => String(((Math.round(n) + 360) % 360) || 360).padStart(3, '0');

const PHASE_LABEL: Record<string, [string, string]> = {
  parked:      ['PKD', '#64748b'],
  pushback:    ['PBK', '#94a3b8'],
  taxi:        ['TXI', '#a3e635'],
  hold_short:  ['HLD', '#fb923c'],
  lineup:      ['LNU', '#fbbf24'],
  takeoff:     ['T/O', '#f59e0b'],
  climb:       ['CLB', '#34d399'],
  cruise:      ['CRZ', '#22c55e'],
  descent:     ['DSC', '#60a5fa'],
  approach:    ['APP', '#818cf8'],
  landing:     ['FNL', '#a78bfa'],
  rollout:     ['RLO', '#c084fc'],
  arrived:     ['ARR', '#6b7280'],
  departed:    ['DEP', '#6b7280'],
};

export default function AtcPage() {
  useSim();
  const [mode, setMode] = useState<'GROUND' | 'APPROACH'>('APPROACH');
  const [cmd,  setCmd]  = useState('');
  const [clock, setClock] = useState('--:--:--');
  const logRef = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<HTMLInputElement>(null);

  // Boot
  useEffect(() => { if (!sim.engine && !sim.loading) sim.load('EGLL'); }, []);

  // UTC clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(`${PAD(d.getUTCHours())}:${PAD(d.getUTCMinutes())}:${PAD(d.getUTCSeconds())}`);
    };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, []);

  // Auto-scroll radio log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  });

  const e     = sim.engine;
  const sel   = e && sim.selectedId != null ? e.byId(sim.selectedId) : null;
  const stats = e ? e.stats() : { total: 0, dep: 0, arr: 0, air: 0, gnd: 0, conf: 0 };

  // Sort: conflicts first, then approach/landing aircraft, then rest
  const acft = e ? [...e.aircraft].sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
    const ap = ['approach', 'landing'].includes(a.phase) ? 0 : 1;
    const bp = ['approach', 'landing'].includes(b.phase) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.callsign.localeCompare(b.callsign);
  }) : [];

  const cfg = ATC_AIRPORTS[sim.icao] ?? ATC_AIRPORTS.EGLL;
  const ilsRunways = sim.radar?.runways ?? [];
  const beacons    = sim.radar?.beacons ?? [];

  const submit = useCallback(() => {
    if (!cmd.trim()) return;
    sim.command(cmd);
    setCmd('');
  }, [cmd]);

  const quick = useCallback((v: string) => {
    if (!sel) return;
    sim.command(`${sel.callsign} ${v}`);
  }, [sel]);

  const altStep = (d: number) => {
    if (!sel) return;
    const cur = Math.round((sel.cmdAltitude ?? sel.altitude) / 1000) * 1000;
    quick(`altitude ${Math.max(0, cur + d)}`);
  };
  const spdStep = (d: number) => {
    if (!sel) return;
    const cur = Math.round((sel.cmdIas ?? sel.speed) / 10) * 10;
    quick(`speed ${Math.max(100, cur + d)}`);
  };
  const hdgStep = (d: number) => {
    if (!sel) return;
    const cur = Math.round(sel.heading / 10) * 10;
    quick(`heading ${((cur + d) + 360) % 360 || 360}`);
  };

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      <div className="atc-root">
        {/* ══════════════════ CANVAS LAYER ══════════════════ */}
        <div className="atc-canvas">
          {mode === 'GROUND' ? <GroundView /> : <ApproachView />}
        </div>

        {/* ══════════════════ LEFT SIDEBAR ══════════════════ */}
        <aside className="atc-left">
          {/* Brand */}
          <div className="brand-row">
            <div className="brand-mark">◆</div>
            <div>
              <div className="brand-name">SKYCONTROL</div>
              <div className="brand-sub">{mode === 'GROUND' ? 'GROUND · TOWER' : 'APPROACH · TRACON'}</div>
            </div>
          </div>

          {/* Mode toggle */}
          <div className="seg-ctrl">
            <button className={`seg-btn${mode === 'APPROACH' ? ' seg-active' : ''}`} onClick={() => setMode('APPROACH')}>RADAR</button>
            <button className={`seg-btn${mode === 'GROUND'   ? ' seg-active' : ''}`} onClick={() => setMode('GROUND')}>GROUND</button>
          </div>

          {/* Stats */}
          <div className="stat-row">
            <StatChip n={stats.total} label="TOTAL"    color="var(--text)" />
            <StatChip n={stats.air}   label="AIRBORNE" color="var(--green)" />
            <StatChip n={stats.gnd}   label="GROUND"   color="var(--yellow)" />
            {stats.conf > 0 && <StatChip n={stats.conf} label="CONFLICT" color="var(--red)" />}
          </div>

          {/* Skill */}
          {e && (
            <div className="skill-wrap">
              <div className="skill-header">
                <span className="label-xs">SKILL LEVEL</span>
                <span className="skill-val">{e.skill.toFixed(1)}</span>
              </div>
              <div className="skill-track">
                <div className="skill-fill" style={{ width: `${Math.min(100, (e.skill / 12) * 100)}%` }} />
              </div>
            </div>
          )}

          {/* Conflict alert */}
          {stats.conf > 0 && (
            <div className="conflict-banner">⚠ CONFLICT — {stats.conf} PAIR{stats.conf > 1 ? 'S' : ''}</div>
          )}

          {/* Aircraft list */}
          <div className="label-xs" style={{ marginBottom: 6, marginTop: 4 }}>TRAFFIC · {acft.length}</div>
          <div className="acft-list">
            {acft.length === 0 && <div className="list-empty">No traffic</div>}
            {acft.map(a => (
              <AcftRow key={a.id} a={a} selected={sim.selectedId === a.id} onSelect={() => sim.select(a.id)} />
            ))}
          </div>

          {/* Controls */}
          <div className="ctrl-footer">
            <div className="btn-row">
              <button className="pill-btn dep-btn" onClick={() => sim.spawnDeparture()}>+ DEP</button>
              <button className="pill-btn arr-btn" onClick={() => sim.spawnArrival()}>+ ARR</button>
            </div>
            <div className="btn-row">
              <button className="pill-btn" onClick={() => sim.togglePause()} style={{ flex: 1 }}>
                {sim.paused ? '▶ RESUME' : '⏸ PAUSE'}
              </button>
            </div>
            <div className="rate-row">
              {[1, 2, 4].map(r => (
                <button key={r} className={`rate-btn${sim.rate === r ? ' rate-active' : ''}`} onClick={() => sim.setRate(r)}>{r}×</button>
              ))}
            </div>
          </div>
        </aside>

        {/* ══════════════════ RIGHT PANEL ══════════════════ */}
        {sel ? (
          <aside className="atc-right" data-conflict={sel.conflict ? 'true' : undefined}>
            {/* Header */}
            <div className="detail-head">
              <div>
                <div className="detail-cs">{sel.callsign}</div>
                <div className="detail-sub">{sel.airline} · {sel.perf.icaoCode} · WC/{sel.perf.weightClass}</div>
              </div>
              <button className="close-btn" onClick={() => sim.select(null)}>✕</button>
            </div>

            {/* Big numbers */}
            <div className="metrics-grid">
              <BigMetric label="ALT" value={FMT(sel.altitude)} unit="ft"
                target={sel.cmdAltitude != null && Math.abs(sel.cmdAltitude - sel.altitude) > 150 ? FMT(sel.cmdAltitude) : undefined}
                up={sel.cmdAltitude != null && sel.cmdAltitude > sel.altitude} />
              <BigMetric label="SPD" value={FMT(sel.speed)} unit="kt"
                target={sel.cmdIas != null && Math.abs(sel.cmdIas - sel.speed) > 5 ? String(sel.cmdIas) : undefined} />
              <BigMetric label="HDG" value={HDG(sel.heading)} unit="°" />
            </div>

            {/* Badges */}
            <div className="badge-row">
              <span className={`phase-badge ${sel.plan.kind}`}>
                {sel.plan.kind === 'departure' ? 'DEP' : 'ARR'}
              </span>
              <PhaseBadge phase={sel.phase} />
              {sel.ilsCaptured && <span className="badge badge-ils">{sel.gsCaptured ? 'ILS' : 'LOC'}</span>}
              {sel.navMode === 'hold' && sel.holdFixName && <span className="badge badge-hold">HLD {sel.holdFixName}</span>}
              {sel.navMode === 'direct' && sel.directTargetName && <span className="badge">DCT {sel.directTargetName}</span>}
              {sel.expedite && <span className="badge badge-expd">EXPD</span>}
            </div>

            {/* Route */}
            <div className="route-line">
              {sel.plan.kind === 'departure'
                ? <><RouteTag>RWY</RouteTag>{sel.plan.runway ?? '—'} <RouteTag>TO</RouteTag>{sel.plan.fix ?? '—'}</>
                : <><RouteTag>VIA</RouteTag>{sel.plan.fix ?? '—'} <RouteTag>STAND</RouteTag>{sel.plan.gateRef ?? '—'}</>
              }
            </div>

            <div className="divider" />

            {/* Ground controls */}
            {!isAirborne(sel) && (
              <section>
                <div className="label-xs" style={{ marginBottom: 6 }}>GROUND CONTROL</div>
                <div className="gnd-grid">
                  {([
                    ['PUSHBACK',        'Pushback'],
                    ['TAXI 27L',        'Taxi 27L'],
                    ['LINE UP',         'Line Up'],
                    ['CLEARED TAKEOFF', 'Cleared T/O'],
                    ['HOLD SHORT',      'Hold Short'],
                    ['CROSS',           'Cross'],
                  ] as const).map(([c, l]) => (
                    <button key={c} className="gnd-btn" onClick={() => quick(c)}>{l}</button>
                  ))}
                </div>
              </section>
            )}

            {/* Approach controls */}
            {isAirborne(sel) && mode === 'APPROACH' && (
              <section className="approach-ctrls">
                <CtrlRow label="ALT">
                  <AdjBtn up onClick={() => altStep(+3000)}>▲3k</AdjBtn>
                  <AdjBtn up onClick={() => altStep(+1000)}>▲1k</AdjBtn>
                  <AdjBtn dn onClick={() => altStep(-1000)}>▼1k</AdjBtn>
                  <AdjBtn dn onClick={() => altStep(-3000)}>▼3k</AdjBtn>
                  <AdjBtn active={sel.expedite} warn onClick={() => quick('expedite')}>EXPD</AdjBtn>
                </CtrlRow>
                <CtrlRow label="SPD">
                  <AdjBtn up onClick={() => spdStep(+20)}>▲20</AdjBtn>
                  <AdjBtn up onClick={() => spdStep(+10)}>▲10</AdjBtn>
                  <AdjBtn dn onClick={() => spdStep(-10)}>▼10</AdjBtn>
                  <AdjBtn dn onClick={() => spdStep(-20)}>▼20</AdjBtn>
                </CtrlRow>
                <CtrlRow label="HDG">
                  <AdjBtn onClick={() => hdgStep(-30)}>◀30</AdjBtn>
                  <AdjBtn onClick={() => hdgStep(-10)}>◀10</AdjBtn>
                  <AdjBtn onClick={() => hdgStep(+10)}>10▶</AdjBtn>
                  <AdjBtn onClick={() => hdgStep(+30)}>30▶</AdjBtn>
                </CtrlRow>
                {ilsRunways.length > 0 && (
                  <CtrlRow label="ILS">
                    {ilsRunways.slice(0, 5).map(r => (
                      <AdjBtn key={r.name} blue active={sel.assignedRunway === r.name} onClick={() => quick(`ILS ${r.name}`)}>
                        {r.name}
                      </AdjBtn>
                    ))}
                  </CtrlRow>
                )}
                {beacons.length > 0 && (
                  <CtrlRow label="HOLD">
                    {beacons.slice(0, 5).map(b => (
                      <AdjBtn key={b.id} blue active={sel.navMode === 'hold' && sel.holdFixName === b.id} onClick={() => quick(`HOLD ${b.id}`)}>
                        {b.id}
                      </AdjBtn>
                    ))}
                  </CtrlRow>
                )}
                <button className="ga-btn" onClick={() => quick('go around')}>GO AROUND</button>
              </section>
            )}

            {/* Airborne quick cmds (ground mode) */}
            {isAirborne(sel) && mode === 'GROUND' && (
              <section>
                <div className="label-xs" style={{ marginBottom: 6 }}>AIRBORNE</div>
                <div className="gnd-grid">
                  {([
                    ['CLIMB 8000',   'Climb 8000'],
                    ['DESCEND 4000', 'Descend 4000'],
                    ['SPEED 200',    'Speed 200'],
                    ['CLEARED LAND', 'Cleared Land'],
                  ] as const).map(([c, l]) => (
                    <button key={c} className="gnd-btn" onClick={() => quick(c)}>{l}</button>
                  ))}
                </div>
              </section>
            )}

            <button className="type-hint-btn" onClick={() => cmdRef.current?.focus()}>
              TYPE COMMAND › {sel.callsign}
            </button>
          </aside>
        ) : (
          <aside className="atc-right atc-right-empty">
            <div className="empty-hint">
              <div className="empty-icon">◎</div>
              <div>Click aircraft on radar<br />or list to select</div>
            </div>
          </aside>
        )}

        {/* ══════════════════ BOTTOM STRIP ══════════════════ */}
        <footer className="atc-bottom">
          {/* Status bar */}
          <div className="status-bar">
            <div className="status-left">
              <span className="apt-name">{cfg.name}</span>
              <span className="apt-icao">{sim.icao}</span>
              {e && (
                <div className="score-chip">
                  <span className="score-val">{e.score}</span>
                  {sim.highScore > 0 && <span className="score-hi">HI {sim.highScore}</span>}
                </div>
              )}
            </div>
            <div className="status-right">
              <div className="airport-picker">
                {Object.keys(ATC_AIRPORTS).map(icao => (
                  <button key={icao} className={`ap-btn${sim.icao === icao ? ' ap-active' : ''}`} onClick={() => sim.load(icao)}>
                    {icao}
                  </button>
                ))}
              </div>
              <button className="tts-btn" onClick={() => sim.toggleTTS()} title="Toggle voice readbacks">
                {sim.tts ? '🔊' : '🔇'}
              </button>
              <div className="clock">{clock}<span className="utc-z">Z</span></div>
            </div>
          </div>

          {/* Radio log */}
          <div className="radio-log" ref={logRef}>
            {sim.radio.length === 0 && <span className="log-empty">Waiting for traffic…</span>}
            {sim.radio.map(l => (
              <div key={l.key} className={`log-line log-${l.who.toLowerCase()}`}>
                <span className="log-who">{l.who === 'ATC' ? 'ATC ▸' : l.who === 'PILOT' ? '◂ PIL' : '  SYS'}</span>
                <span className="log-text">{l.text}</span>
              </div>
            ))}
          </div>

          {/* Command input */}
          <form className="cmd-form" onSubmit={ev => { ev.preventDefault(); submit(); }}>
            <span className="cmd-caret">›</span>
            <input
              ref={cmdRef}
              value={cmd}
              onChange={ev => setCmd(ev.target.value)}
              placeholder={sel
                ? `${sel.callsign} ${isAirborne(sel) ? 'hdg 270  ils 27l  hold big' : 'taxi 27l  line up  takeoff'}`
                : 'CALLSIGN COMMAND…'}
              className="cmd-input"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className="cmd-send">SEND</button>
          </form>
        </footer>

        {/* ══════════════════ LOADING OVERLAY ══════════════════ */}
        {sim.loading && (
          <div className="load-overlay">
            <div className="load-spinner" />
            <div className="load-title">LOADING {cfg.name.toUpperCase()}</div>
            <div className="load-sub">ground data · airspace</div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AcftRow({ a, selected, onSelect }: { a: AircraftState; selected: boolean; onSelect: () => void }) {
  const [short, col] = PHASE_LABEL[a.phase] ?? ['???', '#64748b'];
  const isArr = a.plan.kind === 'arrival';
  return (
    <button
      className={`acft-row${selected ? ' acft-row-sel' : ''}${a.conflict ? ' acft-row-conflict' : ''}`}
      onClick={onSelect}
    >
      <span className={`acft-cs ${isArr ? 'cs-arr' : 'cs-dep'}`}>{a.callsign}</span>
      <span className="acft-phase" style={{ color: col }}>{short}</span>
      {isAirborne(a)
        ? <span className="acft-alt">{Math.round(a.altitude / 100) * 100 > 0 ? `${FMT(a.altitude)} ft` : 'SFC'}</span>
        : <span className="acft-gnd">GND</span>
      }
      <span className={`acft-kind ${isArr ? 'kind-arr' : 'kind-dep'}`}>{isArr ? 'A' : 'D'}</span>
    </button>
  );
}

function StatChip({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="stat-chip">
      <div className="stat-n" style={{ color }}>{n}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const [short, col] = PHASE_LABEL[phase] ?? ['???', '#64748b'];
  return <span className="badge" style={{ color: col, borderColor: col + '44' }}>{short}</span>;
}

function BigMetric({ label, value, unit, target, up }: {
  label: string; value: string; unit: string; target?: string; up?: boolean;
}) {
  return (
    <div className="big-metric">
      <div className="bm-label">{label}</div>
      <div className="bm-val">{value}<span className="bm-unit">{unit}</span></div>
      {target && <div className={`bm-target ${up ? 'bm-up' : 'bm-dn'}`}>{up ? '▲' : '▼'} {target}</div>}
    </div>
  );
}

function CtrlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ctrl-row">
      <div className="label-xs ctrl-label">{label}</div>
      <div className="ctrl-btns">{children}</div>
    </div>
  );
}

function AdjBtn({ children, onClick, up, dn, active, warn, blue }: {
  children: React.ReactNode; onClick: () => void;
  up?: boolean; dn?: boolean; active?: boolean; warn?: boolean; blue?: boolean;
}) {
  let cls = 'adj-btn';
  if (up)     cls += ' adj-up';
  if (dn)     cls += ' adj-dn';
  if (active) cls += ' adj-active';
  if (warn)   cls += active ? ' adj-warn-on' : ' adj-warn';
  if (blue)   cls += ' adj-blue';
  return <button className={cls} onClick={onClick}>{children}</button>;
}

function RouteTag({ children }: { children: React.ReactNode }) {
  return <span className="route-tag">{children}</span>;
}

// ── Global CSS ─────────────────────────────────────────────────────────────────

const GLOBAL_CSS = `
  :root {
    --bg:      #05080d;
    --panel:   #090e16;
    --panel2:  #0c1420;
    --border:  rgba(40,70,130,.28);
    --border2: rgba(40,70,130,.45);
    --text:    #cbd5e1;
    --muted:   #475569;
    --dim:     #1e3a5f;
    --green:   #22c55e;
    --yellow:  #f59e0b;
    --blue:    #3b82f6;
    --red:     #ef4444;
    --ui-font: ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono:    ui-monospace,'JetBrains Mono','Fira Code','SF Mono',monospace;
    --r2: 4px; --r3: 6px; --r4: 8px;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); overflow: hidden; }
  button { cursor: pointer; transition: filter .12s, background .12s; }
  button:hover  { filter: brightness(1.18); }
  button:active { filter: brightness(.88); }
  input { outline: none; }
  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--dim); border-radius: 2px; }
  ::placeholder { color: var(--dim); }

  @keyframes spin    { to { transform: rotate(360deg); } }
  @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.2} }
  @keyframes pulse-r { 0%,100%{opacity:.9} 50%{opacity:.35} }

  .maplibregl-ctrl-attrib { display: none !important; }
  .maplibregl-ctrl-bottom-right { bottom: 8px !important; right: 8px !important; }
  .maplibregl-ctrl-group {
    background: rgba(7,12,22,.9) !important;
    border: 1px solid var(--border) !important;
    border-radius: var(--r4) !important;
  }

  /* ── Grid ── */
  .atc-root {
    display: grid;
    grid-template:
      "left canvas right" 1fr
      "bot  bot    bot"   200px
      / 220px 1fr 268px;
    width: 100vw; height: 100vh;
    background: var(--bg);
    font-family: var(--mono);
    user-select: none;
    overflow: hidden;
  }

  .atc-canvas { grid-area: canvas; position: relative; overflow: hidden; }

  /* ── Left ── */
  .atc-left {
    grid-area: left;
    background: var(--panel); border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    padding: 16px 12px 12px; overflow: hidden;
  }

  .brand-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .brand-mark {
    width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
    background: linear-gradient(145deg,#152a5c,#0a1530);
    border: 1px solid rgba(80,130,240,.3);
    display: flex; align-items: center; justify-content: center;
    color: var(--yellow); font-size: 14px;
    box-shadow: 0 0 14px rgba(59,130,246,.12);
  }
  .brand-name { font-size: 12px; font-weight: 800; letter-spacing: 3px; color: var(--text); line-height: 1; }
  .brand-sub  { font-size: 8px; letter-spacing: 1.5px; color: var(--muted); margin-top: 4px; }

  .seg-ctrl {
    display: flex; gap: 3px; background: rgba(5,10,20,.8);
    border: 1px solid var(--border); border-radius: var(--r4);
    padding: 3px; margin-bottom: 14px;
  }
  .seg-btn {
    flex: 1; padding: 6px 0; font-family: var(--mono); font-size: 9.5px;
    font-weight: 700; letter-spacing: 1px; border: none; border-radius: 5px;
    color: var(--muted); background: transparent;
  }
  .seg-active {
    background: linear-gradient(160deg,#1a3a80,#0f2050);
    color: var(--yellow);
    box-shadow: 0 1px 0 rgba(100,150,255,.12);
  }

  .stat-row {
    display: flex; margin-bottom: 12px;
    background: rgba(8,15,30,.6); border: 1px solid var(--border);
    border-radius: var(--r4); padding: 10px 4px;
  }
  .stat-chip { flex: 1; text-align: center; }
  .stat-n    { font-size: 20px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .stat-l    { font-size: 7.5px; letter-spacing: 1px; color: var(--muted); margin-top: 3px; }

  .skill-wrap   { margin-bottom: 12px; }
  .skill-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
  .skill-val    { font-size: 11px; font-weight: 800; color: var(--green); }
  .skill-track  { height: 3px; background: rgba(20,45,90,.6); border-radius: 2px; }
  .skill-fill   { height: 100%; background: linear-gradient(90deg,#15803d,var(--green)); border-radius: 2px; transition: width .6s ease; }

  .conflict-banner {
    background: rgba(180,20,20,.18); border: 1px solid rgba(239,68,68,.4);
    border-radius: var(--r3); padding: 5px 8px; text-align: center;
    font-size: 9.5px; font-weight: 800; color: var(--red); letter-spacing: 1px;
    animation: blink .75s infinite; margin-bottom: 10px;
  }

  .label-xs {
    font-size: 8px; letter-spacing: 2px; color: var(--muted);
    font-family: var(--ui-font); font-weight: 600; text-transform: uppercase;
  }

  .acft-list   { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
  .list-empty  { font-size: 10px; color: var(--dim); padding: 8px 4px; }

  .acft-row {
    display: flex; align-items: center; gap: 7px; width: 100%;
    padding: 5px 8px; border-radius: var(--r3); text-align: left;
    background: transparent; border: 1px solid transparent;
    font-family: var(--mono);
  }
  .acft-row:hover     { background: rgba(20,40,80,.4); }
  .acft-row-sel       { background: rgba(30,60,140,.3) !important; border-color: rgba(60,110,220,.4) !important; }
  .acft-row-conflict  { animation: blink .7s infinite; }
  .acft-cs    { font-size: 11px; font-weight: 700; min-width: 56px; }
  .cs-arr     { color: var(--green); }
  .cs-dep     { color: var(--yellow); }
  .acft-phase { font-size: 8.5px; min-width: 26px; }
  .acft-alt   { font-size: 9px; color: var(--text); min-width: 46px; font-variant-numeric: tabular-nums; }
  .acft-gnd   { font-size: 9px; color: var(--muted); }
  .acft-kind  { font-size: 8px; font-weight: 700; margin-left: auto; }
  .kind-arr   { color: var(--green); }
  .kind-dep   { color: var(--yellow); }

  .ctrl-footer { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .btn-row     { display: flex; gap: 5px; }
  .pill-btn {
    flex: 1; padding: 8px 0; font-family: var(--mono); font-size: 9.5px;
    font-weight: 700; letter-spacing: .5px; border: 1px solid var(--border);
    border-radius: var(--r3); background: rgba(12,24,48,.7); color: var(--text);
  }
  .dep-btn { color: var(--yellow); border-color: rgba(245,158,11,.3); }
  .arr-btn { color: var(--green);  border-color: rgba(34,197,94,.3);  }
  .rate-row { display: flex; gap: 4px; }
  .rate-btn {
    flex: 1; padding: 5px 0; font-family: var(--mono); font-size: 9px; font-weight: 700;
    border-radius: var(--r2); border: 1px solid var(--border);
    background: rgba(8,16,32,.7); color: var(--muted);
  }
  .rate-active { background: rgba(20,45,110,.8); color: var(--yellow); border-color: rgba(245,158,11,.3); }

  /* ── Right ── */
  .atc-right {
    grid-area: right;
    background: var(--panel); border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow-y: auto; padding: 14px 14px 12px;
  }
  .atc-right[data-conflict] { border-left-color: rgba(239,68,68,.6); }
  .atc-right-empty { align-items: center; justify-content: center; }
  .empty-hint {
    text-align: center; color: var(--dim); font-size: 10.5px;
    line-height: 1.9; display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .empty-icon { font-size: 28px; opacity: .4; }

  .detail-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .detail-cs   { font-size: 22px; font-weight: 800; color: var(--text); letter-spacing: 1px; line-height: 1; }
  .detail-sub  { font-size: 9px; color: var(--muted); margin-top: 5px; font-family: var(--ui-font); }
  .close-btn   {
    width: 26px; height: 26px; border-radius: var(--r2); flex-shrink: 0;
    background: rgba(20,40,80,.5); border: 1px solid var(--border);
    color: var(--muted); font-size: 11px;
    display: flex; align-items: center; justify-content: center;
  }

  .metrics-grid {
    display: flex; justify-content: space-between;
    background: rgba(8,14,28,.7); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 6px; margin-bottom: 10px;
  }
  .big-metric { text-align: center; flex: 1; }
  .bm-label   { font-size: 8px; letter-spacing: 2px; color: var(--muted); margin-bottom: 4px; font-family: var(--ui-font); }
  .bm-val     { font-size: 24px; font-weight: 800; color: var(--text); line-height: 1; font-variant-numeric: tabular-nums; }
  .bm-unit    { font-size: 10px; color: var(--muted); margin-left: 2px; }
  .bm-target  { font-size: 9px; margin-top: 3px; font-weight: 600; }
  .bm-up      { color: var(--blue); }
  .bm-dn      { color: var(--red); }

  .badge-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .badge {
    font-size: 8.5px; font-weight: 700; letter-spacing: .8px;
    padding: 2px 8px; border-radius: var(--r2);
    background: rgba(20,40,80,.6); border: 1px solid var(--border); color: var(--text);
  }
  .phase-badge { font-size: 8.5px; font-weight: 800; padding: 2px 8px; border-radius: var(--r2); letter-spacing: 1px; }
  .phase-badge.arrival   { background: rgba(22,101,52,.3); border: 1px solid rgba(34,197,94,.35); color: var(--green); }
  .phase-badge.departure { background: rgba(120,53,15,.3); border: 1px solid rgba(245,158,11,.35); color: var(--yellow); }
  .badge-ils  { color: var(--blue); border-color: rgba(59,130,246,.4); }
  .badge-hold { color: var(--blue); border-color: rgba(59,130,246,.4); }
  .badge-expd { color: var(--red); border-color: rgba(239,68,68,.4); animation: pulse-r .9s infinite; }

  .route-line { font-size: 10px; color: var(--text); margin-bottom: 10px; }
  .route-tag  {
    font-size: 7.5px; letter-spacing: 1.5px; color: var(--muted);
    background: rgba(20,40,80,.5); border-radius: 3px; padding: 1px 5px;
    margin-right: 4px; font-family: var(--ui-font); font-weight: 600;
  }
  .divider    { border: none; border-top: 1px solid var(--border); margin: 10px 0; }

  .gnd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 4px; }
  .gnd-btn  {
    padding: 7px 4px; font-family: var(--mono); font-size: 9px; font-weight: 600;
    color: var(--text); background: rgba(12,24,50,.7);
    border: 1px solid var(--border); border-radius: var(--r2);
  }
  .gnd-btn:hover { background: rgba(20,45,90,.8); }

  .approach-ctrls { display: flex; flex-direction: column; gap: 7px; }
  .ctrl-row { display: flex; flex-direction: column; gap: 4px; }
  .ctrl-label { margin-bottom: 0; }
  .ctrl-btns  { display: flex; gap: 3px; }

  .adj-btn {
    flex: 1; padding: 6px 2px; font-family: var(--mono); font-size: 9.5px; font-weight: 700;
    border-radius: var(--r2); color: var(--text);
    background: rgba(12,22,44,.8); border: 1px solid var(--border);
  }
  .adj-up      { color: var(--blue); }
  .adj-dn      { color: var(--red); }
  .adj-blue    { color: var(--blue); }
  .adj-active  { background: rgba(30,70,180,.3) !important; border-color: rgba(59,130,246,.5) !important; color: var(--yellow) !important; }
  .adj-warn    { color: var(--muted); }
  .adj-warn-on { color: var(--red); background: rgba(120,20,20,.3) !important; border-color: rgba(239,68,68,.4) !important; animation: pulse-r .9s infinite; }

  .ga-btn {
    width: 100%; padding: 9px 0; font-family: var(--mono); font-size: 10px;
    font-weight: 800; letter-spacing: 1px; color: var(--red);
    background: rgba(100,10,10,.25); border: 1px solid rgba(239,68,68,.35);
    border-radius: var(--r3); margin-top: 2px;
  }
  .ga-btn:hover { background: rgba(140,20,20,.4); }

  .type-hint-btn {
    width: 100%; padding: 8px 0; font-family: var(--mono); font-size: 8.5px;
    font-weight: 700; letter-spacing: .5px; color: var(--dim);
    background: transparent; border: 1px dashed rgba(40,70,130,.3);
    border-radius: var(--r3); margin-top: 12px;
  }
  .type-hint-btn:hover { color: var(--muted); border-color: rgba(40,70,130,.55); }

  /* ── Bottom ── */
  .atc-bottom {
    grid-area: bot;
    background: var(--panel); border-top: 1px solid var(--border);
    display: flex; flex-direction: column;
  }

  .status-bar {
    flex-shrink: 0; height: 40px;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px; border-bottom: 1px solid var(--border);
    background: rgba(5,8,16,.6);
  }
  .status-left  { display: flex; align-items: center; gap: 12px; }
  .status-right { display: flex; align-items: center; gap: 8px; }

  .apt-name  { font-size: 13px; font-weight: 700; color: var(--text); font-family: var(--ui-font); }
  .apt-icao  { font-size: 9.5px; letter-spacing: 2px; color: var(--muted); }
  .score-chip {
    display: flex; gap: 8px; align-items: baseline;
    background: rgba(8,14,28,.7); border: 1px solid var(--border);
    border-radius: var(--r3); padding: 3px 10px; font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .score-val { color: var(--yellow); font-weight: 800; }
  .score-hi  { color: var(--muted); font-size: 9.5px; }

  .airport-picker {
    display: flex; gap: 2px; background: rgba(6,10,20,.8);
    border: 1px solid var(--border); border-radius: var(--r3); padding: 3px;
  }
  .ap-btn {
    padding: 3px 8px; font-family: var(--mono); font-size: 8.5px; font-weight: 700;
    border-radius: var(--r2); border: none; background: transparent; color: var(--muted);
  }
  .ap-active { background: rgba(20,48,120,.8); color: var(--yellow); }

  .tts-btn {
    background: rgba(8,14,28,.7); border: 1px solid var(--border);
    border-radius: var(--r3); padding: 4px 9px; font-size: 13px; line-height: 1;
  }
  .clock {
    font-variant-numeric: tabular-nums; font-size: 13px; color: var(--text);
    background: rgba(8,14,28,.7); border: 1px solid var(--border);
    border-radius: var(--r3); padding: 4px 10px;
    display: flex; align-items: baseline; gap: 3px;
  }
  .utc-z { font-size: 8px; color: var(--muted); letter-spacing: 1px; }

  .radio-log {
    flex: 1; overflow-y: auto; padding: 7px 16px;
    display: flex; flex-direction: column; gap: 2.5px;
  }
  .log-empty  { font-size: 10px; color: var(--dim); }
  .log-line   { display: flex; gap: 10px; font-size: 11px; line-height: 1.5; }
  .log-who    { font-weight: 700; font-size: 9.5px; min-width: 40px; flex-shrink: 0; }
  .log-text   { color: var(--text); }
  .log-atc   .log-who  { color: var(--yellow); }
  .log-pilot .log-who  { color: var(--blue); }
  .log-sys   .log-who  { color: var(--muted); }
  .log-sys   .log-text { color: var(--muted); }

  .cmd-form {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-top: 1px solid var(--border);
    background: rgba(4,7,14,.6); flex-shrink: 0;
  }
  .cmd-caret { color: var(--yellow); font-size: 15px; font-weight: 700; }
  .cmd-input {
    flex: 1; background: transparent; border: none; color: var(--text);
    font-family: var(--mono); font-size: 12px; letter-spacing: .5px;
    text-transform: uppercase;
  }
  .cmd-send {
    font-family: var(--mono); font-size: 9px; font-weight: 800; letter-spacing: 1px;
    color: #05080d; background: var(--yellow); border: none;
    border-radius: var(--r3); padding: 6px 14px;
  }

  /* Loading */
  .load-overlay {
    position: fixed; inset: 0; z-index: 200;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
    background: rgba(4,7,14,.94); backdrop-filter: blur(6px);
  }
  .load-spinner {
    width: 44px; height: 44px; border-radius: 50%;
    border: 3px solid rgba(40,80,160,.2); border-top-color: var(--yellow);
    animation: spin .85s linear infinite;
  }
  .load-title { font-size: 12px; letter-spacing: 4px; color: var(--text); font-weight: 700; }
  .load-sub   { font-size: 9.5px; letter-spacing: 2px; color: var(--muted); }
`;
