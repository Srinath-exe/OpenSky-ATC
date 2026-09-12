'use client'
import * as React from 'react'
import styles from './Select.module.css'
import { cx, useStableId } from '../../utils'
import { IconChevronDown, IconCheck } from '../../icons'

export interface MenuOption<V extends string = string> {
  value: V
  label: React.ReactNode
  /** --text-3 description right of the label (autocomplete) */
  description?: React.ReactNode
  /** right-aligned slot (kbd hint, pill) */
  right?: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
  /** section header rendered before this option */
  section?: string
  /** divider rendered before this option */
  divider?: boolean
  /** typeahead text (defaults to string label) */
  text?: string
  testId?: string
}

export interface MenuProps<V extends string = string> {
  options: MenuOption<V>[]
  value?: V | null
  activeIndex?: number
  onActiveChange?: (i: number) => void
  onSelect: (value: V, option: MenuOption<V>) => void
  /** bottom (default) / top (autocomplete above the input) / static (inline, no positioning) */
  placement?: 'bottom' | 'top' | 'static'
  emptyText?: string
  id?: string
  className?: string
  style?: React.CSSProperties
  testId?: string
  tabular?: boolean
}

/** A11.1 menu panel: --bg-2, radius 14, padding 6, 36px items. Controlled active index for keyboard navigation. */
export function Menu<V extends string = string>({ options, value, activeIndex = -1, onActiveChange, onSelect, placement = 'bottom', emptyText = 'No results', id, className, style, testId, tabular = false }: MenuProps<V>) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div ref={ref} id={id} role="listbox" data-testid={testId} style={style} className={cx(styles.menu, placement === 'bottom' && styles.menuBottom, placement === 'top' && styles.menuTop, placement === 'static' && styles.menuStatic, tabular && styles.tabular, className)}>
      {options.length === 0 ? <div className={styles.empty}>{emptyText}</div> : null}
      {options.map((o, i) => (
        <React.Fragment key={o.value}>
          {o.divider ? <div className={styles.divider} role="separator" /> : null}
          {o.section ? <div className={styles.section}>{o.section}</div> : null}
          <button
            type="button"
            role="option"
            data-index={i}
            data-testid={o.testId}
            aria-selected={value === o.value}
            aria-disabled={o.disabled || undefined}
            tabIndex={-1}
            className={cx(styles.item, i === activeIndex && styles.itemActive, value === o.value && styles.itemSelected, o.disabled && styles.itemDisabled)}
            onMouseEnter={() => onActiveChange?.(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { if (!o.disabled) onSelect(o.value, o) }}
          >
            {o.icon ? <span className={styles.icon}>{o.icon}</span> : null}
            <span className={styles.itemLabel}>
              {o.label}
              {o.description ? <span className={styles.itemDesc}>{o.description}</span> : null}
            </span>
            {o.right ? <span className={styles.itemRight}>{o.right}</span> : null}
            {value === o.value ? <span className={styles.check}><IconCheck size={16} /></span> : null}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export interface SelectProps<V extends string = string> {
  options: MenuOption<V>[]
  value: V | null
  onChange: (value: V, option: MenuOption<V>) => void
  placeholder?: string
  label?: React.ReactNode
  /** leading 18px icon (plane, map) */
  icon?: React.ReactNode
  /** l 40 (default) / m 36 */
  size?: 'l' | 'm'
  surface?: 'solid' | 'glass'
  disabled?: boolean
  error?: string
  helper?: React.ReactNode
  fullWidth?: boolean
  menuPlacement?: 'bottom' | 'top'
  tabular?: boolean
  ariaLabel?: string
  testId?: string
  className?: string
}

/** Custom select: map-pill trigger + A11.1 menu. Arrow keys / Home / End / typeahead / Enter / Esc. */
export function Select<V extends string = string>({ options, value, onChange, placeholder = 'Select', label, icon, size = 'l', surface = 'solid', disabled = false, error, helper, fullWidth = false, menuPlacement = 'bottom', tabular = false, ariaLabel, testId, className }: SelectProps<V>) {
  const id = useStableId('select')
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const typeahead = React.useRef({ text: '', at: 0 })
  const selected = options.find((o) => o.value === value) ?? null

  const openMenu = () => {
    if (disabled) return
    setOpen(true)
    const idx = options.findIndex((o) => o.value === value)
    setActive(idx >= 0 ? idx : options.findIndex((o) => !o.disabled))
  }
  const close = () => { setOpen(false); setActive(-1) }
  const move = (dir: 1 | -1) => {
    if (!options.length) return
    let i = active
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length
      if (!options[i].disabled) { setActive(i); return }
    }
  }
  const commit = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    onChange(o.value, o)
    close()
    triggerRef.current?.focus()
  }

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!open) openMenu(); else move(1); break
      case 'ArrowUp': e.preventDefault(); if (!open) openMenu(); else move(-1); break
      case 'Home': if (open) { e.preventDefault(); setActive(options.findIndex((o) => !o.disabled)) } break
      case 'End': if (open) { e.preventDefault(); for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) { setActive(i); break } } break
      case 'Enter': case ' ': e.preventDefault(); if (!open) openMenu(); else commit(active); break
      case 'Escape': if (open) { e.preventDefault(); e.stopPropagation(); close() } break
      case 'Tab': if (open) close(); break
      default: {
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now()
          const t = typeahead.current
          t.text = now - t.at > 600 ? e.key.toLowerCase() : t.text + e.key.toLowerCase()
          t.at = now
          const idx = options.findIndex((o) => !o.disabled && (o.text ?? (typeof o.label === 'string' ? o.label : '')).toLowerCase().startsWith(t.text))
          if (idx >= 0) { if (!open) { onChange(options[idx].value, options[idx]) } else setActive(idx) }
        }
      }
    }
  }

  return (
    <div ref={rootRef} className={cx(styles.root, fullWidth && styles.full, className)}>
      {label ? <label id={`${id}-label`} htmlFor={id} className={styles.label}>{label}</label> : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-labelledby={label ? `${id}-label` : undefined}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        data-testid={testId}
        disabled={disabled}
        className={cx(styles.trigger, size === 'm' && styles.m, surface === 'glass' && styles.glass, icon && styles.hasIcon, open && styles.open, error && styles.error, tabular && styles.tabular)}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
      >
        {icon ? <span className={styles.icon}>{icon}</span> : null}
        <span className={cx(styles.value, !selected && styles.placeholder)}>{selected ? selected.label : placeholder}</span>
        <span className={styles.chevron}><IconChevronDown size={14} /></span>
      </button>
      {open ? (
        <Menu id={`${id}-menu`} options={options} value={value} activeIndex={active} onActiveChange={setActive} onSelect={(_, o) => commit(options.indexOf(o))} placement={menuPlacement} testId={testId ? `${testId}-menu` : undefined} tabular={tabular} />
      ) : null}
      {error ? <div className={cx(styles.helper, styles.helperError)} role="alert">{error}</div> : helper ? <div className={styles.helper}>{helper}</div> : null}
    </div>
  )
}
