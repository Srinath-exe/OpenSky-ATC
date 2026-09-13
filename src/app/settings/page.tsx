'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  GlassPanel, Button, Pill, Segmented, Toggle, Select, Kpi, ListRow, EmptyState, Divider,
  Icon, IconArrowLeft, IconPlay, cx, formatThousands,
} from '@/design';
import { PageFrame, StateMirror } from '../_lib/PageFrame';
import {
  useSettings, updateSettings, usePrefs, updatePrefs, useHighScore, resetHighScore, useHistory, clearHistory, useSessionRunning, sessionIcao, resetAllSettings,
  type Settings, type UiPrefs, type EmergencyRate, type Difficulty, type DataBlockDensity, type SessionRecord, type Region,
} from '../_lib/persist';
import pkg from '../../../package.json';
import s from './settings.module.css';

const EMERGENCY_OPTIONS: { value: EmergencyRate; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'No random emergencies' },
  { value: 'rare', label: 'Rare', description: 'About one per two hours' },
  { value: 'normal', label: 'Normal', description: 'About one per hour' },
  { value: 'training', label: 'Training', description: 'Frequent, up to two at once' },
];
type PilotDelayKey = 'auto' | '1' | '2' | '4' | '8';
const PILOT_DELAY_OPTIONS: { value: PilotDelayKey; label: string; description: string }[] = [
  { value: 'auto', label: 'Realistic', description: '2-4 s airborne, 4-8 s on the ground' },
  { value: '1', label: '1 s', description: 'Near instant' },
  { value: '2', label: '2 s', description: '' },
  { value: '4', label: '4 s', description: '' },
  { value: '8', label: '8 s', description: 'Slow crews' },
];
const REGION_OPTIONS: { value: Region; label: string; description: string }[] = [
  { value: 'auto', label: 'Automatic', description: 'FAA at K-airports, ICAO elsewhere' },
  { value: 'ICAO', label: 'ICAO', description: '"Line up and wait", "taxi holding point"' },
  { value: 'FAA', label: 'FAA', description: '"Line up and wait", "taxi via", "hold short"' },
];
const DIFFICULTIES: { id: Difficulty; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'normal', label: 'Normal' }, { id: 'high', label: 'High' }];
const DENSITIES: { id: DataBlockDensity; label: string }[] = [{ id: 'compact', label: 'Compact' }, { id: 'normal', label: 'Normal' }, { id: 'full', label: 'Full' }];

const CREDITS: { title: string; subtitle: string; href?: string; icon: React.ReactNode }[] = [
  { title: 'OpenStreetMap contributors', subtitle: 'Airport layouts, taxiways and stands · ODbL 1.0', href: 'https://www.openstreetmap.org/copyright', icon: <Icon name="map" size={18} /> },
  { title: 'Esri World Imagery', subtitle: 'Satellite backdrops · Esri, Maxar, Earthstar Geographics', href: 'https://www.esri.com/en-us/legal/terms/data-attributions', icon: <Icon name="layers" size={18} /> },
  { title: 'Endless ATC airport format', subtitle: 'Airspace, beacons, ILS and entry-point definitions', icon: <Icon name="radio-tower" size={18} /> },
  { title: 'MapLibre GL JS', subtitle: 'Ground map renderer · BSD-3', href: 'https://maplibre.org', icon: <Icon name="map-pin" size={18} /> },
  { title: 'DM Sans', subtitle: 'Colophon Foundry · SIL Open Font License', href: 'https://fonts.google.com/specimen/DM+Sans', icon: <Icon name="info" size={18} /> },
  { title: 'Lucide', subtitle: 'Line icons · ISC', href: 'https://lucide.dev', icon: <Icon name="sparkles" size={18} /> },
];

function pilotDelayKey(v: number | null): PilotDelayKey {
  if (v == null) return 'auto';
  const k = String(Math.round(v));
  return (['1', '2', '4', '8'] as const).includes(k as '1') ? (k as PilotDelayKey) : 'auto';
}

