/*
  Transcript repair between the speech recogniser and the rules (ml/stt/RESULTS2.md "repair").

  Generic recognisers write ATC speech the way they write English: "Speedbird 2, 73, Climb 1, 3000.", "flight level
  9 or 0", "Quantas", "heading to one one", "73klim". This pass makes any engine's transcript readable by the parser
  (src/lib/sim/commands.ts) and the S1 model, using only what the game already knows: the aircraft on frequency.

    1. numbers in one spoken form: digits -> digit words ("2, 73" -> "two seven three", "3000" -> "three thousand"),
       ICAO pronunciations and homophones inside number runs ("niner", "tree", "one to six", "two for zero", "9 or 0")
    2. command words misheard as look-alikes ("klim" -> climb, "heating" -> heading), by phonetic key
    3. the callsign: the words before the first number run are compared with every aircraft's spoken name by
       phonetic key (a Metaphone-style code: "speedpert" and "speedbird" both -> SPTPRT), the number run with its
       flight number; a clear winner is written back as the aircraft's own name ("speedbird 273")

  A rewrite that had to change digits (or guess a missing flight number) is flagged `fuzzy`: the caller should let the
  player check the line instead of sending it. Pure module (no DOM), used in the game and by the benchmark.
*/

import { AIRLINE_TELEPHONY } from '../sim/phraseology';

export interface AsrAircraft { callsign: string; name: string }

export interface Repair {
  text: string;
  changed: boolean;
  /** Callsign the repair matched (null: none or ambiguous). */
  callsign: string | null;
  /** The match needed a digit change or had no flight number: worth a check before sending. */
  fuzzy: boolean;
  notes: string[];
}

/** The aircraft and the words a controller uses for them, from the voice context (src/lib/voice/context.ts). */
export function aircraftFromContext(ctx: string): AsrAircraft[] {
  return ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => {
    const m = l.match(/^(\S+) (.+?) (ARR|DEP) /);
    return { callsign: l.split(' ')[0], name: m ? m[2].toLowerCase() : l.split(' ')[0].toLowerCase() };
  });
}

// ---------- numbers ----------
const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const UNIT: Record<string, number> = Object.fromEntries(DIGIT.map((w, i) => [w, i]));
const TEEN: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** ICAO radiotelephony pronunciations and what recognisers make of them. */
const ICAO_NUM: Record<string, string> = { niner: 'nine', nina: 'nine', tree: 'three', fife: 'five', fower: 'four', wun: 'one', won: 'one', tousand: 'thousand', ate: 'eight', oh: 'zero' };
const isNumWord = (w: string | undefined) => !!w && (w in UNIT || w in TEEN || w in TENS || w === 'thousand' || w === 'hundred' || w === 'decimal' || w === 'point');

function spellNumber(t: string): string {
  const n = parseInt(t, 10);
  if (t.length >= 4 && n % 1000 === 0 && n < 100000) return `${spellDigits(String(n / 1000))} thousand`;
  if (t.length >= 4 && n % 100 === 0 && n < 100000) return `${spellDigits(String(Math.floor(n / 1000)))} thousand ${DIGIT[(n / 100) % 10]} hundred`;
  return spellDigits(t);
}
const spellDigits = (t: string) => t.split('').map((d) => DIGIT[+d]).join(' ');

/** The digit string of a spoken number run ("nine sixty three" -> "963", "one three thousand" -> "13000"). */
export function runDigits(words: string[]): string {
  // digit groups are concatenated ("nine sixty three" -> 963); "thousand" and "hundred" scale only the group before
  // them ("three thousand five hundred" -> 3500, "one three thousand" -> 13000)
  let out = '', total = 0, scaled = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in UNIT) out += UNIT[w];
    else if (w in TEEN) out += TEEN[w];
    else if (w in TENS) { const u = UNIT[words[i + 1]]; if (u !== undefined && u > 0) { out += TENS[w] + u; i++; } else out += TENS[w]; }
    else if (w === 'thousand') { total += parseInt(out || '1', 10) * 1000; out = ''; scaled = true; }
    else if (w === 'hundred') { total += parseInt(out || '1', 10) * 100; out = ''; scaled = true; }
  }
  return scaled ? String(total + (out ? parseInt(out, 10) : 0)) : out;
}

