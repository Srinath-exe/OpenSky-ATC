/*
  Voice verifier — does the model's proposed command match what was said? (ml/verify/RESULTS.md)

  The S1 model (L1) can be confidently wrong: "973 fly heading 102" -> BAW963 at 97%. Its own confidence only says how
  sure it was, not whether the line agrees with the transcript. The verifier scores "this proposal is correct" from two
  kinds of cheap evidence and gates it into send / check / say again:

    round trip   render the proposed command back into spoken phraseology with the engine (transmission(), both
                 ICAO and FAA wording), normalise it like a transcript, and align it with what was heard: is the
                 flight number there, the airline name, every number of the instruction, the key words (left/right,
                 climb/descend), and does another aircraft in the state match the words better?
    generator    per-token signals the S1 decoder already has (src/lib/voice/s1.ts Completion.signals): the
                 callsign margin in the constrained trie, the lowest token probability, digit-token margins.

  A logistic regression over those features (weights + thresholds fitted by ml/verify/fit.py from training-session
  data, written to verify-model.ts) gives P(correct). No network, no model download, well under a millisecond.
  Pure module, no DOM: runs in the browser and in node (ml/verify/post.cjs uses the same code to label the data).
*/
import { transmission, AIRLINE_TELEPHONY } from '../sim/phraseology';
import type { PhraseCtx, PhraseVariant } from '../sim/phraseology';
import type { CommandAST } from '../sim/commandAst';
import type { ParseCtx } from '../sim/commands';

// ---------- transcript normalisation (same as ml/data/augment.py stt_normalise + words_to_digits) ----------
const ONES = 'zero one two three four five six seven eight nine'.split(' ');
const TEENS = 'ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_VAL: Record<string, number> = { oh: 0, niner: 9, tree: 3, fife: 5, fower: 4 };
ONES.forEach((w, i) => { WORD_VAL[w] = i; }); TEENS.forEach((w, i) => { WORD_VAL[w] = 10 + i; });
const ICAO_TO_STT: Record<string, string> = { tree: 'three', niner: 'nine', fife: 'five', fower: 'four', wun: 'one', tousand: 'thousand' };

export function sttWords(s: string): string[] {
  const t = s.toLowerCase().replace(/’/g, "'").replace(/(\w)-(\w)/g, '$1 $2').replace(/[^\w\s.]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.split(' ').map(w => ICAO_TO_STT[w] ?? w) : [];
}

/** Spoken number runs -> digit strings ("eight sixty five" -> "865"), then "4 thousand" -> "4000", "12 hundred" -> "1200". */
export function wordsToDigits(words: string[]): string[] {
  const out: string[] = []; let run = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) {
      const nx = words[i + 1] ?? '';
      if (nx in WORD_VAL && WORD_VAL[nx] > 0 && WORD_VAL[nx] < 10) { run += String(TENS[w] + WORD_VAL[nx]); i++; continue; }
      run += String(TENS[w]); continue;
    }
    if (w in WORD_VAL) { run += String(WORD_VAL[w]); continue; }
    if (run) { out.push(run); run = ''; }
    out.push(w);
  }
  if (run) out.push(run);
  const j: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (/^\d+$/.test(w) && out[i + 1] === 'thousand') {
      let v = Number(w) * 1000; i++;
      if (/^\d$/.test(out[i + 1] ?? '') && out[i + 2] === 'hundred') { v += Number(out[i + 1]) * 100; i += 2; }
      j.push(String(v)); continue;
    }
    if (/^\d{1,2}$/.test(w) && out[i + 1] === 'hundred') { j.push(String(Number(w) * 100)); i++; continue; }
    j.push(w);
  }
  return j;
}

export const normTokens = (s: string) => wordsToDigits(sttWords(s));
const isNum = (w: string) => /^\d+$/.test(w);

