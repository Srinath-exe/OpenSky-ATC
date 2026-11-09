/* Adds the neural voice's input to every exported pilot line (ml/tts/lines.ts): {..., spoken, voice} where spoken is
   speakableAtc(text, variant) (src/lib/tts/pilotSpeech.ts, what the game sends to the TTS worker) and voice is
   voiceFor(callsign). Reads ml/tts/data/lines_*.jsonl, writes ml/tts/data/lines_all.jsonl. Run: ml/tts/lines.sh normalize */
import * as fs from 'node:fs';
import { speakableAtc, splitSentences, voiceFor } from '../../src/lib/tts/pilotSpeech';

const dir = 'ml/tts/data';
const rows = fs.readdirSync(dir).filter(f => /^lines_.*\.jsonl$/.test(f) && f !== 'lines_all.jsonl').sort()
  .flatMap(f => fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
const out = rows.map((r, i) => {
  const spoken = speakableAtc(r.text, r.variant);
  return { ...r, id: i, spoken, sentences: splitSentences(spoken), voice: voiceFor(r.cs) };
});
fs.writeFileSync(`${dir}/lines_all.jsonl`, out.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${out.length} lines -> ${dir}/lines_all.jsonl`);
