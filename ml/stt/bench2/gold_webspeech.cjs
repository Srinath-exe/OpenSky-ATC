// The browser transcript (Web Speech, captured live while the owner recorded) of each gold clip, as a results file
// for score.ts: { wav, heard, alts, ms }.   node ml/stt/bench2/gold_webspeech.cjs ml/data/gold out.jsonl
const fs = require('fs');
const { loadClips } = require('./clips.cjs');
const [dir, out] = process.argv.slice(2);
const rows = loadClips(dir).filter((c) => typeof c.browserTranscript === 'string').map((c) => {
  const alts = [...new Set([c.browserTranscript, ...(Array.isArray(c.browserAlternatives) ? c.browserAlternatives : [])].filter((x) => typeof x === 'string' && x.trim()))];
  return { wav: c.wav, heard: c.browserTranscript || '', alts, ms: 0 };
});
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.error(`${rows.length} clips with a browser transcript`);
