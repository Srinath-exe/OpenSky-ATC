'use client'
/*
  The tutorial's screen. Rail: the three seats and their missions, nothing else. Coach: one objective at a time, spoken by
  the narrator, with the call to make. Around it the cinema (Cinema.tsx): the gate and cold open, a briefing before each
  mission, a stamp at the end. The game behind runs in its minimal mode: map, aircraft, command line.
*/
import * as React from 'react'
import Link from 'next/link'
import s from './Tutorial.module.css'
import { useShell } from '@/game/shellContext'
import { sim } from '@/components/atc/simStore'
import { TABS, CHAPTERS, chaptersOf, missionsOf, type Tab } from './lessons'
import { coach, useCoach } from './runner'
import { sound } from './audio'
import { Briefing, Complete, Prologue } from './Cinema'
import { Radio101 } from './Radio101'
import { spokenCall, callKey } from './spoken'
import { setVoiceEngine, useVoicePrefs } from '@/lib/models/manager'

const INTRO_KEY = 'atc.tutor.intro.v1'

// ---------------------------------------------------------------------------------------------------------------------
// the rail
// ---------------------------------------------------------------------------------------------------------------------
const TAB_ICON: Record<Tab, React.ReactNode> = {
  ground: <svg viewBox="0 0 24 24" aria-hidden><path d="M3 18h18M6 18V9l6-4 6 4v9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>,
  tower: <svg viewBox="0 0 24 24" aria-hidden><path d="M9 21l1-11h4l1 11M7 10h10l-1.5-4h-7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>,
  approach: <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M12 12l6-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
}

