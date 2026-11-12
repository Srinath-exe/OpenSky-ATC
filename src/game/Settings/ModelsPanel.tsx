'use client'
/* Settings > AI models: every model the game runs, its size and memory, whether it is on this device, how fast it runs
   here (measured when it downloads), and the switch between it and the server or browser. lib/models/manager.ts does
   the work. */
import * as React from 'react'
import { Button, Segmented, Icon, cx } from '@/design'
import { MODELS, downloadModel, goOnDevice, measureServer, setPilotVoice, setVoiceEngine, storageUse, useModels, useVoicePrefs, type ModelId, type ModelInfo, type ModelState } from '@/lib/models/manager'
import { Group } from './SettingsTabs'
import s from './SettingsTabs.module.css'

const mb = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`
const ms = (v: number | null) => v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`

export function ModelsPanel({ wide }: { wide: boolean }) {
  const { states, net } = useModels()
  const voice = useVoicePrefs()
  const [store, setStore] = React.useState<{ usedMB: number; quotaMB: number; persisted: boolean } | null>(null)
  const [busyAll, setBusyAll] = React.useState(false)
  const refresh = React.useCallback(() => { void storageUse().then(setStore) }, [])
  React.useEffect(() => { void measureServer(); refresh() }, [refresh])
  const anyBusy = MODELS.some((m) => states[m.id].state === 'downloading')
  React.useEffect(() => { if (!anyBusy) refresh() }, [anyBusy, refresh])

  const ready = MODELS.filter((m) => states[m.id].state === 'ready')
  const allReady = ready.length === MODELS.length
  const totalMB = MODELS.reduce((a, m) => a + m.sizeMB, 0)
  const ramMB = MODELS.reduce((a, m) => a + m.ramMB, 0)
  const hereMB = ready.reduce((a, m) => a + (states[m.id].bytes ? states[m.id].bytes / 1e6 : m.sizeMB), 0)
  // per transmission: the server's text arrives ~0.2 s of processing plus the network round trip after you let go;
  // on this device it is the model's own time (measured on 2 s of audio when it downloaded)
  const serverMs = net.rttMs != null ? net.rttMs + 200 : null
  const localMs = states.stt.runMs
  const saved = serverMs != null && localMs != null ? serverMs - localMs : null
  const onDevice = voice.engine === 'local' && voice.pilot === 'neural'

  const all = async () => { setBusyAll(true); await goOnDevice(); setBusyAll(false); refresh() }   // speech stays on the server unless switched by hand
  return (
    <>
      <Group title="Run on this device" hint="Download the models once and the game hears you, understands you and speaks for the pilots without a trip to the server" span>
        <div className={s.stats}>
          <Stat label="On this device" value={`${hereMB < 10 ? hereMB.toFixed(1) : Math.round(hereMB)} of ${Math.round(totalMB)} MB`} sub={`${ready.length} of ${MODELS.length} models downloaded`} />
          <Stat label="Memory when loaded" value={`≈ ${ramMB} MB`} sub="Only the models in use load" />
          <Stat label="Storage" value={store?.persisted ? 'Kept' : 'Temporary'} sub={store?.persisted ? 'The browser will not clear the files' : 'The browser may clear it when space runs low'} />
          <Stat label="Server round trip" value={ms(net.rttMs)} sub="Measured just now" />
          <Stat label="Per transmission" value={saved == null ? '–' : saved >= 0 ? `${ms(saved)} faster` : `${ms(-saved)} slower`} sub={saved == null ? 'Download speech to text to measure' : `On device ${ms(localMs)} vs server ≈ ${ms(serverMs)}`} tone={saved == null ? undefined : saved >= 0 ? 'good' : 'warn'} />
        </div>
        <div className={s.allRow}>
          <p className={s.note}>{onDevice && allReady ? 'Everything runs on this device. Your voice never leaves it.' : 'Downloads all three and keeps them. Pilot voices switch to this device; speech stays on the server, which hears aviation words much better (switch it below if you need to be offline).'}</p>
          <Button variant={allReady ? 'secondary' : 'accent'} size="sm" iconLeft={<Icon name={allReady ? 'check' : 'arrow-down'} size={16} />} disabled={busyAll || anyBusy || allReady} onClick={all} testId="models-all">
            {busyAll ? 'Downloading…' : allReady ? 'All downloaded' : 'Download all models'}
          </Button>
        </div>
      </Group>
      <div className={cx(s.modelGrid, wide && s.modelGridWide)} data-span="true">
        {MODELS.map((m) => <ModelCard key={m.id} m={m} st={states[m.id]} voice={voice} />)}
      </div>
    </>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'warn' }) {
  return (
    <div className={s.stat} data-tone={tone}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue}>{value}</span>
      <span className={s.statSub}>{sub}</span>
    </div>
  )
}

