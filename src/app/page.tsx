'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  GlassPanel, Button, IconButton, Pill, Segmented, Toggle, Input, Tooltip, Kbd,
  IconArrowUpRight, IconArrowRight, IconChevronLeft, IconSettings, IconWind, IconPlay, cx,
} from '@/design';
import type { WeightClass } from '@/lib/sim/aircraftDB';
import type { RunwayEnd, RunwayPair } from '@/lib/runwayManifest';
import { preferredEnds } from '@/lib/sim/weather';
import { PageFrame, StateMirror } from './_lib/PageFrame';
import {
  AIRPORTS, AIRPORT_BY_ICAO, runwaysOf, longestRunwayFt, satelliteUrl, sanitiseRef, windComponents, MAX_TAILWIND_KT, formatFeet, feetToMetres,
  type AirportMeta,
} from './_lib/airports';
import {
  useSettings, updateSettings, useHighScore, useSessionRunning, writeStartConfig,
  type Difficulty, type Position, type StartConfig,
} from './_lib/persist';
import s from './home.module.css';

const WEIGHTS: WeightClass[] = ['L', 'M', 'H', 'S'];
const WEIGHT_LABEL: Record<WeightClass, string> = { L: 'Light', M: 'Medium', H: 'Heavy', S: 'Super' };
const POSITIONS: { id: Position; label: string }[] = [{ id: 'ground', label: 'Ground' }, { id: 'tower', label: 'Tower' }, { id: 'approach', label: 'Approach' }];
const DIFFICULTIES: { id: Difficulty; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'normal', label: 'Normal' }, { id: 'high', label: 'High' }];

/** Default weight classes per end by runway length (05 §4.1 H3). */
function defaultWeights(lengthFt: number): WeightClass[] {
  if (lengthFt >= 10000) return ['L', 'M', 'H', 'S'];
  if (lengthFt >= 7500) return ['L', 'M', 'H'];
  if (lengthFt >= 5500) return ['L', 'M'];
  return ['L'];
}

interface EndCfg { on: boolean; weights: WeightClass[] }
type RunwayCfg = Record<string, EndCfg>; // keyed by end name

function initialCfg(icao: string): RunwayCfg {
  const cfg: RunwayCfg = {};
  // the ends in use for the field's prevailing wind (the rest can be switched on by hand)
  const meta = AIRPORTS.find((a) => a.icao === icao);
  const on = new Set(meta ? preferredEnds(runwaysOf(icao).flatMap((r) => r.ends), meta.wind.dir, meta.wind.kts) : []);
  for (const r of runwaysOf(icao)) for (const e of r.ends) cfg[e.name] = { on: on.size ? on.has(e.name) : true, weights: defaultWeights(r.lengthFt) };
  return cfg;
}

