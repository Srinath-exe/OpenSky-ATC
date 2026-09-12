'use client';
/*
  /play — the game (00-MASTER-PLAN §1, §2.5; 05-TEST-STRATEGY §3.1 page root).
  On mount: consume the one-shot start config written by the home page (or the
  URL: ?icao=&seed=&spawn=&test=&position=) and `sim.load(cfg)` — also when an
  engine already exists — so a new start config is always applied (audit B-fix).
  With nothing new requested (plain /play from "Resume shift" or the settings
  page) the live engine on the singleton is resumed instead of rebuilt.
*/
import * as React from 'react';
import s from './play.module.css';
import { sim, useSim } from '@/components/atc/simStore';
import type { StartConfig, Position } from '@/components/atc/simStore';
import * as persist from '@/components/atc/persist';
import { applyPrefsToDocument } from '@/app/_lib/persist';
import { GameShell } from '@/game/GameShell';

const FALLBACK_ICAO = 'EGLL';
const POSITIONS: Position[] = ['ground', 'tower', 'approach'];

function readUrl(): Partial<StartConfig> {
  if (typeof window === 'undefined') return {};
  try {
    const q = new URLSearchParams(window.location.search);
    const out: Partial<StartConfig> = {};
    const icao = q.get('icao');
    if (icao && /^[A-Za-z]{4}$/.test(icao)) out.icao = icao.toUpperCase();
    const seed = q.get('seed');
    if (seed != null && seed !== '' && Number.isFinite(Number(seed))) out.seed = Number(seed);
    const spawn = q.get('spawn');
    if (spawn === 'none' || spawn === 'default') out.spawn = spawn;
    const test = q.get('test');
    if (test === '1' || test === 'true') out.test = true;
    const position = q.get('position');
    if (position && (POSITIONS as string[]).includes(position)) out.position = position as Position;
    return out;
  } catch {
    return {};
  }
}

/**
 * Start config for this mount: URL overrides > one-shot home config > the last session's config > defaults.
 * `fresh` is false when nothing new was asked for (no home config, no URL params): a live engine is then resumed,
 * not rebuilt ("Resume shift" / settings "Back to shift" keep the session; a new start config always applies).
 */
function buildConfig(): { cfg: StartConfig; fresh: boolean } {
  const url = readUrl();
  const oneShot = persist.consumeStartConfig<StartConfig>();
  const stored = oneShot ?? sim.lastConfig;
  // The app router can restore a cached route's search string on a plain push('/play'); URL params therefore only count
  // as a new request when they differ from the session already running on the singleton.
  const last = sim.lastConfig;
  const urlDiffers = (Object.keys(url) as Array<keyof StartConfig>).some((k) => !last || url[k] !== last[k]);
  const fresh = !!oneShot || urlDiffers;
  return {
    fresh,
    cfg: {
      ...(stored ?? {}),
      ...url,
      icao: url.icao ?? stored?.icao ?? FALLBACK_ICAO,
      test: url.test || !!stored?.test,
    },
  };
}

export default function PlayPage() {
  const loading = useSim((st) => st.loading);
  const loadError = useSim((st) => st.loadError);
  const hasEngine = useSim((st) => !!st.engine);
  const [hydrated, setHydrated] = React.useState(false);
  const [settled, setSettled] = React.useState(false);
  const booted = React.useRef(false);
  const cfgRef = React.useRef<StartConfig | null>(null);

  const load = React.useCallback((cfg: StartConfig) => {
    cfgRef.current = cfg;
    setSettled(false);
    void sim.load(cfg).finally(() => setSettled(true));
  }, []);

  React.useEffect(() => {
    applyPrefsToDocument();
    setHydrated(true);
    if (booted.current) return;               // StrictMode double-invoke: one boot per mount
    booted.current = true;
    const { cfg, fresh } = buildConfig();
    if (!fresh && sim.resume()) { cfgRef.current = sim.lastConfig ?? cfg; setSettled(true); return }
    load(cfg);
  }, [load]);

  // Leaving the page stops the RAF loop; the engine stays on the singleton for "Back to shift".
  React.useEffect(() => () => { sim.stop(); }, []);

  const retry = React.useCallback(() => { load(cfgRef.current ?? sim.lastConfig ?? { icao: FALLBACK_ICAO }); }, [load]);
  const ready = hydrated && settled && (hasEngine || !!loadError);

  return (
    <div className={s.page} data-testid="page-atc" data-ready={ready ? 'true' : undefined} data-loading={loading || undefined} data-error={loadError ? 'true' : undefined}>
      <GameShell loading={loading} loadError={loadError} onRetry={retry} />
    </div>
  );
}
