'use client'
/*
  Comm log + command line (00-MASTER-PLAN §2.5, UX 04 §2.1 "Comm log", §7.2, §10 "Comm log & command line",
  §G9 undo, §G12 log-line data attributes; design 01 A11.6 / A11.7).
  Lines come from `sim.radio`; the input goes through `sim.command()`; autocomplete from `sim.suggest()`.
*/
import * as React from 'react'
import styles from './CommLog.module.css'
import { Segmented, ScrollArea, Input, Menu, IconButton, Icon, Kbd, Tooltip, cx, usePrefersReducedMotion } from '@/design'
import type { MenuOption } from '@/design'
import type { RadioLine, Position } from '../hooks/useSimSelector'
import { sim, useSim, formatMmSs } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS, readJson, writeJson } from '../persist'
import { isSilent, fromEngine } from '@/lib/sim/dispatch'
import { parseCommand } from '@/lib/sim/commands'
import { describe } from '@/lib/sim/commandAst'
import type { Position as FreqPosition } from '@/lib/sim/types'

type Filter = 'gnd' | 'twr' | 'app' | 'all'
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'gnd', label: 'GND' }, { id: 'twr', label: 'TWR' }, { id: 'app', label: 'APP' }, { id: 'all', label: 'ALL' },
]
const DEFAULT_FILTER: Record<Position, Filter> = { ground: 'gnd', tower: 'twr', approach: 'app' }
const FILTER_POSITIONS: Record<Exclude<Filter, 'all'>, FreqPosition[]> = { gnd: ['ground'], twr: ['tower'], app: ['approach', 'departure'] }
const CHARS_PER_S = 40
const MAX_SUGGESTIONS = 8
const HISTORY_MAX = 30
const EMERGENCY_RE = /\b(mayday|pan[- ]pan)\b/i
const SAY_AGAIN_RE = /say again/i

function lineStatus(l: RadioLine, now: number): string {
  if (l.status === 'undone') return 'undone'
  if (l.status === 'unable' || l.status === 'mismatch' || l.status === 'partial' || l.status === 'error') return l.status
  if (l.who === 'ATC' && l.undoUntil != null && now < l.undoUntil) return 'pending'
  return 'executed'
}

/** Types a line out at ~40 chars/s with a caret (UX §7.2); instant for old lines and reduced motion. */
function TypedText({ text, animate }: { text: string; animate: boolean }) {
  const [shown, setShown] = React.useState(animate ? 0 : text.length)
  React.useEffect(() => {
    if (!animate) { setShown(text.length); return }
    let n = 0
    setShown(0)
    const id = window.setInterval(() => {
      n = Math.min(text.length, n + 1)
      setShown(n)
      if (n >= text.length) window.clearInterval(id)
    }, 1000 / CHARS_PER_S)
    return () => window.clearInterval(id)
  }, [text, animate])
  const done = shown >= text.length
  return <>{done ? text : text.slice(0, shown)}{done ? null : <span className={styles.caret} aria-hidden="true" />}</>
}

/** UNDO chip with the shrinking ring; re-renders with sim time (10 Hz) only while a ring is open. */
function UndoChip({ line }: { line: RadioLine }) {
  const now = useSim((s) => s.time())
  const until = line.undoUntil ?? now
  const total = Math.max(0.001, until - line.at)
  const remaining = Math.max(0, until - now)
  const frac = Math.min(1, remaining / total)
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <button
      type="button"
      className={cx(styles.chip, styles.chipUndo)}
      onClick={(e) => { e.stopPropagation(); sim.undo() }}
      title="Disregard this transmission before the pilot acts on it (U)"
      aria-label={`Undo, ${remaining.toFixed(1)} seconds left`}
      data-testid={`log-line-${line.key}-undo`}
      data-remaining={remaining.toFixed(1)}
    >
      <svg className={styles.ring} viewBox="0 0 14 14" aria-hidden="true">
        <circle className={styles.ringTrack} cx="7" cy="7" r={r} />
        <circle className={styles.ringFill} cx="7" cy="7" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <Icon name="undo-2" size={12} />
      UNDO {remaining.toFixed(1)}s
    </button>
  )
}