// ---------------------------------------------------------------------------
//  Page
// ---------------------------------------------------------------------------
export default function HomePage() {
  const router = useRouter();
  const [icao, setIcao] = React.useState<string | null>(null);
  const running = useSessionRunning();
  const highScore = useHighScore();

  const right = (
    <>
      {highScore > 0 ? (
        <Pill size="m" tone="neutral" tabular testId="home-highscore" count={highScore.toLocaleString('en')}>best</Pill>
      ) : null}
      {running ? (
        <Button variant="secondary" iconLeft={<IconPlay size={16} />} onClick={() => router.push('/play')} testId="home-resume">Resume shift</Button>
      ) : null}
      <IconButton label="Settings" icon={<IconSettings />} size={40} variant="glass" onClick={() => router.push('/settings')} testId="home-settings-link" />
    </>
  );

  return (
    <PageFrame testId="page-home" right={right} brandTestId="nav-brand">
      {icao ? (
        <Detail key={icao} airport={AIRPORT_BY_ICAO[icao]} onBack={() => setIcao(null)} />
      ) : (
        <Picker onPick={setIcao} />
      )}
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------
//  Airport picker
// ---------------------------------------------------------------------------
function Picker({ onPick }: { onPick: (icao: string) => void }) {
  return (
    <>
      <section className={cx(s.hero, 'ds-enter')} aria-labelledby="home-title">
        <h1 id="home-title" className={cx('display-xl', s.wordmark)}>SKYCONTROL</h1>
        <p className={cx('body-m', s.heroSub)}>Ground, tower and approach control at twelve real airports. Pick a field, set the runways in use, and take the frequency.</p>
      </section>
      <ul className={cx(s.grid, 'ds-enter')} aria-label="Airports">
        {AIRPORTS.map((a) => (
          <li key={a.icao} className={s.gridItem}>
            <AirportCard airport={a} onClick={() => onPick(a.icao)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function AirportCard({ airport, onClick }: { airport: AirportMeta; onClick: () => void }) {
  const rws = runwaysOf(airport.icao);
  return (
    <GlassPanel
      interactive
      padding="none"
      className={s.card}
      onClick={onClick}
      testId={`airport-card-${airport.icao}`}
      aria-label={`${airport.name}, ${airport.city} (${airport.icao})`}
      data-icao={airport.icao}
    >
      <span className={s.cardSat} style={{ backgroundImage: `url(${satelliteUrl(airport.icao)})` }} aria-hidden="true" />
      <span className={s.cardVeil} aria-hidden="true" />
      <span className={s.cardBody}>
        <span className={s.cardTop}>
          <Pill size="xs" tone="chip" tabular uppercase>{airport.icao}</Pill>
          <span className={s.cardArrow}><IconArrowUpRight size={18} /></span>
        </span>
        <span className={s.cardBottom}>
          <span className={cx('title-m', s.cardName)}>{airport.name}</span>
          <span className={cx('body-s', s.cardCity)}>{airport.city} · {airport.region}</span>
          <span className={cx('label-xs', s.cardMeta)}>
            <span className="tabular">{rws.length}</span> {rws.length === 1 ? 'runway' : 'runways'} · longest <span className="tabular">{formatFeet(longestRunwayFt(airport.icao))}</span>
          </span>
        </span>
      </span>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
//  Detail: runway configuration + shift setup
// ---------------------------------------------------------------------------
function Detail({ airport, onBack }: { airport: AirportMeta; onBack: () => void }) {
  const router = useRouter();
  const settings = useSettings();
  const runways = runwaysOf(airport.icao);
  const [cfg, setCfg] = React.useState<RunwayCfg>(() => initialCfg(airport.icao));
  const [wind, setWind] = React.useState(airport.wind);
  const [position, setPosition] = React.useState<Position>('tower');
  const [difficulty, setDifficulty] = React.useState<Difficulty>(settings.difficulty);
  const [seed, setSeed] = React.useState('');
  const [starting, setStarting] = React.useState(false);

  const toggleEnd = (end: string) => setCfg((c) => ({ ...c, [end]: { ...c[end], on: !c[end].on } }));
  const toggleWeight = (end: string, w: WeightClass) => setCfg((c) => {
    const cur = c[end].weights;
    const next = cur.includes(w) ? cur.filter((x) => x !== w) : WEIGHTS.filter((x) => x === w || cur.includes(x));
    return { ...c, [end]: { ...c[end], weights: next } };
  });

  const activeEnds = runways.flatMap((r) => r.ends.filter((e) => cfg[e.name]?.on).map((e) => e.name));
  const anyOn = activeEnds.length > 0;

  /** Pick the into-wind end of every pair. */
  const applyWind = () => setCfg((c) => {
    const next = { ...c };
    for (const r of runways) {
      const [a, b] = r.ends;
      const ha = windComponents(a.hdg, wind.dir, wind.kts).headKt;
      const hb = windComponents(b.hdg, wind.dir, wind.kts).headKt;
      const favour = ha >= hb ? a : b;
      const other = favour === a ? b : a;
      next[favour.name] = { ...next[favour.name], on: true };
      next[other.name] = { ...next[other.name], on: false };
    }
    return next;
  });

  const seedNum = seed.trim() === '' ? undefined : Number(seed.trim());
  const seedError = seedNum !== undefined && (!Number.isFinite(seedNum) || !Number.isInteger(seedNum) || seedNum < 0) ? 'Whole number' : undefined;

  const start = () => {
    if (!anyOn || seedError || starting) return;
    const weights: Record<string, WeightClass[]> = {};
    for (const end of activeEnds) weights[end] = [...cfg[end].weights];
    const startCfg: StartConfig = {
      icao: airport.icao, ends: activeEnds, weights, difficulty, position, spawn: 'default',
      wind: { dir: wind.dir, kts: wind.kts },
      ...(seedNum !== undefined ? { seed: seedNum } : {}),
    };
    updateSettings({ difficulty });
    writeStartConfig(startCfg);
    setStarting(true);
    router.push('/play');
  };

  return (
    <div className={cx(s.detail, 'ds-enter')} data-testid="home-detail" data-icao={airport.icao}>
      <section className={s.banner} aria-label={`${airport.name} overview`}>
        <span className={s.bannerSat} style={{ backgroundImage: `url(${satelliteUrl(airport.icao, true)})` }} aria-hidden="true" />
        <span className={s.bannerVeil} aria-hidden="true" />
        <div className={s.bannerTop}>
          <Button variant="secondary" iconLeft={<IconChevronLeft size={16} />} onClick={onBack} testId="home-change-airport">Change airport</Button>
        </div>
        <div className={s.bannerBottom}>
          <div className={s.bannerTitleBlock}>
            <h1 className={cx('display-l', s.bannerTitle)} data-testid="home-detail-title">{airport.name}</h1>
            <p className={cx('body-s', s.bannerSub)}>
              {airport.city} · <span className="tabular">{airport.icao}</span> · <span className="tabular">{airport.iata}</span> · elevation <span className="tabular">{formatFeet(airport.elevationFt)}</span>
            </p>
          </div>
          <div className={s.bannerPills}>
            <Pill size="m" tone="glass" tabular count={runways.length}>{runways.length === 1 ? 'runway' : 'runways'}</Pill>
            <Pill size="m" tone="glass" tabular count={activeEnds.length} testId="home-active-count">active {activeEnds.length === 1 ? 'end' : 'ends'}</Pill>
          </div>
        </div>
      </section>

      <div className={s.columns}>
        <GlassPanel
          variant="solid"
          title="Runways in use"
          parenthetical="(per end)"
          headerRight={<WindControl wind={wind} onChange={setWind} onApply={applyWind} />}
          className={s.runwayPanel}
          testId="home-runways"
        >
          <p className={cx('body-s', s.hint)}>Switch each runway end on or off and choose which wake categories may use it. Head and cross components preview the wind you set.</p>
          <ul className={s.rwyList} aria-label="Runways">
            {runways.map((r) => (
              <RunwayRow key={r.ref} pair={r} cfg={cfg} wind={wind} onToggleEnd={toggleEnd} onToggleWeight={toggleWeight} />
            ))}
          </ul>
        </GlassPanel>

        <aside className={s.side}>
          <GlassPanel variant="solid" title="Shift" testId="home-shift">
            <div className={s.field}>
              <span className={cx('body-s', s.fieldLabel)}>Start at position</span>
              <Segmented ariaLabel="Starting position" value={position} onChange={(v) => setPosition(v as Position)} items={POSITIONS} testId="home-position" />
            </div>
            <div className={s.field}>
              <span className={cx('body-s', s.fieldLabel)}>Traffic difficulty</span>
              <Segmented ariaLabel="Difficulty" value={difficulty} onChange={(v) => setDifficulty(v as Difficulty)} items={DIFFICULTIES} testId="home-difficulty" />
            </div>
            <div className={s.field}>
              <Input
                label="Seed"
                placeholder="Random"
                inputMode="numeric"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                error={seedError}
                helper={seedError ? undefined : 'Same seed, same traffic. Leave empty for a fresh shift.'}
                tabular
                size="m"
                fullWidth
                testId="home-seed"
              />
            </div>
            <div className={s.toggles}>
              <StateMirror state={settings.sound ? 'on' : 'off'}>
                <Toggle checked={settings.sound} onChange={(v) => updateSettings({ sound: v })} label="Sound" description="Radio, alerts and UI cues" labelPosition="left" className={s.toggleRow} testId="home-sound" />
              </StateMirror>
              <StateMirror state={settings.tts ? 'on' : 'off'}>
                <Toggle checked={settings.tts} onChange={(v) => updateSettings({ tts: v })} label="Pilot voice" description="Synthesised readbacks" labelPosition="left" className={s.toggleRow} testId="home-tts" />
              </StateMirror>
            </div>
            <div className={s.startWrap}>
              <Button
                variant="accent"
                size="lg"
                fullWidth
                iconRight={<IconArrowRight size={18} />}
                disabled={!anyOn || Boolean(seedError)}
                loading={starting}
                onClick={start}
                testId="home-start"
                aria-describedby="home-start-hint"
              >
                Start shift
              </Button>
              <p id="home-start-hint" className={cx('body-s', s.startHint)} data-testid="home-start-hint">
                {anyOn
                  ? <>{airport.icao} · {activeEnds.join(' ')} · {DIFFICULTIES.find((d) => d.id === difficulty)?.label.toLowerCase()} traffic · {POSITIONS.find((p) => p.id === position)?.label.toLowerCase()}</>
                  : 'Switch on at least one runway end to start.'}
              </p>
            </div>
          </GlassPanel>
          <GlassPanel variant="nested" padding="tile" className={s.tip} testId="home-tip">
            <span className={cx('body-s', s.tipText)}>
              Departures spawn at the gates and arrivals at the airspace boundary. Click any aircraft to see the commands that are valid right now; <Kbd>?</Kbd> opens the phraseology guide in game.
            </span>
          </GlassPanel>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Wind control (header of the runway card)
// ---------------------------------------------------------------------------
function WindControl({ wind, onChange, onApply }: { wind: { dir: number; kts: number }; onChange: (w: { dir: number; kts: number }) => void; onApply: () => void }) {
  const [dir, setDir] = React.useState(String(wind.dir).padStart(3, '0'));
  const [kts, setKts] = React.useState(String(wind.kts));
  const commit = () => {
    const d = ((parseInt(dir, 10) % 360) + 360) % 360;
    const k = Math.max(0, Math.min(99, parseInt(kts, 10)));
    const next = { dir: Number.isFinite(d) ? d : wind.dir, kts: Number.isFinite(k) ? k : wind.kts };
    setDir(String(next.dir).padStart(3, '0'));
    setKts(String(next.kts));
    if (next.dir !== wind.dir || next.kts !== wind.kts) onChange(next);
  };
  return (
    <div className={s.wind} role="group" aria-label="Wind">
      <span className={s.windIcon}><IconWind size={16} /></span>
      <span className={cx('body-s', s.windLabel)}>Wind</span>
      <Input size="m" tabular value={dir} onChange={(e) => setDir(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} aria-label="Wind direction, degrees true" inputMode="numeric" wrapClassName={s.windInput} testId="home-wind-dir" />
      <span className={cx('body-s', s.windSep)}>/</span>
      <Input size="m" tabular value={kts} onChange={(e) => setKts(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} aria-label="Wind speed, knots" inputMode="numeric" wrapClassName={s.windInputS} testId="home-wind-kts" />
      <span className={cx('body-s', s.windUnit)}>kt</span>
      <Tooltip content="Select the into-wind end of every runway">
        <Button variant="ghost" size="sm" onClick={onApply} testId="home-wind-apply">Into wind</Button>
      </Tooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Runway row
// ---------------------------------------------------------------------------
function RunwayRow({ pair, cfg, wind, onToggleEnd, onToggleWeight }: {
  pair: RunwayPair; cfg: RunwayCfg; wind: { dir: number; kts: number };
  onToggleEnd: (end: string) => void; onToggleWeight: (end: string, w: WeightClass) => void;
}) {
  const ref = sanitiseRef(pair.ref);
  const anyOn = pair.ends.some((e) => cfg[e.name]?.on);
  return (
    <li className={cx(s.rwyRow, !anyOn && s.rwyRowOff)} data-testid={`rwy-row-${ref}`} data-ref={pair.ref} data-active={anyOn ? 'true' : 'false'}>
      <div className={s.rwyId}>
        <span className={cx('title-m', 'tabular', s.rwyRef)}>{pair.ends[0].name} <span className={s.rwySlash}>/</span> {pair.ends[1].name}</span>
        <span className={cx('label-xs', 'tabular', s.rwyLen)}>{formatFeet(pair.lengthFt)} · {feetToMetres(pair.lengthFt).toLocaleString('en')} m</span>
      </div>
      {pair.ends.map((e) => (
        <EndBlock key={e.name} end={e} cfg={cfg[e.name]} wind={wind} onToggle={() => onToggleEnd(e.name)} onWeight={(w) => onToggleWeight(e.name, w)} />
      ))}
    </li>
  );
}

function EndBlock({ end, cfg, wind, onToggle, onWeight }: { end: RunwayEnd; cfg: EndCfg; wind: { dir: number; kts: number }; onToggle: () => void; onWeight: (w: WeightClass) => void }) {
  const wc = windComponents(end.hdg, wind.dir, wind.kts);
  const tail = wc.headKt < 0;
  const bad = tail && -wc.headKt > MAX_TAILWIND_KT;
  return (
    <div className={cx(s.end, !cfg.on && s.endOff)} data-end={end.name}>
      <div className={s.endHead}>
        <Pill size="m" tone={cfg.on ? 'outline' : 'dim'} selected={cfg.on} aria-pressed={cfg.on} interactive onClick={onToggle} tabular testId={`rwy-end-${end.name}`} aria-label={`Runway ${end.name} ${cfg.on ? 'active' : 'inactive'}`}>
          {end.name}
        </Pill>
        <span className={cx('label-xs', 'tabular', s.windPreview, bad && s.windBad)} data-testid={`rwy-wind-${end.name}`} data-head={wc.headKt} data-cross={wc.crossKt} title={`Runway heading ${Math.round(end.hdg).toString().padStart(3, '0')}° true`}>
          {wind.kts === 0 ? 'Calm' : (
            <>
              <span className={s.windPart}>{tail ? 'TW' : 'HW'} {Math.abs(wc.headKt)}</span>
              <span className={s.windDot}>·</span>
              <span className={s.windPart}>XW {wc.crossKt}{wc.crossFrom ? ` ${wc.crossFrom}` : ''}</span>
            </>
          )}
        </span>
      </div>
      <div className={s.weights} role="group" aria-label={`Weight classes for ${end.name}`}>
        {WEIGHTS.map((w) => {
          const on = cfg.weights.includes(w);
          return (
            <Tooltip key={w} content={WEIGHT_LABEL[w]} delay={500}>
              <Pill size="xs" tone={on ? 'orange' : 'dim'} selected={on} aria-pressed={on} interactive disabled={!cfg.on} onClick={() => onWeight(w)} testId={`rwy-weight-${end.name}-${w}`} aria-label={`${WEIGHT_LABEL[w]} on ${end.name}`} className={s.weightChip}>
                {w}
              </Pill>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