const DIGIT_HOMOPHONE: Record<string, string> = { to: 'two', too: 'two', for: 'four', ate: 'eight', won: 'one', free: 'three' };
const isDigitWord = (w: string | undefined) => w !== undefined && w in WORD_VAL && WORD_VAL[w] < 10;
const HEARD_FIX: Record<string, string> = { wright: 'right', write: 'right', ills: 'ils', whole: 'hold', hole: 'hold', holds: 'hold', stan: 'stand', centre: 'center' };
const SIDE: Record<string, string> = { l: 'left', r: 'right', c: 'center' };
/** What was heard, ready to align: recogniser quirks undone ("25r", "wright", "4-9-8"), "seven to two" -> "722" (a homophone between two digits), and the parts the parser
 *  ignores and the render does not know removed (frequencies, wind, QNH / altimeter). */
export function heardTokens(transcript: string): string[] {
  const w: string[] = [];
  for (const x0 of sttWords(transcript)) {
    const m = x0.match(/^(\d{1,2})([lrc])$/);          // "25r" -> "25 right"
    if (m) { w.push(m[1], SIDE[m[2]]); continue; }
    for (const x of x0.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)) {   // "ground121", "107fly"
      if (x === 's') continue;                                        // "7's 7-1": a possessive the recogniser invented
      w.push(HEARD_FIX[x] ?? x);
    }
  }
  for (let i = 1; i < w.length - 1; i++) if (DIGIT_HOMOPHONE[w[i]] && isDigitWord(w[i - 1]) && isDigitWord(w[i + 1])) w[i] = DIGIT_HOMOPHONE[w[i]];
  // recognisers split numbers ("4-9-8", "2:18", "9 78"): adjacent numeric tokens are one number
  const t: string[] = [];
  for (const x of wordsToDigits(w)) { if (isNum(x) && t.length && isNum(t[t.length - 1])) t[t.length - 1] += x; else t.push(x); }
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (/\./.test(x)) continue;                                                            // 118.5
    if (isNum(x) && (t[i + 1] === 'decimal' || t[i + 1] === 'point') && isNum(t[i + 2] ?? '')) { i += 2; continue; }
    if ((x === 'qnh' || x === 'altimeter') && isNum(t[i + 1] ?? '')) { i += 1; continue; }
    if (x === 'wind' && isNum(t[i + 1] ?? '')) {
      i += 1; while (i + 1 < t.length && ['degrees', 'at', 'knots', 'gusting', 'gust', 'variable'].includes(t[i + 1]) || (i + 1 < t.length && isNum(t[i + 1]))) i++;
      continue;
    }
    out.push(x);
  }
  return out;
}

// ---------- round trip ----------
// not evidence either way: glue words, and the optional words controllers (and ml/data/augment.py) drop
const STOP = new Set(('the a an and to of for please your you is that so okay ok uh um er ah then on at in with be by it ' +
  'runway degrees knots feet fly proceed approved maintain').split(' '));
const OPPOSITE: [string, string][] = [['left', 'right'], ['land', 'takeoff']];

function near(a: string, b: string): boolean {   // equal, or one edit apart for words of 5+ letters ("speedboard" ~ "speedbird" is 2: no)
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}
/** Longest common subsequence length of two token lists. */
function lcs(a: string[], b: string[], eq: (x: string, y: string) => boolean): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0), cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = eq(a[i - 1], b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
function lcsub(a: string, b: string): number {   // longest common substring length
  let best = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++; if (k > best) best = k; }
  return best;
}

/** How well a callsign matches the heard words: flight-number digits (0..1) and airline-name words (0..1). */
export function callsignMatch(cs: string, words: string[]): { num: number; name: number } {
  const m = cs.match(/^([A-Z]{2,3})(\d+)([A-Z]{0,2})$/);
  const digits = m ? m[2] : cs.replace(/\D/g, '');
  const nums = words.filter(isNum);
  let num = 0;
  if (digits) for (const n of nums) {
    const v = n === digits ? 1 : n.startsWith(digits) || n.endsWith(digits) ? 0.9 : n.includes(digits) ? 0.75 : 0.5 * lcsub(n, digits) / digits.length;
    if (v > num) num = v;
  }
  const tel = m ? AIRLINE_TELEPHONY[m[1]] : undefined;
  const nameWords = tel ? sttWords(tel) : (m ? m[1].toLowerCase().split('') : []);
  let name = 0;
  if (nameWords.length) {
    if (tel) name = nameWords.filter(w => words.some(x => near(x, w))).length / nameWords.length;
    else { const joined = words.join(' '); name = joined.includes(nameWords.join(' ')) || words.includes(m![1].toLowerCase()) ? 1 : 0; }
  }
  return { num, name };
}

