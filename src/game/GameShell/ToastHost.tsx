'use client'
/* Transient feedback (00-MASTER-PLAN §2.5 "Toasts", design A11.3): renders the store's toast queue with the design-system Toast.
   Alert-mirroring toasts are left to the AlertStack (same alert would otherwise show twice). */
import * as React from 'react'
import styles from './GameShell.module.css'
import { Toast } from '@/design'
import { sim, useSim } from '../hooks/useSimSelector'

const MAX_VISIBLE = 3

export function ToastHost() {
  const toasts = useSim((s) => s.toasts)
  const visible = React.useMemo(() => toasts.filter((t) => !t.alertId && !t.severity).slice(-MAX_VISIBLE), [toasts])
  return (
    <div className={styles.toastHost} data-testid="toast-host" aria-live="polite">
      {visible.map((t) => (
        <Toast
          key={t.key}
          kind={t.kind}
          text={t.scoreDelta != null ? <span className={styles.toastDelta}>{t.text}</span> : t.text}
          detail={t.detail}
          dismissible={t.duration === 0 || t.duration > 3000}
          onDismiss={() => sim.dismissToast(t.key)}
          action={t.callsigns?.length && sim.find(t.callsigns[0]) ? { label: t.callsigns[0], onClick: () => { const a = sim.find(t.callsigns![0]); if (a) sim.select(a.id) } } : undefined}
          testId={`toast-${t.kind}`}
        />
      ))}
    </div>
  )
}
