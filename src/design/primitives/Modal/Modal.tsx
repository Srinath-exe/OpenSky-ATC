'use client'
import * as React from 'react'
import { createPortal } from 'react-dom'
import styles from './Modal.module.css'
import { cx, useStableId } from '../../utils'
import { Button } from '../Button/Button'
import { IconButton } from '../IconButton/IconButton'
import { IconX } from '../../icons'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onEscape?: () => void) {
  React.useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return
    const prev = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === el)
    const first = focusables()[0]
    ;(first ?? el).focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onEscape?.(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (!f.length) { e.preventDefault(); el.focus(); return }
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus() }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; prev?.focus?.({ preventScroll: true }) }
  }, [active, ref, onEscape])
}

function usePortalNode() {
  const [node, setNode] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => { setNode(document.body) }, [])
  return node
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children?: React.ReactNode
  /** custom footer; or use confirm/cancel props */
  footer?: React.ReactNode
  /** left-aligned footer slot */
  footerLeft?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  confirmVariant?: 'primary' | 'accent' | 'danger'
  confirmDisabled?: boolean
  confirmLoading?: boolean
  showClose?: boolean
  /** 640 wide (settings) instead of 440 */
  wide?: boolean
  /** click on the scrim closes (default true) */
  dismissOnScrim?: boolean
  /** render inline instead of a portal (showcase) */
  inline?: boolean
  testId?: string
}

/** Dialog: scrim + focus trap + Esc; footer = Ghost cancel + Primary/Danger confirm. */
export function Modal({ open, onClose, title, children, footer, footerLeft, confirmLabel, cancelLabel = 'Cancel', onConfirm, confirmVariant = 'primary', confirmDisabled = false, confirmLoading = false, showClose = false, wide = false, dismissOnScrim = true, inline = false, testId }: ModalProps) {
  const id = useStableId('modal')
  const panelRef = React.useRef<HTMLDivElement>(null)
  const portal = usePortalNode()
  useFocusTrap(open && !inline, panelRef, onClose)
  if (!open) return null
  const hasFooter = footer !== undefined || confirmLabel || cancelLabel
  const node = (
    <div className={styles.scrim} data-testid={testId ? `${testId}-scrim` : undefined} onMouseDown={(e) => { if (dismissOnScrim && e.target === e.currentTarget) onClose() }} style={inline ? { position: 'absolute' } : undefined}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={title ? `${id}-title` : undefined} tabIndex={-1} data-testid={testId} className={cx(styles.panel, wide && styles.wide)}>
        {title || showClose ? (
          <div className={styles.head}>
            {title ? <h2 id={`${id}-title`} className={styles.title}>{title}</h2> : <span />}
            {showClose ? <IconButton className={styles.close} variant="ghost" size={32} label="Close" icon={<IconX size={16} />} onClick={onClose} testId={testId ? `${testId}-close` : undefined} /> : null}
          </div>
        ) : null}
        {children !== undefined ? <div className={styles.body}>{children}</div> : null}
        {hasFooter ? (
          <div className={styles.footer}>
            {footerLeft ? <span className={styles.footerLeft}>{footerLeft}</span> : null}
            {footer ?? (
              <>
                {cancelLabel ? <Button variant="ghost" onClick={onClose} testId={testId ? `${testId}-cancel` : undefined}>{cancelLabel}</Button> : null}
                {confirmLabel ? <Button variant={confirmVariant} onClick={onConfirm} disabled={confirmDisabled} loading={confirmLoading} testId={testId ? `${testId}-confirm` : undefined}>{confirmLabel}</Button> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
  if (inline || !portal) return inline ? node : null
  return createPortal(node, portal)
}

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  /** "3" count next to the title in the peek state */
  count?: number
  /** snap point: peek 88px / half 50% / full 92% */
  snap?: 'peek' | 'half' | 'full'
  onSnapChange?: (snap: 'peek' | 'half' | 'full') => void
  headerRight?: React.ReactNode
  children?: React.ReactNode
  inline?: boolean
  testId?: string
}

const SNAPS: Array<'peek' | 'half' | 'full'> = ['peek', 'half', 'full']

/** A5 bottom sheet: glass-strong, grab handle, snap points 88px / 50% / 92%, drag threshold 24px. */
export function Sheet({ open, onClose, title, count, snap = 'half', onSnapChange, headerRight, children, inline = false, testId }: SheetProps) {
  const id = useStableId('sheet')
  const ref = React.useRef<HTMLDivElement>(null)
  const portal = usePortalNode()
  const drag = React.useRef<{ y: number } | null>(null)
  useFocusTrap(open && !inline, ref, onClose)
  if (!open) return null
  const onPointerDown = (e: React.PointerEvent) => { drag.current = { y: e.clientY }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return
    const dy = e.clientY - drag.current.y
    drag.current = null
    if (Math.abs(dy) < 24) return
    const i = SNAPS.indexOf(snap)
    if (dy > 0) { if (i === 0) onClose(); else onSnapChange?.(SNAPS[i - 1]) }
    else if (i < SNAPS.length - 1) onSnapChange?.(SNAPS[i + 1])
  }
  const node = (
    <>
      <div className={styles.sheetScrim} onMouseDown={onClose} style={inline ? { position: 'absolute' } : undefined} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={title ? `${id}-title` : undefined} tabIndex={-1} data-testid={testId} data-snap={snap} className={cx(styles.sheet, styles[snap], inline && styles.sheetInline)} style={inline ? { position: 'absolute' } : undefined}>
        <div className={styles.handle} role="presentation" onPointerDown={onPointerDown} onPointerUp={onPointerUp} data-testid={testId ? `${testId}-handle` : undefined} />
        {title || headerRight ? (
          <div className={styles.sheetHead}>
            <div id={`${id}-title`} className={styles.sheetTitle}>{title}{count !== undefined ? <span className={styles.sheetCount}>{count}</span> : null}</div>
            {headerRight}
          </div>
        ) : null}
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </>
  )
  if (inline || !portal) return inline ? node : null
  return createPortal(node, portal)
}
