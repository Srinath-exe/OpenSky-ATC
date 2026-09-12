'use client'
import * as React from 'react'
import styles from './Toast.module.css'
import { cx } from '../../utils'
import { Button } from '../Button/Button'
import { IconButton } from '../IconButton/IconButton'
import { IconInfo, IconCircleCheck, IconTriangleAlert, IconCircleAlert, IconX } from '../../icons'

export type ToastKind = 'info' | 'success' | 'attention' | 'error'
export interface ToastOptions {
  kind?: ToastKind
  text: React.ReactNode
  detail?: React.ReactNode
  action?: { label: string; onClick: () => void }
  /** ms; default 5000 (error 8000); 0 = sticky */
  duration?: number
  dismissible?: boolean
  id?: string
  testId?: string
}
export interface ToastRecord extends ToastOptions { id: string; kind: ToastKind; leaving?: boolean }

interface ToastApi {
  toast: (opts: ToastOptions | string) => string
  dismiss: (id: string) => void
  clear: () => void
  toasts: ToastRecord[]
}
const ToastContext = React.createContext<ToastApi | null>(null)
let seq = 0

const ICONS: Record<ToastKind, React.ReactNode> = {
  info: <IconInfo size={18} />, success: <IconCircleCheck size={18} />, attention: <IconTriangleAlert size={18} />, error: <IconCircleAlert size={18} />,
}

/** Presentational toast (also used standalone in the showcase). */
export function Toast({ kind = 'info', text, detail, action, dismissible = false, onDismiss, leaving = false, testId, onMouseEnter, onMouseLeave }: Omit<ToastOptions, 'id' | 'duration'> & { onDismiss?: () => void; leaving?: boolean; onMouseEnter?: () => void; onMouseLeave?: () => void }) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} data-testid={testId} data-kind={kind} className={cx(styles.toast, styles[kind], leaving && styles.leaving)} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <span className={styles.icon}>{ICONS[kind]}</span>
      <span className={styles.text}>{text}{detail ? <span className={styles.detail}>{detail}</span> : null}</span>
      {action ? <Button variant="ghost" size="sm" className={styles.action} onClick={action.onClick}>{action.label}</Button> : null}
      {dismissible ? <IconButton className={styles.close} variant="ghost" size={32} label="Dismiss" icon={<IconX size={16} />} onClick={onDismiss} /> : null}
    </div>
  )
}

/** Provider + host. Wrap the app once; call `useToast().toast({...})` anywhere. Max 3 visible, auto-dismiss 5s (error 8s), pause on hover. */
export function ToastProvider({ children, max = 3 }: { children: React.ReactNode; max?: number }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([])
  const timers = React.useRef<Map<string, { t: ReturnType<typeof setTimeout>; remaining: number; started: number }>>(new Map())

  const remove = React.useCallback((id: string) => {
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 130)
    const rec = timers.current.get(id)
    if (rec) { clearTimeout(rec.t); timers.current.delete(id) }
  }, [])
  const schedule = React.useCallback((id: string, ms: number) => {
    if (ms <= 0) return
    const t = setTimeout(() => remove(id), ms)
    timers.current.set(id, { t, remaining: ms, started: Date.now() })
  }, [remove])
  const pause = (id: string) => {
    const rec = timers.current.get(id)
    if (!rec) return
    clearTimeout(rec.t)
    rec.remaining = Math.max(500, rec.remaining - (Date.now() - rec.started))
  }
  const resume = (id: string) => {
    const rec = timers.current.get(id)
    if (!rec) return
    rec.started = Date.now()
    rec.t = setTimeout(() => remove(id), rec.remaining)
  }
  const toast = React.useCallback((opts: ToastOptions | string) => {
    const o: ToastOptions = typeof opts === 'string' ? { text: opts } : opts
    const id = o.id ?? `toast-${++seq}`
    const kind = o.kind ?? 'info'
    const duration = o.duration ?? (kind === 'error' ? 8000 : 5000)
    setToasts((ts) => {
      const next = [...ts.filter((t) => t.id !== id), { ...o, id, kind }]
      while (next.length > max) { const drop = next.shift(); if (drop) { const rec = timers.current.get(drop.id); if (rec) clearTimeout(rec.t) } }
      return next
    })
    schedule(id, duration)
    return id
  }, [max, schedule])
  const clear = React.useCallback(() => { timers.current.forEach((r) => clearTimeout(r.t)); timers.current.clear(); setToasts([]) }, [])
  React.useEffect(() => () => { timers.current.forEach((r) => clearTimeout(r.t)) }, [])
  const api = React.useMemo<ToastApi>(() => ({ toast, dismiss: remove, clear, toasts }), [toast, remove, clear, toasts])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.host} data-testid="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <Toast key={t.id} kind={t.kind} text={t.text} detail={t.detail} action={t.action} dismissible={t.dismissible ?? true} leaving={t.leaving} onDismiss={() => remove(t.id)} onMouseEnter={() => pause(t.id)} onMouseLeave={() => resume(t.id)} testId={t.testId ?? `toast-${t.kind}`} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

/** Static stack for docs / showcase. */
export function ToastStack({ children }: { children: React.ReactNode }) {
  return <div className={cx(styles.host, styles.hostStatic)}>{children}</div>
}
