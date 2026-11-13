'use client'
/*
  Settings, one set of tabs for both places they open: the in-game panel (SettingsModal, the tabs the shift needs) and
  the /settings page (all of them, plus your data and the credits). Left: the tabs. Right: the tab's groups - one
  column in the panel, a grid that uses the width on the page. Every change applies at once and stays on this device.
*/
import * as React from 'react'
import { ListRow, Toggle, Select, Pill, Button, Icon, Input, Segmented, Kpi, EmptyState, cx, formatThousands } from '@/design'
import type { MenuOption } from '@/design'
import type { IconName } from '@/design/icons'
import { sim, useSim, sectorAi, sectorPatch } from '@/components/atc/simStore'
import type { Settings } from '@/components/atc/simStore'
import { probeEndpoint } from '@/lib/llm/client'
import type { LlmConfig } from '@/lib/llm/client'
import type { PlayerPosition } from '@/lib/sim/types'
import { useSettings, updateSettings, usePrefs, updatePrefs, useHighScore, resetHighScore, useHistory, clearHistory, resetAllSettings, type DataBlockDensity, type Difficulty, type SessionRecord } from '@/app/_lib/persist'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS, EV_VOICE_ENGINE } from '../persist'
import { nativeSpeechAvailable, VOICE_ACCENTS, defaultAccent } from '@/lib/voice/recognizer'
import type { VoiceEngine } from '@/lib/voice/recognizer'
import { EV_REPLAY_TIPS } from '../HelpOverlay/OnboardingTips'
import { PRESETS, setGraphicsPref, useDetected, useGraphicsPref } from '@/components/atc/WorldMap/quality'
import type { GraphicsPref } from '@/components/atc/WorldMap/quality'
import { setLook, useLook } from '@/components/atc/WorldMap/cinematic'
import { setPilotVoice, setVoiceEngine, useVoicePrefs } from '@/lib/models/manager'
import { ModelsPanel } from './ModelsPanel'
import s from './SettingsTabs.module.css'
import { openReport } from '../Report/Report'

export type TabId = 'gameplay' | 'voice' | 'audio' | 'graphics' | 'models' | 'data' | 'about'
const TABS: { id: TabId; label: string; hint: string; icon: IconName }[] = [
  { id: 'gameplay', label: 'Gameplay', hint: 'Seats, traffic, pilots', icon: 'plane' },
  { id: 'voice', label: 'Voice & input', hint: 'Speech, commands, keys', icon: 'radio' },
  { id: 'audio', label: 'Audio', hint: 'Sound and pilot voices', icon: 'volume-2' },
  { id: 'graphics', label: 'Graphics', hint: 'Quality, look, map', icon: 'layers' },
  { id: 'models', label: 'AI models', hint: 'Download, run on device', icon: 'sparkles' },
  { id: 'data', label: 'Your data', hint: 'Scores and history', icon: 'gauge' },
  { id: 'about', label: 'About', hint: 'Version and credits', icon: 'info' },
]

