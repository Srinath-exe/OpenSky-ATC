'use client';
import React, { useState } from 'react';
import { SimAircraft } from '@/lib/aircraft';
import type { TaxiGraph } from '@/lib/airportData';
import type { CommandBtn } from '@/components/LAXMap';

interface Props {
  aircraft: SimAircraft;
  onClose: () => void;
  onCommand: (cmd: CommandBtn) => void;
  graph: TaxiGraph | null;
}

export default function AircraftPopup({ aircraft, onClose, onCommand, graph }: Props) {
  const stateColor: Record<string, string> = {
    PARKED: '#6b7280',
    PUSHBACK_OUT: '#3b82f6',
    PUSHBACK_COMPLETE: '#60a5fa',
    TAXIING: '#22c55e',
    TAXIING_TO_GATE: '#22c55e',
    HOLDING: '#eab308',
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

  const [runwayInput, setRunwayInput] = useState(aircraft.assignedRunway || '');
  const [gateInput, setGateInput] = useState('');

  const runwayOptions: string[] = graph ? Array.from(graph.runways.keys()).filter(k => k.includes('/')).flatMap(k => {
    const rw = graph.runways.get(k)!;
    return [rw.name1, rw.name2];
  }).filter((v, i, a) => a.indexOf(v) === i) : [];

  const stateLabel = aircraft.state.toLowerCase().replace(/_/g, ' ');
  const progress = aircraft.route
    ? Math.min(100, (aircraft.routeProgress.segmentIndex / Math.max(1, aircraft.route.path.length)) * 100)
    : 0;

  return (
    <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 w-80 rounded-xl border border-gray-700 shadow-2xl overflow-hidden" style={{ background: '#1f2937' }}>
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ background: stateColor[aircraft.state] || '#6b7280' }} />
          <div>
            <div className="font-bold text-base text-white">{aircraft.callsign}</div>
            <div className="text-xs text-gray-400">{aircraft.aircraftType} · {aircraft.assignedGate || 'No gate'}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
      </div>

      <div className="px-4 py-3 space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div className="text-gray-400">State</div>
          <div className="text-white capitalize text-right">{stateLabel}</div>
          <div className="text-gray-400">Speed</div>
          <div className="text-white text-right">{(aircraft.speed * 1.94384).toFixed(0)} kt</div>
          <div className="text-gray-400">Heading</div>
          <div className="text-white text-right">{Math.round(aircraft.heading)}&deg;</div>
          {aircraft.altitude > 0 && (
            <>
              <div className="text-gray-400">Altitude</div>
              <div className="text-white text-right">{Math.round(aircraft.altitude)} ft</div>
            </>
          )}
          {aircraft.assignedRunway && (
            <>
              <div className="text-gray-400">Runway</div>
              <div className="text-white text-right">{aircraft.assignedRunway}</div>
            </>
          )}
          <div className="text-gray-400">Position</div>
          <div className="text-white text-right text-xs">{aircraft.position.lat.toFixed(5)}, {aircraft.position.lng.toFixed(5)}</div>
        </div>

        {aircraft.route && (
          <div className="mt-2 pt-2 border-t border-gray-700">
            <div className="text-xs text-gray-400 mb-1">Route Progress</div>
            <div className="w-full bg-gray-700 rounded-full h-1.5">
              <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="text-xs text-gray-500 mt-1 text-right">
              {aircraft.routeProgress.segmentIndex} / {aircraft.route.path.length} segments · {aircraft.routeProgress.holdingAt ? 'HOLDING' : 'moving'}
            </div>
          </div>
        )}
      </div>

      {/* Command buttons — context aware */}
      <div className="px-4 py-3 border-t border-gray-700 space-y-2">
        {/* Departure flow */}
        {aircraft.state === 'PARKED' && (
          <button onClick={() => onCommand({ kind: 'pushback' })} className="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold">
            ▶ Pushback Approved
          </button>
        )}

        {(aircraft.state === 'PUSHBACK_COMPLETE' || aircraft.state === 'PARKED') && (
          <div className="flex gap-2">
            <input
              list="rw-list"
              value={runwayInput}
              onChange={(e) => setRunwayInput(e.target.value.toUpperCase())}
              placeholder="Runway (e.g. 25L)"
              className="flex-1 px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-white text-xs font-mono"
            />
            <button
              onClick={() => onCommand({ kind: 'taxi_runway', runway: runwayInput || undefined })}
              className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-semibold whitespace-nowrap"
            >
              Taxi to RWY
            </button>
            <datalist id="rw-list">
              {runwayOptions.map(r => <option key={r} value={r} />)}
            </datalist>
          </div>
        )}

        {aircraft.state === 'TAXIING_TO_GATE' && (
          <div className="text-xs text-gray-400">Taxiing to gate {aircraft.assignedGate}</div>
        )}

        {/* Taxi to any gate */}
        {(aircraft.state === 'HOLDING' || aircraft.state === 'TAXIING' || aircraft.state === 'ARRIVING_RUNWAY' || aircraft.state === 'LANDED') && (
          <div className="flex gap-2">
            <input
              value={gateInput}
              onChange={(e) => setGateInput(e.target.value)}
              placeholder="Gate name"
              className="flex-1 px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-white text-xs font-mono"
            />
            <button
              onClick={() => onCommand({ kind: 'taxi_gate', gate: gateInput || undefined })}
              className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white text-xs font-semibold whitespace-nowrap"
            >
              Taxi to Gate
            </button>
          </div>
        )}

        {/* Hold / Continue */}
        {(aircraft.state === 'TAXIING' || aircraft.state === 'TAXIING_TO_GATE') && (
          <button onClick={() => onCommand({ kind: 'hold' })} className="w-full px-3 py-1.5 rounded bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-semibold">
            ⏸ Hold Position
          </button>
        )}
        {aircraft.state === 'HOLDING' && (
          <button onClick={() => onCommand({ kind: 'continue' })} className="w-full px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-semibold">
            ▶ Continue Taxi
          </button>
        )}

        {/* Line up + takeoff */}
        {(aircraft.state === 'HOLDING' || aircraft.state === 'RUNWAY_ENTRY') && (
          <button onClick={() => onCommand({ kind: 'line_up' })} className="w-full px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold">
            Line Up & Wait
          </button>
        )}
        {aircraft.state === 'LINE_UP' && (
          <button onClick={() => onCommand({ kind: 'takeoff', runway: aircraft.assignedRunway || undefined })} className="w-full px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">
            ✈ Cleared for Takeoff
          </button>
        )}

        {/* Despawn */}
        {aircraft.state !== 'TAKEOFF_ROLL' && aircraft.state !== 'ROTATE' && aircraft.state !== 'AIRBORNE_CLIMB' && aircraft.state !== 'HANDED_OFF' && (
          <button onClick={() => onCommand({ kind: 'despawn' })} className="w-full px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs">
            Remove
          </button>
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-700 text-center text-[10px] text-gray-500">
        Click on the map to set a custom taxi destination
      </div>
    </div>
  );
}