/*
  LLM I/O — the observation (docs/spec/07-LLM-IO.md §2).

  `buildObservation()` renders what a controller at `position` sees as a compact, deterministic block of text (and the
  same facts as JSON): weather / ATIS / runways, the open pilot requests, every aircraft on the frequency with its stage
  and the actions currently valid for it, other traffic, active alerts, the recent radio and the model's own last
  actions with their outcome. Pure: engine in, strings out — the headless tests exercise it without a DOM.
*/
import type { SimEngine } from '../sim/engine';
import type { AircraftState, Position, PlayerPosition } from '../sim/types';
import { stageLabel, isAirbornePhase } from '../sim/stage';
import { fromEngine } from '../sim/dispatch';
import type { ActionId } from '../sim/commandTree';

export interface RadioSnippet { who: string; callsign?: string; text: string; at: number }
export interface ActionOutcome { line: string; ok: boolean; note: string }

export interface ObserveOptions {
  position: PlayerPosition;
  /** Recent comm-log lines (oldest first); the last `radioLines` are shown. */
  radio?: RadioSnippet[];
  radioLines?: number;
  /** The model's previous commands and how they went. */
  lastActions?: ActionOutcome[];
  /** Cap on the traffic listed for other frequencies. */
  maxOther?: number;
  /** Include the taxiway / fix vocabulary line (once per session is enough — the caller decides). */
  vocabulary?: boolean;
}

export interface ObservedAircraft {
  callsign: string; type: string; wake: string; kind: 'DEP' | 'ARR'; stage: string; phase: string; onFrequency: Position;
  stand: string | null; runway: string | null; headingMag: number; speedKt: number; altitudeFt: number; airborne: boolean;
  distNM: number | null; bearingMag: number | null; toThresholdNM: number | null; route: string | null;
  request: { kind: string; text: string; ageS: number; answers: string[] } | null; actions: string[];
}
export interface Observation {
  icao: string; position: PlayerPosition; simTime: number; clock: string;
  wind: { dirMag: number; kts: number; gust: number }; visM: number; cloud: string; qnh: number | null; atis: string | null;
  activeDep: string[]; activeArr: string[]; runways: { name: string; status: string; occupant: string | null }[];
  score: number; traffic: { total: number; air: number; ground: number };
  requests: { callsign: string; kind: string; text: string; ageS: number }[];
  mine: ObservedAircraft[]; others: ObservedAircraft[];
  alerts: { severity: string; title: string; subjects: string[]; detail: string }[];
  radio: RadioSnippet[]; lastActions: ActionOutcome[];
  text: string;
}