interface LineProps {
  line: RadioLine
  now: number
  animate: boolean
  undoable: boolean
  repeat: boolean
  selected: boolean
  onCorrect: (line: RadioLine) => void
}

const LogLine = React.memo(function LogLine({ line, now, animate, undoable, repeat, selected, onCorrect }: LineProps) {
  const status = lineStatus(line, now)
  const clickable = !!line.callsign
  const emergency = line.who === 'PILOT' && EMERGENCY_RE.test(line.text)
  const select = () => { if (!line.callsign) return; const a = sim.find(line.callsign); if (a) sim.select(a.id) }
  const canRepeat = repeat && !!line.ast && line.status !== 'undone'
  const canCorrect = line.who === 'ATC' && line.status === 'mismatch' && !!line.callsign
  return (
    <div
      id={`log-line-${line.key}`}
      className={styles.line}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={select}
      onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); select() } }}
      data-testid="radio-line"
      data-who={line.who}
      data-key={line.key}
      data-callsign={line.callsign}
      data-status={status}
      data-emergency={emergency || undefined}
      data-clickable={clickable}
      data-selected={selected}
    >
      <span className={styles.time}>{formatMmSs(line.at)}</span>
      <span className={styles.who}>{line.who}</span>
      <span className={styles.text} data-testid="radio-text"><TypedText text={line.text} animate={animate} />{line.status === 'undone' ? <span className={styles.superseded}> · disregarded</span> : null}</span>
      <span className={styles.chips}>
        {undoable ? <UndoChip line={line} /> : null}
        {canRepeat ? (
          <button type="button" className={styles.chip} onClick={(e) => { e.stopPropagation(); if (line.ast) sim.dispatchAst(line.ast) }} title="Transmit again" data-testid={`log-line-${line.key}-repeat`}>
            <Icon name="rotate-ccw" size={12} />REPEAT
          </button>
        ) : null}
        {canCorrect ? (
          <button type="button" className={styles.chip} onClick={(e) => { e.stopPropagation(); onCorrect(line) }} title="Correct the readback" data-testid={`log-line-${line.key}-correct`}>
            <Icon name="corner-down-left" size={12} />CORRECT
          </button>
        ) : null}
      </span>
    </div>
  )
})

function lastTokenRange(text: string): { start: number; end: number } {
  if (/\s$/.test(text) || text === '') return { start: text.length, end: text.length }
  const start = text.lastIndexOf(' ') + 1
  return { start, end: text.length }
}