function phraseCtx(variant: PhraseVariant, magVar: number, transitionAltFt: number): PhraseCtx {
  const tel = (cs: string) => { const m = cs.match(/^([A-Z]{3})(\d+[A-Z]{0,2})$/); const t = m && AIRLINE_TELEPHONY[m[1]]; return t ? `${t} ${m![2]}` : cs; };
  return { variant, telephony: tel, unit: () => '', freq: () => '', wind: null, qnh: null, atisLetter: null, magVar, transitionAltFt, time: 0, aircraft: null, spokenType: (x: string) => x };
}

/** Words whose choice depends on the aircraft's current state, which the render does not know (climb vs descend,
 *  reduce vs increase speed): neutral in the alignment; climb/descend is checked against the known altitude instead. */
const STATE_VERBS = new Set(['climb', 'descend', 'maintain', 'reduce', 'increase']);

/** The spoken forms of a command (ICAO / FAA wording, flight levels or feet), normalised like a transcript, callsign
 *  part removed. The transition altitude is not in the parse context, so both a high and a low one are rendered. */
export function spokenForms(ast: CommandAST, magVar = 0): string[][] {
  const out: string[][] = [];
  for (const v of ['ICAO', 'FAA'] as PhraseVariant[]) for (const ta of [18000, 3000]) {
    let s = '';
    try { s = transmission(ast, phraseCtx(v, magVar, ta)); } catch { /* no phrase for this kind */ }
    if (!s) continue;
    const i = s.indexOf(',');
    const toks = normTokens(i >= 0 ? s.slice(i + 1) : s).filter(w => !STATE_VERBS.has(w)).map(w => (w === 'centre' ? 'center' : w));
    if (toks.length && !out.some(o => o.join(' ') === toks.join(' '))) out.push(toks);
  }
  return out;
}

function altitudesOf(ast: CommandAST): number[] {
  const out: number[] = [];
  JSON.stringify(ast, (k, v) => { if (k === 'ft' && typeof v === 'number') out.push(v); return v; });
  return out;
}

export interface RoundTrip {
  csNum: number; csName: number;   // the proposed aircraft's flight number / airline name in what was heard (0..1)
  csOther: number;                 // best other aircraft's match minus the proposed one's (> 0: someone else fits better)
  numRecall: number;               // share of the instruction's numbers that were heard
  numExtra: number;                // heard digits that neither the callsign nor the instruction explains (0..2, 3 digits = 1)
  kwRecall: number;                // share of the instruction's words that were heard (in order, counted)
  conflict: number;                // heard "left" but the line says right; "descend" to a level above the aircraft (0/1)
  cover: number;                   // share of the heard content (words + numbers, in order) the proposal accounts for
  seq: number;                     // share of the proposal's spoken content that was heard, in order
  kwMiss: number;                  // words of the proposal that were not heard (0..3)
  heardMiss: number;               // heard content tokens the proposal does not account for (0..4)
  sideMiss: number;                // left / right / center heard but absent from the command (0..2)
  rendered: number;                // 1 when the engine could render the command to words
}

const csScore = (m: { num: number; name: number }) => 0.6 * m.num + 0.4 * m.name;