export function SettingsTabs({ variant, initial = 'gameplay', onLeave }: { variant: 'panel' | 'page'; initial?: TabId; onLeave?: () => void }) {
  const tabs = variant === 'panel' ? TABS.filter((t) => t.id !== 'data' && t.id !== 'about') : TABS
  const [tab, setTab] = React.useState<TabId>(initial)
  const body = React.useRef<HTMLDivElement>(null)
  const pick = (id: TabId) => { setTab(id); body.current?.scrollTo({ top: 0 }) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault(); const i = tabs.findIndex((t) => t.id === tab); const n = tabs[(i + (e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length]
    pick(n.id); (document.getElementById(`settab-${n.id}`) as HTMLButtonElement | null)?.focus()
  }
  return (
    <div className={s.root} data-variant={variant}>
      <nav className={s.nav} role="tablist" aria-label="Settings" aria-orientation="vertical" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`settab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className={s.tab} onClick={() => pick(t.id)} data-testid={`settab-${t.id}`}>
            <span className={s.tabIcon}><Icon name={t.icon} size={16} /></span>
            <span className={s.tabText}><span className={s.tabLabel}>{t.label}</span><span className={s.tabHint}>{t.hint}</span></span>
          </button>
        ))}
      </nav>
      <div ref={body} className={s.body} role="tabpanel" aria-labelledby={`settab-${tab}`}>
        <div className={s.head}><h2 className={s.title}>{tabs.find((t) => t.id === tab)?.label}</h2></div>
        <div className={s.groups} data-tab={tab}>
          {tab === 'gameplay' && <Gameplay />}
          {tab === 'voice' && <VoiceInput />}
          {tab === 'audio' && <Audio />}
          {tab === 'graphics' && <Graphics inGame={variant === 'panel'} onLeave={onLeave} />}
          {tab === 'models' && <><ModelsPanel wide={variant === 'page'} /><Llm /></>}
          {tab === 'data' && <Data />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  )
}

export function Group({ title, hint, children, span, testId }: { title: string; hint?: string; children: React.ReactNode; span?: boolean; testId?: string }) {
  return (
    <section className={s.group} data-span={span || undefined} data-testid={testId}>
      <header className={s.groupHead}><h3 className={s.groupTitle}>{title}</h3>{hint ? <p className={s.groupHint}>{hint}</p> : null}</header>
      <div className={s.rows}>{children}</div>
    </section>
  )
}
const Mirror = ({ on, children }: { on: boolean; children: React.ReactNode }) => <span data-state={on ? 'on' : 'off'}>{children}</span>
const set = (patch: Partial<Settings>) => updateSettings(patch)

// ── gameplay ──
type DelayKey = 'auto' | '1' | '2' | '3' | '4' | '6' | '8'
const DELAYS: MenuOption<DelayKey>[] = [
  { value: 'auto', label: 'Realistic', description: '2–4 s airborne, 4–8 s on the ground' },
  { value: '1', label: '1 s' }, { value: '2', label: '2 s' }, { value: '3', label: '3 s' }, { value: '4', label: '4 s' }, { value: '6', label: '6 s' }, { value: '8', label: '8 s' },
]
const delayKey = (v: number | null): DelayKey => { if (v == null) return 'auto'; const k = String(Math.round(v)) as DelayKey; return DELAYS.some((o) => o.value === k) ? k : 'auto' }
const EMERG: MenuOption<Settings['emergencyRate']>[] = [
  { value: 'off', label: 'Off', description: 'No random emergencies' }, { value: 'rare', label: 'Rare', description: 'About one per two hours' },
  { value: 'normal', label: 'Normal', description: 'About one per hour' }, { value: 'training', label: 'Training', description: 'Frequent, up to two at once' },
]
const REGION: MenuOption<Settings['region']>[] = [
  { value: 'auto', label: 'Automatic', description: 'FAA at K-airports, ICAO elsewhere' }, { value: 'ICAO', label: 'ICAO' }, { value: 'FAA', label: 'FAA' },
]
const YOU_AI = [{ id: 'you', label: 'You' }, { id: 'ai', label: 'AI' }]

function Gameplay() {
  const st = useSettings()
  return (
    <>
      <Group title="Who controls" hint="Work one seat and let the AI run the other, or both yourself">
        <ListRow flush title="Tower" subtitle="Ground and runway: start-up, pushback, taxi, take-off and landing clearances" trailing={<Segmented small ariaLabel="Tower controller" items={YOU_AI} value={sectorAi(st, 'airfield') ? 'ai' : 'you'} onChange={(v) => set(sectorPatch('airfield', v === 'ai'))} testId="set-sector-airfield" />} />
        <ListRow flush title="Approach" subtitle="Radar: arrivals onto the ILS, departures climbed out" trailing={<Segmented small ariaLabel="Approach controller" items={YOU_AI} value={sectorAi(st, 'approach') ? 'ai' : 'you'} onChange={(v) => set(sectorPatch('approach', v === 'ai'))} testId="set-sector-approach" />} />
        <ListRow flush title="Automatic handoffs" subtitle="Frequency changes at 1,000 ft on departure and 10 NM established" trailing={<Mirror on={st.autoHandoff}><Toggle checked={st.autoHandoff} onChange={(v) => set({ autoHandoff: v })} testId="set-auto-handoff" /></Mirror>} />
      </Group>
      <Group title="Traffic">
        <ListRow flush title="Difficulty" subtitle="Default for new shifts; the setup page can override it" trailing={<Segmented small ariaLabel="Difficulty" value={st.difficulty} onChange={(v) => set({ difficulty: v as Difficulty })} items={[{ id: 'low', label: 'Low' }, { id: 'normal', label: 'Normal' }, { id: 'high', label: 'High' }]} testId="set-difficulty" />} />
        <ListRow flush title="Emergencies" subtitle="How often pilots declare" trailing={<Select size="m" ariaLabel="Emergency rate" options={EMERG} value={st.emergencyRate} onChange={(v) => set({ emergencyRate: v })} className={s.select} testId="set-emergency-rate" />} />
        <ListRow flush title="Phraseology" subtitle="Wording in transmissions and readbacks" trailing={<Select size="m" ariaLabel="Phraseology" options={REGION} value={st.region} onChange={(v) => set({ region: v })} className={s.select} testId="set-phraseology" />} />
      </Group>
      <Group title="Pilots">
        <ListRow flush title="Response delay" subtitle="Time before a crew reads back; also your undo window" trailing={<Select size="m" ariaLabel="Pilot response delay" options={DELAYS} value={delayKey(st.pilotDelayS)} onChange={(v) => set({ pilotDelayS: v === 'auto' ? null : Number(v) })} className={s.select} tabular testId="set-pilot-delay" />} />
        <ListRow flush title="Readback errors" subtitle="About 2 % of readbacks come back wrong: catch and correct them" trailing={<Mirror on={st.readbackErrors}><Toggle checked={st.readbackErrors} onChange={(v) => set({ readbackErrors: v })} testId="set-readback-errors" /></Mirror>} />
        <ListRow flush title="Strict frequencies" subtitle="Aircraft only answer the position that owns them" trailing={<Mirror on={st.strictFrequencies}><Toggle checked={st.strictFrequencies} onChange={(v) => set({ strictFrequencies: v })} testId="set-strict-frequencies" /></Mirror>} />
      </Group>
    </>
  )
}

// ── voice & input ──
const engineOptions = (): MenuOption<VoiceEngine>[] => [
  ...(nativeSpeechAvailable() ? [{ value: 'native' as const, label: 'Phone', description: 'The OpenATC app transcribes on this phone; audio never leaves it' }] : []),
  { value: 'server', label: 'Server (tuned for ATC)', description: 'SkyControl ATC-ASR 110M, our model fine-tuned on ATC speech, on this game\'s server, with the callsigns on frequency. The most accurate; text ~0.3 s after you let go. Audio not stored' },
  { value: 'local', label: 'On this device', description: 'Moonshine in your browser: audio never leaves this device. Download it under AI models' },
  { value: 'browser', label: 'Browser (Google)', description: 'The built-in recogniser (Chrome sends audio to Google); often mishears aviation words' },
]
function VoiceInput() {
  const st = useSettings()
  const { engine } = useVoicePrefs()
  const [accent, setAccentState] = usePersistedState<string>(LS.voiceAccent, defaultAccent())
  const setAccent = (v: string) => { setAccentState(v); window.setTimeout(() => window.dispatchEvent(new Event(EV_VOICE_ENGINE)), 0) }
  const [badges, setBadges] = usePersistedState<boolean>(LS.hotkeyBadges, true)
  React.useEffect(() => { document.documentElement.setAttribute('data-hotkey-badges', badges ? 'on' : 'off') }, [badges])
  const opts = engineOptions()
  return (
    <>
      <Group title="Voice" hint="Hold the talk key and speak like on the radio">
        <ListRow flush title="Speech recognition" subtitle={opts.find((o) => o.value === engine)?.description ?? ''} trailing={<Select size="m" ariaLabel="Voice recognition" options={opts} value={engine} onChange={(v) => setVoiceEngine(v)} className={s.select} testId="set-voice-engine" />} />
        {engine === 'browser' && <ListRow flush title="Accent" subtitle="The browser recogniser has a model per accent: pick yours" trailing={<Select size="m" ariaLabel="Voice accent" options={VOICE_ACCENTS} value={accent} onChange={setAccent} className={s.select} testId="set-voice-accent" />} />}
      </Group>
      <Group title="Commands">
        <ListRow flush title="Typed commands transmit on Enter" subtitle="Off shows the parsed command for review first" trailing={<Mirror on={st.typedInstant}><Toggle checked={st.typedInstant} onChange={(v) => set({ typedInstant: v })} testId="set-typed-instant" /></Mirror>} />
        <ListRow flush title="Instant vectors" subtitle="Drag-to-heading on the map transmits without a confirm step" trailing={<Mirror on={st.instantVectors}><Toggle checked={st.instantVectors} onChange={(v) => set({ instantVectors: v })} testId="set-instant-vectors" /></Mirror>} />
        <ListRow flush title="Hotkey badges" subtitle="Show the key letter on every action button" trailing={<Mirror on={badges}><Toggle checked={badges} onChange={setBadges} testId="set-hotkey-badges" /></Mirror>} />
      </Group>
    </>
  )
}

// ── audio ──
function Audio() {
  const st = useSettings()
  const { pilot } = useVoicePrefs()
  const v = Math.round(st.volume * 100)
  return (
    <>
      <Group title="Sound">
        <ListRow flush title="Sound" subtitle="Radio clicks, alert chimes and UI cues" trailing={<Mirror on={st.sound}><Toggle checked={st.sound} onChange={(x) => set({ sound: x })} testId="set-sound" /></Mirror>} />
        <ListRow flush title="Volume" subtitle="Master level for every sound" meta={<span data-testid="set-volume-value" data-value={v}>{v} %</span>} trailing={
          <input type="range" min={0} max={100} step={5} value={v} disabled={!st.sound} aria-label="Master volume" className={s.range} style={{ ['--v' as string]: `${v}%` }} onChange={(e) => set({ volume: Number(e.target.value) / 100 })} data-testid="set-volume" />
        } />
      </Group>
      <Group title="Pilots on the radio">
        <ListRow flush title="Pilot voice" subtitle="Spoken readbacks and requests" trailing={<Mirror on={st.tts}><Toggle checked={st.tts} onChange={(x) => set({ tts: x })} testId="set-tts" /></Mirror>} />
        <ListRow flush title="Voices" subtitle={pilot === 'neural' ? 'Neural: four pilot voices made on this device (Paradee-8M, ~8 MB, see AI models)' : 'Browser: the built-in speech voice, the same for every pilot'} trailing={
          <Segmented small ariaLabel="Pilot voices" items={[{ id: 'neural', label: 'Neural' }, { id: 'browser', label: 'Browser' }]} value={pilot} onChange={(x) => setPilotVoice(x as 'neural' | 'browser')} testId="set-pilot-voices" />
        } />
      </Group>
    </>
  )
}

// ── graphics ──
function Graphics({ inGame, onLeave }: { inGame: boolean; onLeave?: () => void }) {
  const st = useSettings(); const prefs = usePrefs()
  const pref = useGraphicsPref(); const detected = useDetected(); const look = useLook()
  const tier = pref === 'auto' ? detected?.tier ?? null : pref
  const p = tier ? PRESETS[tier] : null
  const what = p ? `${p.bokeh ? 'Depth of field' : 'No depth of field'} · ${p.fxaa ? 'FXAA' : 'no AA'} · up to ${p.dprMax}× render scale · models within ${(p.modelDist / 1000).toFixed(1)} km${p.fpsCap ? ` · ${p.fpsCap} fps` : ''}` : 'Detected once the map is up'
  const label = (k: GraphicsPref) => k === 'auto' ? `Auto${detected ? ` (${detected.tier})` : ''}` : k[0].toUpperCase() + k.slice(1)
  return (
    <>
      <Group title="3D map" span testId="graphics-section">
        <ListRow flush title="Quality" subtitle={what} trailing={
          <span className={s.pills} role="group" aria-label="3D map quality">
            {(['auto', 'ultra', 'high', 'medium', 'low'] as const).map((k) => <Pill key={k} size="s" tone="outline" interactive selected={pref === k} aria-pressed={pref === k} onClick={() => setGraphicsPref(k)} testId={`gfx-${k}`}>{label(k)}</Pill>)}
          </span>
        } />
        <ListRow flush title="Look" subtitle={look === 'cinematic' ? 'Cinematic: glow on the sun and the lights, a film colour grade, vignette and grain' : 'Standard: clean and true to life'} trailing={
          <span className={s.pills} role="group" aria-label="Map look">
            {(['standard', 'cinematic'] as const).map((k) => <Pill key={k} size="s" tone="outline" interactive selected={look === k} aria-pressed={look === k} onClick={() => setLook(k)} testId={`look-${k}`}>{k === 'standard' ? 'Standard' : 'Cinematic'}</Pill>)}
          </span>
        } />
        {detected ? <ListRow flush title="This device" subtitle={`${detected.device.gpu || 'GPU unknown'} · ${detected.device.cores} cores${detected.device.memoryGB ? ` · ${detected.device.memoryGB} GB` : ''}${detected.device.coarse ? ' · touch' : ''}`} meta={<span data-testid="gfx-detected" data-tier={detected.tier}>{detected.tier}</span>} /> : null}
      </Group>
      <Group title="Map and scope">
        <ListRow flush title="Ground map" subtitle="Satellite imagery or the vector chart" trailing={
          <span className={s.pills} role="group" aria-label="Ground theme">
            <Pill size="s" tone="outline" interactive selected={st.groundTheme === 'satellite'} aria-pressed={st.groundTheme === 'satellite'} onClick={() => set({ groundTheme: 'satellite' })} testId="set-theme-satellite">Satellite</Pill>
            <Pill size="s" tone="outline" interactive selected={st.groundTheme === 'chart'} aria-pressed={st.groundTheme === 'chart'} onClick={() => set({ groundTheme: 'chart' })} testId="set-theme-chart">Chart</Pill>
          </span>
        } />
        <ListRow flush title="Range rings" subtitle="5 NM rings on the approach scope" trailing={<Mirror on={st.showRings}><Toggle checked={st.showRings} onChange={(v) => set({ showRings: v })} testId="set-show-rings" /></Mirror>} />
        <ListRow flush title="Data blocks" subtitle="How much each aircraft label shows" trailing={<Segmented small ariaLabel="Data block density" value={prefs.dataBlockDensity} onChange={(v) => updatePrefs({ dataBlockDensity: v as DataBlockDensity })} items={[{ id: 'compact', label: 'Compact' }, { id: 'normal', label: 'Normal' }, { id: 'full', label: 'Full' }]} testId="set-datablock" />} />
      </Group>
      <Group title="Comfort">
        <ListRow flush title="Reduced motion" subtitle="Fades only; no lifts, slides or count-ups" trailing={<Mirror on={prefs.reducedMotion}><Toggle checked={prefs.reducedMotion} onChange={(v) => updatePrefs({ reducedMotion: v })} testId="set-reduced-motion" /></Mirror>} />
        {inGame ? <ListRow flush title="First-run tips" subtitle="Show the coach marks again" trailing={<Button variant="ghost" size="sm" onClick={() => { onLeave?.(); window.dispatchEvent(new Event(EV_REPLAY_TIPS)) }} testId="set-reset-tips">Replay</Button>} /> : null}
      </Group>
    </>
  )
}

// ── edge LLM ──
const INTERVALS: MenuOption<'4' | '8' | '15' | '30'>[] = [{ value: '4', label: '4 s' }, { value: '8', label: '8 s' }, { value: '15', label: '15 s' }, { value: '30', label: '30 s' }]
const ago = (ms: number | null) => { if (ms == null) return ''; const x = Math.round((Date.now() - ms) / 1000); return x < 60 ? `${x} s ago` : `${Math.round(x / 60)} min ago` }
function Llm() {
  const llm = useSim((x) => x.llm)
  const status = useSim((x) => ({ ...x.llmStatus() }))
  const logSize = useSim((x) => x.llmAgent.log.length)
  const setLlm = (patch: Partial<LlmConfig>) => sim.updateLlm(patch)
  const [probe, setProbe] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const togglePos = (p: PlayerPosition, on: boolean) => setLlm({ positions: on ? Array.from(new Set([...llm.positions, p])) : llm.positions.filter((x) => x !== p) })
  const test = async () => {
    setBusy(true); setProbe(null)
    const r = await probeEndpoint(llm)
    setProbe(r.ok ? { ok: true, text: `Connected in ${r.ms} ms${r.models.length ? ` · models: ${r.models.slice(0, 6).join(', ')}${r.models.length > 6 ? '…' : ''}` : ''}` } : { ok: false, text: r.error ?? 'failed' })
    setBusy(false)
  }
  const exportLog = () => {
    const blob = new Blob([sim.llmAgent.exportJsonl()], { type: 'application/jsonl' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `skycontrol-io-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const statusText = status.lastError ? `Error: ${status.lastError}` : status.calls ? `${status.calls} call${status.calls === 1 ? '' : 's'} · last ${status.lastMs ?? '–'} ms ${ago(status.lastAt)}${status.model ? ` · ${status.model}` : ''}` : llm.mode === 'off' ? 'Off' : 'Waiting for the first call…'
  return (
    <Group title="AI controller (language model)" hint="A chat model that reads the traffic as text and works a position, or advises you. Run one on your machine (Ollama, LM Studio) for no round trips at all" span testId="llm-section">
      <ListRow flush title="Mode" subtitle="Advise = suggestions in the comm log · Control = works the positions" trailing={
        <span className={s.pills} role="group" aria-label="LLM mode">
          {(['off', 'advise', 'control'] as const).map((m) => <Pill key={m} size="s" tone="outline" interactive selected={llm.mode === m} aria-pressed={llm.mode === m} onClick={() => setLlm({ mode: m })} testId={`llm-mode-${m}`}>{m === 'off' ? 'Off' : m === 'advise' ? 'Advise' : 'Control'}</Pill>)}
        </span>
      } />
      <ListRow flush title="Positions" subtitle="Positions the model works" trailing={
        <span className={s.pills} role="group" aria-label="LLM positions">
          {(['ground', 'tower', 'approach'] as const).map((p) => <Pill key={p} size="s" tone="outline" interactive selected={llm.positions.includes(p)} aria-pressed={llm.positions.includes(p)} onClick={() => togglePos(p, !llm.positions.includes(p))} testId={`llm-pos-${p}`}>{p[0].toUpperCase() + p.slice(1)}</Pill>)}
        </span>
      } />
      <ListRow flush title="Endpoint" subtitle="OpenAI-compatible base URL (…/v1); empty = this server's default" trailing={<Input size="m" placeholder="http://127.0.0.1:11434/v1" value={llm.endpoint} onChange={(e) => setLlm({ endpoint: e.target.value })} testId="llm-endpoint" />} />
      <ListRow flush title="Model" subtitle="Model name at the endpoint" trailing={<Input size="m" placeholder="qwen2.5:3b" value={llm.model} onChange={(e) => setLlm({ model: e.target.value })} testId="llm-model" />} />
      <ListRow flush title="API key" subtitle="Optional bearer token" trailing={<Input size="m" type="password" placeholder="sk-…" value={llm.apiKey} onChange={(e) => setLlm({ apiKey: e.target.value })} testId="llm-key" autoComplete="off" />} />
      <ListRow flush title="Cadence" subtitle="Seconds between calls per position" trailing={<Select<'4' | '8' | '15' | '30'> value={String(llm.intervalS) as '4' | '8' | '15' | '30'} options={INTERVALS} onChange={(v) => setLlm({ intervalS: Number(v) })} className={s.select} testId="llm-interval" ariaLabel="LLM cadence" />} />
      <ListRow flush title="Call the endpoint from the browser" subtitle="Needed for a model on your own machine; off = via this server (key stays server-side)" trailing={<Mirror on={llm.direct}><Toggle checked={llm.direct} onChange={(v) => setLlm({ direct: v })} testId="llm-direct" /></Mirror>} />
      <ListRow flush title="Record I/O for training" subtitle={`Observation → command pairs from you and the model · ${logSize} record${logSize === 1 ? '' : 's'}`} trailing={
        <span className={s.pills}>
          <Mirror on={llm.record}><Toggle checked={llm.record} onChange={(v) => setLlm({ record: v })} testId="llm-record" /></Mirror>
          <Button variant="ghost" size="sm" disabled={!logSize} onClick={exportLog} testId="llm-export">Export</Button>
          <Button variant="ghost" size="sm" disabled={!logSize} onClick={() => sim.llmAgent.clearLog()} testId="llm-clear">Clear</Button>
        </span>
      } />
      <ListRow flush title="Status" subtitle={statusText} trailing={<Button variant="secondary" size="sm" disabled={busy} onClick={test} testId="llm-test">{busy ? 'Testing…' : 'Test connection'}</Button>} testId="llm-status" />
      {probe ? <p className={s.note} data-testid="llm-probe" data-ok={probe.ok ? 'true' : 'false'}>{probe.text}</p> : null}
    </Group>
  )
}

// ── your data (page) ──
const fmtDate = (ms: number) => { try { return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
const fmtDur = (sec: number) => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` }
function Data() {
  const high = useHighScore(); const history = useHistory()
  return (
    <>
      <Group title="High score">
        <div className={s.score}>
          <span data-testid="set-highscore" data-value={high}><Kpi size="m" value={high} split="comma" countUp /></span>
          <Button variant="danger" size="sm" onClick={resetHighScore} disabled={high === 0} testId="set-reset-score">Reset</Button>
        </div>
      </Group>
      <Group title="Settings">
        <ListRow flush title="Reset all settings" subtitle="Back to the defaults; the high score is kept" trailing={<Button variant="secondary" size="sm" onClick={resetAllSettings} testId="set-reset-all">Reset</Button>} />
      </Group>
      <Group title={`Recent shifts${history.length ? ` (last ${Math.min(history.length, 10)})` : ''}`} span>
        {history.length === 0 ? <EmptyState compact title="No shifts recorded yet" hint="Finish a session and it shows up here with score, movements and incidents." testId="set-history-empty" /> : (
          <>
            <div className={s.tableWrap}>
              <table className={cx(s.table, 'tabular')} data-testid="set-history">
                <thead><tr><th>When</th><th>Airport</th><th className={s.num}>Score</th><th className={s.num}>Skill</th><th className={s.num}>Movements</th><th className={s.num}>Incidents</th><th className={s.num}>Duration</th></tr></thead>
                <tbody>
                  {history.map((r: SessionRecord, i: number) => (
                    <tr key={`${r.endedAt}-${i}`} data-testid={`set-history-${i}`} data-score={r.points}>
                      <td>{fmtDate(r.endedAt)}</td><td>{r.icao}</td><td className={s.num}>{formatThousands(r.points)}</td><td className={s.num}>{r.skill.toFixed(1)}</td>
                      <td className={s.num}>{r.movements}</td><td className={cx(s.num, r.incidents > 0 && s.bad)}>{r.incidents}</td><td className={s.num}>{fmtDur(r.simTimeS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.right}><Button variant="ghost" size="sm" onClick={clearHistory} testId="set-clear-history">Clear history</Button></div>
          </>
        )}
      </Group>
    </>
  )
}

// ── about (page) ──
const CREDITS: { title: string; subtitle: string; href?: string; icon: IconName }[] = [
  { title: 'OpenStreetMap contributors', subtitle: 'Airport layouts, taxiways and stands · ODbL 1.0', href: 'https://www.openstreetmap.org/copyright', icon: 'map' },
  { title: 'Esri World Imagery', subtitle: 'Satellite backdrops · Esri, Maxar, Earthstar Geographics', href: 'https://www.esri.com/en-us/legal/terms/data-attributions', icon: 'layers' },
  { title: 'Endless ATC airport format', subtitle: 'Airspace, beacons, ILS and entry-point definitions', icon: 'radio-tower' },
  { title: 'MapLibre GL JS', subtitle: 'Ground map renderer · BSD-3', href: 'https://maplibre.org', icon: 'map-pin' },
  { title: 'SkyControl ATC-ASR 110M', subtitle: 'Our speech model, fine-tuned from NVIDIA Parakeet TDT 110M (CC-BY-4.0) · CC BY-NC-SA 4.0', icon: 'radio' },
  { title: 'Moonshine, Parakeet, Paradee', subtitle: 'Speech models · MIT / CC-BY-4.0 / Apache-2.0', icon: 'radio' },
  { title: 'DM Sans', subtitle: 'Colophon Foundry · SIL Open Font License', href: 'https://fonts.google.com/specimen/DM+Sans', icon: 'info' },
  { title: 'Lucide', subtitle: 'Line icons · ISC', href: 'https://lucide.dev', icon: 'sparkles' },
]
export const VersionContext = React.createContext('')
function About() {
  const version = React.useContext(VersionContext)
  return (
    <>
      <Group title="SKYCONTROL">
        <ListRow flush title="Ground, tower and approach simulation" subtitle="Real airports, real phraseology, your voice" meta={<span data-testid="set-version">v{version}</span>} />
      </Group>
      <Group title="Something wrong?">
        <ListRow flush icon={<Icon name="circle-alert" size={18} />} title="Report a problem" subtitle="Tell us what went wrong; the last radio calls and what the speech engine heard go with it" onClick={openReport} testId="set-report" />
      </Group>
      <Group title="Credits" span>
        <div className={s.credits}>
          {CREDITS.map((c) => (
            <ListRow key={c.title} flush icon={<Icon name={c.icon} size={18} />} title={c.title} subtitle={c.subtitle} trailing={c.href ? <Icon name="external-link" size={16} /> : undefined}
              onClick={c.href ? () => window.open(c.href, '_blank', 'noopener,noreferrer') : undefined} testId={`set-credit-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} />
          ))}
        </div>
      </Group>
    </>
  )
}