// ---------- phonetic key ----------
/** Metaphone-style code: spelling variants and voicing ("speedbird" / "speed pert", "qantas" / "quantas") collide. */
export function phoneticKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/mb$/, 'm')
    .replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/sh/g, 's').replace(/ch/g, 'k')
    .replace(/th/g, 't').replace(/wh/g, 'w').replace(/qu/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/dg/g, 'j')
    .replace(/z/g, 's').replace(/v/g, 'f').replace(/b/g, 'p').replace(/d/g, 't').replace(/g/g, 'k').replace(/j/g, 'k');
  const first = /[aeiouy]/.test(s[0]) ? 'a' : s[0];
  return (first + s.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
const sim = (a: string, b: string) => (!a || !b ? 0 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

// ---------- command words ----------
const VOCAB = ('climb descend maintain heading turn left right flight level altitude feet thousand hundred speed knots reduce increase ' +
  'expedite runway cleared clear land landing takeoff take off line up wait hold short position cross taxi via contact tower ground ' +
  'approach departure center centre monitor frequency decimal direct proceed ils localizer localiser intercept established report ' +
  'vacate vacated exit pushback push back start startup approved roger standby unable traffic negative affirm correction say again go ' +
  'around missed cancel continue expect squawk ident wind degrees qnh altimeter information behind follow give way gate stand after ' +
  'when ready immediate immediately then and the to for of at or above below until minimum minute minutes legs published holding as ' +
  'inbound outbound visual final mile miles behind caution wake turbulence good day fly on in your with now number turns').split(' ');
const VOCAB_SET = new Set(VOCAB);
/** Everyday words a controller says that sound like command words but are not misheard ones: never snapped onto
 *  the vocabulary ("cheers" is not "cross", "accept" is not "expedite", "field" is not "flight"). */
const KEEP = new Set(('cheers mate accept able field copy sight thanks thank please sorry okay yeah nice there where what whats how ' +
  'gear fuel souls persons people check problem anything something everything today tonight morning evening welcome hello ' +
  'weather ride level? bumpy smooth crew cabin passengers parked parking need want like could would should maybe sure').replace('level? ', '').split(' '));
const JUNK = new Set(['and', 'the', 'a', 'an', 'number', 'now', 'its', 'it', 'is', 'in', 'on', 'uh', 'um', 'er', 'ah', 'oh']);
const VOCAB_KEYS = new Map<string, string[]>();
for (const w of VOCAB) if (w.length >= 4 && phoneticKey(w).length >= 3) { const k = phoneticKey(w); VOCAB_KEYS.set(k, [...(VOCAB_KEYS.get(k) ?? []), w]); }
const PHONETIC = new Set('alpha alfa bravo charlie delta echo foxtrot golf hotel india juliet juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey whisky xray yankee zulu'.split(' '));
/** Spellings recognisers produce for ATC words that a phonetic key would not catch. */
const WORD_FIX: Record<string, string> = {
  decent: 'descend', descending: 'descend', ills: 'ils', qh: 'qnh', qnh: 'qnh', climbing: 'climb', clime: 'climb', klim: 'climb',
  heating: 'heading', hitting: 'heading', headed: 'heading', lineup: 'line up', holdshort: 'hold short',
  hole: 'hold', whole: 'hold', holed: 'hold', rodger: 'roger', standbye: 'standby', squak: 'squawk', localiser: 'localizer', 'stand-by': 'standby', niner: 'nine',
  write: 'right', rite: 'right', runaway: 'runway', 'run-way': 'runway', nots: 'knots', knot: 'knots', fl: 'flight level',
  // the browser's recogniser (Chrome, Indian English) on real controller speech
  wireless: 'ils', iris: 'ils', ranveer: 'runway', lakh: 'left', project: 'roger', approve: 'approved', decimals: 'decimal', notes: 'knots',
};
/** Multi-word mishearings and synonyms, on the normalised text: "hand off to tower" = contact tower. */
// Plain language -> the standard phrase (spec 12 §3.3): what a controller says when not reading the book. Each
// entry only rewrites wording around the values; numbers, callsigns, runways and fixes pass through untouched.
// Measured on ml/s1/freeword (own-words test set); every entry must keep tests/commands and the gold recordings green.
const FAC = '(tower|ground|approach|departure|delivery|control|center|director|radar)';
const NATO = '(?:alpha|alfa|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliett?|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|xray|x-ray|yankee|zulu)';
const PLAIN_WORDS: [RegExp, string][] = [
  [/\b(?:uh+|um+|er+|please|thanks|thank you|good day|bye(?: bye)?|cheers(?: mate)?|do you copy|how copy|over and out|over)\b/g, ''],
  // acknowledgements, wait, refusals
  [/\b(?:copy that|copied|okay understood|understood|roger that)\b/g, 'roger'],
  [/\b(?:hang on(?: a (?:moment|second|sec|minute))?|give me a (?:second|moment|minute|sec)|one moment|i ?ll call you back)\b/g, 'standby'],
  [/\b(?:cant do that(?: right now)?|cannot do that(?: right now)?|unable at the moment|negative(?= (?:due |unable|traffic)))\b/g, 'unable'],
  [/\bunable unable\b/g, 'unable'],
  [/\bdue (?:to )?traffic\b/g, 'traffic'],
  // levels and speeds
  [/\b(?:come down to|descend down to|go down to|drop down to)\b/g, 'descend'],
  [/\b(?:go up to|climb up to|climb on up to)\b/g, 'climb'],
  [/\b(?:slow(?: it)?(?: down)?(?: to)?|bring (?:the |your )?speed back to|reduce to)\b/g, 'reduce speed'],
  [/\b(?:speed up to|pick up (?:the |your )?speed to|increase to)\b/g, 'increase speed'],
  [/\b(?:descend faster|expedite (?:your |the )?descent|expedite down)\b/g, 'expedite descent'],
  [/\b(?:climb faster|expedite (?:your |the )?climb|expedite up)\b/g, 'expedite climb'],
  [/\bexpedite descent expedite\b/g, 'expedite descent'],
  // headings and routes
  [/\b(?:turn (?:on ?to|to)(?: a)? heading(?: of)?|come on ?to heading|make your heading|steer heading|fly a heading of|turn heading)\b/g, 'fly heading'],
  [/\b(?:route|go|proceed|fly) direct(?: to)?\b/g, 'direct'],
  [/\bdirect to\b/g, 'direct'],
  [/\benter the hold at\b/g, 'hold at'],
  [/\b(right|left) hand turns\b/g, '$1 turns'],
  // frequency changes
  [new RegExp(`\\b(?:switch to|over to|go to|call|talk to)(?: the)? ${FAC}\\b`, 'g'), 'contact $1'],
  [new RegExp(`\\bcontact the ${FAC}(?: now)?\\b`, 'g'), 'contact $1'],
  // ground
  [/\b(?:you can |you may )?(?:keep|carry on|continue) taxi(?:ing)?\b/g, 'continue taxi'],
  [/\b(?:stop where you are|hold your position)\b/g, 'hold position'],
  [/\btaxi out to\b/g, 'taxi to'],
  [new RegExp(`(?<!to )(?<!taxi )\\bstand (?=${NATO}\\b)`, 'g'), 'taxi to stand '],
  [new RegExp(`\\busing (?=${NATO}\\b)`, 'g'), 'via '],
  [new RegExp(`\\b(${NATO}(?: \\w+)?) and (?=${NATO}\\b)`, 'g'), '$1 '],
  [new RegExp(`\\btake (${NATO}(?: \\w+)?) to vacate\\b`, 'g'), 'vacate via $1'],
  [/\b(?:you can|you may|go ahead and) (cross|push ?back|start(?: up)?|taxi|line up)\b/g, '$1'],
  [/\bpush ?back(?= expect\b)/g, 'pushback approved'],
  [/\byou ?(?:re|are) good to start\b/g, 'start up approved'],
  [/\btell me when you ?(?:re|are) (?:clear|across|vacated)\b/g, 'report vacated'],
  // approach and runway
  [/\byou ?(?:re|are) (?:cleared|clear)\b/g, 'cleared'],
  [/\bclear(?:ed)? to go\b/g, ''],
  [/\bcleared takeoff\b/g, 'cleared for takeoff'],
  [/\bcleared for the ils\b/g, 'cleared ils'],
  [/\b(?:call me|report when) established\b/g, 'report established'],
  [/\b(?:plan on|you can expect|expect an?)(?: the)?\b/g, 'expect'],
  [/\b(?:i have you on radar|radar identified|identified)\b/g, 'radar contact'],
  [/\b(?:the )?wind is\b/g, 'wind'],
];
const PHRASE_FIX: [RegExp, string][] = [
  [/\b(?:hand ?offs?|hand of|hand over|handover)(?: to)?\b/g, 'contact'],
  [/\bshut up\b/g, 'start up'],
  ...PLAIN_WORDS,
];
const FACILITY = ['tower', 'ground', 'approach', 'departure', 'center', 'control', 'director', 'radar'];

// ---------- the pass ----------
const HALLUCINATION = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+)$/i;

/** Tokens of a transcript in lower case, numbers as digit words, punctuation gone (keeps 27L, fl350 -> flight level). */
export function normaliseTokens(raw: string): string[] {
  let s = raw.replace(/[’']/g, '').replace(/°/g, ' degrees ').toLowerCase();
  if (HALLUCINATION.test(s.trim())) return [];
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1')                     // 4,000 -> 4000
    .replace(/(\d)\s*[-:/]\s*(?=\d)/g, '$1 ')                     // 2-7-0, 2:73 -> 2 7 0, 2 73
    .replace(/\b(\d{1,2})\s*(l|r|c)\b(?=\W*$|\s)/g, '$1$2')       // "27 l" kept with its runway
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')                         // 73klim -> 73 klim
    .replace(/\bfl\s*(\d)/g, 'flight level $1')
    .replace(/([a-z])-([a-z])/g, '$1 $2')
    .replace(/(\d)\.(\d)/g, '$1 decimal $2')
    .replace(/[^a-z0-9\s]/g, ' ');
  const out: string[] = [];
  for (const t of s.split(/\s+/).filter(Boolean)) {
    if (/^\d+$/.test(t)) out.push(...spellNumber(t).split(' '));
    else if (/^\d{1,2}[lrc]$/.test(t)) { out.push(...spellDigits(t.slice(0, -1)).split(' '), ({ l: 'left', r: 'right', c: 'center' } as Record<string, string>)[t.slice(-1)]); }
    else out.push(t);
  }
  // single letters spelled out ("u p s", "k l m") -> one word
  for (let i = 0; i < out.length - 1; i++) {
    if (/^[a-z]$/.test(out[i]) && /^[a-z]$/.test(out[i + 1]) && out[i] !== 'a') {
      let j = i; let w = ''; while (j < out.length && /^[a-z]$/.test(out[j])) w += out[j++];
      if (w.length >= 2 && w.length <= 3) out.splice(i, j - i, w);
    }
  }
  return out;
}

const NUM_CONTEXT = new Set(['heading', 'runway', 'level', 'speed', 'squawk', 'altitude', 'frequency', 'decimal']);
// not speed: "reduce speed to 90" is the usual phrasing, a missing digit must not become 290
const DIGITS_FOR: Record<string, number> = { heading: 3, level: 3, squawk: 4, runway: 2 };

function fixNumbers(w: string[], notes: string[]): string[] {
  w = w.map((x, i) => {
    const m = ICAO_NUM[x];
    if (!m) return x;
    if (x === 'oh' && !(isNumWord(w[i - 1]) || isNumWord(w[i + 1]))) return x;
    if ((x === 'ate' || x === 'won') && !(isNumWord(w[i - 1]) || isNumWord(w[i + 1]) || ICAO_NUM[w[i + 1]])) return x;
    return m;
  });
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const x = w[i], prev = out[out.length - 1], next = w[i + 1];
    const numBefore = isNumWord(prev), numAfter = isNumWord(next) || (next !== undefined && next in ICAO_NUM);
    if ((x === 'to' || x === 'too' || x === 'for' || x === 'fore') && numAfter) {
      const digit = x === 'for' || x === 'fore' ? 'four' : 'two';
      if (numBefore && prev !== 'thousand' && prev !== 'hundred') { out.push(digit); notes.push(`${x}->${digit}`); continue; }
      // "heading to one one" = heading two one one: only when the run is then exactly as long as the field needs
      const need = DIGITS_FOR[prev ?? ''];
      if (need) { let j = i + 1; const run: string[] = []; while (isNumWord(w[j])) run.push(w[j++]); if (runDigits(run).length === need - 1) { out.push(digit); notes.push(`${prev} ${x}->${digit}`); continue; } }
    }
    if (x === 'or' && numBefore && numAfter) { notes.push('or dropped'); continue; }   // "9 or 0": niner zero
    out.push(x);
  }
  return out;
}

function fixWords(w: string[], from: number, protect: Set<string>, notes: string[]): string[] {
  return w.flatMap((x, i) => {
    if (i < from || isNumWord(x) || protect.has(x) || PHONETIC.has(x)) return [x];
    // "160 not" = 160 knots
    if ((x === 'not' || x === 'nut' || x === 'knot' || x === 'nots') && isNumWord(w[i - 1])) { notes.push(`${x}->knots`); return ['knots']; }
    // "descent" is a word of its own after expedite; elsewhere it is "descend" misheard
    if (x === 'descent' && !/^exp/.test(w[i - 1] ?? '')) { notes.push('descent->descend'); return ['descend']; }
    const f = WORD_FIX[x];
    if (f && f !== x) { notes.push(`${x}->${f}`); return f.split(' '); }
    if (x.length < 3 || VOCAB_SET.has(x) || KEEP.has(x)) return [x];
    // "contact cover" = contact tower: the one facility within two letters
    if (w[i - 1] === 'contact' && x.length >= 4) {
      const near = FACILITY.filter((f) => levenshtein(x, f) <= 2);
      if (near.length === 1) { notes.push(`${x}->${near[0]}`); return [near[0]]; }
    }
    // inflections of a command word: "holds" -> hold, "increased" -> increase, "climbed" -> climb
    for (const stem of [x.replace(/s$/, ''), x.replace(/d$/, ''), x.replace(/ed$/, ''), x.replace(/ing$/, '')]) {
      if (stem !== x && stem.length >= 3 && VOCAB_SET.has(stem)) { notes.push(`${x}->${stem}`); return [stem]; }
    }
    const key = phoneticKey(x);
    const hit = key.length >= 3 ? VOCAB_KEYS.get(key) : undefined;
    if (hit && hit.length === 1 && hit[0] !== x) { notes.push(`${x}->${hit[0]}`); return [hit[0]]; }
    return [x];
  });
}

interface Cand { a: AsrAircraft; tel: string; telKey: string; digits: string }

/** Repair a transcript against the aircraft on frequency. */
export function repairTranscript(raw: string, aircraft: AsrAircraft[]): Repair {
  const notes: string[] = [];
  let toks = normaliseTokens(raw);
  let joined = toks.join(' ');
  for (const [re, to] of PHRASE_FIX) joined = joined.replace(re, (m, ...g) => { const out = to.replace(/\$(\d)/g, (_, n: string) => (typeof g[Number(n) - 1] === 'string' ? g[Number(n) - 1] : '')); if (out.trim() !== m.trim()) notes.push(`${m}->${out}`); return out; }).replace(/\s+/g, ' ').trim();
  // a fix or beacon spelled with the phonetic alphabet after "direct" / "hold at": "direct bravo india golf" = direct big
  joined = joined.replace(/\b(direct|hold at|holding at|via)((?: (?:alpha|alfa|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|juliett|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|whisky|xray|yankee|zulu)){3,5})\b/g,
    (m, head: string, run: string) => { if (head === 'via') return m; const id = run.trim().split(' ').map((x) => x[0]).join(''); notes.push(`${run.trim()}->${id}`); return `${head} ${id}`; });
  if (joined !== toks.join(' ')) toks = joined.split(' ').filter(Boolean);
  let w = fixNumbers(toks, notes);
  const cands: Cand[] = aircraft.map((a) => {
    const parts = a.name.toLowerCase().split(/\s+/);
    const last = parts[parts.length - 1] ?? '';
    const hasNum = /\d/.test(last);
    const tel = (hasNum ? parts.slice(0, -1) : parts).join(' ');
    return { a, tel, telKey: phoneticKey(tel.replace(/\s+/g, '')), digits: (hasNum ? last : a.callsign).replace(/\D/g, '') };
  });
  const telWords = new Set(cands.flatMap((c) => c.tel.split(' ')).filter(Boolean));

  // the callsign: the last 0-3 words before the first number run (within the first 4 words), then that number run
  let callsign: string | null = null, fuzzy = false, spanEnd = 0;
  let k = 0; while (k < w.length && k < 4 && !isNumWord(w[k])) k++;
  // the number run after the name; a "." inside it is a separator here ("Delta 5.0" = five zero), not a decimal point
  let e = k; while (e < w.length && isNumWord(w[e]) && (k < 3 || (w[e] !== 'decimal' && w[e] !== 'point'))) e++;
  const heardDigits = k < 4 ? runDigits(w.slice(k, e).filter((x) => x !== 'decimal' && x !== 'point')) : '';
  type Hit = { c: Cand; L: number; total: number; num: number; name: number };
  const hits: Hit[] = [];
  // words before the number that can be the remnant of a clipped name ("number nine six" for "...bird nine six")
  const junkBefore = k > 0 && k <= 2 && w.slice(0, k).every((x) => JUNK.has(x) || (!VOCAB_SET.has(x) && !PHONETIC.has(x)));
  for (let L = 0; L <= Math.min(3, k); L++) {
    const span = w.slice(k - L, k);
    if (L === 0 && k > 0 && !junkBefore) continue;                     // digits alone count only at the start
    if (L > 0 && span.every((x) => VOCAB_SET.has(x) && !telWords.has(x))) continue;
    const key = phoneticKey(span.join(''));
    for (const c of cands) {
      let num = 0;
      if (heardDigits) {
        if (heardDigits === c.digits) num = 1;
        else if (heardDigits.length >= 2 && c.digits.endsWith(heardDigits)) num = 0.85;
        else if (heardDigits.length === c.digits.length + 1 && heardDigits.endsWith(c.digits)) num = 0.7;
        else if (heardDigits.length === c.digits.length && levenshtein(heardDigits, c.digits) === 1) num = 0.55;
        else if (c.digits.length >= 2 && heardDigits.length > c.digits.length && heardDigits.startsWith(c.digits) && L > 0) num = 0.9;   // "62312 left": 623 + runway 12
      }
      let name = 0;
      if (L > 0 && c.telKey) {
        name = sim(key, c.telKey);
        if (key.length >= 2 && c.telKey.endsWith(key)) name = Math.max(name, 0.8);   // the start was cut off
      }
      const total = L === 0 ? (k === 0 ? (num >= 0.85 ? num : 0) : num === 1 ? 0.8 : 0)
        : name < 0.5 ? 0 : heardDigits ? 0.45 * name + 0.55 * num : name >= 0.85 ? 0.75 * name : 0;
      if (total > 0) hits.push({ c, L, total, num, name });
    }
  }
  hits.sort((x, y) => y.total - x.total || y.L - x.L);
  const best = hits[0];
  const rival = best && hits.find((h) => h.c !== best.c);
  const sameTel = best ? cands.filter((c) => c.tel === best.c.tel).length : 0;
  if (best && best.total >= 0.72 && (!rival || best.total - rival.total >= 0.12) && !(!heardDigits && sameTel > 1)) {
    callsign = best.c.a.callsign;
    // a remnant before an exact, unique flight number ("Bieber 50", "number nine six") is as good as the number alone
    fuzzy = best.num < 0.9 || (best.L > 0 && best.name < 0.6) || (best.L === 0 && k > 0 && heardDigits.length < 2);
    let from = best.L === 0 ? 0 : k - best.L;
    const to = heardDigits ? e : k;
    // words left before the matched part of the name are the rest of the misheard name ("jack blue" -> "jetblue")
    if (best.L > 0 && from > 0 && from <= 2 && w.slice(0, from).every((x) => !VOCAB_SET.has(x) && !PHONETIC.has(x) && !isNumWord(x))) from = 0;
    // a number run longer than the flight number keeps its tail ("six two three one two left" -> name + "one two left")
    const rest = heardDigits && heardDigits.length > best.c.digits.length && heardDigits.startsWith(best.c.digits) ? spellDigits(heardDigits.slice(best.c.digits.length)).split(' ') : [];
    // the spoken name when the parser knows the airline's telephony, else the callsign itself ("hong kong express" -> HKE528)
    const m = best.c.a.callsign.match(/^([A-Z]{3})\d/);
    const known = !!m && (AIRLINE_TELEPHONY[m[1]] ?? '').toLowerCase() === best.c.tel && best.c.tel.split(' ').length <= 2;   // the parser reads 1-2 word names
    const plain = !best.c.tel || !known || best.c.a.name.replace(/\s+/g, '') === best.c.a.callsign.toLowerCase();
    const nameNow = (plain ? best.c.a.callsign : best.c.a.name).toLowerCase().split(/\s+/);
    const before = w.slice(from, to).join(' ');
    if (before !== nameNow.join(' ')) notes.push(`callsign "${before}" -> ${callsign}${fuzzy ? ' (check)' : ''}`);
    w = [...w.slice(0, from), ...nameNow, ...rest, ...w.slice(to)];
    spanEnd = from + nameNow.length;
  }
  w = fixWords(w, spanEnd, callsign ? new Set() : telWords, notes);
  w = applyCorrection(w, spanEnd, notes);
  w = dropCutOffValue(w, notes);
  const text = w.join(' ');
  return { text, changed: notes.length > 0 || text !== raw.trim().toLowerCase(), callsign, fuzzy, notes };
}

// ---------- corrections and cut-off values ----------
const VALUE_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety', 'hundred', 'thousand', 'flight', 'level', 'decimal', 'point', 'knots', 'degrees', 'feet', 'left', 'right', 'center']);
const isValue = (x: string) => VALUE_WORDS.has(x) || /^\d+$/.test(x);
const CORRECTION = /^(?:correction|sorry)$/;

/**
 * "descend four thousand correction five thousand" -> "descend five thousand"; "heading two seven zero correction
 * two eight zero" -> "heading two eight zero"; "climb flight level eight zero correction climb flight level nine zero"
 * -> "climb flight level nine zero". A correction that restates a whole instruction replaces the one before it
 * (from its first word that also occurs before); anything else is left to the parser.
 */
function applyCorrection(w: string[], start: number, notes: string[]): string[] {
  for (let guard = 0; guard < 3; guard++) {
    const i = w.findIndex((x, k) => k >= start && CORRECTION.test(x));
    if (i < 0) return w;
    let j = i + 1;
    while (j < w.length && (CORRECTION.test(w[j]) || w[j] === 'i' && w[j + 1] === 'say' && w[j + 2] === 'again')) j += w[j] === 'i' ? 3 : 1;
    const right = w.slice(j);
    if (!right.length) return w;
    let left = w.slice(0, i);
    if (isValue(right[0]) && !(right[0] === 'left' || right[0] === 'right')) {
      let k = left.length; while (k > start && isValue(left[k - 1]) && !(left[k - 1] === 'flight' && left[k] !== 'level')) k--;
      if (right[0] === 'flight' || !(left[k] === 'flight')) left = left.slice(0, k);
      else left = left.slice(0, k);
    } else {
      const at = left.lastIndexOf(right[0]);
      const dir = right[0] === 'left' || right[0] === 'right' ? Math.max(left.lastIndexOf('left'), left.lastIndexOf('right')) : -1;
      const cut = at >= start ? at : dir >= start ? dir : -1;
      if (cut < 0) return w;
      left = left.slice(0, cut);
    }
    const out = [...left, ...right];
    notes.push(`correction: ${w.slice(start).join(' ')} -> ${out.slice(start).join(' ')}`);
    w = out;
  }
  return w;
}

/** A heading or flight level cut off after one digit ("fly heading two") is not an instruction: drop the value, so the
 *  parser asks again instead of sending heading 002. */
function dropCutOffValue(w: string[], notes: string[]): string[] {
  const n = w.length;
  const single = (k: number) => k === n - 1 && /^(?:zero|one|two|three|four|five|six|seven|eight|nine)$/.test(w[k]);
  if (n >= 2 && w[n - 2] === 'heading' && single(n - 1) || n >= 3 && w[n - 3] === 'flight' && w[n - 2] === 'level' && single(n - 1)) {
    notes.push(`cut off: ${w.slice(-3).join(' ')}`);
    return w.slice(0, -1);
  }
  return w;
}
