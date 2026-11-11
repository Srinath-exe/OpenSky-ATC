// ============================================================
//  Pilot speech text — what the neural pilot voice reads (ml/tts/RESULTS.md).
//
//  The radio log keeps the engine's own wording; this module turns a pilot line into what a pilot would actually
//  say, for a text-to-speech model that reads words, not codes:
//    callsign codes   "JBU248"       -> "JetBlue two four eight" (the engine's telephony, ICAO or FAA grouping)
//    flight levels    "FL350"        -> "flight level three five zero"
//    runways          "04L", "16R/34L", "runway 07" -> "zero four left", "one six right", "runway zero seven"
//    frequencies      "118.500"      -> "one one eight decimal five" (FAA "point"; trailing zeros dropped)
//    altitudes        "13000 ft"     -> "one three thousand", "4500" -> "four thousand five hundred"
//    other numbers    digit by digit, with ICAO "tree / fife / niner" when the variant is ICAO (phraseology.ts)
//    codes            fix names that read as words ("LAMBO") are lowercased so they are said as words; the rest
//                     ("ILS", "QNH", "JFKNE") stay capitals and are spelled
//  Pure: no DOM, no randomness. voiceFor() picks a pilot's voice from a hash of the callsign so an aircraft always
//  sounds the same.
// ============================================================
import { telephony, spokenDigits, spokenFrequency, spokenRunway } from '../sim/phraseology';
import { personaOf } from '../sim/persona';
import type { PhraseVariant } from '../sim/phraseology';

/** Paradee-8M v1.2 voices, in the model's order (config.json "voices"). */
export const PILOT_VOICES = ['af_heart', 'bf_isabella', 'am_puck', 'bm_fable'] as const;
export type PilotVoiceId = typeof PILOT_VOICES[number];

/** Airlines whose crews get a British or an American voice; every other airline gets either, by hash. */
const BRITISH = new Set(['BAW', 'VIR', 'EZY', 'EIN', 'RYR', 'SHT', 'TOM', 'EXS', 'LOG', 'BEE']);
const AMERICAN = new Set(['UAL', 'AAL', 'DAL', 'JBU', 'SWA', 'ASA', 'FDX', 'UPS', 'NKS', 'FFT', 'SKW', 'ENY', 'RPA']);

/** FNV-1a, 32 bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export interface PilotVoice {
  voice: PilotVoiceId;
  /** Model speaking rate (1 = the voice's normal pace). Pilots talk a little fast: 1.00-1.14. */
  speed: number;
  /** Playback detune in cents (-70..+70): a small pitch difference between crews on the same voice. */
  detune: number;
}

/** The same callsign always gets the same voice, rate and pitch. */
export function voiceFor(callsign: string): PilotVoice {
  const cs = (callsign || '').toUpperCase().trim();
  const h = hash32(cs);
  const prefix = cs.slice(0, 3);
  const british = BRITISH.has(prefix) ? true : AMERICAN.has(prefix) ? false : ((h >>> 1) & 1) === 1;
  const female = (h & 1) === 1;
  const voice: PilotVoiceId = british ? (female ? 'bf_isabella' : 'bm_fable') : (female ? 'af_heart' : 'am_puck');
  // the crew's character (sim/persona.ts) sets the pace too: a student or a crew new to the airport talks slower
  const speed = Math.round((1.0 + ((h >>> 8) % 1000) / 1000 * 0.14) * personaOf(callsign).rate * 1000) / 1000;
  const detune = ((h >>> 18) % 141) - 70;
  return { voice, speed, detune };
}

/** Acronyms said as words, or spelled in a way the G2P says right. Others in capitals are spelled letter by letter. */
const SAID: Record<string, string> = {
  ATIS: 'atis', NOTAM: 'notam', TCAS: 'tee cas', RNAV: 'R nav', SID: 'sid', STAR: 'star', ACAS: 'aycas',
  INTL: 'International', ARFF: 'A R F F', CAVOK: 'cav okay', VFR: 'V F R', IFR: 'I F R', TMA: 'T M A',
};
const ABBR: Record<string, string> = { Intl: 'International', Int: 'International', Apt: 'Airport', Rwy: 'runway', RWY: 'runway', Twr: 'Tower', App: 'Approach', Gnd: 'Ground', Dep: 'Departure' };
/** A capitals-only code that reads as a word: 4-6 letters, a vowel, never three consonants in a row ("LAMBO", "BUZAD").
 *  The game's generated beacons (airport code + compass point: "JFKNE", "SSYSW") are spelled. */
