'use client'
/* Standalone viewer for the procedural 3D world map: /map3d?icao=KSFO[&seed=N]. Boots the sim (live) and renders WorldMap full-screen. */
import * as React from 'react';
import { sim, useSim } from '@/components/atc/simStore';
import { WorldMap } from '@/components/atc/WorldMap/WorldMap';

export default function Map3dPage() {
  const hasEngine = useSim((s) => !!s.engine);
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const icao = (q.get('icao') ?? 'KSFO').toUpperCase();
    const seed = Number(q.get('seed') ?? 11);
    if (q.get('test') === '1') sim.enableTestMode({ seed, spawn: (q.get('spawn') as 'none' | 'default') ?? 'default' });
    void sim.load({ icao, seed, spawn: 'default', position: 'ground' } as never);
    return () => { sim.stop(); };
  }, []);
  return (
    <main style={{ position: 'fixed', inset: 0, background: '#0b0b0c' }} data-testid="page-map3d" data-ready={hasEngine ? 'true' : 'false'}>
      {hasEngine ? <WorldMap standalone /> : null}
    </main>
  );
}