const ACTION_VERB: Partial<Record<ActionId, string>> = {
  'action-pushback': 'PUSHBACK APPROVED', 'action-startup': 'STARTUP APPROVED', 'action-taxi-runway': 'TAXI <rwy> [VIA <twys>] [HOLD SHORT <rwy>]',
  'action-taxi-stand': 'TAXI STAND <stand> [VIA <twys>]', 'action-taxi-point': 'TAXI <twy> <twy>', 'action-amend-route': 'TAXI <rwy> VIA <twys>',
  'action-hold-short': 'HOLD SHORT <rwy|twy>', 'action-hold-position': 'HOLD POSITION', 'action-hold-fix': 'HOLD AT <fix>', 'action-continue': 'CONTINUE TAXI',
  'action-cross': 'CROSS <rwy>', 'action-lineup': 'LINE UP AND WAIT <rwy>', 'action-takeoff': 'CLEARED FOR TAKEOFF <rwy>', 'action-cancel-takeoff': 'CANCEL TAKEOFF',
  'action-cancel-lineup': 'HOLD POSITION', 'action-land': 'CLEARED TO LAND <rwy>', 'action-goaround': 'GO AROUND', 'action-cancel-approach': 'CANCEL APPROACH HDG <hdg> CLIMB <alt>',
  'action-exit': 'VACATE <twy> | TAKE NEXT EXIT LEFT/RIGHT', 'action-plan-exit': 'EXIT <twy>', 'action-heading': 'HDG <hdg> | TURN LEFT/RIGHT HDG <hdg>',
  'action-altitude': 'CLIMB <ft> | DESCEND <ft>', 'action-speed': 'SPEED <kt> | SPEED RESUME', 'action-direct': 'DCT <fix>', 'action-resume-sid': 'RESUME OWN NAVIGATION',
  'action-ils': 'CLEARED ILS <rwy>', 'action-expect-runway': 'EXPECT <rwy>', 'action-change-runway': 'EXPECT <rwy>', 'action-expedite': 'EXPEDITE',
  'action-handoff': 'CONTACT TOWER | CONTACT GROUND | CONTACT APPROACH | CONTACT DEPARTURE', 'action-report': 'REPORT HEADING', 'action-say-again': 'SAY AGAIN',
  'action-correction': 'CORRECTION <instruction>', 'action-standby': 'STANDBY', 'action-unable': 'UNABLE', 'action-giveway': 'GIVE WAY TO <callsign> | FOLLOW <callsign>',
  'action-wind-check': 'WIND CHECK', 'action-turnaround': 'TAXI STAND <stand>',
  'emerg-ack': 'ROGER MAYDAY', 'emerg-priority': 'PRIORITY CLEARED TO LAND <rwy>', 'emerg-dispatch': 'FIRE 1 STANDBY <rwy>', 'emerg-hold-all': 'ALL STATIONS HOLD POSITION',
  'emerg-breakoff': 'GO AROUND', 'emerg-stop-runway': 'CANCEL TAKEOFF', 'emerg-reopen': 'OPS 1 INSPECT <rwy>', 'emerg-cancel-ack': 'ROGER MAYDAY CANCELLED', 'emerg-resume-all': 'ALL STATIONS CONTINUE',
};

const REQUEST_ANSWERS: Record<string, string[]> = {
  pushback: ['PUSHBACK APPROVED', 'STANDBY', 'UNABLE'], startup: ['STARTUP APPROVED', 'STANDBY'], taxi: ['TAXI <rwy> VIA <twys>', 'STANDBY'],
  cross: ['CROSS <rwy>', 'HOLD SHORT <rwy>'], ready: ['CLEARED FOR TAKEOFF <rwy>', 'LINE UP AND WAIT <rwy>', 'HOLD POSITION'],
  with_you: ['ROGER', 'RADAR CONTACT'], taxi_in: ['TAXI STAND <stand> VIA <twys>'], runway_vacated: ['CONTACT GROUND', 'TAXI STAND <stand>'],
  further: ['HDG <hdg>', 'DESCEND <ft>', 'CLEARED ILS <rwy>'], higher: ['CLIMB <ft>', 'UNABLE'], lower: ['DESCEND <ft>', 'UNABLE'], direct: ['DCT <fix>', 'UNABLE'],
  say_again: ['(repeat the last instruction)'], wind_check: ['WIND CHECK'], radio_check: ['ROGER'],
};

