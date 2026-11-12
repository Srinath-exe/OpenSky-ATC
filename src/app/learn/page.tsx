'use client';
/*
  /learn — the tutorial. SFO with no traffic of its own: each chapter builds its scene on the live sim, and the coach
  (src/game/Tutorial) walks the player through it. ?tab=ground|tower|approach picks the position to start with.
*/
import * as React from 'react';
import { sim, useSim } from '@/components/atc/simStore';
import { applyPrefsToDocument } from '@/app/_lib/persist';
import { GameShell } from '@/game/GameShell';
import { Rail, CoachOverlay, useTutorBoot } from '@/game/Tutorial/Tutorial';
import { sound } from '@/game/Tutorial/audio';
import type { Tab } from '@/game/Tutorial/lessons';
import s from '@/game/Tutorial/Tutorial.module.css';

const tabOf = (): Tab => {
  if (typeof window === 'undefined') return 'ground';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t === 'tower' || t === 'approach' ? t : 'ground';
};

export default function LearnPage() {
  const loading = useSim((st) => st.loading);
  const loadError = useSim((st) => st.loadError);
  const hasEngine = useSim((st) => !!st.engine);
  const [tab] = React.useState<Tab>(tabOf);
  const [settled, setSettled] = React.useState(false);
  const booted = React.useRef(false);
  const load = React.useCallback(() => {
    setSettled(false);
    void sim.load({ icao: 'KSFO', spawn: 'none', position: tab, ends: ['28L', '28R', '01L', '01R'] }).finally(() => setSettled(true));
  }, [tab]);
  React.useEffect(() => {
    applyPrefsToDocument();
    if (booted.current) return; booted.current = true;
    load();
  }, [load]);
  React.useEffect(() => () => { sim.stop(); }, []);
  const { layer, replayIntro } = useTutorBoot(settled && hasEngine, tab);
  // the browser lets sound start only after a click: any click on the page will do
  React.useEffect(() => { const u = () => sound.unlock(); window.addEventListener('pointerdown', u); void sound.loadIndex(); return () => window.removeEventListener('pointerdown', u); }, []);
  return (
    <div className={s.page} data-testid="page-learn" data-ready={settled && hasEngine ? 'true' : undefined}>
      <Rail onIntro={replayIntro} />
      <div className={s.game}>
        <GameShell loading={loading} loadError={loadError} onRetry={load} overlay={<CoachOverlay />} minimal />
      </div>
      {layer}
    </div>
  );
}
