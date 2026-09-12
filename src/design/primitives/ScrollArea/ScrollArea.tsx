'use client'
import * as React from 'react'
import styles from './ScrollArea.module.css'
import { cx, mergeRefs } from '../../utils'
import { Pill } from '../Pill/Pill'
import { IconArrowDown } from '../../icons'

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: 'vertical' | 'horizontal'
  /** 12px edge fade mask (default on) */
  fade?: boolean
  maxHeight?: number | string
  height?: number | string
  /** Radio-log behaviour: stick to bottom unless the user scrolled up; shows a "n new" pill */
  stickToBottom?: boolean
  newCount?: number
  onAtBottomChange?: (atBottom: boolean) => void
  testId?: string
}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { direction = 'vertical', fade = true, maxHeight, height, stickToBottom = false, newCount = 0, onAtBottomChange, testId, className, style, children, onScroll, ...rest },
  ref,
) {
  const inner = React.useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = React.useState(true)
  const check = React.useCallback(() => {
    const el = inner.current
    if (!el) return
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    setAtBottom((prev) => { if (prev !== b) onAtBottomChange?.(b); return b })
  }, [onAtBottomChange])
  React.useEffect(() => {
    if (!stickToBottom) return
    const el = inner.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
  })
  const scrollToBottom = () => { const el = inner.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setAtBottom(true); onAtBottomChange?.(true) } }
  return (
    <div className={cx(styles.root, className)} style={{ maxHeight, height, ...style }} data-testid={testId ? `${testId}-root` : undefined}>
      <div
        ref={mergeRefs(ref, inner)}
        data-testid={testId}
        className={cx(direction === 'vertical' ? styles.v : styles.h, fade && styles.fade)}
        style={{ maxHeight, height }}
        onScroll={(e) => { check(); onScroll?.(e) }}
        tabIndex={0}
        {...rest}
      >
        {children}
      </div>
      {stickToBottom && !atBottom && newCount > 0 ? (
        <Pill interactive size="xs" tone="glass" className={styles.newPill} icon={<IconArrowDown size={12} />} onClick={scrollToBottom} testId={testId ? `${testId}-new` : undefined}>{newCount} new</Pill>
      ) : null}
    </div>
  )
})