export function wordLike(code: string): boolean {
  if (code.length < 4 || code.length > 6 || !/[AEIOU]/.test(code) || /[^AEIOU]{3}/.test(code)) return false;
  return !/^[A-Z]{3}(N|S|E|W|NE|NW|SE|SW|NO|SO|EA|WE)$/.test(code);
}

function altitudeWords(ft: number, v: PhraseVariant): string {
  const th = Math.floor(ft / 1000), hu = Math.round((ft % 1000) / 100);
  const parts: string[] = [];
  if (th) parts.push(`${spokenDigits(String(th), v)} thousand`);
  if (hu) parts.push(`${spokenDigits(String(hu), v)} hundred`);
  return parts.join(' ') || 'zero';
}

/** Text -> words a pilot says. `variant` picks ICAO (tree / fife / niner, "decimal") or FAA wording. */
export function speakableAtc(text: string, variant: PhraseVariant = 'ICAO'): string {
  const v = variant;
  let s = ` ${text} `;
  s = s.replace(/[#*_~^|<>{}[\]\\]/g, ' ').replace(/&/g, ' and ').replace(/°/g, ' degrees ');
  s = s.replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1');                                      // "John F. Kennedy": no sentence break
  s = s.replace(/\b(Intl|Int|Apt|Rwy|RWY|Twr|App|Gnd|Dep)\b\.?/g, (m, w: string) => ABBR[w] ?? m);
  // callsign codes: three letters + flight number (+ optional letters), the engine's telephony (unknown airlines spelled)
  s = s.replace(/\b[A-Z]{3}\d{1,4}[A-Z]{0,2}\b/g, (m) => ` ${telephony(m, v)} `);
  s = s.replace(/\bFL\s?(\d{2,3})\b/g, (_, n: string) => ` flight level ${spokenDigits(n.padStart(3, '0'), v)} `);
  s = s.replace(/\b(\d{2}[LRC]?)\/(\d{2}[LRC]?)\b/g, '$1');                             // "16R/34L": the end in use
  s = s.replace(/\b(\d{1,2})([LRC])\b/g, (_, n: string, side: string) => ` ${spokenRunway(n + side, v)} `);
  s = s.replace(/\b(runway|localizer|localiser|ILS|LOC)\s+(\d{1,2})\b/gi, (_, w: string, n: string) => `${w} ${spokenRunway(n, v)}`);
  s = s.replace(/\b(1[1-3]\d)\.(\d{1,3})\b/g, (_, a: string, b: string) => ` ${spokenFrequency(`${a}.${b.replace(/(\d)0+$/, '$1')}`, v)} `);
  s = s.replace(/\b(\d+)\.(\d+)\b/g, (_, a: string, b: string) => ` ${spokenDigits(a, v)} ${v === 'FAA' ? 'point' : 'decimal'} ${spokenDigits(b, v)} `);
  s = s.replace(/\b(heading)\s+(\d{1,3})\b/gi, (_, w: string, n: string) => `${w} ${spokenDigits(n.padStart(3, '0'), v)}`);
  s = s.replace(/\b(squawk|QNH|altimeter|speed|stand|gate|course|radial|wind|code|transponder|information)\s+(\d+)\b/gi, (_, w: string, n: string) => `${w} ${spokenDigits(n, v)}`);
  s = s.replace(/\b(\d{1,2}),(\d{3})\b/g, '$1$2');                                     // "13,000"
  s = s.replace(/\b(\d{4,5})\s*(?:ft|feet)\b/g, (_, n: string) => ` ${altitudeWords(Number(n), v)} feet `);
  s = s.replace(/\b(\d{1,2}[1-9]00|\d{1,2}000)\b/g, (_, n: string) => ` ${altitudeWords(Number(n), v)} `);
  s = s.replace(/\b(\d+)\s*(kts?|KTS?)\b/g, (_, n: string) => ` ${spokenDigits(n, v)} knots `);
  s = s.replace(/\b(\d+)\s*NM\b/g, (_, n: string) => ` ${spokenDigits(n, v)} miles `);
  s = s.replace(/\b(\d+)\s*(?:ft)\b/g, (_, n: string) => ` ${spokenDigits(n, v)} feet `);
  s = s.replace(/\d+/g, (n) => ` ${spokenDigits(n, v)} `);
  s = s.replace(/\b(?:kts?|KTS?)\b/g, 'knots').replace(/\bft\b/g, 'feet').replace(/\bNM\b/g, 'miles');
  // capital codes: known ones as said, word-like fixes lowercased, the rest stay capitals (spelled by the G2P)
  s = s.replace(/\b[A-Z]{2,}\b/g, (w) => SAID[w] ?? (wordLike(w) ? w.toLowerCase() : w));
  s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[,.;:\s]+/, '');
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

/** One sentence per synthesis call (the model reads at most 510 phonemes): split at . ! ?, long ones at commas. */
export function splitSentences(text: string, maxChars = 220): string[] {
  const out: string[] = [];
  for (const sent of text.split(/(?<=[.!?])\s+/)) {
    let s = sent.trim();
    while (s.length > maxChars) {
      const cut = s.lastIndexOf(', ', maxChars);
      const at = cut > 20 ? cut + 1 : s.lastIndexOf(' ', maxChars);
      if (at <= 0) break;
      out.push(s.slice(0, at).trim().replace(/,$/, '.'));
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/** At most this many words in a line's first synthesis call when the line has a natural break (the callsign at its
 *  start, or an early comma): a call costs ~90 ms plus ~38 ms a word on one WASM thread, and the first one is what
 *  the player waits for; the rest is synthesised while it plays. */
export const FIRST_CHUNK_WORDS = 4;

const nWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** What one synthesis call reads: sentences, and a long sentence (more than `maxWords`) cut at its commas into clauses
 *  of at least `minWords`, so the first clause is heard while the rest is synthesised. Each piece keeps its comma.
 *  Then the first piece is cut short when it is longer than FIRST_CHUNK_WORDS and has a natural break: right after
 *  `lead` (the pilot's own callsign as spoken, e.g. "Lufthansa one fife tree") when the line starts with it, where a
 *  pilot pauses anyway (a comma is added), else at its first comma after 2 to FIRST_CHUNK_WORDS + 1 words. Both
 *  halves keep at least 2 words. */
export function speechChunks(text: string, maxWords = 7, minWords = 3, lead?: string): string[] {
  const out: string[] = [];
  for (const sent of splitSentences(text)) {
    const words = sent.split(/\s+/).length;
    if (words <= maxWords) { out.push(sent); continue; }
    const clauses = sent.split(/(?<=,)\s+/);
    let cur = '';
    for (const c of clauses) {
      cur = cur ? `${cur} ${c}` : c;
      if (cur.split(/\s+/).length >= minWords) { out.push(cur); cur = ''; }
    }
    if (cur) {
      if (out.length && cur.split(/\s+/).length < minWords) out[out.length - 1] = `${out[out.length - 1]} ${cur}`;
      else out.push(cur);
    }
  }
  if (out.length && nWords(out[0]) > FIRST_CHUNK_WORDS) out.splice(0, 1, ...splitFirst(out[0], lead));
  return out;
}

function splitFirst(piece: string, lead?: string): string[] {
  const words = piece.split(/\s+/);
  const cs = (lead ?? '').replace(/[.,;:!?]+$/, '').trim();
  if (cs) {
    const n = nWords(cs);
    const head = words.slice(0, n).join(' ').replace(/[,;:]$/, '');
    if (n >= 1 && n <= 6 && head.toLowerCase() === cs.toLowerCase() && words.length - n >= 2) {
      return [`${head},`, words.slice(n).join(' ')];
    }
  }
  for (let i = 1; i < Math.min(words.length - 2, FIRST_CHUNK_WORDS + 1); i++) {   // a comma after words[i]: i+1 words
    if (/,$/.test(words[i])) return [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')];
  }
  return [piece];
}