export function CommLog() {
  const shell = useShell()
  const reduced = usePrefersReducedMotion()
  const position = useSim((s) => s.position)
  const radio = useSim((s) => s.radio)
  const selectedCs = useSim((s) => s.selected()?.callsign ?? null)
  const lastCallsign = useSim((s) => s.lastCallsign)
  const typedInstant = useSim((s) => s.settings.typedInstant)
  const undoKey = useSim((s) => s.undoableLine()?.key ?? null)
  const nowFloor = useSim((s) => Math.floor(s.time()))
  const hasEngine = useSim((s) => !!s.engine)
  /** Deterministic e2e runs assert radio text right after advance(): no typing animation in test mode (05 §3.1). */
  const testMode = useSim((s) => s.testMode)

  const [filters, setFilters] = usePersistedState<Partial<Record<Position, Filter>>>(LS.logFilter, {})
  const filter: Filter = filters[position] ?? DEFAULT_FILTER[position]
  const setFilter = (f: Filter) => setFilters((m) => ({ ...m, [position]: f }))

  const lines = React.useMemo(() => {
    if (filter === 'all') return radio
    const allowed = FILTER_POSITIONS[filter]
    return radio.filter((l) => !l.position || allowed.includes(l.position))
  }, [radio, filter])

  // Which lines type out: only those that arrived after mount and are among the newest few.
  const mountKey = React.useRef<number | null>(null)
  if (mountKey.current == null) mountKey.current = radio.length ? radio[radio.length - 1].key : 0
  const animateFrom = mountKey.current

  // Repeat chips: an ATC line answered by "say again".
  const repeatKeys = React.useMemo(() => {
    const out = new Set<number>()
    for (let i = 0; i < radio.length; i++) {
      const l = radio[i]
      if (l.who !== 'PILOT' || !SAY_AGAIN_RE.test(l.text) || !l.callsign) continue
      for (let j = i - 1; j >= 0; j--) { const p = radio[j]; if (p.who === 'ATC' && p.callsign === l.callsign) { out.add(p.key); break } }
    }
    return out
  }, [radio])

  // Autoscroll bookkeeping (ScrollArea stickToBottom + "n new" pill).
  const [atBottom, setAtBottom] = React.useState(true)
  const [seenKey, setSeenKey] = React.useState(0)
  const lastKey = lines.length ? lines[lines.length - 1].key : 0
  React.useEffect(() => { if (atBottom && lastKey !== seenKey) setSeenKey(lastKey) }, [atBottom, lastKey, seenKey])
  const newCount = atBottom ? 0 : lines.reduce((n, l) => n + (l.key > seenKey ? 1 : 0), 0)

  // ---- command line ----
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [value, setValue] = React.useState('')
  const [focused, setFocused] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const [error, setError] = React.useState<{ text: string; token: string | null } | null>(null)
  const [review, setReview] = React.useState<string | null>(null)
  const [shakeKey, setShakeKey] = React.useState(0)
  const [acceptKey, setAcceptKey] = React.useState(0)
  const [historyIdx, setHistoryIdx] = React.useState(-1)
  // while stepping through history the recalled text must not open the autocomplete (arrows keep walking the history)
  const historyMode = historyIdx >= 0
  const history = React.useRef<string[]>([])
  React.useEffect(() => { history.current = readJson<string[]>(LS.cmdHistory, []) }, [])

  const suggestions = React.useMemo(() => {
    if (!hasEngine || !focused || !value.trim()) return []
    try { return sim.suggest(value).slice(0, MAX_SUGGESTIONS) } catch { return [] }
  }, [value, focused, hasEngine])
  const menuOpen = suggestions.length > 0 && focused && !review && !historyMode
  React.useEffect(() => { setActive(suggestions.length ? 0 : -1) }, [suggestions])

  const placeholder = React.useMemo(() => {
    const cs = selectedCs ?? lastCallsign
    if (!cs || !hasEngine) return 'Callsign then a command, e.g. BAW123 taxi 27L via A B'
    try {
      const verbs = sim.suggest(`${cs} `).filter((s) => s.kind === 'verb').slice(0, 3).map((s) => s.text.toLowerCase())
      return verbs.length ? `${cs} ${verbs.join(' · ')}` : `${cs} …`
    } catch { return `${cs} …` }
  }, [selectedCs, lastCallsign, hasEngine])

  const focus = React.useCallback((prefill?: string) => {
    const el = inputRef.current
    if (!el) return
    if (prefill != null) { setValue(prefill); setReview(null); setError(null) }
    el.focus({ preventScroll: true })
    window.requestAnimationFrame(() => { const n = el.value.length; try { el.setSelectionRange(n, n) } catch { /* not a text input */ } })
  }, [])
  React.useEffect(() => { shell.registerCmdFocus(focus); return () => shell.registerCmdFocus(null) }, [shell, focus])

  const accept = (i: number) => {
    const s = suggestions[i]
    if (!s) return
    const { start } = lastTokenRange(value)
    setValue(`${value.slice(0, start)}${s.text} `)
    setError(null)
  }

  const pushHistory = (text: string) => {
    const next = [text, ...history.current.filter((h) => h !== text)].slice(0, HISTORY_MAX)
    history.current = next
    writeJson(LS.cmdHistory, next)
    setHistoryIdx(-1)
  }

  const send = () => {
    const text = value.trim()
    if (!text) return
    if (!typedInstant && review == null) {
      // Review step: show what was parsed; the second Enter transmits (UX §9 "typed = instant" off).
      const e = sim.engine
      if (!e) return
      const p = parseCommand(text, fromEngine(e, { lastCallsign: sim.lastCallsign, position: sim.position }))
      if (p.ok && p.ast) { setReview(describe(p.ast)); setError(null); return }
      const err = p.errors[0]
      setError({ text: err?.message ?? 'Unable to parse', token: err?.token ?? null })
      setShakeKey((k) => k + 1)
      return
    }
    const r = sim.command(text)
    setReview(null)
    if (!r.ok && isSilent(r.code)) {
      setError({ text: r.reason ?? r.code, token: null })
      setShakeKey((k) => k + 1)
      return
    }
    pushHistory(text)
    setValue('')
    setError(null)
    setAcceptKey((k) => k + 1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Tab') { e.preventDefault(); accept(active < 0 ? 0 : active); return }
      if (e.key === 'Escape') { e.preventDefault(); setFocused(false); inputRef.current?.blur(); return }
    }
    if (e.key === 'Enter') { e.preventDefault(); send(); return }
    if (e.key === 'Escape') {
      if (review) { e.preventDefault(); setReview(null); return }
      if (value) { e.preventDefault(); setValue(''); setError(null); return }
      return
    }
    if (e.key === 'ArrowUp' && !menuOpen) {
      const h = history.current
      if (!h.length) return
      e.preventDefault()
      const next = Math.min(h.length - 1, historyIdx + 1)
      setHistoryIdx(next); setValue(h[next]); setReview(null)
      return
    }
    if (e.key === 'ArrowDown' && !menuOpen && historyIdx >= 0) {
      e.preventDefault()
      const next = historyIdx - 1
      setHistoryIdx(next); setValue(next < 0 ? '' : history.current[next]); setReview(null)
    }
  }

  const onCorrect = React.useCallback((line: RadioLine) => { if (line.callsign) focus(`${line.callsign} correction `) }, [focus])

  const menuOptions: MenuOption[] = suggestions.map((s, i) => ({ value: `${i}:${s.text}`, label: s.label, description: s.kind, testId: `cmd-autocomplete-${i}` }))

  const last = lines.length ? lines[lines.length - 1] : null
  const collapsed = shell.logCollapsed

  return (
    <section className={styles.log} aria-label="Communications log" data-collapsed={collapsed} data-testid="comm-log">
      <header className={styles.header}>
        <Segmented ariaLabel="Frequency filter" small value={filter} onChange={(id) => setFilter(id as Filter)} items={FILTERS.map((f) => ({ id: f.id, label: f.label, testId: `log-filter-${f.id}` }))} testId="log-filter" />
        {collapsed && last ? (
          <span className={styles.lastLine} data-testid="log-last-line">
            <span className={styles.who} data-who={last.who}>{last.who}</span>
            <span className={styles.text}>{last.callsign ? `${last.callsign} · ` : ''}{last.text}</span>
          </span>
        ) : <span className={styles.headerSpacer} />}
        <Tooltip content="Last plane called" kbd={['Shift', 'R']} placement="top">
          <IconButton size={32} variant="ghost" label="Last plane called" icon={<Icon name="rotate-ccw" size={16} />} disabled={!lastCallsign} onClick={() => { if (lastCallsign) focus(`${lastCallsign} `) }} className={styles.lastCalled} testId="log-last-called" />
        </Tooltip>
        <Tooltip content={collapsed ? 'Expand comm log' : 'Collapse comm log'} kbd={['F8']} placement="top">
          <IconButton size={32} variant="ghost" label={collapsed ? 'Expand comm log' : 'Collapse comm log'} icon={<Icon name={collapsed ? 'chevron-up' : 'chevron-down'} size={16} />} aria-expanded={!collapsed} data-state={collapsed ? 'collapsed' : 'open'} onClick={shell.toggleLog} testId="log-collapse" />
        </Tooltip>
      </header>

      {!collapsed ? (
        <ScrollArea className={styles.list} stickToBottom newCount={newCount} onAtBottomChange={setAtBottom} testId="radio-log" aria-live="polite" role="log">
          {lines.length === 0 ? <div className={styles.empty} data-testid="radio-log-empty">No transmissions on this frequency yet.</div> : null}
          <div className={styles.lines}>
            {lines.map((l) => (
              <LogLine
                key={l.key}
                line={l}
                now={l.undoUntil != null ? nowFloor : 0}
                animate={!reduced && !testMode && l.key > animateFrom && (l.who === 'PILOT' || l.who === 'ATC')}
                undoable={l.key === undoKey}
                repeat={repeatKeys.has(l.key)}
                selected={!!selectedCs && l.callsign === selectedCs}
                onCorrect={onCorrect}
              />
            ))}
          </div>
        </ScrollArea>
      ) : null}

      <footer className={styles.footer}>
        {error ? <span className={styles.error} role="alert" data-testid="cmd-parse-error">{error.text}{error.token ? <> · <span data-testid="cmd-parse-error-token">{error.token}</span></> : null}</span> : null}
        {review ? <span className={styles.error} role="status" data-testid="cmd-review">{review} — Enter to transmit, Esc to edit</span> : null}
        {menuOpen ? (
          <Menu
            id="cmd-autocomplete"
            className={styles.menu}
            placement="top"
            options={menuOptions}
            activeIndex={active}
            onActiveChange={setActive}
            onSelect={(v) => { accept(Number(v.split(':')[0])); inputRef.current?.focus() }}
            testId="cmd-autocomplete"
          />
        ) : null}
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); send() }} data-testid="cmd-form" data-hotkeys="off">
          <Input
            ref={inputRef}
            size="m"
            surface="solid"
            fullWidth
            wrapClassName={styles.inputWrap}
            prefixIcon={<Icon name="terminal" size={16} />}
            placeholder={placeholder}
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); setReview(null); setHistoryIdx(-1) }}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 0)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label="Command line"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'cmd-autocomplete' : undefined}
            disabled={!hasEngine}
            acceptKey={acceptKey}
            shakeKey={shakeKey}
            suffix={
              <span className={styles.suffix}>
                {!value && !focused ? <Kbd plain>/</Kbd> : null}
                <IconButton size={32} variant="ghost" label="Send" icon={<Icon name="corner-down-left" size={16} />} type="submit" disabled={!value.trim() || !hasEngine} testId="cmd-send" />
              </span>
            }
            testId="cmd-input"
          />
        </form>
        <span className={styles.pttWrap}>
          <button
            type="button"
            className={styles.ptt}
            data-state={shell.ptt ? 'on' : 'off'}
            aria-pressed={shell.ptt}
            aria-label="Push to talk (hold)"
            title="Hold to talk · Ctrl+Space"
            onPointerDown={(e) => { e.preventDefault(); shell.setPtt(true) }}
            onPointerUp={() => shell.setPtt(false)}
            onPointerLeave={() => shell.setPtt(false)}
            onPointerCancel={() => shell.setPtt(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shell.setPtt(true) } }}
            onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') shell.setPtt(false) }}
            data-testid="cmd-ptt"
          >
            <span className={styles.pttDot} aria-hidden="true" />
            PTT
            <span className={styles.pttHint}>hold · Ctrl+Space</span>
          </button>
          {shell.ptt ? <span className={styles.transcript} data-testid="cmd-ptt-transcript">Listening… <span data-testid="cmd-ptt-unsupported">speech input is not available in this build; type the command instead</span></span> : null}
        </span>
      </footer>
    </section>
  )
}
