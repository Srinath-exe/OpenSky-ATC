'use client'
/* Help overlay (00-MASTER-PLAN §2.5 "HelpOverlay", UX 04 §8, §10 "Help"): hotkeys (from the single HOTKEYS table),
   phraseology reference, stage x action matrix (from ACTION_MATRIX so it cannot drift), alerts and glossary. */
import * as React from 'react'
import styles from './HelpOverlay.module.css'
import { Modal, Tabs, Input, IconButton, IconX, Kbd, ScrollArea, Icon, cx } from '@/design'
import { ACTION_MATRIX, ACTION_DEFS, REASONS } from '@/lib/sim/commandTree'
import type { ActionId, ReasonCode } from '@/lib/sim/commandTree'
import { ALL_STAGES } from '@/lib/sim/types'
import { stageLabel } from '@/lib/sim/stage'
import { SHELL_HOTKEYS, actionHotkeys } from '../hotkeys'
import type { Hotkey } from '../hotkeys'
import { useShell } from '../shellContext'
import { PHRASES, ALERT_HELP, GLOSSARY } from './phrases'

type Tab = 'hotkeys' | 'phraseology' | 'matrix' | 'alerts' | 'glossary'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'hotkeys', label: 'Hotkeys' }, { id: 'phraseology', label: 'Phraseology' }, { id: 'matrix', label: 'Stage × action' }, { id: 'alerts', label: 'Alerts' }, { id: 'glossary', label: 'Glossary' },
]
const REGION_LABEL: Record<Hotkey['region'], string> = { global: 'Global', bay: 'Strip bay', panel: 'Command panel', map: 'Map', log: 'Comm log' }

const CHORD_RE = /^[A-Z0-9],[A-Z0-9]$/
/** "M,A" is a chord (two presses); "," / "." / "Shift+/" are single keys. */
function keyParts(key: string): string[] {
  if (CHORD_RE.test(key)) return key.split(',')
  if (key.length === 1) return [key]
  return key.split('+')
}

function matches(q: string, ...fields: string[]): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return fields.some((f) => f.toLowerCase().includes(s))
}

