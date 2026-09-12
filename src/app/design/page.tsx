'use client'
/* /design - dev showcase: every primitive in every state, on the dark shell. Used for visual QA against 01-DESIGN-SYSTEM.md. */
import * as React from 'react'
import s from './design.module.css'
import {
  GlassPanel, Button, IconButton, Pill, PlateChip, Tabs, Segmented, Toggle, Checkbox, Input, Select, Menu, Kpi, StatTile, BarChart, Sparkline,
  ProgressBar, Badge, Divider, ListRow, AlertItem, AlertGroup, Toast, ToastProvider, ToastStack, useToast, Tooltip, Modal, Sheet, Kbd, Skeleton,
  EmptyState, ScrollArea, Dial, Ladder, Stepper, StepperSummary, LoadingOverlay,
  Icon, ICONS, LogoMark, AircraftTop, FireTruck, FollowMeCar, Tug, Ambulance, Fuel, Deice, Windsock,
  IconArrowUpRight, IconSearch, IconBell, IconHeadphones, IconRadioTower, IconPlus, IconMinus, IconLocate, IconMap, IconPlane, IconChevronDown, IconNavigation,
  IconSeparation, IconPlaneLanding, IconSiren, IconWind, IconClock, IconTerminal, IconSend, IconPointerClick, IconPause, IconSettings, IconX, IconWifi, IconGoAround,
  formatAltitude, cx,
} from '@/design'
import type { IconName, BarDatum } from '@/design'

const SECTIONS = ['tokens', 'type', 'panels', 'buttons', 'pills', 'tabs', 'controls', 'inputs', 'numbers', 'charts', 'lists', 'alerts', 'feedback', 'overlays', 'atc', 'satellite', 'icons']

function H({ id, title, ref: r }: { id: string; title: string; ref: string }) {
  return <div className={s.h} id={id}><h2 className={s.h1}>{title}</h2><span className={s.hRef}>{r}</span></div>
}
function Spec({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={cx(s.spec, className)}><span className={s.label}>{label}</span>{children}</div>
}

const SWATCHES: Array<[string, string]> = [
  ['--bg-0', '#0b0b0c'], ['--bg-1', '#121212'], ['--bg-2', '#1c1c1e'], ['--bg-3', '#252628'], ['--bg-4', '#3a3b3c'],
  ['--text-1', '#ffffff'], ['--text-2', '#c8c8c8'], ['--text-3', '#868686'], ['--text-4', '#606060'], ['--text-5', '#444446'],
  ['--orange', '#f5933f'], ['--orange-deep', '#ea7226'], ['--orange-tint-20', 'rgba(245,147,63,.2)'], ['--orange-tint-08', 'rgba(245,147,63,.08)'],
  ['--red', '#fb0a08'], ['--red-tint', 'rgba(251,10,8,.1)'], ['--green', '#57cd50'], ['--green-dim', 'rgba(87,205,80,.7)'],
  ['--blue-marker', '#0a609b'], ['--pink-marker', '#b5647a'], ['--lime-marker', '#8e9716'],
  ['--map-water', '#1d2c33'], ['--map-veg', '#3b4f37'], ['--map-rock', '#2b2b2b'],
]

const BAR_DATA: BarDatum[] = [
  { label: 'Jan', current: [62000, 128000], compare: [55000, 118000] },
  { label: 'Feb', current: [58000, 130000], compare: [50000, 112000] },
  { label: 'Mar', current: [70000, 122000], compare: [64000, 108000] },
  { label: 'Apr', current: [96000, 138000], compare: [108000, 152000] },
  { label: 'May', current: [78000, 126000], compare: [66000, 116000] },
  { label: 'Jun', current: [98000, 132000], compare: [90000, 122000], value: 122580, delta: 4 },
  { label: 'Jul', current: [52000, 116000], compare: [46000, 96000] },
]

function makeSpark(n = 180): number[] {
  const out: number[] = []
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let i = 0; i < n; i++) {
    const base = 58 + Math.sin(i / 21) * 5
    const jag = (rnd() - 0.5) * 16
    const peak1 = i > 88 && i < 100 ? 30 - Math.abs(i - 94) * 2.5 : 0
    const peak2 = i > 150 && i < 162 ? 28 - Math.abs(i - 156) * 2.2 : 0
    const dip = i > 16 && i < 28 ? -22 + Math.abs(i - 22) * 1.8 : 0
    out.push(Math.max(20, Math.min(100, base + jag + peak1 + peak2 + dip)))
  }
  return out
}
const SPARK = makeSpark()

function ToastDemo() {
  const { toast } = useToast()
  return (
    <div className={s.row}>
      <Button onClick={() => toast({ kind: 'info', text: 'Runway 28L in use' })}>Info toast</Button>
      <Button onClick={() => toast({ kind: 'success', text: 'BAW123 cleared to land 28L', detail: 'Readback correct' })}>Success toast</Button>
      <Button onClick={() => toast({ kind: 'attention', text: 'Wind now 280 at 18 kt', action: { label: 'ATIS', onClick: () => {} } })}>Attention toast</Button>
      <Button onClick={() => toast({ kind: 'error', text: 'ADS-B feed lost', action: { label: 'Retry', onClick: () => {} } })}>Error toast (8 s)</Button>
    </div>
  )
}

function StepperDemo() {
  const [idx, setIdx] = React.useState(1)
  const [hdg, setHdg] = React.useState(270)
  const steps = [
    { id: 'action', label: 'Action', value: 'Vector' },
    { id: 'value', label: 'Heading', value: String(hdg).padStart(3, '0') },
    { id: 'turn', label: 'Turn', value: 'Left' },
    { id: 'confirm', label: 'Transmit' },
  ]
  return (
    <Stepper
      steps={steps}
      activeIndex={idx}
      onStepClick={setIdx}
      title="BAW123"
      subtitle="A320 · Airborne · FL120"
      summary={<StepperSummary parts={[{ text: 'BAW123', strong: true }, ' turn left heading ', { text: String(hdg).padStart(3, '0'), strong: true }]} />}
      onBack={() => setIdx((i) => Math.max(0, i - 1))}
      onCancel={() => setIdx(0)}
      onConfirm={() => setIdx((i) => Math.min(3, i + 1))}
      confirmDisabled={idx < 1}
      testId="stepper"
    >
      {idx === 1 ? <Dial value={hdg} onChange={setHdg} current={310} size={200} quickSteps={[-30, -10, 10, 30]} testId="dial-stepper" /> : <div className={s.note}>Step {idx + 1} content</div>}
    </Stepper>
  )
}

