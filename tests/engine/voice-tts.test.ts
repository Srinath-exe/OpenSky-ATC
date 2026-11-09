// Neural pilot voice text (src/lib/tts/pilotSpeech.ts) and browser G2P (public/voice/tts-g2p.js, ml/tts/RESULTS.md):
// the ATC normaliser turns the engine's codes into what a pilot says (consistent with phraseology.ts), sentences and
// clauses split where the worker needs them, every callsign keeps one voice, and the lexicon G2P gives misaki's
// phonemes for ATC words.  Run: ml/tts/test.sh
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { speakableAtc, splitSentences, speechChunks, voiceFor, wordLike, PILOT_VOICES } from '../../src/lib/tts/pilotSpeech';
import { readback, spokenRunway, spokenFrequency } from '../../src/lib/sim/phraseology';

test('callsign codes become the engine telephony, ICAO digits or FAA grouping', () => {
  assert.equal(speakableAtc('JBU248 holding short runway 04L', 'FAA'), 'JetBlue two forty-eight holding short runway zero four left.');
  assert.equal(speakableAtc('DLH153 holding short runway 27L', 'ICAO'), 'Lufthansa one fife tree holding short runway two seven left.');
  assert.equal(speakableAtc('BAW15 airborne runway 09R', 'ICAO'), 'Speedbird one fife airborne runway zero niner right.');
  assert.equal(speakableAtc('ZZZ12 rolling', 'ICAO'), 'Zulu Zulu Zulu one two rolling.');      // unknown airline: spelled, as telephony() does
});

test('runways, frequencies, flight levels, altitudes, headings and codes', () => {
  assert.equal(speakableAtc('DLH153 runway 16R/34L vacated', 'ICAO'), 'Lufthansa one fife tree runway one six right vacated.');
  assert.equal(speakableAtc('VIR527 contact Heathrow Tower 118.500', 'ICAO'), `Virgin fife two seven contact Heathrow Tower ${spokenFrequency('118.5', 'ICAO')}.`);
  assert.equal(speakableAtc('contact tower 118.500', 'FAA'), 'contact tower one one eight point five.');
  assert.equal(speakableAtc('contact 121.775', 'ICAO'), 'contact one two one decimal seven seven fife.');
  assert.equal(speakableAtc('climb FL350', 'ICAO'), 'climb flight level tree fife zero.');
  assert.equal(speakableAtc('climb FL 90', 'FAA'), 'climb flight level zero nine zero.');
  assert.equal(speakableAtc('passing 1800 climbing 13,000', 'FAA'), 'passing one thousand eight hundred climbing one three thousand.');
  assert.equal(speakableAtc('descend 4500 ft', 'FAA'), 'descend four thousand five hundred feet.');
  assert.equal(speakableAtc('squawk 7000', 'ICAO'), 'squawk seven zero zero zero.');
  assert.equal(speakableAtc('heading 90', 'ICAO'), 'heading zero niner zero.');
  assert.equal(speakableAtc('QNH 1013', 'ICAO'), 'QNH one zero one tree.');
  assert.equal(speakableAtc('established localizer 07', 'ICAO'), 'established localizer zero seven.');
  assert.equal(speakableAtc('speed 250 kts', 'FAA'), 'speed two five zero knots.');
  assert.equal(spokenRunway('27L', 'ICAO'), 'two seven left');   // the same helper the normaliser uses
});

test('names, fixes and acronyms', () => {
  assert.equal(speakableAtc('JBU248 contact John F. Kennedy Intl Tower 118.500', 'FAA'), 'JetBlue two forty-eight contact John F Kennedy International Tower one one eight point five.');
  assert.equal(speakableAtc('request direct LAMBO', 'ICAO'), 'request direct lambo.');   // word-like fix: said as a word
  assert.equal(speakableAtc('request direct JFKNE', 'ICAO'), 'request direct JFKNE.');   // generated beacon: stays capitals (spelled / lexicon)
  assert.equal(speakableAtc('direct EPM', 'ICAO'), 'direct EPM.');
  assert.equal(speakableAtc('handed off, leaving the TMA', 'ICAO'), 'handed off, leaving the T M A.');
  assert.equal(speakableAtc('stand Hotel one # two', 'ICAO'), 'stand Hotel one two.');
  assert.ok(wordLike('BUZAD') && wordLike('LAMBO') && !wordLike('JFKSE') && !wordLike('SSYSW') && !wordLike('CDGNW') && !wordLike('ILS'));
});

test('phraseology readbacks pass through unchanged, and no digit is left anywhere', () => {
  const lines = [
    'Descend flight level seven zero, Speedbird four zero.',
    'Cleared to land runway three one left, Lufthansa eight twenty.',
    'Heathrow Ground, Sky Dubai two niner fife, stand fife four fife Lima, request pushback, information Alpha.',
    'Departure one two fife decimal two zero zero, good day, Speedbird two four eight.',
  ];
  for (const l of lines) assert.equal(speakableAtc(l, 'ICAO'), l);
  const coded = ['AFR880 established localizer 31R', 'FDB295 runway 12R/30L vacated', 'UAE761 climbing FL120 heading 275 speed 250', 'Wind 270 at 15 kts, QNH 998'];
  for (const c of coded) for (const v of ['ICAO', 'FAA'] as const) assert.doesNotMatch(speakableAtc(c, v), /\d/, `${v}: ${c}`);
  // the engine's own readback for an AST is already words
  const ctx = { variant: 'ICAO', telephony: () => 'Speedbird one one seven', unit: () => 'Heathrow Tower', freq: () => '118.505', wind: null, qnh: 1013, atisLetter: 'A', magVar: 0, transitionAltFt: 6000, time: 0, aircraft: null, spokenType: () => 'Boeing 737' } as never;
  const rb = readback({ kind: 'altitude', callsign: 'BAW117', ft: 8000 } as never, ctx);
  assert.ok(rb.length > 0);
  assert.equal(speakableAtc(rb, 'ICAO'), rb);
});

