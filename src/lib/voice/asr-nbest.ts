/*
  Several transcripts -> one command (ml/stt/RESULTS2.md "n-best").

  A recogniser can return its n best guesses (n-best list): Web Speech with maxAlternatives, the server engine as
  "with the callsign prompt" + "without it". Each guess is repaired (asr-repair.ts) and tried on the rules (L0), best
  ranked first; the first that parses wins. When none parses, the S1 model (L1, through understandVoice) reads each of
  the first three and the most confident proposal wins. Wraps understand.ts without changing it.
*/
import { understand, understandVoice } from './understand';
import type { L1Like, VoiceResult } from './understand';
import type { ParseCtx } from '../sim/commands';
import { AIRLINE_TELEPHONY } from '../sim/phraseology';
import { aircraftFromContext, repairTranscript } from './asr-repair';
import type { AsrAircraft, Repair } from './asr-repair';

export interface HeardResult extends VoiceResult {
  /** Which alternative won (0 = the recogniser's best). */
  alt: number;
  /** The repaired text that was understood ('' when nothing was heard). */
  heard: string;
  notes: string[];
}

export interface HeardOptions { repair?: boolean; nbest?: boolean; minConfidence?: number }

/** Aircraft + spoken names: from the voice context when there is one, else from the parse context. */
export function asrAircraft(ctx: ParseCtx, state: { text: string } | null): AsrAircraft[] {
  if (state?.text) return aircraftFromContext(state.text);
  return (ctx.aircraft ?? []).map((a) => {
    const m = a.callsign.match(/^([A-Z]{3})(\d+[A-Z]{0,2})$/); const tel = m ? AIRLINE_TELEPHONY[m[1]] : undefined;
    return { callsign: a.callsign, name: tel && m ? `${tel} ${m[2]}`.toLowerCase() : a.callsign.toLowerCase() };
  });
}

/** Spoken names to bias a recogniser with ("speedbird 963"), the speaker's own frequency first (voiceContext order). */
export function biasNames(state: { text: string } | null): string[] {
  return state?.text ? aircraftFromContext(state.text).map((a) => a.name) : [];
}

const checkCallsign = (r: VoiceResult, rep: Repair | null): VoiceResult => {
  if (!r.ok || !rep?.fuzzy || !rep.callsign || r.line.split(/\s+/)[0] !== rep.callsign) return r;
  return { ...r, ok: false, error: `Callsign matched by sound (${rep.callsign}): check and press Enter` };
};

export async function understandHeard(alternatives: string[], ctx: ParseCtx, magVar: number, l1: L1Like | null,
  state: { text: string; callsigns: string[] } | null, opts: HeardOptions = {}): Promise<HeardResult> {
  const repair = opts.repair ?? true;
  let alts = [...new Set(alternatives.map((a) => a.trim()).filter(Boolean))];
  if (opts.nbest === false) alts = alts.slice(0, 1);
  if (!alts.length) {
    const u = understand('', ctx, magVar);
    return { ...u, confidence: null, sayAgain: false, modelMs: null, alt: 0, heard: '', notes: [] };
  }
  const aircraft = repair ? asrAircraft(ctx, state) : [];
  const tries = alts.map((raw, i) => ({ i, raw, rep: repair ? repairTranscript(raw, aircraft) : null }));
  // rules first, over every alternative (microseconds each). A parse whose callsign was only matched by sound is held
  // back (it goes to the player to check) while a later alternative may still parse with an exact callsign.
  let fuzzy: HeardResult | null = null;
  for (const t of tries) {
    for (const text of t.rep && t.rep.text !== t.raw ? [t.rep.text, t.raw] : [t.raw]) {
      const u = understand(text, ctx, magVar);
      if (u.ok) {
        const r = checkCallsign({ ...u, confidence: 1, sayAgain: false, modelMs: null }, text === t.rep?.text ? t.rep : null);
        const h: HeardResult = { ...r, alt: t.i, heard: text, notes: text === t.rep?.text ? t.rep.notes : [] };
        if (h.ok) return h;
        fuzzy ??= h;
      }
    }
  }
  if (fuzzy) return fuzzy;
  // then the model, on the raw and the repaired text of the first alternatives (it was trained on raw recogniser
  // output, so a repair that helps the rules can mislead it: "expedite descent" -> "descend"); most confident wins
  const modelTries = tries.flatMap((t) => [{ t, text: t.raw, rep: null as Repair | null }, ...(t.rep && t.rep.text && t.rep.text !== t.raw ? [{ t, text: t.rep.text, rep: t.rep }] : [])]).slice(0, l1 ? 4 : 1);
  let best: HeardResult | null = null;
  const rank = (r: VoiceResult) => (r.ok ? 2 : 0) + (r.source === 'L1' && !r.sayAgain && r.line && !/did not parse/.test(r.error ?? '') ? 1 : 0) + (r.confidence ?? 0) * 0.5;
  for (const m of modelTries) {
    const r = checkCallsign(await understandVoice(m.text, ctx, magVar, l1, state, opts.minConfidence), m.rep);
    const h: HeardResult = { ...r, alt: m.t.i, heard: m.text, notes: m.rep?.notes ?? [] };
    if (!best || rank(h) > rank(best)) best = h;
    if (!l1) break;
  }
  return best!;
}
