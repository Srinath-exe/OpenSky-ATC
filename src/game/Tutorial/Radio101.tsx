'use client'
/*
  Radio 101: how a controller talks, before the first call. Three steps (callsigns, numbers, letters), each with the
  written form turning into the spoken one, real recordings to hear, and one question to answer. No sim.
*/
import * as React from 'react'
import s from './Radio101.module.css'
import { sound } from './audio'
import { Clip } from './Clip'

interface Ex { w: string; say: string; id: string }
interface Step { goal: string; vo: string; title: string; rule: string; hero: Ex; examples: Ex[]; q: { ask: string; options: string[]; right: number } }
const STEPS: Step[] = [
  {
    goal: 'callsign', vo: 'r101-cs', title: 'Callsigns', rule: 'The airline’s radio name, then the flight number, in pairs.',
    hero: { w: 'DLH455', say: 'Lufthansa four fifty-five', id: 'ex-dlh' },
    examples: [{ w: 'UAL214', say: 'United two fourteen', id: 'ex-ual' }, { w: 'SWA902', say: 'Southwest nine zero two', id: 'ex-swa' }, { w: 'ASA331', say: 'Alaska three thirty-one', id: 'ex-asa' }],
    q: { ask: 'How do you say SKW5520?', options: ['Sierra Kilo Whiskey five five two zero', 'SkyWest fifty-five twenty', 'SkyWest five thousand five hundred twenty'], right: 1 },
  },
  {
    goal: 'numbers', vo: 'r101-num', title: 'Numbers', rule: 'Runways, headings and speeds digit by digit. Altitudes in thousands.',
    hero: { w: 'RWY 01R', say: 'Runway zero one right', id: 'ex-rwy' },
    examples: [{ w: 'HDG 270', say: 'heading two seven zero', id: 'ex-hdg' }, { w: '5,000 ft', say: 'five thousand', id: 'ex-alt' }, { w: '11,000 ft', say: 'one one thousand', id: 'ex-alt2' }, { w: '210 kt', say: 'two one zero knots', id: 'ex-spd' }, { w: '118.5', say: 'one one eight point five', id: 'ex-frq' }],
    q: { ask: 'Heading 090?', options: ['Heading ninety', 'Heading zero nine zero', 'Heading nine'], right: 1 },
  },
  {
    goal: 'letters', vo: 'r101-let', title: 'Letters', rule: 'Every letter has a word, so nothing is misheard over the radio.',
    hero: { w: 'M5 M1 A2', say: 'Mike five, Mike one, Alpha two', id: 'ex-twy' },
    examples: [],
    q: { ask: 'Taxi via B, then K?', options: ['Bee, then Kay', 'Baker, then King', 'Bravo, then Kilo'], right: 2 },
  },
]
const ALPHA = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'.split(' ')

function Spoken({ ex, big = false }: { ex: Ex; big?: boolean }) {
  const [on, setOn] = React.useState(false)
  const hear = () => { sound.unlock(); setOn(true); void sound.say(ex.id) }
  return (
    <button className={s.ex} data-big={big} data-on={on} onClick={hear} title="Hear it">
      <span className={s.written}>{ex.w}</span>
      <span className={s.arrow}>→</span>
      <span className={s.said} key={String(on)}>{ex.say.split(' ').map((w, i) => <span key={i} style={{ animationDelay: `${i * 70}ms` }}>{w}</span>)}</span>
      <span className={s.ear} aria-hidden>🔊</span>
    </button>
  )
}

export function Radio101({ onMet, onDone }: { onMet: (goal: string) => void; onDone: () => void }) {
  const [i, setI] = React.useState(0)
  const [pick, setPick] = React.useState<number | null>(null)
  const st = STEPS[i]
  React.useEffect(() => { setPick(null); void sound.loadIndex().then(() => { void sound.say(st.vo, sound.now + 0.4) }) }, [i, st.vo])
  const answer = (k: number) => {
    if (pick === st.q.right) return
    setPick(k)
    if (k === st.q.right) { void sound.sfx('chime', 0, 0.6); onMet(st.goal) } else void sound.sfx('tick', 0, 0.6)
  }
  const right = pick === st.q.right
  const next = () => { if (i < STEPS.length - 1) { void sound.sfx('whoosh', 0, 0.5); setI(i + 1) } else { void sound.say('r101-done'); onDone() } }
  return (
    <div className={s.wrap} data-testid="tutor-radio101">
      <Clip id="r101" loop className={s.bg} />
      <div className={s.panel} key={i}>
        <div className={s.steps}>{STEPS.map((x, k) => <span key={x.goal} data-on={k === i} data-done={k < i}>{k + 1} · {x.title}</span>)}</div>
        <h2 className={s.title}>{st.title}</h2>
        <p className={s.rule}>{st.rule}</p>
        <Spoken ex={st.hero} big />
        {st.examples.length ? <div className={s.exs}>{st.examples.map((x) => <Spoken key={x.id} ex={x} />)}</div> : (
          <div className={s.alpha}>{ALPHA.map((w) => <button key={w} onClick={() => { sound.unlock(); void sound.say(`pa-${w[0]}`) }}><b>{w[0]}</b><span>{w}</span></button>)}</div>
        )}
        <div className={s.quiz}>
          <div className={s.ask}>{st.q.ask}</div>
          <div className={s.opts}>{st.q.options.map((o, k) => <button key={o} onClick={() => answer(k)} data-state={pick === k ? (k === st.q.right ? 'right' : 'wrong') : right && k === st.q.right ? 'right' : undefined} disabled={right}>{o}</button>)}</div>
        </div>
        <div className={s.foot}>
          <span className={s.tip}>Tap any example to hear it.</span>
          <button className={s.next} onClick={next} disabled={!right} data-testid="tutor-r101-next">{i < STEPS.length - 1 ? 'Next →' : 'Start mission 01 →'}</button>
        </div>
      </div>
    </div>
  )
}
