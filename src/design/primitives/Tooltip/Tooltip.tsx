'use client'
import * as React from 'react'
import styles from './Tooltip.module.css'
import { cx, useStableId } from '../../utils'
import { Kbd } from '../Kbd/Kbd'

export interface TooltipProps {
  content: React.ReactNode
  /** keyboard hint rendered as Kbd chips after the label (A20) */
  kbd?: string[]
  children: React.ReactElement
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** ms before showing (300) */
  delay?: number
  disabled?: boolean
  /** wrapper display block instead of inline-flex */
  block?: boolean
  /** show immediately (docs) */
  open?: boolean
  testId?: string
}

const GAP = 8

/** Hover / focus tooltip. Wraps a single element; reads position with getBoundingClientRect (fixed). */
export function Tooltip({ content, kbd, children, placement = 'top', delay = 300, disabled = false, block = false, open: openProp, testId }: TooltipProps) {
  const id = useStableId('tip')
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const isOpen = (openProp ?? open) && !disabled

  const show = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), delay) }
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false) }
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const forced = openProp === true
  React.useLayoutEffect(() => {
    if (!isOpen || forced) { setPos(null); return }
    const a = anchorRef.current?.getBoundingClientRect()
    const t = tipRef.current?.getBoundingClientRect()
    if (!a || !t) return
    let left = a.left + a.width / 2 - t.width / 2
    let top = a.top - t.height - GAP
    if (placement === 'bottom') top = a.bottom + GAP
    if (placement === 'left') { left = a.left - t.width - GAP; top = a.top + a.height / 2 - t.height / 2 }
    if (placement === 'right') { left = a.right + GAP; top = a.top + a.height / 2 - t.height / 2 }
    left = Math.max(8, Math.min(window.innerWidth - t.width - 8, left))
    top = Math.max(8, Math.min(window.innerHeight - t.height - 8, top))
    setPos({ left, top })
  }, [isOpen, placement, content, forced])

  React.useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', hide, true) }
  }, [isOpen])

  return (
    <span ref={anchorRef} className={cx(styles.anchor, block && styles.block)} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} aria-describedby={isOpen ? id : undefined} data-testid={testId}>
      {children}
      {isOpen ? (
        <div ref={tipRef} id={id} role="tooltip" className={cx(styles.tip, forced && styles.tipInline, forced && placement === 'bottom' && styles.tipInlineBottom, forced && placement === 'right' && styles.tipInlineRight, forced && placement === 'left' && styles.tipInlineLeft)} style={forced ? undefined : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
          <span>{content}</span>
          {kbd?.length ? <span className={styles.kbd}>{kbd.map((k) => <Kbd key={k}>{k}</Kbd>)}</span> : null}
        </div>
      ) : null}
    </span>
  )
}
