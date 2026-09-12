'use client'
/* Pause menu (UX 04 §2.1, §10 "pause-*", §G12 pause-confirm-*): Esc with nothing selected. The sim is paused while it is open. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './PauseMenu.module.css'
import { Modal, ListRow, Icon, Button, Kbd } from '@/design'
import { sim, useSim, formatSimClock } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'

type Confirm = 'restart' | 'quit' | null

export function PauseMenu() {
  const shell = useShell()
  const router = useRouter()
  const open = !!shell.open.pause
  const icao = useSim((s) => s.icao)
  const time = useSim((s) => Math.floor(s.time()))
  const score = useSim((s) => s.score())
  const counts = useSim((s) => s.counts())
  const [confirm, setConfirm] = React.useState<Confirm>(null)
  const wasRunning = React.useRef(false)

  // Pause on open; resume on close only if the sim was running before.
  React.useEffect(() => {
    if (!open) return
    wasRunning.current = !sim.paused
    if (!sim.paused) sim.setPaused(true)
    setConfirm(null)
    return () => { if (wasRunning.current && sim.paused) sim.setPaused(false) }
  }, [open])

  const close = React.useCallback(() => shell.hide('pause'), [shell])
  /** Open another overlay from here: the menu closes, the sim stays paused (Space or the pause button resumes). */
  const openFromMenu = (o: 'runwayConfig' | 'settings' | 'stats') => { wasRunning.current = false; close(); shell.show(o) }
  const restart = () => { close(); void sim.restart() }
  const quit = () => { close(); sim.stop(); router.push('/') }

  return (
    <Modal open={open} onClose={close} title="Paused" testId="pause-menu" cancelLabel="">
      <div className={styles.meta}>
        <span><strong>{icao}</strong> · {formatSimClock(time)}</span>
        <span>{counts.total} aircraft · <strong>{score}</strong> pts</span>
      </div>
      {confirm ? (
        <div className={styles.confirm} role="group" aria-label={confirm === 'restart' ? 'Confirm restart' : 'Confirm quit'} data-testid={`pause-confirm-${confirm}`}>
          <span className={styles.confirmText}>
            {confirm === 'restart' ? 'Restart the shift with fresh traffic? The current session is recorded in your history.' : 'Quit to the home page? The current session is recorded in your history.'}
          </span>
          <div className={styles.confirmActions}>
            <Button variant="ghost" onClick={() => setConfirm(null)} testId="pause-confirm-no">Back</Button>
            <Button variant="danger" onClick={confirm === 'restart' ? restart : quit} testId="pause-confirm-yes">{confirm === 'restart' ? 'Restart' : 'Quit'}</Button>
          </div>
        </div>
      ) : (
        <div className={styles.list} role="menu">
          <ListRow icon={<Icon name="play" size={18} />} title="Resume" subtitle="Back to the shift" meta={<Kbd>Esc</Kbd>} onClick={close} testId="pause-resume" />
          <ListRow icon={<Icon name="rotate-ccw" size={18} />} title="Restart" subtitle="Same airport and runways, new traffic" onClick={() => setConfirm('restart')} testId="pause-restart" />
          <ListRow icon={<Icon name="plane-takeoff" size={18} />} title="Runway configuration" subtitle="Active runways, roles and weight classes" onClick={() => openFromMenu('runwayConfig')} testId="pause-runways" />
          <ListRow icon={<Icon name="settings-2" size={18} />} title="Settings" subtitle="Sound, realism, display" onClick={() => openFromMenu('settings')} testId="pause-settings" />
          <ListRow icon={<Icon name="gauge" size={18} />} title="Session stats" subtitle="Score breakdown, movements, incidents" onClick={() => openFromMenu('stats')} testId="pause-tracks" />
          <ListRow icon={<Icon name="house" size={18} />} title="Quit to home" subtitle="Ends the shift" onClick={() => setConfirm('quit')} testId="pause-quit" />
        </div>
      )}
    </Modal>
  )
}
