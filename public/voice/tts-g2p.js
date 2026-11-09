// Grapheme-to-phoneme for the neural pilot voice (public/voice/tts-worker.js; ml/tts/RESULTS.md).
// Paradee-8M only ever heard misaki's phonemes (Kokoro's Python G2P). In the browser:
//   1. a lexicon of misaki's own phonemes for the game's vocabulary, American and British
//      (/models/tts/atc-lexicon-v1.json, built by ml/tts/build_lexicon.py), including the fixes' spoken names;
//   2. capital codes not in it are spelled with misaki's letter names ("JFKSE");
//   3. any other word goes to eSpeak NG (the `phonemizer` package, what kokoro-js uses, loaded only then) and
//      through paradee's eSpeak-to-misaki table (toMisaki below).
// Works in a worker and in node (ml/tts/g2p_eval.mjs). No DOM.

// toMisaki: from github.com/sahilmahendrakar/paradee web/misaki.js (Apache-2.0, Sahil Mahendrakar), unchanged:
// misaki's own eSpeak-to-misaki table (misaki/espeak.py), for American and, with british set, British English.
const E2M = [
  ['ʔˌn̩', 'ʔn'], ['ʔn̩', 'ʔn'],
  ['aɪ', 'I'], ['aʊ', 'W'],
  ['dʒ', 'ʤ'],
  ['eɪ', 'A'], ['e', 'A'],
  ['tʃ', 'ʧ'],
  ['ɔɪ', 'Y'],
  ['ʲo', 'jo'], ['ʲə', 'jə'], ['ʲ', ''],
  ['ɚ', 'əɹ'],
  ['r', 'ɹ'],
  ['x', 'k'], ['ç', 'k'],
  ['ɬ', 'l'],
  ['̃', ''],
];

export function toMisaki(ps, british = false) {
  if (british) ps = ps.split('eə').join('ɛː');
  for (const [a, b] of E2M) ps = ps.split(a).join(b);
  ps = ps.replace(/(\S)̩/gu, 'ᵊ$1').replace(/̩/g, '');
  ps = ps.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, 'ᵊl');
  ps = british ? ps.replace(/ɐ(?!n?(?:[\s;:,.!?—…"“”()]|$))/gu, 'ə')
    : ps.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, 'ə');
  if (british) {
    ps = ps.split('iə').join('ɪə').split('əʊ').join('Q');
    ps = ps.replace(/(^|\s)ðɪ(?=\s|$)/gu, '$1ði');
  } else {
    ps = ps.split('oʊ').join('O')
      .split('ɜːɹ').join('ɜɹ').split('ɜː').join('ɜɹ')
      .split('ɪə').join('iə')
      .split('ː').join('');
  }
  ps = ps.split('o').join('ɔ');
  return ps.split('ɾ').join('T').split('ʔ').join('t');
}

const PUNCT = ';:,.!?—…"“”()';
const TOKEN = /([A-Za-z][A-Za-z'’-]*)|([;:,.!?—…"“”()])|(\s+)|([^\sA-Za-z;:,.!?—…"“”()]+)/g;
const VOWEL_START = /^[ˈˌ]?[aeiouæɑɐɒɔəɛɜɪʊʌAIOWYQᵊ]/;

/** eSpeak (phonemizer.js) on a whole sentence the way kokoro-js does it: text between punctuation, punctuation kept. */
export async function espeakSentence(text, british, phonemize) {
  const lang = british ? 'en' : 'en-us';
  const parts = text.split(/([;:,.!?—…"“”()]+\s*)/);
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (/^[;:,.!?—…"“”()]+\s*$/.test(p)) { out += p; continue; }
    out += (await phonemize(p, lang)).join(' ');
  }
  return toMisaki(out.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l'), british).trim();
}

export class AtcG2P {
  /** lexicon: atc-lexicon-v1.json; loadEspeak: async () => phonemize(text, lang) or null (called once, on the first unknown word). */
  constructor(lexicon, loadEspeak = null) {
    this.lex = lexicon;
    this.loadEspeak = loadEspeak;
    this.espeak = null;
    this.espeakFailed = false;
    this.stats = { words: 0, lexicon: 0, spelled: 0, espeak: 0, dropped: 0 };
  }

  spell(code, L) {
    const names = code.toUpperCase().split('').map((c) => L.letters[c] || '');
    return names.map((n, i) => (i < names.length - 1 ? n.replace(/ˈ/g, 'ˌ') : n)).join('');
  }

  lookup(word, L) {
    const w = L.words;
    if (w[word] != null) return w[word];
    const lo = word.toLowerCase();
    if (w[lo] != null) return w[lo];
    const cap = lo[0].toUpperCase() + lo.slice(1);
    if (w[cap] != null) return w[cap];
    if (word.includes('-')) {
      const parts = word.split('-').filter(Boolean).map((p) => this.lookup(p, L));
      if (parts.length && parts.every((p) => p != null)) return parts.join('');
    }
    return null;
  }

  async espeakWord(word, british) {
    if (!this.espeak && !this.espeakFailed && this.loadEspeak) {
      try { this.espeak = await this.loadEspeak(); } catch { this.espeakFailed = true; }
      if (!this.espeak) this.espeakFailed = true;
    }
    if (!this.espeak) return null;
    try { return toMisaki((await this.espeak(word, british ? 'en' : 'en-us')).join(' '), british).replace(/\s+/g, '') || null; } catch { return null; }
  }

  /** Text (already through the ATC normaliser) -> misaki-style phoneme string. */
  async phonemize(text, british = false) {
    const L = british ? this.lex.gb : this.lex.us;
    const toks = [];
    for (const m of text.replace(/’/g, "'").matchAll(TOKEN)) {
      if (m[3]) { if (toks.length) toks[toks.length - 1].ws = true; continue; }
      if (m[2]) { toks.push({ ps: m[2], ws: false, punct: true }); continue; }
      if (m[4]) continue;                                   // digits or symbols the normaliser left: not said
      const word = m[1].replace(/'+$/, '');
      this.stats.words++;
      let ps = null;
      if (word.toLowerCase() === 'the') ps = 'the';           // decided below from the next word
      else ps = this.lookup(word, L);
      if (ps != null) { if (ps !== 'the') this.stats.lexicon++; }
      else if (/^[A-Z]{2,6}$/.test(word)) { ps = this.spell(word, L); this.stats.spelled++; }
      else {
        ps = await this.espeakWord(word, british);
        if (ps) this.stats.espeak++;
        else if (word.length <= 4) { ps = this.spell(word, L); this.stats.spelled++; }
        else { this.stats.dropped++; continue; }
      }
      toks.push({ ps, ws: false, punct: false });
    }
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].ps !== 'the') continue;
      const next = toks.slice(i + 1).find((t) => !t.punct);
      toks[i].ps = next && VOWEL_START.test(next.ps) ? L.the.vowel : L.the.consonant;
      this.stats.lexicon++;
    }
    let out = '';
    for (const t of toks) out += t.ps + (t.ws ? ' ' : '');
    return out.trim();
  }
}

export const PUNCTUATION = PUNCT;