function ModelCard({ m, st, voice }: { m: ModelInfo; st: ModelState; voice: { engine: string; pilot: string } }) {
  const id: ModelId = m.id
  const chip = st.state === 'ready' ? 'On this device' : st.state === 'downloading' ? `Downloading ${Math.round(st.progress * 100)} %` : st.state === 'error' ? 'Failed' : 'Not downloaded'
  const use = id === 's1' ? null
    : id === 'stt' ? { items: [{ id: 'server', label: 'Server' }, { id: 'local', label: 'This device' }], value: voice.engine === 'local' ? 'local' : 'server', set: (v: string) => setVoiceEngine(v === 'local' ? 'local' : 'server') }
    : { items: [{ id: 'browser', label: 'Browser' }, { id: 'neural', label: 'This device' }], value: voice.pilot, set: (v: string) => setPilotVoice(v === 'neural' ? 'neural' : 'browser') }
  return (
    <article className={s.model} data-state={st.state} data-testid={`model-${id}`}>
      <header className={s.modelHead}>
        <div>
          <h4 className={s.modelName}>{m.name}{id === 's1' ? <span className={s.badge}>Main</span> : null}</h4>
          <p className={s.modelRole}>{m.role}</p>
        </div>
        <span className={s.chip} data-state={st.state}>{chip}</span>
      </header>
      <p className={s.modelId}>{m.model}</p>
      <dl className={s.facts}>
        <div><dt>Download</dt><dd>{st.bytes && st.state === 'ready' ? mb(st.bytes) : `${m.sizeMB} MB`}</dd></div>
        <div><dt>Memory</dt><dd>≈ {m.ramMB} MB</dd></div>
        <div><dt>Loads in</dt><dd>{ms(st.loadMs)}</dd></div>
        <div><dt>{id === 'tts' ? 'One line' : id === 'stt' ? '2 s of speech' : 'One command'}</dt><dd>{ms(st.runMs)}</dd></div>
      </dl>
      {m.extra ? <p className={s.modelExtra}>{m.extra}{st.device ? ` · runs on ${st.device}` : ''}</p> : st.device ? <p className={s.modelExtra}>Runs on {st.device}</p> : null}
      {st.state === 'downloading' ? <div className={s.bar}><span style={{ transform: `scaleX(${st.progress.toFixed(3)})` }} /></div> : null}
      {st.state === 'error' ? <p className={s.err}>{st.message}</p> : null}
      <footer className={s.modelFoot}>
        {use ? (
          <span className={s.useRow}><span className={s.useLabel}>Use</span><Segmented small ariaLabel={`${m.name}: where it runs`} items={use.items} value={use.value} onChange={use.set} testId={`model-${id}-use`} /></span>
        ) : <span className={s.useLabel}>Always runs on this device</span>}
        <Button variant={st.state === 'ready' ? 'ghost' : 'secondary'} size="sm" iconLeft={<Icon name={st.state === 'ready' ? 'rotate-cw' : 'arrow-down'} size={14} />} disabled={st.state === 'downloading'} onClick={() => void downloadModel(id)} testId={`model-${id}-download`}>
          {st.state === 'ready' ? 'Test again' : st.state === 'downloading' ? 'Downloading…' : st.state === 'error' ? 'Retry' : 'Download'}
        </Button>
      </footer>
      <p className={s.instead}><span>Instead:</span> {m.instead}</p>
    </article>
  )
}