const mag = (trueDeg: number, magVar: number) => Math.round(((trueDeg - magVar) % 360 + 360) % 360);
const pad3 = (n: number) => String(Math.round(n) % 360).padStart(3, '0');
const clock = (t: number) => { const s = Math.max(0, Math.floor(t)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function describeAircraft(e: SimEngine, a: AircraftState, position: PlayerPosition, enabled: Map<number, ActionId[]>): ObservedAircraft {
  const stage = e.stageOf(a);
  const air = isAirbornePhase(a.phase);
  const runway = a.plan.runway ?? a.assignedRunway ?? null;
  const distM = Math.hypot(a.pos.x, a.pos.y);
  const bearingTrue = (Math.atan2(a.pos.x, a.pos.y) * 180 / Math.PI + 360) % 360;
  const toThr = runway ? e.distToThresholdNM(a, runway) : null;
  const req = a.requests.find(r => r.answeredAt == null && e.time >= a.standbyUntil) ?? null;
  const route = a.plan.taxiRoute && a.plan.taxiRoute.length ? a.plan.taxiRoute.join(' ') : null;
  // the valid actions, minus the meta verbs (report / say again / correction / wind check) that would only add noise;
  // STANDBY / UNABLE only while a request is open
  const META = new Set<ActionId>(['action-report', 'action-say-again', 'action-correction', 'action-wind-check']);
  const acts = (enabled.get(a.id) ?? []).filter(id => !META.has(id) && (req || (id !== 'action-standby' && id !== 'action-unable'))).map(id => ACTION_VERB[id]).filter((v): v is string => !!v);
  return {
    callsign: a.callsign, type: a.perf.icaoCode, wake: a.perf.weightClass, kind: a.plan.kind === 'departure' ? 'DEP' : 'ARR',
    stage: stageLabel(stage).long, phase: a.phase, onFrequency: a.onFrequency,
    stand: a.plan.gateRef ?? a.reservedStand ?? null, runway, headingMag: mag(a.heading, e.magVar), speedKt: Math.round(a.speed), altitudeFt: Math.round(a.altitude / 100) * 100,
    airborne: air, distNM: air ? Math.round(distM / 1852 * 10) / 10 : null, bearingMag: air ? mag(bearingTrue, e.magVar) : null,
    toThresholdNM: toThr != null && air ? Math.round(toThr * 10) / 10 : null, route,
    request: req ? { kind: req.kind, text: req.text, ageS: Math.round(e.time - req.at), answers: REQUEST_ANSWERS[req.kind] ?? ['ROGER'] } : null,
    actions: position === a.onFrequency ? acts : [],
  };
}

function aircraftLine(o: ObservedAircraft, mine: boolean): string {
  const parts = [`${o.callsign} ${o.type}/${o.wake} ${o.kind}`, o.stage];
  if (o.airborne) {
    parts.push(`${o.altitudeFt} ft`, `${o.speedKt} kt`, `hdg ${pad3(o.headingMag)}`);
    if (o.distNM != null && o.bearingMag != null) parts.push(`${o.distNM} NM out, bearing ${pad3(o.bearingMag)} from the field`);
    if (o.toThresholdNM != null && o.runway) parts.push(`${o.toThresholdNM} NM to threshold ${o.runway}`);
    else if (o.runway) parts.push(`rwy ${o.runway}`);
  } else {
    if (o.stand) parts.push(`stand ${o.stand}`);
    if (o.runway) parts.push(`rwy ${o.runway}`);
    if (o.route) parts.push(`via ${o.route}`);
    parts.push(`hdg ${pad3(o.headingMag)}`, `${o.speedKt} kt`);
  }
  if (!mine) parts.push(`on ${o.onFrequency.toUpperCase()}`);
  if (o.request) parts.push(`REQUEST ${o.request.kind.replace('_', ' ')} (${o.request.ageS}s)`);
  if (mine && o.actions.length) parts.push(`can: ${o.actions.join(' · ')}`);
  return `- ${parts.join(' · ')}`;
}

export function buildObservation(e: SimEngine, opts: ObserveOptions): Observation {
  const position = opts.position;
  const wx = e.wx();
  let atis: ReturnType<SimEngine['weather']['atis']> | null = null;
  try { atis = e.weather.atis(); } catch { atis = null; }
  const runways = e.runwayStates();
  const ctx = fromEngine(e, { position, withActions: true });
  const enabled = new Map<number, ActionId[]>();
  for (const row of ctx.aircraft ?? []) if (row.enabledActions && row.id != null) enabled.set(row.id, row.enabledActions);
  const all = e.aircraft.map(a => describeAircraft(e, a, position, enabled));
  const mine = all.filter(o => o.onFrequency === position);
  const others = all.filter(o => o.onFrequency !== position).slice(0, opts.maxOther ?? 12);
  const requests = mine.filter(o => o.request).map(o => ({ callsign: o.callsign, kind: o.request!.kind, text: o.request!.text, ageS: o.request!.ageS }));
  const alerts = e.activeAlerts().map(al => ({ severity: al.severity, title: al.title, subjects: al.subjects, detail: al.detail }));
  const occupant = (name: string): string | null => {
    const rs = runways.find(r => r.name === name); if (!rs) return null;
    const occ = e.aircraft.find(a => (a.phase === 'takeoff' || a.phase === 'landing' || a.phase === 'rollout' || a.phase === 'lineup') && (a.plan.runway === rs.name || a.plan.runway === rs.reciprocal || a.assignedRunway === rs.name));
    return occ ? `${occ.callsign} ${occ.phase}` : null;
  };
  const rwyRows = runways.filter(r => r.activeDep || r.activeArr).map(r => ({ name: r.name, status: r.status, occupant: occupant(r.name) }));
  const counts = e.counts();
  const radio = (opts.radio ?? []).filter(r => r.who !== 'SYS').slice(-(opts.radioLines ?? 6));
  const lastActions = opts.lastActions ?? [];
  const windMag = mag(wx.windDirTrue, e.magVar);

  const L: string[] = [];
  L.push(`SKYCONTROL ${e.air.icao} · you are ${position.toUpperCase()} · sim ${clock(e.time)}`);
  L.push(`WX wind ${pad3(windMag)}/${Math.round(wx.windKt)}${wx.gustKt ? `G${Math.round(wx.gustKt)}` : ''} kt · vis ${wx.visM >= 10000 ? '10 km+' : `${(wx.visM / 1000).toFixed(1)} km`} · ${wx.cloud}${atis ? ` · QNH ${atis.qnh} · ATIS ${atis.letter}` : ''}`);
  L.push(`RUNWAYS dep ${runways.filter(r => r.activeDep).map(r => r.name).join(',') || '-'} · arr ${runways.filter(r => r.activeArr).map(r => r.name).join(',') || '-'}${rwyRows.length ? ' · ' + rwyRows.map(r => `${r.name} ${r.status === 'open' ? (r.occupant ? `OCCUPIED (${r.occupant})` : 'FREE') : r.status.toUpperCase()}`).join(' · ') : ''}`);
  L.push(`SCORE ${e.stats.points} · TRAFFIC ${counts.total} (air ${counts.air}, ground ${counts.gnd})`);
  if (opts.vocabulary) {
    if (position === 'approach') L.push(`FIXES ${(ctx.fixes ?? []).join(' ') || '-'}`);
    else L.push(`TAXIWAYS ${(ctx.taxiways ?? []).join(' ') || '-'}`);
  }
  L.push('');
  L.push(`REQUESTS ON ${position.toUpperCase()} (${requests.length})${requests.length ? ' — answer each, or STANDBY:' : ''}`);
  for (const o of mine) if (o.request) L.push(`- ${o.callsign}: "${o.request.text}" (${o.request.ageS}s) · answers: ${o.request.answers.join(' | ')}`);
  L.push('');
  L.push(`AIRCRAFT ON ${position.toUpperCase()} (${mine.length})`);
  for (const o of mine) L.push(aircraftLine(o, true));
  if (others.length) { L.push(''); L.push(`OTHER TRAFFIC (${others.length}, not on your frequency — do not instruct)`); for (const o of others) L.push(aircraftLine(o, false)); }
  L.push('');
  L.push(`ALERTS (${alerts.length})`);
  for (const al of alerts) L.push(`- ${al.severity.toUpperCase()} · ${al.title} · ${al.subjects.join(' / ')} · ${al.detail}`);
  if (radio.length) { L.push(''); L.push(`RECENT RADIO (last ${radio.length})`); for (const r of radio) L.push(`- [${clock(r.at)}] ${r.who}${r.callsign ? ` ${r.callsign}` : ''}: ${r.text}`); }
  if (lastActions.length) { L.push(''); L.push('YOUR LAST ACTIONS'); for (const x of lastActions) L.push(`- "${x.line}" → ${x.ok ? 'OK' : 'REJECTED'}${x.note ? `: ${x.note}` : ''}`); }

  return {
    icao: e.air.icao, position, simTime: e.time, clock: clock(e.time),
    wind: { dirMag: windMag, kts: Math.round(wx.windKt), gust: Math.round(wx.gustKt) }, visM: wx.visM, cloud: wx.cloud, qnh: atis?.qnh ?? null, atis: atis?.letter ?? null,
    activeDep: runways.filter(r => r.activeDep).map(r => r.name), activeArr: runways.filter(r => r.activeArr).map(r => r.name), runways: rwyRows,
    score: e.stats.points, traffic: { total: counts.total, air: counts.air, ground: counts.gnd },
    requests, mine, others, alerts, radio, lastActions, text: L.join('\n'),
  };
}