/** Align the proposed command, rendered back to words, with the transcript. */
export function roundTrip(transcript: string, ast: CommandAST, ctx: ParseCtx, magVar = 0): RoundTrip {
  const heard = heardTokens(transcript);
  const cs = 'callsign' in ast && ast.callsign ? ast.callsign : '';
  const mine = cs ? callsignMatch(cs, heard) : { num: 0, name: 0 };
  let other = 0;
  for (const a of ctx.aircraft ?? []) if (a.callsign !== cs) other = Math.max(other, csScore(callsignMatch(a.callsign, heard)));
  const csDigits = cs.replace(/^[A-Z]+/, '').replace(/\D/g, '');
  const telWords = new Set(cs ? sttWords(AIRLINE_TELEPHONY[cs.slice(0, 3)] ?? '') : []);
  const heardSet = new Set(heard);
  // the content of what was heard, callsign taken out ("86029 right" -> the flight number 860 + "29 right")
  let csSeen = false;
  const content: string[] = [];
  for (const w of heard) {
    if (STOP.has(w) || STATE_VERBS.has(w) || telWords.has(w)) continue;
    if (csDigits && !csSeen && isNum(w) && w.startsWith(csDigits)) { csSeen = true; if (w.length > csDigits.length) content.push(w.slice(csDigits.length)); continue; }
    content.push(w);
  }
  const heardNums = content.filter(isNum);
  // digits as one stream, adjacent numeric tokens joined ("2 5 right" heard as "2", "5"): a fallback for numbers >= 2 digits
  const stream = content.map(w => (isNum(w) ? w : '|')).join('').replace(/\|+/g, '|');
  const forms = spokenForms(ast, magVar);
  // climb vs descend: the verb that fits the aircraft's known altitude, against the verb that was heard
  const self = (ctx.aircraft ?? []).find(a => a.callsign === cs);
  const alts = altitudesOf(ast);
  let verbConflict = 0;
  if (self?.altitude != null && alts.length) {
    const want = alts[0] > self.altitude + 50 ? 'climb' : alts[0] < self.altitude - 50 ? 'descend' : '';
    const other = want === 'climb' ? 'descend' : want === 'descend' ? 'climb' : '';
    if (other && heardSet.has(other) && !heardSet.has(want)) verbConflict = 1;
  }
  const same = (a: string, b: string) => (isNum(a) || isNum(b) ? a === b : near(a, b));
  let best: RoundTrip | null = null, bestKey = -Infinity;
  for (const form of forms.length ? forms : [[] as string[]]) {
    const f = form.filter(w => !STOP.has(w));
    const nums = f.filter(isNum), words = f.filter(w => !isNum(w));
    // numbers: each one said back must be heard (as itself, or inside a run the recogniser merged: "2602")
    const used = new Array(heardNums.length).fill(false);
    let hit = 0;
    for (const n of nums) {
      let k = heardNums.findIndex((h, q) => !used[q] && h === n);
      if (k < 0) k = heardNums.findIndex((h, q) => !used[q] && n.length >= 2 && h.includes(n));
      if (k >= 0) { used[k] = true; hit++; } else if (n.length >= 2 && stream.includes(n)) hit++;
    }
    const numRecall = nums.length ? hit / nums.length : 1;
    // heard digits nobody accounts for
    let left = 0;
    for (const h of heardNums) {
      let rest = h;
      for (const n of [...nums].sort((a, b) => b.length - a.length)) { const k = rest.indexOf(n); if (k >= 0) rest = rest.slice(0, k) + rest.slice(k + n.length); else if (rest && n.includes(rest)) rest = ''; }
      left += rest.length;
    }
    const extra = Math.min(left, 6) / 3;
    // words, in order and counted (a taxi route "echo echo foxtrot" is not "echo foxtrot"): longest common subsequence
    const hw = content.filter(w => !isNum(w));
    const wl = lcs(words, hw, same);
    const kwRecall = words.length ? wl / words.length : 1;
    const both = lcs(f, content, same);
    const cover = content.length ? both / content.length : 1;
    const seq = f.length ? both / f.length : 1;
    const fset = new Set(f);
    const conflict = verbConflict || OPPOSITE.some(([x, y]) => (heardSet.has(x) && !heardSet.has(y) && fset.has(y) && !fset.has(x)) || (heardSet.has(y) && !heardSet.has(x) && fset.has(x) && !fset.has(y))) ? 1 : 0;
    // a runway side that was heard but is not in the command ("hold short of runway 24L" -> "Hold short 24")
    const sideMiss = ['left', 'right', 'center'].filter(x => heardSet.has(x) && !fset.has(x)).length;
    const r: RoundTrip = { csNum: mine.num, csName: mine.name, csOther: other - csScore(mine), numRecall, numExtra: extra, kwRecall, conflict, cover, seq,
      kwMiss: Math.min(words.length - wl, 3), heardMiss: Math.min(content.length - both, 4), sideMiss: Math.min(sideMiss, 2), rendered: forms.length ? 1 : 0 };
    const key = numRecall + kwRecall + cover + seq - conflict - extra;
    if (key > bestKey) { best = r; bestKey = key; }
  }
  return best!;
}

