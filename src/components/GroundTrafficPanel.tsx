'use client';
import React from 'react';
import { useGroundTraffic } from '@/context/GroundTrafficContext';

export default function GroundTrafficPanel() {
  const { state, dispatch } = useGroundTraffic();
  const aircrafts = Array.from(state.aircrafts.values());

  const stateColor: Record<string, string> = {
    PARKED: '#6b7280',
    PUSHBACK_OUT: '#3b82f6',
    PUSHBACK_COMPLETE: '#60a5fa',
    TAXIING: '#22c55e',
    HOLDING: '#eab308',
    RUNWAY_ENTRY: '#f97316',
    DEPARTING: '#ef4444',
    ARRIVING_RUNWAY: '#a855f7',
    ARRIVED_GATE: '#10b981',
  };

  return (
    <div className="absolute top-16 left-4 z-30 w-64 max-h-[calc(100vh-120px)] overflow-y-auto rounded-xl border border-gray-700 shadow-xl flex flex-col" style={{ background: '#1f2937' }}>
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between sticky top-0" style={{ background: '#1f2937' }}>
        <span className="font-bold text-sm text-white">Ground Traffic</span>
        <span className="text-xs text-gray-400 font-mono">{aircrafts.length} AC</span>
      </div>

      <div className="p-2 space-y-1">
        {aircrafts.map((ac) => {
          const isSelected = state.selectedId === ac.id;
          return (
            <button
              key={ac.id}
              onClick={() => dispatch({ type: 'SELECT', id: isSelected ? null : ac.id })}
              className={`w-full text-left rounded-lg px-2 py-1.5 transition-all text-xs ${
                isSelected ? 'bg-blue-900/50 border border-blue-700' : 'hover:bg-gray-700/50 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: stateColor[ac.state] || '#6b7280' }} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-white truncate">{ac.callsign}</div>
                  <div className="text-gray-400 truncate">
                    {ac.aircraftType} · {ac.state.toLowerCase().replace('_', ' ')} · {(ac.speed * 1.94384).toFixed(0)}kt
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