export default function DesignPage() {
  const [tab, setTab] = React.useState('tower')
  const [seg, setSeg] = React.useState('month')
  const [rate, setRate] = React.useState('1')
  const [on, setOn] = React.useState(true)
  const [off, setOff] = React.useState(false)
  const [cb, setCb] = React.useState(true)
  const [cb2, setCb2] = React.useState(false)
  const [sel, setSel] = React.useState<string | null>('27L')
  const [sel2, setSel2] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<number | null>(5)
  const [cursor, setCursor] = React.useState<number | null>(null)
  const [modal, setModal] = React.useState(false)
  const [sheet, setSheet] = React.useState(false)
  const [snap, setSnap] = React.useState<'peek' | 'half' | 'full'>('half')
  const [alertOpen, setAlertOpen] = React.useState(true)
  const [heading, setHeading] = React.useState(270)
  const [alt, setAlt] = React.useState(5000)
  const [spd, setSpd] = React.useState(250)
  const [count, setCount] = React.useState(12)
  const [pillSel, setPillSel] = React.useState('air')
  const [inputErr, setInputErr] = React.useState('')
  const [shakeKey, setShakeKey] = React.useState(0)
  const [flash, setFlash] = React.useState(0)
  const [warnCollapsed, setWarnCollapsed] = React.useState(false)
  const [lines, setLines] = React.useState<string[]>(['SYS|Session started EGLL 27R/27L', 'ATC|BAW123 taxi to holding point 27R via A, B', 'PILOT|Taxi holding point 27R via A B, BAW123', 'ATC|DLH4AB descend FL80', 'PILOT|Unable FL80, DLH4AB', 'ATC|BAW123 line up and wait 27R', 'PILOT|Line up and wait 27R, BAW123'])
  const runwayOptions = [
    { value: '27L', label: '27L', description: 'ILS · 3,902 m' },
    { value: '27R', label: '27R', description: 'ILS · 3,884 m' },
    { value: '09L', label: '09L', description: 'ILS · 3,902 m', divider: true, section: 'Easterly' },
    { value: '09R', label: '09R', description: 'closed', disabled: true },
  ]
  const alt5000 = formatAltitude(5000)

  return (
    <ToastProvider>
      <div className={s.page} data-testid="design-page">
        <nav className={s.nav}>
          <span className={s.navTitle}><LogoMark size={28} /> SKYCONTROL design <span className={s.navSub}>dev showcase</span></span>
          <div className={s.navLinks}>{SECTIONS.map((id) => <a key={id} href={`#${id}`}>{id}</a>)}</div>
        </nav>

        {/* ---------------- tokens ---------------- */}
        <section className={s.section}>
          <H id="tokens" title="Colour tokens" ref="01 §1 · A1" />
          <div className={s.swatches}>
            {SWATCHES.map(([name, val]) => <div key={name} className={s.swatch} style={{ background: `var(${name})` }} title={val}><span className={s.swatchName}>{name}</span></div>)}
          </div>
          <div className={s.grid2} style={{ marginTop: 20 }}>
            <div className={s.card}>
              <span className={s.cardTitle}>Spacing scale</span>
              {[4, 8, 12, 16, 20, 24, 32, 40].map((n) => <div key={n} className={s.row}><span className={s.label} style={{ width: 56 }}>--s {n}px</span><div className={s.spaceBar} style={{ width: n * 4 }} /></div>)}
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>Radii and strokes</span>
              <div className={s.row}>
                {[['--r-card', 20], ['--r-card-lg', 24], ['--r-inner', 14], ['--r-chip', 10], ['--r-pill', 999]].map(([n, r]) => <Spec key={n} label={`${n} ${r === 999 ? '' : r + 'px'}`}><div className={s.radiusBox} style={{ borderRadius: `var(${n})` }} /></Spec>)}
              </div>
              <div className={s.row}>
                <Spec label="ruler ticks (A8)"><div className={s.ruler}>{Array.from({ length: 24 }).map((_, i) => <span key={i} className={cx(s.tick, i % 5 === 0 && s.tickMajor)} />)}</div></Spec>
                <Spec label="divider --line"><div style={{ width: 160 }}><Divider spacing="none" /></div></Spec>
                <Spec label="divider strong"><div style={{ width: 160 }}><Divider spacing="none" strong /></div></Spec>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- type ---------------- */}
        <section className={s.section}>
          <H id="type" title="Typography" ref="01 §2 · A9 · A18" />
          <div className={s.card}>
            {[['display-xl', '44 / 300 / 1.0 / -0.02em'], ['display-l', '36 / 300'], ['display-m', '28 / 300'], ['title-l', '20 / 400'], ['title-m', '16 / 400'], ['body-m', '14 / 400'], ['body-s', '13 / 400'], ['label-xs', '11 / 400 / +0.01em'], ['micro-caps', '10 / 500 / +0.08em caps']].map(([cls, note]) => (
              <div key={cls} className={s.typeRow}><span className={s.label}>{cls}<br />{note}</span><span className={cls}>{cls === 'micro-caps' ? 'sqk wtc' : 'Heathrow · EGLL 122,580 Traffic'}</span></div>
            ))}
            <div className={s.row}>
              <Spec label="text tiers">
                <div className={s.row}><span className="text-1">text-1 title</span><span className="text-2">text-2 label</span><span className="text-3">text-3 caption</span><span className="text-4">text-4 trailing</span><span className="text-5">text-5 far tick</span></div>
              </Spec>
              <Spec label="tabular vs proportional"><div className={s.row}><span className="tnum body-m">14:07:53Z · 1,240 · 0111</span><span className="body-m">14:07:53Z · 1,240 · 0111</span></div></Spec>
              <Spec label="link"><a className="link" href="#type">Phraseology reference</a></Spec>
              <Spec label="selection"><span className="body-m" style={{ background: 'var(--selection)' }}>selected text</span></Spec>
            </div>
          </div>
        </section>

        {/* ---------------- panels ---------------- */}
        <section className={s.section}>
          <H id="panels" title="GlassPanel" ref="01 §4.1 · §1.2 · A1-3/4/9 · A11.10 · A16" />
          <div className={s.satellite} style={{ height: 'auto', padding: 20 }}>
            <div className={s.satImg} />
            <div className={s.grid} style={{ position: 'relative', zIndex: 1 }}>
              <GlassPanel variant="glass" title="Glass" subtitle="08.03.2026, 02:37:53" affordance="open" testId="panel-glass">Fill .50 · blur 40 · hairline .10 · inner highlight</GlassPanel>
              <GlassPanel variant="glass-strong" title="Glass strong" affordance="open">Fill .72 for readability over bright map</GlassPanel>
              <GlassPanel variant="lit" title="Lit (selected)" affordance="open" subtitle="Sheen 135° .28 → .02">Selected strip card</GlassPanel>
              <GlassPanel variant="prism" title="Prism rim" affordance="open">Refraction band at 55%</GlassPanel>
              <GlassPanel variant="glass" title="Interactive" interactive onClick={() => {}} affordance="open">Hover: lift 2px, border .16, sheen 60%</GlassPanel>
              <GlassPanel variant="glass" title="Interactive · hover" interactive forceState="hover" onClick={() => {}} affordance="open">Forced hover state</GlassPanel>
              <GlassPanel variant="glass" title="Warning" titleSize="l" affordance="collapse" collapsed={warnCollapsed} onAffordance={() => setWarnCollapsed((c) => !c)} padding="card-lg" radius="card-lg">Collapsible body (chevron rotates)</GlassPanel>
              <GlassPanel variant="glass" title="Disabled" disabled affordance="open">Opacity .45</GlassPanel>
              <GlassPanel variant="glass" title="Error" error="Could not load ATIS for EGLL" onRetry={() => {}} affordance="open" />
            </div>
          </div>
          <div className={s.grid} style={{ marginTop: 12 }}>
            <GlassPanel variant="solid" title="Solid on shell" affordance="open" testId="panel-solid">--bg-1, no border, no shadow</GlassPanel>
            <GlassPanel variant="solid" title="Solid interactive" interactive onClick={() => {}} affordance="open">Hover: translateY(-1px), bg #151515</GlassPanel>
            <GlassPanel variant="solid" title="Solid · hover" interactive forceState="hover" onClick={() => {}} affordance="open">Forced hover</GlassPanel>
            <GlassPanel variant="solid" title="Operational efficiency" hasDisplayNumber affordance="open" headerGap><Kpi value={78.3} decimals={1} unit="%" /></GlassPanel>
            <GlassPanel variant="nested" title="Nested (--bg-2)" padding="tile">Tile inside a panel: plain fill, no blur</GlassPanel>
            <GlassPanel variant="solid" title="Capacity issues" parenthetical="(2 lines)" affordance="collapse">Title with parenthetical</GlassPanel>
            <GlassPanel variant="solid" title="Loading" affordance="none"><div className={s.col}><Skeleton variant="number" /><Skeleton lines={3} /></div></GlassPanel>
            <GlassPanel variant="solid" title="Enter animation" enter>opacity 0→1, y 8→0, blur 8→0, 320ms</GlassPanel>
            <GlassPanel variant="solid" title="Empty" affordance="none"><EmptyState icon={<IconPlane size={24} />} title="No traffic" hint="Use + DEP or + ARR" compact /></GlassPanel>
          </div>
        </section>

        {/* ---------------- buttons ---------------- */}
        <section className={s.section}>
          <H id="buttons" title="Button and IconButton" ref="01 §4.18 · A2 · A3" />
          <div className={s.card}>
            {(['primary', 'accent', 'secondary', 'ghost', 'danger'] as const).map((v) => (
              <div key={v} className={s.row}>
                <span className={s.label} style={{ width: 80 }}>{v}</span>
                <Button variant={v} testId={`btn-${v}`}>Rest</Button>
                <Button variant={v} forceState="hover">Hover</Button>
                <Button variant={v} forceState="pressed">Pressed</Button>
                <Button variant={v} forceState="focus">Focus</Button>
                <Button variant={v} selected>Selected</Button>
                <Button variant={v} disabled>Disabled</Button>
                <Button variant={v} loading>Loading</Button>
                <Button variant={v} iconLeft={<IconSend size={16} />}>Icon left</Button>
                <Button variant={v} iconRight={<IconChevronDown size={14} />}>Icon right</Button>
              </div>
            ))}
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>sizes</span>
              <Button size="sm">Small 30</Button><Button size="md">Medium 36</Button><Button size="lg">Large 40</Button>
              <Button size="sm" iconLeft={<IconPlaneLanding size={14} />}>Taxi 27L</Button>
              <Button tabular flashKey={flash} onClick={() => setFlash((f) => f + 1)} iconLeft={<Icon name="arrow-up" size={14} />}>3k (click to flash)</Button>
              <Button variant="danger" fullWidth iconLeft={<IconGoAround size={16} />} style={{ maxWidth: 240 }}>Go around</Button>
            </div>
            <Divider spacing="s" />
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>icon 40 glass</span>
              <IconButton label="Search" icon={<IconSearch />} testId="ib-rest" />
              <IconButton label="Hover" icon={<IconSearch />} forceState="hover" />
              <IconButton label="Pressed" icon={<IconSearch />} forceState="pressed" />
              <IconButton label="Focus" icon={<IconSearch />} forceState="focus" />
              <IconButton label="Active" icon={<IconHeadphones />} active />
              <IconButton label="Alerts" icon={<IconBell />} badge={3} badgePulse />
              <IconButton label="Feed lost" icon={<IconRadioTower />} danger />
              <IconButton label="Disabled" icon={<IconBell />} disabled />
              <IconButton label="Loading" icon={<IconBell />} loading />
              <IconButton label="Avatar" icon={<span className="body-s" style={{ fontWeight: 500 }}>SR</span>} variant="solid" ring />
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>sizes / variants</span>
              <IconButton label="32 ghost" size={32} variant="ghost" icon={<IconX />} />
              <IconButton label="36 pause" size={36} icon={<IconPause />} />
              <IconButton label="44 map" size={44} variant="map" icon={<IconPlus />} />
              <IconButton label="44 map follow" size={44} variant="map" icon={<IconLocate />} active accentIcon />
              <IconButton label="44 map" size={44} variant="map" icon={<IconMinus />} />
              <IconButton label="56 mobile" size={56} variant="solid" icon={<IconBell />} badge={12} />
              <IconButton label="raised" size={32} variant="raised" icon={<AircraftTop size={18} />} />
            </div>
          </div>
        </section>

        {/* ---------------- pills ---------------- */}
        <section className={s.section}>
          <H id="pills" title="Pill, PlateChip, Badge" ref="01 §4.3 · §4.10 · A3 · A24-8" />
          <div className={s.card}>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>count row</span>
              {[['air', 12, 'Airborne'], ['taxi', 8, 'Taxiing'], ['hold', 5, 'Holding'], ['gate', 3, 'At gate']].map(([id, n, l]) => (
                <Pill key={String(id)} size="l" interactive count={n as number} selected={pillSel === id} onClick={() => setPillSel(String(id))} testId={`pill-${id}`}>{l}</Pill>
              ))}
              <Pill size="l" interactive count={0} disabled>Pushback</Pill>
              <Pill size="l" interactive count={4} forceState="hover">Hover</Pill>
              <Pill size="l" interactive count={4} forceState="pressed">Pressed</Pill>
              <Pill size="l" interactive count={4} forceState="focus">Focus</Pill>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>status 30</span>
              <Pill tone="outline">Ground</Pill>
              <Pill tone="green">Airborne</Pill>
              <Pill tone="red">Emerg</Pill>
              <Pill tone="red-solid">7700</Pill>
              <Pill tone="orange">Advisory</Pill>
              <Pill tone="solid">Selected</Pill>
              <Pill tone="dim">Upcoming</Pill>
              <Pill tone="outline" dot="green">Online</Pill>
              <Pill tone="outline" dot="red" dotGlow>Conflict</Pill>
              <Pill tone="outline" dot="orange">Pending</Pill>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>signal chips</span>
              <Pill tone="outline" icon={<IconRadioTower />} iconTone="orange" style={{ background: 'transparent', borderColor: 'transparent' }}>ADS-B</Pill>
              <Pill tone="outline" icon={<IconPlaneLanding />} iconTone="green" style={{ background: 'transparent', borderColor: 'transparent' }}>ILS</Pill>
              <Pill tone="outline" icon={<IconHeadphones />} style={{ background: 'transparent', borderColor: 'transparent' }}>COMM</Pill>
              <Pill tone="outline" icon={<IconWifi />} iconTone="green" style={{ background: 'transparent', borderColor: 'transparent' }}>LTE</Pill>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>xs 24 tags</span>
              <Pill size="xs" tone="tag">BAW123</Pill>
              <Pill size="xs" tone="solid" icon={<IconPlaneLanding />}>A</Pill>
              <Pill size="xs" tone="solid" icon={<Icon name="plane-takeoff" />}>D</Pill>
              <Pill size="xs" tone="neutral">DCT BIG</Pill>
              <Pill size="xs" tone="orange">EXPD</Pill>
              <Pill size="xs" tone="neutral" tabular>3.1 nm / 900 ft</Pill>
              <Pill size="xs" tone="tag" uppercase>hld big</Pill>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>map pills 40</span>
              <Pill size="l" tone="glass" interactive icon={<IconPlane />} trailing={<IconChevronDown size={14} />}>BAW123</Pill>
              <Pill size="l" tone="glass" interactive icon={<IconMap />}>Satellite · Chart</Pill>
              <Pill size="m" tone="glass" interactive icon={<IconPause size={16} />}>Paused</Pill>
              <Pill size="s" tone="solid">Paused</Pill>
              <Pill size="s" tone="neutral" tabular><span className="text-3">Score</span><span>1,240</span><span className="text-3">HI 1,240</span></Pill>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>plate chips</span>
              <PlateChip letter="M" value="4523" />
              <PlateChip letter="H" value="G-STBA" size="l" />
              <span style={{ padding: 8, borderRadius: 14, background: 'var(--glass-fill)' }}><PlateChip letter="L" value="45623" size="l" onGlass /></span>
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>badges</span>
              <Badge value={2} /><Badge value={120} /><Badge value={7} size="m" /><Badge value={1} size="m" glow /><Badge value={3} size="m" tone="orange" /><Badge value={4} size="m" tone="neutral" /><Badge value="!" tone="white" /><Badge dot glow /><Badge value={9} pulse /><Badge value={count} bumpKey={count} /><Button size="sm" variant="ghost" onClick={() => setCount((c) => c + 1)}>bump</Button>
            </div>
          </div>
        </section>

        {/* ---------------- tabs ---------------- */}
        <section className={s.section}>
          <H id="tabs" title="Tabs and Segmented" ref="01 §4.9 · §4.6 · A2 · A15" />
          <div className={s.card}>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>nav tabs</span>
              <Tabs ariaLabel="Position" value={tab} onChange={setTab} testId="tabs-position" items={[{ id: 'ground', label: 'Ground' }, { id: 'tower', label: 'Tower' }, { id: 'approach', label: 'Approach', badge: 2 }, { id: 'analytics', label: 'Analytics' }, { id: 'settings', label: 'Settings', disabled: true }]} />
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>compact</span>
              <Tabs compact ariaLabel="Bays" value={tab} onChange={setTab} items={[{ id: 'ground', label: 'Departures' }, { id: 'tower', label: 'Arrivals' }, { id: 'approach', label: 'Handoffs' }]} />
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>segmented</span>
              <Spec label="range"><Segmented ariaLabel="Range" value={seg} onChange={setSeg} testId="seg-range" items={[{ id: 'hour', label: 'Hour' }, { id: 'shift', label: 'Shift' }, { id: 'month', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'year', label: 'Year', disabled: true }]} /></Spec>
              <Spec label="rate · tabular"><Segmented ariaLabel="Rate" tabular value={rate} onChange={setRate} items={[{ id: '1', label: '1×' }, { id: '2', label: '2×' }, { id: '4', label: '4×' }]} /></Spec>
              <Spec label="airport · small"><Segmented ariaLabel="Airport" small value={sel ?? 'EGLL'} onChange={() => {}} items={[{ id: 'EGLL', label: 'EGLL' }, { id: 'KJFK', label: 'KJFK' }, { id: 'KSFO', label: 'KSFO' }]} /></Spec>
            </div>
          </div>
        </section>

        {/* ---------------- controls ---------------- */}
        <section className={s.section}>
          <H id="controls" title="Toggle and Checkbox" ref="01 §4.19 · A2" />
          <div className={s.card}>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>toggle</span>
              <Toggle checked={off} onChange={setOff} label="Off" testId="toggle-off" />
              <Toggle checked={on} onChange={setOn} label="On" />
              <Toggle checked={false} onChange={() => {}} label="Hover" forceState="hover" />
              <Toggle checked={true} onChange={() => {}} label="Focus" forceState="focus" />
              <Toggle checked={false} onChange={() => {}} label="Disabled off" disabled />
              <Toggle checked={true} onChange={() => {}} label="Disabled on" disabled />
              <Toggle checked={on} onChange={setOn} label="Voice readback" description="Synthesised pilot voice" labelPosition="left" />
            </div>
            <div className={s.row}>
              <span className={s.label} style={{ width: 80 }}>checkbox</span>
              <Checkbox checked={cb2} onChange={setCb2} label="Unchecked" testId="cb" />
              <Checkbox checked={cb} onChange={setCb} label="Checked" />
              <Checkbox checked={false} onChange={() => {}} indeterminate label="Indeterminate" />
              <Checkbox checked={false} onChange={() => {}} label="Disabled" disabled />
              <Checkbox checked onChange={() => {}} label="Disabled checked" disabled />
              <Checkbox checked={false} onChange={() => {}} label="Error" error />
              <Checkbox checked={cb} onChange={setCb} label="Emergencies" description="Engine fire, medical, 7700" />
            </div>
          </div>
        </section>

        {/* ---------------- inputs ---------------- */}
        <section className={s.section}>
          <H id="inputs" title="Input and Select" ref="01 §4.19 · A2 · A11.1 · A11.6 · A20" />
          <div className={s.grid}>
            <div className={s.card}>
              <Input placeholder="Search Ctrl+K" prefixIcon={<IconSearch size={16} />} suffix={<Kbd keys={['Ctrl', 'K']} />} testId="input-search" />
              <Input placeholder="Hover" forceState="hover" />
              <Input placeholder="Focus" forceState="focus" defaultValue="BAW123 heading 270" />
              <Input label="Callsign" placeholder="BAW123" helper="ICAO airline code + flight number" />
              <Input placeholder="Disabled" disabled />
              <Input placeholder="Squawk" defaultValue="4523" tabular label="Tabular" />
            </div>
            <div className={s.card}>
              <Input placeholder="BAW123 heading 270 · ils 27L · hold BIG" prefixIcon={<IconTerminal size={16} />} suffix={<IconButton label="Send" size={32} variant="ghost" icon={<IconSend size={16} />} />} error={inputErr} shakeKey={shakeKey} testId="input-cmd"
                onKeyDown={(e) => { if (e.key === 'Enter') { setInputErr("Unknown command 'hedaing'"); setShakeKey((k) => k + 1) } }} helper="Press Enter to see the parse-error state" />
              <div style={{ position: 'relative', borderRadius: 14, background: 'var(--glass-fill)', padding: 12 }}>
                <Input placeholder="Glass surface over map" surface="glass" prefixIcon={<IconSearch size={16} />} />
              </div>
              <Input size="m" placeholder="Size m (36)" />
            </div>
            <div className={s.card}>
              <Select label="Runway" options={runwayOptions} value={sel} onChange={setSel} icon={<IconPlaneLanding size={18} />} testId="select-runway" />
              <Select options={runwayOptions} value={sel2} onChange={setSel2} placeholder="Placeholder" />
              <Select options={runwayOptions} value={sel} onChange={setSel} disabled />
              <Select options={runwayOptions} value={null} onChange={setSel2} error="Choose a runway" size="m" />
              <div style={{ borderRadius: 14, background: 'var(--glass-fill)', padding: 12 }}>
                <Select options={[{ value: 'BAW123', label: 'BAW123', description: 'A320' }, { value: 'DLH4AB', label: 'DLH4AB', description: 'A359' }]} value="BAW123" onChange={() => {}} surface="glass" icon={<IconPlane size={18} />} />
              </div>
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>Menu (static)</span>
              <Menu placement="static" activeIndex={1} value="27L" onSelect={() => {}} options={[
                { value: 'h', label: 'heading 270', description: 'turn left', right: <Kbd>H</Kbd> },
                { value: '27L', label: 'ils 27L', description: 'cleared ILS approach', right: <Kbd>I</Kbd> },
                { value: 'hold', label: 'hold BIG', description: 'as published', section: 'Holding' },
                { value: 'ga', label: 'go around', disabled: true },
              ]} />
            </div>
          </div>
        </section>

        {/* ---------------- numbers ---------------- */}
        <section className={s.section}>
          <H id="numbers" title="Kpi and StatTile" ref="01 §2.2 · §4.2 · A7 · A9" />
          <div className={s.grid2}>
            <div className={s.card}>
              <div className={s.row}>
                <Spec label="display-xl · counts"><Kpi value={122580} unit="Month" testId="kpi-month" /></Spec>
                <Spec label="percent · no gap"><Kpi value={78.3} decimals={1} unit="%" /></Spec>
                <Spec label="± prefix · display suffix"><Kpi prefix="± " value={2.5} decimals={1} suffixDisplay="min" unit="Average variance" unitTone="text-3" /></Spec>
              </div>
              <div className={s.row}>
                <Spec label="altitude 5,000 ft"><Kpi size="m" hi={alt5000.hi} lo={alt5000.lo} unit="ft" tabular /></Spec>
                <Spec label="FL350"><Kpi size="m" prefix="FL" prefixDim value="350" split="none" /></Spec>
                <Spec label="SFC"><Kpi size="m" value="SFC" dim /></Spec>
                <Spec label="speed"><Kpi size="m" value={250} unit="kt" /></Spec>
                <Spec label="heading"><Kpi size="m" prefix="HDG " prefixDim value="005" split="none" tabular /></Spec>
                <Spec label="distance"><Kpi size="m" value="4.2" split="decimal" unit="nm" /></Spec>
              </div>
              <div className={s.row}>
                <Spec label="delta up"><Kpi size="l" value={142} delta={4} /></Spec>
                <Spec label="delta late (orange)"><Kpi size="l" value={12} unit="min" delta={2} deltaUnit="min" /></Spec>
                <Spec label="empty"><Kpi size="l" value="—" /></Spec>
                <Spec label="red"><Kpi size="l" value={7700} red split="none" tabular /></Spec>
                <Spec label="count-up"><Kpi size="l" value={count * 97} countUp tabular /><Button size="sm" variant="ghost" onClick={() => setCount((c) => c + 1)}>+</Button></Spec>
              </div>
              <div className={s.metrics}>
                <Kpi label="Altitude" size="m" hi="5," lo="000" unit="ft" tabular />
                <Kpi label="Speed" size="m" value={250} unit="kt" tabular />
                <Kpi label="Heading" size="m" value="270" split="none" tabular />
                <Kpi label="Vertical" size="m" value="−1,200" split="none" unit="fpm" tabular />
                <Kpi label="Squawk" size="m" value="4523" split="none" tabular />
                <Kpi label="Distance" size="m" value="3.1" split="decimal" unit="nm" tabular />
              </div>
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>Stat tiles 200 × 104</span>
              <div className={s.tiles}>
                <StatTile label="Under control" value={12} icon="ok" testId="tile-ok" />
                <StatTile label="Conflicts" value={2} icon="alert" conflict testId="tile-conflict" />
                <StatTile label="Conflicts" value={0} icon="alert" conflict />
                <StatTile label="Holding" value={5} onClick={() => {}} />
              </div>
              <span className={s.cardTitle}>Progress</span>
              <ProgressBar value={0.42} label="Loading EGLL…" showValue />
              <ProgressBar value={0.7} tone="orange" thickness={4} />
              <ProgressBar indeterminate />
              <ProgressBar value={0.3} tone="red" fixedWidth />
            </div>
          </div>
        </section>

        {/* ---------------- charts ---------------- */}
        <section className={s.section}>
          <H id="charts" title="BarChart and Sparkline" ref="01 §4.5 · §4.7 · A8" />
          <div className={s.grid2}>
            <GlassPanel variant="solid" title="Movements per hour" hasDisplayNumber affordance="open" headerGap testId="card-bars">
              <Kpi value={122580} unit="Month" />
              <div style={{ height: 24 }} />
              <Segmented ariaLabel="Range" value={seg} onChange={setSeg} items={[{ id: 'hour', label: 'Hour' }, { id: 'shift', label: 'Shift' }, { id: 'month', label: 'Day' }, { id: 'week', label: 'Week' }]} />
              <div style={{ height: 28 }} />
              <BarChart data={BAR_DATA} yTicks={[50000, 100000, 150000]} domain={[40000, 160000]} selected={selected} onSelect={setSelected} legend={{ current: 'Arrivals', compare: 'Departures' }} testId="barchart" ariaLabel="Movements per hour" />
            </GlassPanel>
            <GlassPanel variant="solid" title="Slot adherence" hasDisplayNumber affordance="open" headerGap testId="card-spark">
              <Kpi value={78.3} decimals={1} unit="%" />
              <div style={{ height: 24 }} />
              <Sparkline data={SPARK} yTicks={[25, 50, 75, 100]} domain={[20, 100]} target={80} targetCaption="Target:" targetLabel=">80%" lowThreshold={46} xLabels={['06:00', '09:00', '12:00', '15:00', '18:00', '21:00']} showCurrent cursor={cursor} onCursorChange={setCursor} testId="sparkline" ariaLabel="Slot adherence" />
            </GlassPanel>
          </div>
        </section>

        {/* ---------------- lists ---------------- */}
        <section className={s.section}>
          <H id="lists" title="ListRow, Divider, ScrollArea, Skeleton, EmptyState" ref="01 §4.17 · A2 · A4 · A11.7 · A11.10" />
          <div className={s.grid2}>
            <div className={s.card}>
              <ListRow icon={<IconPlane size={18} />} title="BAW123" subtitle="A320 · British Airways" meta="FL120" onClick={() => {}} testId="row-rest" />
              <ListRow icon={<IconPlane size={18} />} title="Hover" subtitle="forced" meta="250 kt" onClick={() => {}} forceState="hover" />
              <ListRow icon={<IconPlane size={18} />} title="Pressed" subtitle="forced" meta="250 kt" onClick={() => {}} forceState="pressed" />
              <ListRow icon={<IconPlane size={18} />} title="Focus" subtitle="inset ring" meta="250 kt" onClick={() => {}} forceState="focus" />
              <ListRow icon={<IconPlane size={18} />} title="Selected" subtitle="DLH4AB" meta="HDG 270" onClick={() => {}} selected />
              <ListRow icon={<IconClock size={18} />} iconTone="orange" title="Late" subtitle="slot +2min" meta="+2min" metaTone="orange" chevron onClick={() => {}} />
              <ListRow title="Disabled" subtitle="handed off" meta="—" disabled onClick={() => {}} />
              <ListRow icon={<IconPlane size={18} />} title="Loading" loading />
              <ListRow title="With trailing" subtitle="Voice readback" trailing={<Toggle checked={on} onChange={setOn} />} />
              <ListRow title="Static row" subtitle="no hover, no cursor" meta="14:07:53Z" />
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>ScrollArea · radio log (stick to bottom, fade mask)</span>
              <ScrollArea height={160} stickToBottom newCount={2} testId="scroll-log">
                {lines.map((l, i) => { const [who, text] = l.split('|'); return <div key={i} className={s.logLine}><span className={cx(s.who, who === 'ATC' ? s.whoAtc : who === 'PILOT' ? s.whoPilot : s.whoSys)}>{who}</span><span style={{ color: who === 'ATC' ? 'var(--text-1)' : text.startsWith('Unable') ? 'var(--orange)' : undefined }}>{text}</span></div> })}
              </ScrollArea>
              <div className={s.row}><Button size="sm" onClick={() => setLines((ls) => [...ls, `PILOT|Readback ${ls.length}`])}>Append line</Button></div>
              <Divider label="Skeleton" />
              <div className={s.row}><Skeleton variant="circle" width={40} height={40} /><Skeleton variant="pill" /><Skeleton variant="number" /></div>
              <Skeleton lines={3} />
              <Divider label="Empty states" />
              <EmptyState icon={<IconPointerClick size={24} />} title="Select an aircraft on the map or in the list" compact />
              <EmptyState icon={<IconPlane size={24} />} title="No traffic" hint="Use + DEP or + ARR" action={<Button size="sm">+ DEP</Button>} compact testId="empty-traffic" />
              <EmptyState title="Could not load airport" hint="Check the connection" error action={<Button variant="ghost" size="sm">Retry</Button>} compact />
            </div>
          </div>
        </section>

        {/* ---------------- alerts ---------------- */}
        <section className={s.section}>
          <H id="alerts" title="AlertItem and AlertGroup" ref="01 §4.12 · A13" />
          <div className={s.grid2}>
            <GlassPanel variant="solid" title="Warning" titleSize="l" affordance="collapse" padding="card-lg" radius="card-lg" testId="alerts-panel">
              <div className={s.col} style={{ gap: 24, marginTop: 24 }}>
                <AlertGroup icon={<IconSeparation size={18} />} title="Separation" parenthetical="(2 pairs)" count={2} countTone="white">
                  <AlertItem severity="warning" index={1} title="BAW123 / DLH4AB 2.4 nm / 600 ft" time="4m ago" expanded={alertOpen} onToggle={setAlertOpen} affected={[{ name: 'BAW123', detail: 'FL120 · 250 kt · HDG 270' }, { name: 'DLH4AB', detail: 'FL115 · 280 kt · HDG 090' }]} recommend={{ text: 'BAW123 turn left heading 240', onAccept: () => {} }} testId="alert-warning" />
                  <AlertItem severity="warning" index={2} title="EZY45 / RYR8K 4.1 nm / 900 ft" time="1m ago" affected={[{ name: 'EZY45', detail: '3.1 nm / 900 ft' }]} />
                </AlertGroup>
                <AlertGroup icon={<IconSiren size={18} />} title="Emergency" parenthetical="(27R)" count={1} countTone="red">
                  <AlertItem severity="critical" index={1} title="AFR22 engine fire · 7700" time="12s ago" pulse expanded affected={[{ name: 'AFR22', detail: 'B77W · 3 nm final 27R' }]} recommend={{ text: 'Dispatch ARFF to 27R', onAccept: () => {} }} actions={<><Button size="sm" variant="secondary">Acknowledge</Button><Button size="sm" variant="danger">Close 27R</Button></>} testId="alert-critical" />
                </AlertGroup>
                <AlertGroup icon={<IconPlaneLanding size={18} />} title="Runway" parenthetical="(27L)" count={1} countTone="text-2">
                  <AlertItem severity="advisory" index={1} title="Sequence EZY45 behind BAW123" time="2m ago" recommend={{ text: 'EZY45 reduce speed 180 kt', done: true }} expanded />
                </AlertGroup>
                <AlertGroup icon={<IconWind size={18} />} title="Wake turbulence" count={0} countTone="text-3">
                  <AlertItem severity="info" index={1} title="Resolved: BAW123 / DLH4AB" time="8m ago" />
                </AlertGroup>
              </div>
            </GlassPanel>
            <div className={s.col}>
              <div className={s.card}>
                <span className={s.cardTitle}>Toast (static, all kinds)</span>
                <ToastStack>
                  <Toast kind="info" text="Runway 28L in use" testId="toast-static-info" />
                  <Toast kind="success" text="BAW123 cleared to land 28L" detail="Readback correct" />
                  <Toast kind="attention" text="Wind now 280 at 18 kt" action={{ label: 'ATIS', onClick: () => {} }} />
                  <Toast kind="error" text="ADS-B feed lost" action={{ label: 'Retry', onClick: () => {} }} dismissible />
                </ToastStack>
                <span className={s.cardTitle}>Live (bottom-centre host, max 3, pause on hover)</span>
                <ToastDemo />
              </div>
              <div className={s.card}>
                <span className={s.cardTitle}>Tooltip and Kbd</span>
                <div className={s.row}>
                  <Tooltip content="Recentre on selection" kbd={['⌖']}><IconButton label="Recentre" size={44} variant="map" icon={<IconLocate />} /></Tooltip>
                  <Tooltip content="Pause" kbd={['Space']} placement="bottom"><IconButton label="Pause" size={36} icon={<IconPause />} /></Tooltip>
                  <Tooltip content="Always open (docs)" open placement="right"><Button size="sm">Open tooltip</Button></Tooltip>
                </div>
                <div className={s.row}>
                  <Kbd>Esc</Kbd><Kbd keys={['Ctrl', 'K']} /><Kbd keys={['Alt', '1']} /><Kbd>↑</Kbd><Kbd>[</Kbd><span className="body-s text-3">plain: <Kbd plain keys={['Ctrl', 'Shift', 'F']} /></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- feedback ---------------- */}
        <section className={s.section}>
          <H id="feedback" title="Modal and Sheet" ref="01 A11.2 · A5" />
          <div className={s.grid2}>
            <div className={s.inlineHost}>
              <Modal open inline title="Change airport?" confirmLabel="Change" onConfirm={() => {}} onClose={() => {}} testId="modal-inline">The current session at EGLL will end. Score and stats are saved to the session history.</Modal>
            </div>
            <div className={s.inlineHost}>
              <Modal open inline title="End of shift" confirmLabel="Close runway" confirmVariant="danger" showClose onConfirm={() => {}} onClose={() => {}} footerLeft={<Kbd keys={['Esc']} />}>Danger confirmation with close button and footer-left slot.</Modal>
            </div>
            <div className={s.inlineHost}>
              <Sheet open inline title="Alerts" count={3} snap="half" onClose={() => {}} testId="sheet-inline">
                <AlertItem severity="warning" index={1} title="BAW123 / DLH4AB 2.4 nm" time="4m ago" />
              </Sheet>
            </div>
            <div className={s.inlineHost} style={{ height: 240 }}>
              <LoadingOverlay open text="Loading EGLL…" progress={0.42} testId="loading-overlay" />
            </div>
            <div className={s.card}>
              <div className={s.row}>
                <Button onClick={() => setModal(true)} testId="open-modal">Open modal (portal, focus trap, Esc)</Button>
                <Button onClick={() => setSheet(true)}>Open sheet</Button>
              </div>
              <Modal open={modal} onClose={() => setModal(false)} title="Change airport?" confirmLabel="Change" onConfirm={() => setModal(false)} testId="modal-live">
                The current session at EGLL will end. <Input placeholder="Type to test focus trap" style={{ marginTop: 12 }} />
              </Modal>
              <Sheet open={sheet} onClose={() => setSheet(false)} title="Alerts" count={3} snap={snap} onSnapChange={setSnap} testId="sheet-live">
                <div className={s.col}>
                  <AlertItem severity="critical" index={1} title="AFR22 engine fire · 7700" time="12s ago" />
                  <AlertItem severity="warning" index={2} title="BAW123 / DLH4AB 2.4 nm" time="4m ago" />
                  <div className={s.row}><Button size="sm" onClick={() => setSnap('peek')}>peek</Button><Button size="sm" onClick={() => setSnap('half')}>half</Button><Button size="sm" onClick={() => setSnap('full')}>full</Button></div>
                </div>
              </Sheet>
            </div>
          </div>
        </section>

        {/* ---------------- atc ---------------- */}
        <section className={s.section}>
          <H id="atc" title="Dial, Ladder, Stepper" ref="04 command tree · A11.4" />
          <div className={s.grid}>
            <div className={s.card}>
              <span className={s.cardTitle}>Dial · heading 0–359 (drag, arrows, Shift = 1°)</span>
              <div className={s.row}>
                <Dial value={heading} onChange={setHeading} current={310} quickSteps={[-30, -10, 10, 30]} testId="dial" />
                <Dial value={90} onChange={() => {}} size={140} label="RWY" />
                <Dial value={180} onChange={() => {}} current={180} size={140} disabled />
              </div>
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>Ladder · altitude and speed</span>
              <div className={s.row + ' ' + s.rowTop}>
                <Ladder value={alt} onChange={setAlt} min={0} max={15000} step={1000} majorEvery={5000} current={3000} label="ALT" unit="ft" quickSteps={[3000, 1000, -1000, -3000]} testId="ladder-alt" />
                <Ladder value={spd} onChange={setSpd} min={160} max={340} step={10} majorEvery={50} current={280} label="SPD" unit="kt" quickSteps={[20, 10, -10, -20]} width={96} testId="ladder-spd" />
                <Ladder value={2000} onChange={() => {}} min={0} max={6000} step={500} majorEvery={2000} label="ALT" unit="ft" disabled height={160} />
              </div>
            </div>
            <div className={s.card}>
              <span className={s.cardTitle}>Stepper · command builder</span>
              <StepperDemo />
            </div>
          </div>
        </section>

        {/* ---------------- satellite ---------------- */}
        <section className={s.section}>
          <H id="satellite" title="Glass over satellite" ref="01 §5 · §6 · §4.13 · §4.15 · §4.16 · A10" />
          <div className={s.satellite} data-testid="satellite-stage">
            <div className={s.satImg} />
            <div className={s.satTitle}>
              <span className="display-xl">San Francisco · KSFO</span>
              <span className={s.satSub}>GROUND · TOWER</span>
              <div className={s.row}>
                <Pill size="l" tone="glass" interactive icon={<IconPlane />} trailing={<IconChevronDown size={14} />}>BAW123</Pill>
                <Pill size="l" tone="glass" interactive icon={<IconMap />}>Satellite · Chart</Pill>
              </div>
            </div>
            <div className={s.satNav}>
              <Input placeholder="Search Ctrl+K" surface="glass" prefixIcon={<IconSearch size={20} />} style={{ width: 280 }} />
              <IconButton label="ADS-B" icon={<IconRadioTower />} />
              <IconButton label="Radio" icon={<IconHeadphones />} />
              <IconButton label="Alerts" icon={<IconBell />} badge={2} />
              <IconButton label="Controller" icon={<span className="body-s" style={{ fontWeight: 500 }}>SR</span>} variant="solid" ring />
            </div>
            <div className={s.ring} />
            <div className={s.puck}><IconNavigation size={22} style={{ transform: 'rotate(45deg)' }} /></div>
            <div className={s.chevron} style={{ left: '30%', top: '62%' }}><IconNavigation size={12} style={{ transform: 'rotate(120deg)' }} /></div>
            <div className={s.dataBlock} style={{ left: 'calc(30% + 18px)', top: 'calc(62% - 26px)' }}>DLH4AB <span className={s.dataDot}>·</span> <span className={s.dataDim}>050</span> <span className={s.dataDot}>·</span> <span className={s.dataDim}>25</span></div>
            <div className={s.chevron} style={{ left: '22%', top: '40%', color: 'var(--red)' }}><IconNavigation size={12} style={{ transform: 'rotate(200deg)' }} /></div>
            <div className={s.dataBlock} style={{ left: 'calc(22% + 18px)', top: 'calc(40% - 26px)', background: 'var(--red-85)' }}>AFR22 <span className={s.dataDot} style={{ color: 'var(--w-70)' }}>·</span> 7700</div>
            <div className={s.popover}>
              <GlassPanel variant="glass" title="BAW123" subtitle="Next: BIG" affordance="open" padding="tile" style={{ padding: 18 }}>
                <div style={{ marginTop: 8 }}><Kpi size="l" value="4.2" split="decimal" unit="nm" unitTone="text-4" /></div>
              </GlassPanel>
            </div>
            <div className={s.satControls}>
              <IconButton label="Zoom out" size={44} variant="map" icon={<IconMinus />} />
              <IconButton label="Recentre" size={44} variant="map" icon={<IconLocate />} active accentIcon />
              <IconButton label="Zoom in" size={44} variant="map" icon={<IconPlus />} />
            </div>
            <div className={s.satRight}>
            <GlassPanel variant="glass" title="Warning" titleSize="l" affordance="collapse" padding="card-lg" radius="card-lg" testId="sat-warning">
              <div className={s.col} style={{ gap: 24, marginTop: 24 }}>
                <AlertGroup icon={<IconSeparation size={18} />} title="Separation" parenthetical="(2 pairs)">
                  <AlertItem severity="warning" index={2} title="BAW123 / DLH4AB 2.4 nm / 600 ft" time="4m ago" expanded affected={[{ name: 'BAW123', detail: 'FL120 · 250 kt' }, { name: 'DLH4AB', detail: 'FL115 · 280 kt' }]} recommend={{ text: 'BAW123 turn left heading 240', onAccept: () => {} }} />
                </AlertGroup>
                <AlertGroup icon={<IconClock size={18} />} title="Slot deviations" parenthetical="(27L)">
                  <AlertItem severity="warning" index={1} title="EZY45 is 15 mins behind schedule" time="12m ago" affected={[{ name: 'EZY45', detail: '+15min' }]} />
                </AlertGroup>
              </div>
            </GlassPanel>
            </div>
            <div className={s.satBottom}>
              <GlassPanel variant="glass" title="Slot deviation" hasDisplayNumber affordance="open" headerGap style={{ width: 400 }}>
                <Kpi prefix="± " value={2.5} decimals={1} suffixDisplay="min" unit="Average variance" unitTone="text-3" />
                <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
                  <PlateChip letter="M" value="4523" onGlass />
                  <span className="body-s text-2 tnum">−2min</span>
                  <span className="body-s tnum" style={{ color: 'var(--orange)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconClock size={14} />+1min</span>
                  <span className="body-s text-2 tnum">−1min</span>
                </div>
              </GlassPanel>
              <GlassPanel variant="glass" title="Movements per hour" hasDisplayNumber affordance="open" headerGap style={{ width: 420 }}>
                <Kpi value={142580} unit="today" unitTone="text-3" />
                <div style={{ height: 16 }} />
                <BarChart data={BAR_DATA.slice(0, 6)} yTicks={[50000, 100000, 150000]} domain={[40000, 160000]} height={120} selected={5} onGlass legend={undefined} ariaLabel="Movements today" />
              </GlassPanel>
            </div>
          </div>
        </section>

        {/* ---------------- icons ---------------- */}
        <section className={s.section}>
          <H id="icons" title="Icons" ref="01 A6 · custom glyphs" />
          <div className={s.iconGrid}>
            {(Object.keys(ICONS) as IconName[]).map((name) => <div key={name} className={s.iconCell}><Icon name={name} size={20} /><span className={s.iconName}>{name}</span></div>)}
            {[['aircraft-top', AircraftTop], ['fire-truck', FireTruck], ['follow-me-car', FollowMeCar], ['tug', Tug], ['ambulance', Ambulance], ['fuel', Fuel], ['deice', Deice], ['windsock', Windsock]].map(([name, G]) => {
              const Glyph = G as typeof AircraftTop
              return <div key={String(name)} className={s.iconCell}><Glyph size={24} /><span className={s.iconName}>{String(name)} (custom)</span></div>
            })}
            <div className={s.iconCell}><LogoMark size={28} /><span className={s.iconName}>logo mark</span></div>
            <div className={s.iconCell}><IconArrowUpRight size={18} /><span className={s.iconName}>arrow-up-right 18</span></div>
            <div className={s.iconCell}><IconSettings /><span className={s.iconName}>settings-2</span></div>
          </div>
        </section>
      </div>
    </ToastProvider>
  )
}
