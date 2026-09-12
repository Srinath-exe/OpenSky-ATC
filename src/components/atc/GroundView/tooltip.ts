// ============================================================
//  Hover tooltip content (UX 04 §4 "Hover tooltip"): callsign · type/wake ·
//  stage · alt/GS/hdg · cmd targets · pending instruction · REQ · stand/route.
//  Pure: the DOM card in index.tsx just renders these rows.
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { AircraftState, Vehicle } from '@/lib/sim/types';
import { isAirborne } from '@/lib/sim/aircraft';
import { stageLabel, type StageTone } from '@/lib/sim/stage';
import { describe } from '@/lib/sim/commandAst';
import type { PlayerPosition } from './bridge';

export interface TipRow { label: string; value: string; tone?: 'orange' | 'red' | 'green' | 'dim' }
export interface TipModel {
  title: string;
  subtitle: string;
  stage: string;
  stageTone: StageTone | 'emergency';
  rows: TipRow[];
  note: string | null;
  noteTone: 'orange' | 'red' | null;
}

const hdg3 = (h: number) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0');
const mmss = (s: number) => { const m = Math.floor(s / 60), r = Math.max(0, Math.round(s - m * 60)); return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };

export function aircraftTip(engine: SimEngine, a: AircraftState, position: PlayerPosition): TipModel {
  const air = isAirborne(a);
  const stage = engine.stageOf(a);
  const sl = stageLabel(stage);
  const rows: TipRow[] = [];
  const mag = (h: number) => hdg3(h - engine.magVar);
  if (air || position === 'tower') {
    const altT = a.cmdAltitude ?? null;
    rows.push({ label: 'ALT', value: `${Math.round(a.altitude).toLocaleString('en')} ft${altT != null && Math.abs(altT - a.altitude) > 100 ? ` ${altT > a.altitude ? '▲' : '▼'} ${altT.toLocaleString('en')}` : ''}` });
    rows.push({ label: 'GS', value: `${Math.round(a.speed)} kt${a.cmdIas != null && Math.abs(a.cmdIas - a.speed) > 5 ? ` ${a.cmdIas > a.speed ? '▲' : '▼'} ${a.cmdIas}` : ''}` });
    const hT = Math.round(a.targetHeading);
    rows.push({ label: 'HDG', value: `${mag(a.heading)}${Math.abs(((hT - a.heading + 540) % 360) - 180) > 2 ? ` → ${mag(hT)}` : ''}` });
  }
  if (!air) {
    if (a.plan.kind === 'departure') {
      if (a.plan.runway) rows.push({ label: 'RWY', value: a.plan.runway });
      if (a.plan.gateRef) rows.push({ label: 'STAND', value: a.plan.gateRef });
    } else {
      const stand = a.reservedStand ?? a.plan.gateRef;
      if (stand) rows.push({ label: 'STAND', value: stand });
    }
    if (a.plan.taxiRoute?.length) rows.push({ label: 'VIA', value: a.plan.taxiRoute.join(' ') });
    if (a.holdShortRunway) rows.push({ label: 'HOLD', value: a.holdShortRunway, tone: 'orange' });
    if (a.speed > 1) rows.push({ label: 'GS', value: `${Math.round(a.speed)} kt` });
  } else {
    if (a.assignedRunway) rows.push({ label: a.ilsCaptured ? (a.gsCaptured ? 'ILS' : 'LOC') : 'RWY', value: a.assignedRunway, tone: a.ilsCaptured ? 'green' : undefined });
    if (a.plan.kind === 'arrival' && a.plan.runway) {
      const nm = engine.distToThresholdNM(a, a.assignedRunway ?? a.plan.runway);
      if (nm != null && nm < 30) rows.push({ label: 'FINAL', value: `${nm.toFixed(1)} NM` });
    }
    if (a.landingCleared) rows.push({ label: 'CLR', value: 'LAND', tone: 'green' });
    if (a.takeoffCleared) rows.push({ label: 'CLR', value: 'T/O', tone: 'green' });
  }
  let note: string | null = null, noteTone: 'orange' | 'red' | null = null;
  const emerg = a.emergency && a.emergency.status !== 'resolved' ? a.emergency : null;
  const req = a.requests.find(r => r.answeredAt == null);
  const pending = a.pendingCmds.find(c => c.ast);
  if (emerg) { note = `${emerg.level} · ${emerg.type.replace(/_/g, ' ')}`; noteTone = 'red'; }
  else if (req) { note = req.text; noteTone = 'orange'; }
  else if (pending?.ast) { note = `Pending: ${describe(pending.ast)}${pending.applyAt > engine.time ? ` (${mmss(pending.applyAt - engine.time)})` : ''}`; noteTone = 'orange'; }
  const freq = a.onFrequency === position || (position === 'approach' && a.onFrequency === 'departure') ? '' : ` · ${a.onFrequency.toUpperCase()}`;
  return {
    title: a.callsign,
    subtitle: `${a.perf.icaoCode}/${a.wakeCategory[0]}${freq} · ${a.plan.kind === 'arrival' ? 'ARR' : 'DEP'}${a.plan.dest ? ` ${a.plan.dest}` : ''}`,
    stage: sl.short, stageTone: emerg ? 'emergency' : sl.tone,
    rows, note, noteTone,
  };
}

export function vehicleTip(engine: SimEngine, v: Vehicle): TipModel {
  const rows: TipRow[] = [];
  const t = v.target;
  if (t && v.state !== 'standby') rows.push({ label: 'TO', value: t.kind === 'runway' ? `RWY ${t.runway}` : t.kind === 'aircraft' ? t.callsign : t.kind === 'stand' ? `STAND ${t.ref}` : t.kind === 'point' ? 'MAP POINT' : 'STATION' });
  if (v.state === 'enroute' && v.etaAt != null) rows.push({ label: 'ETA', value: mmss(Math.max(0, v.etaAt - engine.time)), tone: 'orange' });
  if (v.speed > 0.5) rows.push({ label: 'GS', value: `${Math.round(v.speed)} kt` });
  if (v.holdShortRunway) rows.push({ label: 'HOLD', value: v.holdShortRunway, tone: 'orange' });
  if (v.onRunway) rows.push({ label: 'ON RWY', value: v.onRunway, tone: 'red' });
  const state = v.state === 'standby' ? 'STATION' : v.state === 'enroute' ? 'EN ROUTE' : v.state === 'onscene' ? 'ON SCENE' : 'RETURNING';
  return { title: v.callsign.toUpperCase(), subtitle: v.type.toUpperCase(), stage: state, stageTone: v.state === 'onscene' ? 'warn' : v.state === 'standby' ? 'neutral' : 'ground', rows, note: null, noteTone: null };
}
