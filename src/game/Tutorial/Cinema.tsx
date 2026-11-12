'use client'
/*
  The tutorial's cinema: the cold open (a narrated minute over the raea film that ends with the player picking a seat),
  the mission briefings before each chapter, and the stamp when a mission is done. Everything moves on the narration's
  clock: pictures, kinetic captions (each word lands as it is spoken), radio waveforms, hits and whooshes.
*/
import * as React from 'react'
import s from './Cinema.module.css'
import { sound } from './audio'
import { Clip, loadClips, clipDur, clipUrl } from './Clip'
import { TABS, missionsOf, type Chapter, type Tab } from './lessons'

// ---------------------------------------------------------------------------------------------------------------------
// clock + helpers
// ---------------------------------------------------------------------------------------------------------------------
/** Seconds since `start` was called, on the audio clock when there is one; re-renders ~30 times a second while running. */
function useSeq(running: boolean) {
  const t0 = React.useRef<number | null>(null)
  const [, force] = React.useState(0)
  const now = React.useCallback(() => (sound.ctx ? sound.now : performance.now() / 1000), [])
  const t = React.useCallback(() => (t0.current == null ? 0 : now() - t0.current), [now])
  const start = React.useCallback((offset = 0) => { t0.current = now() - offset; force((x) => x + 1) }, [now])
  React.useEffect(() => {
    if (!running) return
    let raf = 0, last = 0
    const loop = (ms: number) => { raf = requestAnimationFrame(loop); if (ms - last > 30) { last = ms; force((x) => x + 1) } }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running])
  return { t, start, started: () => t0.current != null, at: (tt: number) => (t0.current ?? now()) + tt }
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '')

/** Words of a narrated line, each landing as it is spoken. `at` = the line's start on the sequence clock. */
export function Kinetic({ id, at, t, em = [], variant = 'hero', hold = 1.2, className }: { id: string; at: number; t: number; em?: string[]; variant?: 'hero' | 'brief' | 'radio'; hold?: number; className?: string }) {
  const info = sound.line(id)
  if (!info || t < at - 0.05) return null
  const local = t - at
  const out = clamp01((local - info.dur - hold) / 0.5)
  if (out >= 1) return null
  const emph = new Set(em.map(norm))
  return (
    <div className={`${s.kin} ${s[`kin_${variant}`]} ${className ?? ''}`} style={{ opacity: 1 - out, filter: out ? `blur(${out * 8}px)` : undefined }} aria-live="polite">
      {info.words.map(([w, a], i) => (local >= a - 0.04 ? <span key={i} className={emph.has(norm(w)) ? s.em : undefined}>{w}</span> : <span key={i} className={s.ghost}>{w}</span>))}
    </div>
  )
}

/** Live bars from the voice bus (radio scenes). */
function Wave({ n = 28 }: { n?: number }) {
  const b = sound.bands(n)
  return <div className={s.wave} aria-hidden>{b.map((v, i) => <i key={i} style={{ transform: `scaleY(${0.08 + v * 0.92})` }} />)}</div>
}

// ---------------------------------------------------------------------------------------------------------------------
// the cold open
// ---------------------------------------------------------------------------------------------------------------------
interface Scene { from: number; to: number; t0: number; t1: number; zoom?: [number, number] }
const SEATS: Array<{ tab: Tab; film: [number, number]; line: string }> = [
  { tab: 'ground', film: [268, 318], line: 'Push them back. Route them. Keep them apart.' },
  { tab: 'tower', film: [352, 404], line: 'Every landing. Every takeoff. Your call.' },
  { tab: 'approach', film: [60, 140], line: 'Turn chaos in the sky into one clean line.' },
]
const PRO_CLIPS = ['pro-1', 'pro-2', 'pro-3']