export function Rail({ onIntro }: { onIntro: () => void }) {
  const st = useCoach((x) => x)
  const muted = React.useSyncExternalStore(sound.subscribe, () => sound.muted, () => false)
  const chs = chaptersOf(st.tab)
  return (
    <aside className={s.rail} aria-label="Training">
      <div className={s.railHead}>
        <Link href="/start" className={s.back} aria-label="Home">←</Link>
        <span className={s.railTitle}>Training</span>
        <button className={s.mute} onClick={() => sound.setMuted(!muted)} aria-label={muted ? 'Sound on' : 'Sound off'} title={muted ? 'Sound on' : 'Sound off'}>{muted ? '🔇' : '🔊'}</button>
      </div>
      <nav className={s.tabs} role="tablist">
        {TABS.map((t) => {
          const all = chaptersOf(t.id), done = all.filter((c) => st.progress[c.id]).length
          return (
            <button key={t.id} role="tab" aria-selected={t.id === st.tab} className={s.tab} data-on={t.id === st.tab} onClick={() => coach.setTab(t.id)} data-testid={`tutor-tab-${t.id}`}>
              <span className={s.tabIcon}>{TAB_ICON[t.id]}</span>
              <span className={s.tabName}>{t.title}</span>
              <span className={s.tabDots}>{all.map((c) => <i key={c.id} data-done={!!st.progress[c.id]} />)}</span>
              <span className={s.srOnly}>{done} of {all.length} done</span>
            </button>
          )
        })}
      </nav>
      <ol className={s.chapters} key={st.tab}>
        {chs.map((c, i) => (
          <li key={c.id} style={{ animationDelay: `${i * 40}ms` }}>
            <button className={s.chapter} data-on={st.chapter?.id === c.id} data-done={!!st.progress[c.id]} onClick={() => { sound.unlock(); coach.open(c.id) }} data-testid={`tutor-ch-${c.id}`}>
              <span className={s.chNum}>{st.progress[c.id] ? '✓' : c.ui ? '◎' : String(missionsOf(st.tab).indexOf(c) + 1).padStart(2, '0')}</span>
              <span className={s.chTitle}>{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className={s.railFoot}>
        <button className={s.footLink} onClick={onIntro}>▶ Watch the intro</button>
        <button className={s.footLink} onClick={() => coach.freePlay()} data-testid="tutor-free">Free play</button>
        <Link className={s.footLink} href={`/play?icao=KSFO&position=${st.tab}`}>Real shift →</Link>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// the coach
// ---------------------------------------------------------------------------------------------------------------------
function Phrase({ text }: { text: string }) {
  return <span className={s.phrase} key={text}>{text.split(' ').map((w, i) => <span key={i} style={{ animationDelay: `${150 + i * 80}ms` }} data-cs={i === 0}>{w}</span>)}</span>
}
const OK = ['ok-1', 'ok-2', 'ok-3', 'ok-4']

export function CoachOverlay() {
  const st = useCoach((x) => x)
  const shell = useShell()
  const ch = st.chapter
  const live = st.stage === 'live' || st.stage === 'done'

  // the game stays minimal while training: strip bay folded, comm log down to its last line (restored on the way out)
  const was = React.useRef<{ bay: boolean; log: boolean } | null>(null)
  React.useEffect(() => {
    if (!live) return
    if (!was.current) was.current = { bay: shell.bayCollapsed, log: shell.logCollapsed }
    if (!shell.bayCollapsed) shell.toggleBay()
    if (!shell.logCollapsed) shell.setLogCollapsed(true)
  }, [live, ch, shell])   // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => { const w = was.current; if (!w) return; if (!w.bay) shell.toggleBay(); if (!w.log) shell.setLogCollapsed(false) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const cur = live ? coach.current() : null
  const metN = st.met.size
  // the narrator: a word of praise when something is done, then the next objective
  const said = React.useRef<{ goal: string | null; met: number }>({ goal: null, met: 0 })
  React.useEffect(() => {
    if (!ch || st.stage !== 'live') { said.current = { goal: null, met: 0 }; return }
    const prev = said.current; said.current = { goal: cur?.id ?? null, met: metN }
    let at = 0
    if (metN > prev.met) { void sound.sfx('chime', 0, 0.6); const ok = OK[Math.floor(Math.random() * OK.length)]; void sound.say(ok); at = sound.now + (sound.line(ok)?.dur ?? 1) + 0.25 }
    if (cur && cur.id !== prev.goal && sound.line(`g-${ch.id}-${cur.id}`)) void sound.say(`g-${ch.id}-${cur.id}`, at)
  }, [cur?.id, metN, st.stage, ch]) // eslint-disable-line react-hooks/exhaustive-deps
  const warnN = st.notes.filter((n) => n.tone === 'warn').length
  React.useEffect(() => { if (warnN) void sound.say('warn-1') }, [warnN])

  const [stayed, setStayed] = React.useState<string | null>(null)
  if (!ch) return null
  if (st.stage === 'story') return <Briefing key={ch.id} chapter={ch} onDone={() => coach.begin()} />

  const list = chaptersOf(ch.tab); const idx = list.findIndex((c) => c.id === ch.id)
  const next = list[idx + 1] ?? CHAPTERS[CHAPTERS.findIndex((c) => c.id === ch.id) + 1] ?? null
  const goNext = () => { if (next) { coach.setTab(next.tab); coach.open(next.id) } else coach.freePlay() }
  if (ch.ui === 'radio') return <Radio101 onMet={(g) => coach.markMet(g)} onDone={goNext} />
  const required = ch.goals.filter((g) => !g.optional)
  const phrase = coach.phrase(cur)
  // how it is said on the radio (the game's own phraseology), with the controller's recording when there is one
  const spoken = phrase && sim.engine ? spokenCall(sim.engine, phrase) : null
  const rec = spoken && sound.line(callKey(spoken)) ? callKey(spoken) : null
  const note = [...st.notes].reverse().find((n) => n.tone !== 'done')   // the coach's voice and the dots already mark progress
  const calls = sim.radio.filter((l) => l.who === 'ATC' && (l.at ?? 0) >= coach.t0()).length
  return (
    <>
      <section className={s.card} data-testid="tutor-card" key={ch.id}>
        <header className={s.cardHead}>
          <span className={s.kicker}><b>{TABS.find((t) => t.id === ch.tab)?.title}</b> · Mission {String(missionsOf(ch.tab).indexOf(ch) + 1).padStart(2, '0')} · {ch.title}</span>
          {coach.fast ? <span className={s.fast}>⏩ Fast-forward</span> : null}
          <button className={s.iconBtn} onClick={() => coach.open(ch.id, { story: false })} title="Start this mission again" aria-label="Restart">↺</button>
        </header>
        {cur ? (
          <div className={s.objective} key={cur.id}>
            <h2 className={s.goalTitle}>{cur.title}</h2>
            {phrase ? (
              <>
                <div className={s.sayRow}>
                  <Phrase text={phrase} />
                  <button className={s.use} onClick={() => { sound.unlock(); void sound.sfx('tick', 0, 0.5); shell.focusCmd(phrase) }} data-testid="tutor-use">Use</button>
                </div>
                {spoken ? (
                  <button className={s.spoken} onClick={() => { sound.unlock(); if (rec) void sound.say(rec) }} disabled={!rec} title={rec ? 'Hear it' : undefined}>
                    <span className={s.spokenLabel}>Say</span><span className={s.spokenText}>{spoken.replace(/\.$/, '')}</span>{rec ? <span className={s.spokenEar}>🔊</span> : null}
                  </button>
                ) : null}
                <div className={s.hint}>Type it below, or hold <kbd>Ctrl</kbd> <kbd>Space</kbd> and say it.</div>
                <SpeechEngine />
              </>
            ) : <div className={s.hint}>Watch the map.</div>}
          </div>
        ) : st.stage === 'done' ? (
          <div className={s.objective}><h2 className={s.goalTitle}>Mission complete</h2>{next ? <button className={s.use} onClick={goNext}>Next: {next.title} →</button> : null}</div>
        ) : null}
        <div className={s.dots} aria-hidden>{required.map((g) => <i key={g.id} data-met={st.met.has(g.id)} data-now={cur?.id === g.id} />)}</div>
      </section>
      {note ? <div className={s.note} data-tone={note.tone} key={note.id} onClick={() => coach.dismissNote(note.id)}>{note.text}</div> : null}
      {st.stage === 'done' && stayed !== ch.id && !ch.ui ? (
        <Complete chapter={ch} seconds={(performance.now() - coach.startedWall) / 1000} calls={calls} clean={!coach.warned} nextLabel={next ? (next.tab !== ch.tab ? `On to ${TABS.find((t) => t.id === next.tab)?.title}` : `Next: ${next.title}`) : 'Free play'} onNext={goNext} onStay={() => setStayed(ch.id)} />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// the page's tutorial layer: the gate (and the cold open on a first visit), then missions
// ---------------------------------------------------------------------------------------------------------------------
export function useTutorBoot(ready: boolean, tab: Tab) {
  const [intro, setIntro] = React.useState<'gate' | 'off'>('gate')
  React.useEffect(() => {
    if (!ready) return
    coach.init(); coach.setTab(tab)
    return () => coach.dispose()
  }, [ready, tab])
  React.useEffect(() => () => { sim.setPaused(false) }, [])
  // the game rests under the full-screen intro (the map idles at a low frame rate while paused and still)
  React.useEffect(() => { if (ready && intro === 'gate') sim.setPaused(true) }, [ready, intro])
  const seen = typeof window !== 'undefined' && (() => { try { return localStorage.getItem(INTRO_KEY) === '1' } catch { return false } })()
  const markSeen = () => { try { localStorage.setItem(INTRO_KEY, '1') } catch { /* */ } }
  const firstOpen = (t: Tab) => { const p = coach.state.progress; const c = chaptersOf(t).find((x) => !p[x.id]) ?? chaptersOf(t)[0]; coach.setTab(t); coach.open(c.id) }
  const layer = intro === 'gate' && ready ? (
    <Prologue returning={seen} onPick={(t) => { markSeen(); setIntro('off'); firstOpen(t) }} onSkip={() => { markSeen(); setIntro('off'); firstOpen(coach.state.tab) }} />
  ) : null
  return { layer, replayIntro: () => setIntro('gate') }
}

/** Which recogniser hears the player, on the card: the server one is the one tuned for ATC; on-device and the browser's
 *  hear aviation words much worse, so when one of those is on the card says so and offers the switch back. */
function SpeechEngine() {
  const { engine } = useVoicePrefs()
  if (engine === 'server' || engine === 'native') return <div className={s.engine} data-ok="true">Speech: server, tuned for ATC</div>
  const what = engine === 'local' ? 'on this device (Moonshine): it mishears aviation words far more often' : "the browser's (Google): it mishears aviation words"
  return (
    <div className={s.engine} data-ok="false">
      Speech: {what}. <button type="button" className={s.engineFix} onClick={() => setVoiceEngine('server')} data-testid="tutor-speech-server">Use the server</button>
    </div>
  )
}