function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function SettingsPage() {
  const router = useRouter();
  const settings = useSettings();
  const prefs = usePrefs();
  const highScore = useHighScore();
  const history = useHistory();
  const running = useSessionRunning();
  const [resetKey, setResetKey] = React.useState(0);

  const set = (patch: Partial<Settings>) => updateSettings(patch);
  const pref = (patch: Partial<UiPrefs>) => updatePrefs(patch);

  const right = (
    <>
      {running ? (
        <Button variant="accent" iconLeft={<IconPlay size={16} />} onClick={() => router.push('/play')} testId="set-resume">Back to shift{sessionIcao() ? ` · ${sessionIcao()}` : ''}</Button>
      ) : null}
      <Button variant="secondary" iconLeft={<IconArrowLeft size={16} />} onClick={() => router.push('/')} testId="set-back">Home</Button>
    </>
  );

  return (
    <PageFrame testId="page-settings" crumb="Settings" width="narrow" brandTestId="set-home" right={right}>
      <div className={cx(s.page, 'ds-enter')}>
        <header className={s.head}>
          <h1 className={cx('title-l', s.title)}>Settings</h1>
          <p className={cx('body-s', s.sub)}>Changes apply immediately, also to a running shift, and are kept on this device.</p>
        </header>

        {/* ---------------- Simulation ---------------- */}
        <GlassPanel variant="solid" title="Simulation" testId="set-section-simulation" as="section">
          <div className={s.rows}>
            <ListRow title="Auto mode" subtitle="AI controllers work every position you are not on — play ground while the AI runs tower and approach, or the other way round" trailing={
              <StateMirror state={settings.autoMode ? 'on' : 'off'}><Toggle checked={settings.autoMode} onChange={(v) => set({ autoMode: v })} testId="set-automode" /></StateMirror>
            } />
            <ListRow title="AI tower assist" subtitle="Routine tower clearances go out on their own once they are safe" trailing={
              <StateMirror state={settings.autoTower ? 'on' : 'off'}><Toggle checked={settings.autoTower} onChange={(v) => set({ autoTower: v })} testId="set-autotower" /></StateMirror>
            } />
            <ListRow title="AI approach assist" subtitle="Arrivals on the approach frequency are sequenced onto the ILS for you — radar contact, descent, spacing vectors, approach clearance" trailing={
              <StateMirror state={settings.autoApproach ? 'on' : 'off'}><Toggle checked={settings.autoApproach} onChange={(v) => set({ autoApproach: v })} testId="set-autoapproach" /></StateMirror>
            } />
            <ListRow title="Auto taxi-in" subtitle="Arrivals taxi to their stand after vacating without a ground clearance" trailing={
              <StateMirror state={settings.autoGround ? 'on' : 'off'}><Toggle checked={settings.autoGround} onChange={(v) => set({ autoGround: v })} testId="set-autoground" /></StateMirror>
            } />
            <ListRow title="Automatic handoffs" subtitle="Frequency changes at 1,000 ft on departure and 10 NM established" trailing={
              <StateMirror state={settings.autoHandoff ? 'on' : 'off'}><Toggle checked={settings.autoHandoff} onChange={(v) => set({ autoHandoff: v })} testId="set-auto-handoff" /></StateMirror>
            } />
            <ListRow title="Strict frequencies" subtitle="Aircraft only answer the position that owns them" trailing={
              <StateMirror state={settings.strictFrequencies ? 'on' : 'off'}><Toggle checked={settings.strictFrequencies} onChange={(v) => set({ strictFrequencies: v })} testId="set-strict-frequencies" /></StateMirror>
            } />
            <ListRow title="Emergencies" subtitle="How often pilots declare" trailing={
              <Select size="m" ariaLabel="Emergency rate" options={EMERGENCY_OPTIONS} value={settings.emergencyRate} onChange={(v) => set({ emergencyRate: v })} className={s.select} testId="set-emergency-rate" />
            } />
            <ListRow title="Pilot readback errors" subtitle="About 2 % of readbacks come back wrong; catch and correct them" trailing={
              <StateMirror state={settings.readbackErrors ? 'on' : 'off'}><Toggle checked={settings.readbackErrors} onChange={(v) => set({ readbackErrors: v })} testId="set-readback-errors" /></StateMirror>
            } />
            <ListRow title="Pilot response delay" subtitle="Time before a crew reads back" trailing={
              <Select size="m" ariaLabel="Pilot response delay" options={PILOT_DELAY_OPTIONS} value={pilotDelayKey(settings.pilotDelayS)} onChange={(v) => set({ pilotDelayS: v === 'auto' ? null : Number(v) })} className={s.select} tabular testId="set-pilot-delay" />
            } />
            <ListRow title="Phraseology" subtitle="Wording used in transmissions and readbacks" trailing={
              <Select size="m" ariaLabel="Phraseology" options={REGION_OPTIONS} value={settings.region} onChange={(v) => set({ region: v })} className={s.select} testId="set-phraseology" />
            } />
            <ListRow title="Instant vectors" subtitle="Drag-to-heading on the map transmits without a confirm step" trailing={
              <StateMirror state={settings.instantVectors ? 'on' : 'off'}><Toggle checked={settings.instantVectors} onChange={(v) => set({ instantVectors: v })} testId="set-instant-vectors" /></StateMirror>
            } />
            <ListRow title="Typed commands transmit on Enter" subtitle="Off shows the parsed command for review first" trailing={
              <StateMirror state={settings.typedInstant ? 'on' : 'off'}><Toggle checked={settings.typedInstant} onChange={(v) => set({ typedInstant: v })} testId="set-typed-instant" /></StateMirror>
            } />
            <ListRow title="Traffic difficulty" subtitle="Default for new shifts; the home page can override it" trailing={
              <Segmented ariaLabel="Difficulty" value={settings.difficulty} onChange={(v) => set({ difficulty: v as Difficulty })} items={DIFFICULTIES} small testId="set-difficulty" />
            } />
          </div>
        </GlassPanel>

        {/* ---------------- Display ---------------- */}
        <GlassPanel variant="solid" title="Display" testId="set-section-display" as="section">
          <div className={s.rows}>
            <ListRow title="Ground map" subtitle="Satellite imagery or the vector chart" trailing={
              <span className={s.pillGroup} role="group" aria-label="Ground theme">
                <Pill size="s" tone="outline" interactive selected={settings.groundTheme === 'satellite'} aria-pressed={settings.groundTheme === 'satellite'} onClick={() => set({ groundTheme: 'satellite' })} testId="set-theme-satellite">Satellite</Pill>
                <Pill size="s" tone="outline" interactive selected={settings.groundTheme === 'chart'} aria-pressed={settings.groundTheme === 'chart'} onClick={() => set({ groundTheme: 'chart' })} testId="set-theme-chart">Chart</Pill>
              </span>
            } />
            <ListRow title="Range rings" subtitle="5 NM rings and the separation ring on the approach scope" trailing={
              <StateMirror state={settings.showRings ? 'on' : 'off'}><Toggle checked={settings.showRings} onChange={(v) => set({ showRings: v })} testId="set-show-rings" /></StateMirror>
            } />
            <ListRow title="Data blocks" subtitle="How much each aircraft label shows" trailing={
              <Segmented ariaLabel="Data block density" value={prefs.dataBlockDensity} onChange={(v) => pref({ dataBlockDensity: v as DataBlockDensity })} items={DENSITIES} small testId="set-datablock" />
            } />
            <ListRow title="Reduced motion" subtitle="Fades only; no lifts, slides or count-ups" trailing={
              <StateMirror state={prefs.reducedMotion ? 'on' : 'off'}><Toggle checked={prefs.reducedMotion} onChange={(v) => pref({ reducedMotion: v })} testId="set-reduced-motion" /></StateMirror>
            } />
          </div>
        </GlassPanel>

        {/* ---------------- Audio ---------------- */}
        <GlassPanel variant="solid" title="Audio" testId="set-section-audio" as="section">
          <div className={s.rows}>
            <ListRow title="Sound" subtitle="Radio clicks, alert chimes and UI cues" trailing={
              <StateMirror state={settings.sound ? 'on' : 'off'}><Toggle checked={settings.sound} onChange={(v) => set({ sound: v })} testId="set-sound" /></StateMirror>
            } />
            <ListRow title="Pilot voice" subtitle="Synthesised readbacks and requests" trailing={
              <StateMirror state={settings.tts ? 'on' : 'off'}><Toggle checked={settings.tts} onChange={(v) => set({ tts: v })} testId="set-tts" /></StateMirror>
            } />
            <ListRow
              title="Volume"
              subtitle="Master level for every sound"
              meta={<span data-testid="set-volume-value" data-value={Math.round(settings.volume * 100)}>{Math.round(settings.volume * 100)} %</span>}
              trailing={
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(settings.volume * 100)}
                  disabled={!settings.sound}
                  aria-label="Master volume"
                  className={s.range}
                  style={{ ['--v' as string]: `${Math.round(settings.volume * 100)}%` }}
                  onChange={(e) => set({ volume: Number(e.target.value) / 100 })}
                  data-testid="set-volume"
                />
              }
            />
          </div>
        </GlassPanel>

        {/* ---------------- Data ---------------- */}
        <GlassPanel variant="solid" title="Data" testId="set-section-data" as="section">
          <div className={s.scoreRow}>
            <div className={s.scoreBlock}>
              <span className={cx('label-xs', s.label)}>High score</span>
              <span className={s.scoreValue} data-testid="set-highscore" data-value={highScore}>
                <Kpi size="m" value={highScore} split="comma" countUp />
              </span>
            </div>
            <Button variant="danger" size="sm" onClick={() => { resetHighScore(); setResetKey((k) => k + 1); }} flashKey={resetKey} disabled={highScore === 0} testId="set-reset-score">Reset high score</Button>
          </div>

          <Divider spacing="m" />

          <div className={s.historyHead}>
            <span className={cx('body-m', s.historyTitle)}>Recent shifts <span className={s.paren}>(last {Math.min(history.length, 10)})</span></span>
            <Button variant="ghost" size="sm" onClick={clearHistory} disabled={history.length === 0} testId="set-clear-history">Clear</Button>
          </div>
          {history.length === 0 ? (
            <EmptyState compact title="No shifts recorded yet" hint="Finish a session and it shows up here with score, movements and incidents." testId="set-history-empty" />
          ) : (
            <div className={s.tableWrap}>
              <table className={cx(s.table, 'tabular')} data-testid="set-history">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Airport</th>
                    <th scope="col" className={s.num}>Score</th>
                    <th scope="col" className={s.num}>Skill</th>
                    <th scope="col" className={s.num}>Movements</th>
                    <th scope="col" className={s.num}>Incidents</th>
                    <th scope="col" className={s.num}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r: SessionRecord, i: number) => (
                    <tr key={`${r.endedAt}-${i}`} data-testid={`set-history-${i}`} data-score={r.points}>
                      <td>{formatDate(r.endedAt)}</td>
                      <td>{r.icao}</td>
                      <td className={s.num}>{formatThousands(r.points)}</td>
                      <td className={s.num}>{r.skill.toFixed(1)}</td>
                      <td className={s.num}>{r.movements}</td>
                      <td className={cx(s.num, r.incidents > 0 && s.bad)}>{r.incidents}</td>
                      <td className={s.num}>{formatDuration(r.simTimeS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Divider spacing="m" />

          <ListRow title="Reset all settings" subtitle="Back to defaults; the high score is kept" trailing={
            <Button variant="secondary" size="sm" onClick={resetAllSettings} testId="set-reset-all">Reset</Button>
          } />
        </GlassPanel>

        {/* ---------------- About ---------------- */}
        <GlassPanel variant="solid" title="About" testId="set-section-about" as="section">
          <div className={s.rows}>
            <ListRow title="SKYCONTROL" subtitle="Ground, tower and approach simulation" meta={<span data-testid="set-version">v{pkg.version}</span>} />
            {CREDITS.map((c) => (
              <ListRow
                key={c.title}
                icon={c.icon}
                title={c.title}
                subtitle={c.subtitle}
                trailing={c.href ? <span className={s.ext}><Icon name="external-link" size={16} /></span> : undefined}
                onClick={c.href ? () => window.open(c.href, '_blank', 'noopener,noreferrer') : undefined}
                testId={`set-credit-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              />
            ))}
          </div>
        </GlassPanel>
      </div>
    </PageFrame>
  );
}