function HotkeysTab({ q }: { q: string }) {
  const rows = React.useMemo(() => [...SHELL_HOTKEYS, ...actionHotkeys()], [])
  const shown = rows.filter((h) => matches(q, h.key, h.action, h.when, REGION_LABEL[h.region]))
  if (!shown.length) return <div className={styles.empty}>No shortcut matches “{q}”.</div>
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>Key</th><th>Action</th><th>Where</th><th>When</th></tr></thead>
        <tbody>
          {shown.map((h) => (
            <tr key={h.id} data-testid={`help-hotkey-row-${h.id}`}>
              <td>{CHORD_RE.test(h.key) ? keyParts(h.key).map((k, i) => <React.Fragment key={k}>{i ? ' then ' : ''}<Kbd>{k}</Kbd></React.Fragment>) : <Kbd keys={keyParts(h.key)} />}</td>
              <td className={styles.action}>{h.action}</td>
              <td className={styles.region}>{REGION_LABEL[h.region]}</td>
              <td className={styles.when}>{h.when}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PhraseologyTab({ q }: { q: string }) {
  const shown = PHRASES.filter((p) => matches(q, p.action, p.atc, p.pilot, p.when, p.group))
  if (!shown.length) return <div className={styles.empty}>No phrase matches “{q}”.</div>
  const groups = Array.from(new Set(shown.map((p) => p.group)))
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>Action</th><th>Controller says</th><th>Pilot reads back</th><th>Valid when</th></tr></thead>
        {groups.map((g) => (
          <tbody key={g}>
            <tr><td colSpan={4} className={styles.group}>{g}</td></tr>
            {shown.filter((p) => p.group === g).map((p) => (
              <tr key={p.id} data-testid={`help-phrase-${p.id}`}>
                <td className={styles.action}>{p.action}{p.id in ACTION_DEFS && ACTION_DEFS[p.id as ActionId].key ? <> <Kbd>{ACTION_DEFS[p.id as ActionId].key}</Kbd></> : null}</td>
                <td className={styles.atc}>{p.atc}</td>
                <td className={styles.pilot}>{p.pilot}</td>
                <td className={styles.when}>{p.when}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function cellInfo(cell: string): { state: 'on' | 'dyn' | 'off' | 'hidden'; title: string; glyph: string } {
  if (cell === 'on') return { state: 'on', title: 'Enabled', glyph: '●' }
  if (cell === '-') return { state: 'hidden', title: 'Hidden', glyph: '' }
  if (cell.startsWith('dyn:')) return { state: 'dyn', title: `Depends on ${cell.slice(4).replace(/_/g, ' ')}`, glyph: '◐' }
  const code = cell.slice(4) as ReasonCode
  return { state: 'off', title: REASONS[code] ?? code, glyph: '○' }
}

function MatrixTab({ q }: { q: string }) {
  const actions = (Object.keys(ACTION_DEFS) as ActionId[]).sort((a, b) => ACTION_DEFS[a].order - ACTION_DEFS[b].order).filter((id) => matches(q, id, ACTION_DEFS[id].label, ACTION_DEFS[id].group))
  if (!actions.length) return <div className={styles.empty}>No action matches “{q}”.</div>
  return (
    <div className={styles.body}>
      <div className={styles.legend}>
        <span className={styles.legendOn}>enabled</span>
        <span className={styles.legendDyn}>conditional (hover for the rule)</span>
        <span className={styles.legendOff}>disabled with reason (hover)</span>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.matrix} data-testid="help-matrix">
          <thead>
            <tr>
              <th className={cx(styles.rowHead, styles.corner)}>Action \ stage</th>
              {ALL_STAGES.map((s) => <th key={s} title={stageLabel(s).long}><span className={styles.stageHead}>{stageLabel(s).short}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {actions.map((id) => (
              <tr key={id}>
                <th className={styles.rowHead}>{ACTION_DEFS[id].label}{ACTION_DEFS[id].key ? ` · ${ACTION_DEFS[id].key}` : ''}</th>
                {ALL_STAGES.map((s) => {
                  const c = cellInfo(ACTION_MATRIX[id][s])
                  return <td key={s} data-cell={c.state} title={`${ACTION_DEFS[id].label} · ${stageLabel(s).long}: ${c.title}`} data-testid={`help-matrix-cell-${s}-${id}`}>{c.glyph}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AlertsTab({ q }: { q: string }) {
  const shown = ALERT_HELP.filter((a) => matches(q, a.kind, a.title, a.meaning, a.fix))
  if (!shown.length) return <div className={styles.empty}>No alert matches “{q}”.</div>
  return (
    <div className={styles.rows}>
      {shown.map((a) => (
        <div key={a.kind} className={styles.card} data-testid={`help-alert-${a.kind}`}>
          <span className={styles.cardTitle}>{a.title}</span>
          <span className={styles.cardBody}><span>{a.meaning}</span><span className={styles.cardFix}><strong>Fix:</strong> {a.fix}</span></span>
        </div>
      ))}
    </div>
  )
}

function GlossaryTab({ q }: { q: string }) {
  const shown = GLOSSARY.filter((g) => matches(q, g.term, g.text))
  if (!shown.length) return <div className={styles.empty}>No term matches “{q}”.</div>
  return (
    <div className={styles.rows}>
      {shown.map((g) => (
        <div key={g.term} className={styles.card} data-testid={`help-glossary-${g.term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
          <span className={styles.cardTitle}>{g.term}</span>
          <span className={styles.cardBody}>{g.text}</span>
        </div>
      ))}
    </div>
  )
}

export function HelpOverlay() {
  const shell = useShell()
  const open = !!shell.open.help
  const [tab, setTab] = React.useState<Tab>('hotkeys')
  const [q, setQ] = React.useState('')
  React.useEffect(() => { if (open) setQ('') }, [open])
  const close = React.useCallback(() => shell.hide('help'), [shell])
  return (
    <Modal open={open} onClose={close} wide testId="help-overlay" cancelLabel="">
      <div className={styles.head}>
        <Tabs ariaLabel="Help sections" compact value={tab} onChange={(id) => setTab(id as Tab)} items={TABS.map((t) => ({ id: t.id, label: t.label, testId: `help-tab-${t.id}` }))} testId="help-tabs" />
        <span className={styles.headSpacer} />
        <Input size="m" className={styles.search} prefixIcon={<Icon name="search" size={16} />} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search help" testId="help-search" />
        <IconButton size={32} variant="ghost" label="Close help" icon={<IconX size={16} />} onClick={close} testId="help-close" />
      </div>
      <ScrollArea className={styles.scroll} maxHeight="calc(100vh - 220px)">
        {tab === 'hotkeys' ? <HotkeysTab q={q} /> : null}
        {tab === 'phraseology' ? <PhraseologyTab q={q} /> : null}
        {tab === 'matrix' ? <MatrixTab q={q} /> : null}
        {tab === 'alerts' ? <AlertsTab q={q} /> : null}
        {tab === 'glossary' ? <GlossaryTab q={q} /> : null}
      </ScrollArea>
    </Modal>
  )
}