/** A fixed, hand-weighted agreement score from the round trip alone (no learning): candidate (c) of the comparison. */
export function roundTripScore(r: RoundTrip): number {
  return 0.35 * csScore({ num: r.csNum, name: r.csName }) + 0.35 * r.numRecall + 0.1 * r.kwRecall + 0.1 * r.cover + 0.1 * r.seq
    - 0.25 * r.conflict - 0.075 * r.numExtra - 0.3 * Math.max(r.csOther, 0) - 0.15 * r.sideMiss;
}

// ---------- the learned gate ----------
/** Per-token signals from the S1 decoder (s1.ts Completion.signals; same definitions as ml/verify/gen.py). */
export interface GenSignals {
  csMargin: number; pSay: number; csMinFull: number; insMinP: number; insLp: number; insMinMargin: number;
  digMinP: number; digMargin: number; rwyMinP: number; eosP: number; nTok: number;
  /** The callsign search (s1.ts decodeScored): log-likelihood of the chosen callsign and its margin over the runner-up.
   *  Absent from older workers, NaN in 'trie' mode: then the full gate cannot score and the basic one decides. */
  csLh?: number; csLhMargin?: number;
}

export interface VerifierModel {
  name: string; features: string[]; mean: number[]; std: number[];
  /** Logistic regression: P = sigmoid(b + w . z), z the standardised features. */
  w: number[]; b: number;
  /** Or one hidden ReLU layer: P = sigmoid(b2 + w2 . relu(w1 z + b1)) (w1 is hidden x features). */
  hidden?: { w1: number[][]; b1: number[]; w2: number[]; b2: number };
  /** P(correct) >= send: sent; >= sayAgain: the player checks it; below: "say again". */
  thresholds: { send: number; sayAgain: number };
  fitted?: Record<string, unknown>;
}

const lg = (p: number) => Math.log(Math.max(p, 1e-6));
const clip = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** The feature vector by name (the names fit.py uses). Missing generator signals -> null (use the basic model). */
export function featureMap(conf: number, rt: RoundTrip, g: GenSignals | null | undefined): Record<string, number> {
  const f: Record<string, number> = {
    log_conf: lg(conf), rt_cs_num: rt.csNum, rt_cs_name: rt.csName, rt_cs_other: rt.csOther, rt_num_recall: rt.numRecall, rt_num_extra: rt.numExtra,
    rt_kw_recall: rt.kwRecall, rt_conflict: rt.conflict, rt_cover: rt.cover, rt_seq: rt.seq, rt_kw_miss: rt.kwMiss, rt_heard_miss: rt.heardMiss, rt_side_miss: rt.sideMiss, rt_rendered: rt.rendered,
    rt_cs_other_pos: Math.max(rt.csOther, 0), rt_cs_tie: rt.csOther > -0.05 ? 1 : 0, rt_num_full: rt.numRecall >= 1 ? 1 : 0, rt_cs_full: rt.csNum >= 0.9 ? 1 : 0,
  };
  if (g) Object.assign(f, {
    cs_margin: clip(g.csMargin, -5, 20), log_p_say: lg(g.pSay), log_cs_min_full: lg(g.csMinFull), log_ins_min_p: lg(g.insMinP), ins_lp: clip(g.insLp, -30, 0),
    ins_min_margin: clip(g.insMinMargin, -5, 20), log_dig_min_p: lg(g.digMinP), dig_margin: clip(g.digMargin, -5, 20), log_rwy_min_p: lg(g.rwyMinP), log_eos_p: lg(g.eosP),
  });
  // NaN / missing stays NaN, so verifierScore() returns null for a gate that uses them (ml/verify/fit.py LH_CAP = s1.ts marginCapNorm)
  if (g) Object.assign(f, { cs_lh_margin: clip(g.csLhMargin ?? NaN, -2, 2), cs_lh: clip(g.csLh ?? NaN, -30, 0) });
  return f;
}

