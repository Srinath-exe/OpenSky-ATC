/*
  How a written call is said on the radio, by the game's own phraseology: "DLH455 taxi to runway 01R via M5 M1" ->
  "Lufthansa four fifty-five, runway zero one right, taxi via Mike five, Mike one". The coach shows it under each call,
  and the controller's recorded voice says it (scripts/learn_audio.mjs records every call the lessons suggest, keyed by
  callKey of the spoken text).
*/
import type { SimEngine } from '../../lib/sim/engine'
import { parseCommand } from '../../lib/sim/commands'
import { fromEngine } from '../../lib/sim/dispatch'
import { transmission } from '../../lib/sim/phraseology'

export function spokenCall(e: SimEngine, line: string): string | null {
  try {
    const pr = parseCommand(line, fromEngine(e, { lastCallsign: null, position: e.playerPosition }))
    if (!pr.ok || !pr.ast) return null
    const a = pr.callsign ? e.find(pr.callsign) ?? null : null
    // the wind changes from minute to minute and a learner need not say it: leave it out
    const t = transmission(pr.ast, e.phraseCtx(a)).replace(/,?\s*wind [a-z ]+? at [a-z -]+?(?=[,.]|$)/i, '').trim()
    return t || null
  } catch { return null }
}

/** A short stable id for a spoken line (FNV-1a), shared by the recorder and the page. */
export function callKey(spoken: string): string {
  let h = 0x811c9dc5
  const t = spoken.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `call-${h.toString(16).padStart(8, '0')}`
}
