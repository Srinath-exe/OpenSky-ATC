'use client'
/* "Report a problem": a note from the player plus what the page was doing (lib/report.ts), and the crash reporter.
   Mounted once in the root layout; anything opens it with openReport(). */
import * as React from 'react'
import { Modal } from '@/design'
import { installErrorReporting, reportProblem } from '@/lib/report'
import s from './Report.module.css'

const EVENT = 'skycontrol:report'
export function openReport(): void { window.dispatchEvent(new Event(EVENT)) }

export function ReportHost() {
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState('')
  const [state, setState] = React.useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  React.useEffect(() => {
    installErrorReporting()
    const on = () => { setState('idle'); setOpen(true) }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  const send = async () => {
    setState('sending')
    const id = await reportProblem(note.trim())
    setState(id ? 'sent' : 'failed')
    if (id) setNote('')
  }
  const close = () => setOpen(false)
  if (state === 'sent') return (
    <Modal open={open} onClose={close} title="Thanks, it's on its way" confirmLabel="Done" onConfirm={close}>
      <p className={s.text}>We got the report along with the last radio calls and what the speech engine heard, so we can see exactly what happened.</p>
    </Modal>
  )
  return (
    <Modal open={open} onClose={close} title="Report a problem" confirmLabel={state === 'sending' ? 'Sending…' : 'Send report'} confirmVariant="accent"
      onConfirm={send} confirmDisabled={state === 'sending' || note.trim().length < 3} cancelLabel="Cancel">
      <label className={s.label} htmlFor="report-note">What went wrong?</label>
      <textarea id="report-note" className={s.area} rows={5} value={note} onChange={(e) => setNote(e.target.value)} autoFocus maxLength={4000}
        placeholder={'For example: I said "United 214, taxi to runway 1 right via A" and it heard something else.'} data-testid="report-note" />
      <p className={s.small}>The report includes the page you are on, your browser and screen size, the last radio calls and what the speech engine heard. No recordings of your voice.</p>
      {state === 'failed' ? <p className={s.err}>It did not send. Check your connection and try again.</p> : null}
    </Modal>
  )
}