/** Standardised features are clipped (same in ml/verify/fit.py): a value far outside the training range cannot dominate. */
const ZCLIP = 5;
export function verifierScore(m: VerifierModel, f: Record<string, number>): number | null {
  const x: number[] = [];
  for (let i = 0; i < m.features.length; i++) {
    const v = f[m.features[i]];
    if (v === undefined || !Number.isFinite(v)) return null;
    x.push(clip((v - m.mean[i]) / m.std[i], -ZCLIP, ZCLIP));
  }
  let z: number;
  if (m.hidden) {
    const { w1, b1, w2, b2 } = m.hidden; z = b2;
    for (let h = 0; h < w1.length; h++) { let a = b1[h]; for (let i = 0; i < x.length; i++) a += w1[h][i] * x[i]; if (a > 0) z += w2[h] * a; }
  } else { z = m.b; for (let i = 0; i < x.length; i++) z += m.w[i] * x[i]; }
  return 1 / (1 + Math.exp(-z));
}

/**
 * Disagreements that are near-certain errors on the training-session data (ml/verify/RESULTS.md, veto rules), whatever
 * the score: a runway side heard but missing, left heard but right proposed, another aircraft fitting the words better,
 * or a number nobody said while a heard number is left unexplained. A vetoed proposal is never sent on its own.
 */
export function vetoOf(rt: RoundTrip): string | null {
  if (rt.sideMiss > 0) return 'a runway side that was heard is missing';
  if (rt.conflict > 0) return 'a direction does not match what was heard';
  if (rt.csOther > 0) return 'another aircraft matches what was heard better';
  if (rt.numRecall < 1 && rt.numExtra > 0) return 'a number does not match what was heard';
  return null;
}

/**
 * The instruction must be one that was said: a heading, altitude or speed proposal whose kind has no keyword in the
 * transcript ("increase speed 2230-230" -> "Fly heading 230") is never sent on its own. Recognisers drop or mangle the
 * digits far more often than these words, so a missing keyword means the model guessed the instruction.
 */
const KIND_WORDS: Record<string, RegExp> = {
  heading: /\b(heading|hdg|turn|vector|vectors|degrees)\b/,
  altitude: /\b(climb|climbing|descend|descent|descending|maintain|flight level|level|fl|altitude|thousand|feet|ft)\b/,
  speed: /\b(speed|knots|knot|kts|kt|mach|faster|slower)\b/,
};
export function kindVeto(transcript: string, ast: CommandAST): string | null {
  const parts = ast.kind === 'sequence' ? ast.parts : [ast];
  const t = ` ${transcript.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  for (const p of parts) {
    const re = KIND_WORDS[p.kind];
    if (re && !re.test(t)) return `“${p.kind}” was not heard`;
  }
  return null;
}

export type Gate = 'send' | 'check' | 'sayAgain';
export const gateOf = (p: number, t: VerifierModel['thresholds']): Gate => (p >= t.send ? 'send' : p >= t.sayAgain ? 'check' : 'sayAgain');
