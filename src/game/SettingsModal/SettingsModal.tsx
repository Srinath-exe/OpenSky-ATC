'use client'
/* In-game settings (UX 04 §10 "settings-btn", G12 `settings-modal`): the settings that matter mid-shift, applied live through the
   store; everything else (history, high score, about) lives on the /settings route, linked from the footer. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './SettingsModal.module.css'
import { Modal, ListRow, Toggle, Select, Pill, Button, Icon } from '@/design'
import type { MenuOption } from '@/design'
import { useSettings, updateSettings } from '@/app/_lib/persist'
import type { Settings } from '@/components/atc/simStore'
import { useShell } from '../shellContext'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS } from '../persist'
import { EV_REPLAY_TIPS } from '../HelpOverlay/OnboardingTips'

type PilotDelayKey = 'auto' | '1' | '2' | '3' | '4' | '6' | '8'
const PILOT_DELAY_OPTIONS: MenuOption<PilotDelayKey>[] = [
  { value: 'auto', label: 'Realistic', description: '2–4 s air, 4–8 s ground' },
  { value: '1', label: '1 s' }, { value: '2', label: '2 s' }, { value: '3', label: '3 s' }, { value: '4', label: '4 s' }, { value: '6', label: '6 s' }, { value: '8', label: '8 s' },
]
const EMERGENCY_OPTIONS: MenuOption<Settings['emergencyRate']>[] = [
  { value: 'off', label: 'Off' }, { value: 'rare', label: 'Rare' }, { value: 'normal', label: 'Normal' }, { value: 'training', label: 'Training', description: 'Frequent' },
]
const REGION_OPTIONS: MenuOption<Settings['region']>[] = [
  { value: 'auto', label: 'Auto', description: 'FAA at K-airports' }, { value: 'ICAO', label: 'ICAO' }, { value: 'FAA', label: 'FAA' },
]

function delayKey(v: number | null): PilotDelayKey {
  if (v == null) return 'auto'
  const k = String(Math.round(v)) as PilotDelayKey
  return PILOT_DELAY_OPTIONS.some((o) => o.value === k) ? k : 'auto'
}

function Mirror({ state, children }: { state: 'on' | 'off'; children: React.ReactNode }) {
  return <span data-state={state}>{children}</span>
}

export function SettingsModal() {
  const shell = useShell()
  const router = useRouter()
  const open = !!shell.open.settings
  const settings = useSettings()
  const [hotkeyBadges, setHotkeyBadges] = usePersistedState<boolean>(LS.hotkeyBadges, true)
  const set = (patch: Partial<Settings>) => updateSettings(patch)
  const close = React.useCallback(() => shell.hide('settings'), [shell])
  React.useEffect(() => { document.documentElement.setAttribute('data-hotkey-badges', hotkeyBadges ? 'on' : 'off') }, [hotkeyBadges])

  return (
    <Modal
      open={open}
      onClose={close}
      title="Settings"
      showClose
      testId="settings-modal"
      footer={
        <div className={styles.foot}>
          <span className={styles.footHint}>Changes apply at once and are kept on this device.</span>
          <Button variant="secondary" size="sm" iconRight={<Icon name="external-link" size={14} />} onClick={() => { close(); router.push('/settings') }} testId="set-open-full">All settings</Button>
          <Button variant="primary" size="sm" onClick={close} testId="set-close">Done</Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.section}>
          <span className={styles.sectionTitle}>Audio</span>
          <div className={styles.rows}>
            <ListRow flush title="Sound" subtitle="Radio clicks, alert chimes, UI cues" trailing={<Mirror state={settings.sound ? 'on' : 'off'}><Toggle checked={settings.sound} onChange={(v) => set({ sound: v })} testId="set-sound" /></Mirror>} />
            <ListRow flush title="Pilot voice" subtitle="Synthesised readbacks and requests" trailing={<Mirror state={settings.tts ? 'on' : 'off'}><Toggle checked={settings.tts} onChange={(v) => set({ tts: v })} testId="set-tts" /></Mirror>} />
            <ListRow
              flush
              title="Volume"
              meta={<span data-testid="set-volume-value" data-value={Math.round(settings.volume * 100)}>{Math.round(settings.volume * 100)} %</span>}
              trailing={<input type="range" min={0} max={100} step={5} value={Math.round(settings.volume * 100)} disabled={!settings.sound} aria-label="Master volume" className={styles.range} onChange={(e) => set({ volume: Number(e.target.value) / 100 })} data-testid="set-volume-master" />}
            />
          </div>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>Realism</span>
          <div className={styles.rows}>
            <ListRow flush title="Pilot response delay" subtitle="Also the undo window" trailing={<Select size="m" ariaLabel="Pilot response delay" options={PILOT_DELAY_OPTIONS} value={delayKey(settings.pilotDelayS)} onChange={(v) => set({ pilotDelayS: v === 'auto' ? null : Number(v) })} className={styles.select} tabular testId="set-pilot-delay" />} />
            <ListRow flush title="Strict frequencies" subtitle="Aircraft only answer the position that owns them" trailing={<Mirror state={settings.strictFrequencies ? 'on' : 'off'}><Toggle checked={settings.strictFrequencies} onChange={(v) => set({ strictFrequencies: v })} testId="set-strict-frequencies" /></Mirror>} />
            <ListRow flush title="Readback errors" subtitle="About 2 % of readbacks come back wrong" trailing={<Mirror state={settings.readbackErrors ? 'on' : 'off'}><Toggle checked={settings.readbackErrors} onChange={(v) => set({ readbackErrors: v })} testId="set-readback-errors" /></Mirror>} />
            <ListRow flush title="Automatic handoffs" subtitle="Frequency changes at 1,000 ft and 10 NM established" trailing={<Mirror state={settings.autoHandoff ? 'on' : 'off'}><Toggle checked={settings.autoHandoff} onChange={(v) => set({ autoHandoff: v })} testId="set-auto-handoff" /></Mirror>} />
            <ListRow flush title="Emergencies" trailing={<Select size="m" ariaLabel="Emergency rate" options={EMERGENCY_OPTIONS} value={settings.emergencyRate} onChange={(v) => set({ emergencyRate: v })} className={styles.select} testId="set-emergency-rate" />} />
            <ListRow flush title="Phraseology" trailing={<Select size="m" ariaLabel="Phraseology" options={REGION_OPTIONS} value={settings.region} onChange={(v) => set({ region: v })} className={styles.select} testId="set-phraseology" />} />
          </div>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>Input</span>
          <div className={styles.rows}>
            <ListRow flush title="Instant vectors" subtitle="Drag-to-heading transmits without a confirm step" trailing={<Mirror state={settings.instantVectors ? 'on' : 'off'}><Toggle checked={settings.instantVectors} onChange={(v) => set({ instantVectors: v })} testId="set-instant-vectors" /></Mirror>} />
            <ListRow flush title="Typed commands transmit on Enter" subtitle="Off shows the parsed command for review first" trailing={<Mirror state={settings.typedInstant ? 'on' : 'off'}><Toggle checked={settings.typedInstant} onChange={(v) => set({ typedInstant: v })} testId="set-typed-instant" /></Mirror>} />
            <ListRow flush title="Hotkey badges" subtitle="Show the key letter on every action button" trailing={<Mirror state={hotkeyBadges ? 'on' : 'off'}><Toggle checked={hotkeyBadges} onChange={setHotkeyBadges} testId="set-hotkey-badges" /></Mirror>} />
          </div>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>Display</span>
          <div className={styles.rows}>
            <ListRow flush title="Ground map" subtitle="Satellite imagery or the vector chart" trailing={
              <span className={styles.pillGroup} role="group" aria-label="Ground theme">
                <Pill size="s" tone="outline" interactive selected={settings.groundTheme === 'satellite'} aria-pressed={settings.groundTheme === 'satellite'} onClick={() => set({ groundTheme: 'satellite' })} testId="set-theme-satellite">Satellite</Pill>
                <Pill size="s" tone="outline" interactive selected={settings.groundTheme === 'chart'} aria-pressed={settings.groundTheme === 'chart'} onClick={() => set({ groundTheme: 'chart' })} testId="set-theme-chart">Chart</Pill>
              </span>
            } />
            <ListRow flush title="Range rings" subtitle="5 NM rings on the approach scope" trailing={<Mirror state={settings.showRings ? 'on' : 'off'}><Toggle checked={settings.showRings} onChange={(v) => set({ showRings: v })} testId="set-show-rings" /></Mirror>} />
            <ListRow flush title="Replay onboarding" subtitle="Show the first-run tips again" trailing={<Button variant="ghost" size="sm" onClick={() => { close(); window.dispatchEvent(new Event(EV_REPLAY_TIPS)) }} testId="set-reset-tips">Replay</Button>} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