test('sentences and clauses', () => {
  assert.deepEqual(splitSentences('John F Kennedy International Approach, Delta seventy-six. Request descent.'), ['John F Kennedy International Approach, Delta seventy-six.', 'Request descent.']);
  const s = 'Radar contact, altimeter three zero two one, ILS zero six left, Qantas eight eighty.';
  const c = speechChunks(s);
  assert.ok(c.length >= 2, JSON.stringify(c));
  assert.equal(c.join(' '), s);
  for (const x of c) assert.ok(x.split(' ').length >= 3, x);
  assert.deepEqual(speechChunks('Roger, standing by, Virgin fife one.'), ['Roger, standing by, Virgin fife one.']);   // short: one piece
  const long = Array.from({ length: 60 }, (_, i) => `word${i % 7}`).join(' ') + '.';
  for (const p of splitSentences(long)) assert.ok(p.length <= 220);
});

test('each callsign keeps one voice, rate and pitch; airlines and voices spread', () => {
  assert.deepEqual(voiceFor('BAW117'), voiceFor('baw117'));
  assert.deepEqual(voiceFor('DLH153'), voiceFor('DLH153'));
  for (const cs of ['BAW1', 'BAW117', 'VIR527', 'EZY97', 'EIN72']) assert.match(voiceFor(cs).voice, /^b/, cs);
  for (const cs of ['UAL76', 'AAL527', 'DAL108', 'JBU248', 'SWA542']) assert.match(voiceFor(cs).voice, /^a/, cs);
  const count: Record<string, number> = {};
  const airlines = ['DLH', 'AFR', 'UAE', 'QTR', 'SIA', 'QFA', 'KLM', 'FDB', 'IGO', 'JAL', 'ANA', 'CPA', 'THY', 'ETD'];
  for (let i = 0; i < 400; i++) {
    const v = voiceFor(`${airlines[i % airlines.length]}${100 + i * 7}`);
    count[v.voice] = (count[v.voice] ?? 0) + 1;
    assert.ok(v.speed >= 1.0 && v.speed <= 1.14, String(v.speed));
    assert.ok(v.detune >= -70 && v.detune <= 70, String(v.detune));
  }
  for (const v of PILOT_VOICES) assert.ok((count[v] ?? 0) >= 40, `${v}: ${count[v]}`);
});

// public/voice/tts-g2p.js is a browser ES module; load its source as a data: URL (the test build is CommonJS)
const esm = new Function('u', 'return import(u)') as (u: string) => Promise<{ AtcG2P: new (lex: unknown, load?: unknown) => { phonemize(t: string, british?: boolean): Promise<string>; stats: Record<string, number> }; toMisaki(ps: string, british?: boolean): string }>;
const ROOT = process.cwd();
const loadG2P = () => esm('data:text/javascript;base64,' + fs.readFileSync(path.join(ROOT, 'public/voice/tts-g2p.js')).toString('base64'));
const lexicon = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/tts/atc-lexicon-v1.json'), 'utf8'));

test('browser G2P: misaki phonemes for ATC words, both accents, without eSpeak', async () => {
  const { AtcG2P } = await loadG2P();
  const g = new AtcG2P(lexicon(), null);
  assert.equal(await g.phonemize('niner', false), 'nˈInəɹ');
  assert.equal(await g.phonemize('niner', true), 'nˈInə');
  assert.equal(await g.phonemize('Speedbird one one seven.', false), 'spˈidbɜɹd wˈʌn wˈʌn sˈɛvən.');
  assert.equal(await g.phonemize('flight level', false), 'flˈIt lˈɛvᵊl');
  assert.equal(await g.phonemize('runway two seven left', false), 'ɹˈʌnwˌA tˈu sˈɛvən lˈɛft');
  assert.equal(await g.phonemize('Lufthansa one fifty-three, start-up approved.', false), 'lʌfθˈænsə wˈʌn fˈɪftiθɹˌi, stˈɑɹtˌʌp əpɹˈuvd.');
  assert.equal(await g.phonemize('the end, the runway', false), 'ði ˈɛnd, ðə ɹˈʌnwˌA');
  assert.equal(await g.phonemize('direct BIG', false), 'dəɹˈɛkt bˈɪɡɪn');               // a fix says its spoken name (airspace file)
  assert.equal(await g.phonemize('QXZ', false), 'kjˌuˌɛkszˈi');                          // unknown capitals: misaki's letter names
  assert.equal(g.stats.espeak, 0);
});

test('browser G2P: an unknown word goes to the eSpeak loader once, and is dropped or spelled if it fails', async () => {
  const { AtcG2P, toMisaki } = await loadG2P();
  let loads = 0;
  const g = new AtcG2P(lexicon(), async () => { loads++; return async (t: string) => [t === 'zorblat' ? 'zˈɔːɹblæt' : 'ʔ']; });
  assert.equal(await g.phonemize('zorblat', false), toMisaki('zˈɔːɹblæt', false).replace(/\s+/g, ''));
  await g.phonemize('zorblat again', false);
  assert.equal(loads, 1);
  const bad = new AtcG2P(lexicon(), async () => { throw new Error('offline'); });
  assert.equal(await bad.phonemize('roger zorblat', false), 'ɹˈɑʤəɹ');
  assert.equal(toMisaki('aɪ oʊ eɪ', false), 'I O A');
});