export function Prologue({ onPick, onSkip, returning = false }: { onPick: (tab: Tab) => void; onSkip: () => void; returning?: boolean }) {
  const [phase, setPhase] = React.useState<'gate' | 'play' | 'leaving'>('gate')
  const [ready, setReady] = React.useState(false)
  const seq = useSeq(phase === 'play')
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    void sound.loadIndex().then(() => { setReady(true) })
    void loadClips().then(() => tick((n) => n + 1))
    for (const id of PRO_CLIPS) { const l = document.createElement('link'); l.rel = 'preload'; l.as = 'video'; l.href = clipUrl(id); document.head.appendChild(l) }
    const id = window.setInterval(() => tick((n) => n + 1), 250); return () => window.clearInterval(id)
  }, [])
  const loaded = ready && clipDur('pro-1') ? 1 : 0
  const d = (id: string) => sound.line(id)?.dur ?? 3
  // the timeline (seconds), from the narration's lengths
  const T = React.useMemo(() => {
    const a1 = 1.0, a2 = a1 + d('pro-1') + 0.9
    const r1 = a2 + d('pro-2') + 1.0, r2 = r1 + d('pro-r1') + 0.7
    const y = r2 + d('pro-r2') + 1.1, y2 = y + 0.5
    const seats = y2 + d('pro-3') + 1.6
    const sc: Scene[] = [
      { from: 0, to: 44, t0: 0, t1: a2 },
      { from: 44, to: 120, t0: a2, t1: r1 },
      { from: 120, to: 212, t0: r1, t1: y },
    ]
    return { a1, a2, r1, r2, y, y2, seats, sc }
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const begin = () => {
    sound.unlock()
    sound.preload(['pro-1', 'pro-2', 'pro-r1', 'pro-r2', 'pro-3', 'pro-4', 'sfx:hit', 'sfx:whoosh', 'sfx:riser', 'sfx:squelch', 'sfx:jet', 'sfx:tick', 'music:bed', 'sfx:hum'])
    setPhase('play'); seq.start()
    void sound.loop('music:bed', true, 0.9, 2.5); void sound.loop('sfx:hum', true, 0.35, 3)
    void sound.sfx('riser', seq.at(0.1), 0.6); void sound.sfx('ping', seq.at(0.4), 0.5)
    void sound.say('pro-1', seq.at(T.a1)); void sound.say('pro-2', seq.at(T.a2 + 0.3))
    void sound.say('pro-r1', seq.at(T.r1 + 0.3)); void sound.say('pro-r2', seq.at(T.r2 + 0.3))
    void sound.sfx('jet', seq.at(T.r2 + d('pro-r2') - 1.5), 0.55)
    void sound.sfx('hit', seq.at(T.y), 1); void sound.say('pro-3', seq.at(T.y2))
    void sound.sfx('whoosh', seq.at(T.seats - 0.2), 0.8); void sound.say('pro-4', seq.at(T.seats + 0.3))
    for (let i = 0; i < 3; i++) void sound.sfx('tick', seq.at(T.seats + 0.5 + i * 0.22), 0.6)
  }
  const pick = (tab: Tab) => { void sound.sfx('whoosh', 0, 0.9); setPhase('leaving'); window.setTimeout(() => onPick(tab), 650) }
  const skip = () => { sound.unlock(); void sound.loop('music:bed', true, 0.6, 2); setPhase('leaving'); window.setTimeout(onSkip, 500) }

  // headless checks: jump the cold open to a moment
  React.useEffect(() => { (window as unknown as { __introSeek?: (x: number) => void }).__introSeek = (x) => seq.start(x) }, [seq])
  const t = seq.t()
  const sc = T.sc.find((x) => t >= x.t0 && t < x.t1) ?? (t >= T.seats ? null : T.sc[0])
  const flash = phase === 'play' ? Math.max(0, 1 - Math.abs(t - T.y) / 0.18) : 0
  const shake = phase === 'play' && t > T.y && t < T.y + 0.5 ? (1 - (t - T.y) / 0.5) * 9 : 0
  const radio = t >= T.r1 && t < T.y ? (t < T.r2 ? 'pilot' : 'tower') : null
  const seats = t >= T.seats

  if (phase === 'gate') return (
    <div className={s.gate} data-testid="tutor-gate">
      <div className={s.radar} aria-hidden><i className={s.sweep} /><b /><b /><b /><em style={{ left: '62%', top: '30%' }} /><em style={{ left: '30%', top: '58%', animationDelay: '1.3s' }} /><em style={{ left: '70%', top: '68%', animationDelay: '2.1s' }} /></div>
      <div className={s.gateText}>
        <div className={s.gateKicker}>KSFO · 37.62°N 122.38°W · One frequency</div>
        <h1 className={s.gateTitle}><span>Skycontrol</span><span>Training</span></h1>
        {returning ? (
          <>
            <button className={s.take} onClick={skip} data-testid="tutor-continue"><span className={s.takeRing} />Continue training</button>
            <button className={s.gateAlt} onClick={begin} disabled={!ready}>Watch the intro again</button>
          </>
        ) : (
          <>
            <button className={s.take} onClick={begin} disabled={!ready} data-testid="tutor-begin"><span className={s.takeRing} />{ready ? 'Take the frequency' : 'Tuning…'}</button>
            <div className={s.gateSub}>Sound on · about a minute · {Math.round(loaded * 100)}% loaded</div>
          </>
        )}
      </div>
      {returning ? null : <button className={s.skipIntro} onClick={skip}>Skip intro</button>}
    </div>
  )

  return (
    <div className={s.pro} data-leaving={phase === 'leaving'} style={{ transform: shake ? `translate(${(Math.random() - 0.5) * shake}px, ${(Math.random() - 0.5) * shake}px)` : undefined }} data-testid="tutor-prologue">
      {/* the film: one clip per scene, all buffered, each played at the speed that fits its narration */}
      {T.sc.map((x, i) => { const on = sc === x; const len = x.t1 - x.t0; return <Clip key={PRO_CLIPS[i]} id={PRO_CLIPS[i]} playing={on} rate={clipDur(PRO_CLIPS[i]) / len} zoomS={len} className={`${s.scene} ${s.zoom}`} style={{ opacity: on ? 1 : 0 }} /> })}
      {t >= T.y - 0.05 && t < T.seats + 0.6 ? <img className={s.still} src="/learn/clips/yours.webp" alt="" /> : null}
      <div className={s.grain} aria-hidden />
      <div className={s.vignette} aria-hidden />
      <div className={s.flash} style={{ opacity: flash }} aria-hidden />
      <div className={s.hud} aria-hidden>
        <span>KSFO</span><span className={s.hudRec}>● LIVE</span>
        <span className={s.hudClock}>{new Date(Date.UTC(2026, 10, 11, 6, 47, Math.floor(t))).toISOString().slice(11, 19)}Z</span>
        <span>TWR 118.500</span>
      </div>
      <div className={s.bars} aria-hidden data-on={!seats} />

      <Kinetic id="pro-1" at={T.a1} t={t} em={['ninety', 'seconds']} />
      <Kinetic id="pro-2" at={T.a2 + 0.3} t={t} em={['voice.']} />
      {radio ? (
        <div className={s.radio} data-who={radio} key={radio}>
          <div className={s.radioWho}><b>{radio === 'pilot' ? 'SJX12' : 'SFO TOWER'}</b><span>{radio === 'pilot' ? 'Starlux · A350 · 10 NM final · 28R' : '118.500 · cleared to land'}</span></div>
          <Wave />
          <Kinetic id={radio === 'pilot' ? 'pro-r1' : 'pro-r2'} at={radio === 'pilot' ? T.r1 + 0.3 : T.r2 + 0.3} t={t} variant="radio" hold={0.4} />
        </div>
      ) : null}
      {t >= T.y - 0.1 && t < T.seats + 0.4 ? (
        <div className={s.yours} data-out={t > T.seats - 0.1}>
          <div className={s.yoursSmall}>Tonight, that voice is</div>
          <div className={s.yoursBig} data-in={t >= T.y2 + (sound.line('pro-3')?.words.slice(-1)[0]?.[1] ?? d('pro-3') * 0.7) - 0.05}>yours.</div>
        </div>
      ) : null}
      {seats ? (
        <div className={s.seats}>
          <Kinetic id="pro-4" at={T.seats + 0.3} t={t} variant="brief" hold={30} className={s.seatsLine} em={['pick']} />
          <div className={s.seatRow}>
            {SEATS.map((x, i) => {
              const tb = TABS.find((q) => q.id === x.tab)!
              return (
                <button key={x.tab} className={s.seat} style={{ animationDelay: `${0.5 + i * 0.22}s` }} onClick={() => pick(x.tab)} data-testid={`tutor-seat-${x.tab}`}>
                  <Clip id={`seat-${x.tab}`} loop className={s.seatFilm} />
                  <span className={s.seatShade} />
                  <span className={s.seatNum}>0{i + 1}</span>
                  <span className={s.seatBody}>
                    <span className={s.seatName}>{tb.title}</span>
                    <span className={s.seatLine}>{x.line}</span>
                    <span className={s.seatMeta}>{missionsOf(x.tab).length} missions · {tb.blurb}</span>
                  </span>
                  <span className={s.seatGo}>Start →</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <div className={s.progress} aria-hidden><i style={{ transform: `scaleX(${clamp01(t / (T.seats + 3))})` }} /></div>
      {!seats ? <button className={s.skipIntro} onClick={() => seq.start(T.seats - 0.3)}>Skip ⏭</button> : <button className={s.skipIntro} onClick={skip}>Explore on my own</button>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// mission briefing
// ---------------------------------------------------------------------------------------------------------------------
export const FILM_OF: Record<string, [number, number]> = {
  'g-push': [268, 318], 'g-taxi': [304, 352], 'g-stop': [214, 262], 'g-cross': [318, 352], 'g-giveway': [222, 262], 'g-handoff': [336, 358],
  't-depart': [352, 404], 't-land': [146, 212], 't-gap': [168, 212], 't-goaround': [140, 180],
  'a-vectors': [44, 120], 'a-ils': [96, 160], 'a-sep': [60, 120],
}
const EM: Record<string, string[]> = {
  'g-push': ['backwards.', 'tug'], 'g-taxi': ['maze', 'light'], 'g-stop': ['stop.'], 'g-cross': ['big', 'word.'], 'g-giveway': ['one', 'first,'], 'g-handoff': ['tower.', 'clean.'],
  't-depart': ['one', 'seventy', 'count.'], 't-land': ['three', 'words'], 't-gap': ['cross.', 'timing'], 't-goaround': ['seconds.'],
  'a-vectors': ['three', 'numbers:'], 'a-ils': ['invisible', 'home.'], 'a-sep': ['closing', 'fast.'],
}

export function Briefing({ chapter, onDone }: { chapter: Chapter; onDone: () => void }) {
  const list = missionsOf(chapter.tab); const n = list.findIndex((c) => c.id === chapter.id) + 1
  const tab = TABS.find((x) => x.id === chapter.tab)!
  const vo = `b-${chapter.id}`
  const [go, setGo] = React.useState(false)
  const seq = useSeq(!go)
  const [stage, setStage] = React.useState<'brief' | 'turn' | 'out'>('brief')
  const dur = sound.line(vo)?.dur ?? 7
  const tObj = 1.1 + dur + 0.3, tTurn = tObj + 0.6 + chapter.goals.filter((g) => !g.optional).length * 0.32 + 1.2
  const finish = React.useCallback(() => {
    if (stage !== 'brief') return
    setStage('turn'); void sound.sfx('hit', 0, 0.8); void sound.sfx('whoosh', sound.now + 0.55, 0.8)
    window.setTimeout(() => setStage('out'), 900); window.setTimeout(() => { setGo(true); onDone() }, 1500)
  }, [stage, onDone])
  React.useEffect(() => {
    void Promise.all([sound.loadIndex(), loadClips()]).then(() => {
      seq.start()
      void sound.sfx('whoosh', seq.at(0.05), 0.7); void sound.say(vo, seq.at(1.1))
      chapter.goals.filter((g) => !g.optional).forEach((_, i) => void sound.sfx('tick', seq.at(tObj + 0.6 + i * 0.32), 0.5))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const t = seq.t()
  React.useEffect(() => { if (seq.started() && t >= tTurn && stage === 'brief') finish() }, [t, tTurn, stage, finish, seq])
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); finish() } }
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true)
  }, [finish])
  const goals = chapter.goals.filter((g) => !g.optional)
  return (
    <div className={s.brief} data-stage={stage} onClick={finish} data-testid="tutor-story">
      <Clip id={chapter.id} rate={clipDur(chapter.id) ? Math.max(0.75, Math.min(1.25, clipDur(chapter.id) / tTurn)) : 1} zoomS={tTurn} playing={stage !== 'out'} className={`${s.scene} ${s.zoom}`} style={{ opacity: seq.started() ? (stage === 'brief' ? 1 : 0.35) : 0 }} />
      <div className={s.grain} aria-hidden />
      <div className={s.vignette} aria-hidden />
      <div className={s.bars} data-on="true" aria-hidden />
      <div className={s.briefHead}>
        <div className={s.briefKicker}><span>{tab.title}</span><i />Mission {String(n).padStart(2, '0')} of {String(list.length).padStart(2, '0')}</div>
        <h2 className={s.briefTitle}>{chapter.title.split(' ').map((w, i) => <span key={i} style={{ animationDelay: `${0.25 + i * 0.09}s` }}>{w}</span>)}</h2>
      </div>
      <Kinetic id={vo} at={1.1} t={t} variant="brief" hold={60} em={EM[chapter.id]} className={s.briefVo} />
      {t >= tObj ? (
        <div className={s.objectives}>
          <div className={s.objLabel}>Objectives</div>
          {goals.map((g, i) => <div key={g.id} className={s.obj} style={{ animationDelay: `${0.6 + i * 0.32}s` }}><i>{i + 1}</i>{g.title}</div>)}
        </div>
      ) : null}
      {stage !== 'brief' ? <div className={s.turn}><span>Your</span><span>turn</span></div> : null}
      <div className={s.briefSkip}>Click or press Enter to start</div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// mission complete
// ---------------------------------------------------------------------------------------------------------------------
export function Complete({ chapter, seconds, calls, clean, onNext, onStay, nextLabel }: { chapter: Chapter; seconds: number; calls: number; clean: boolean; onNext: () => void; onStay: () => void; nextLabel: string }) {
  React.useEffect(() => { void sound.sfx('stamp', sound.now + 0.35, 1); void sound.sfx('chime', sound.now + 0.1, 0.7); void sound.say(Math.random() < 0.5 ? 'done-1' : 'done-2', sound.now + 0.9) }, [])
  const mm = Math.floor(seconds / 60), ss = Math.round(seconds % 60)
  return (
    <div className={s.done} data-testid="tutor-complete">
      <div className={s.doneCard}>
        <div className={s.stamp}>Cleared</div>
        <div className={s.doneKicker}>Mission complete</div>
        <div className={s.doneTitle}>{chapter.title}</div>
        <div className={s.stats}>
          <div><b>{mm}:{String(ss).padStart(2, '0')}</b><span>time</span></div>
          <div><b>{calls}</b><span>calls</span></div>
          <div><b data-ok={clean}>{clean ? 'Clean' : 'Close calls'}</b><span>safety</span></div>
        </div>
        <div className={s.doneRow}>
          <button className={s.doneStay} onClick={onStay}>Stay and play</button>
          <button className={s.doneNext} onClick={onNext} data-testid="tutor-next">{nextLabel} →</button>
        </div>
      </div>
    </div>
  )
}
