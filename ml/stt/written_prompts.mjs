// Adds `written` to each gold prompt (public/voice/gold-prompts.json): the controller line with real numbers, for the
// pages to show ("Qantas one seven seven ... runway one six right" -> "Qantas 177 ... runway 16R"). `said` stays the
// spoken reference the scorers use. Run: node ml/stt/written_prompts.mjs
import fs from 'node:fs';

const DIG = { zero: '0', one: '1', two: '2', three: '3', tree: '3', four: '4', fower: '4', five: '5', fife: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };
const TEEN = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
const SIDE = { left: 'L', right: 'R', centre: 'C', center: 'C' };

/** digits for one number word ("niner" 9, "eighteen" 18, "fifty" 50, "twenty-two" 22), else null */
function num(w) {
  if (DIG[w]) return DIG[w];
  if (TEEN[w]) return TEEN[w];
  const m = w.match(/^([a-z]+)(?:-([a-z]+))?$/);
  if (m && TENS[m[1]] && (!m[2] || DIG[m[2]])) return TENS[m[1]] + (m[2] ? DIG[m[2]] : '0');
  return null;
}

export function written(said) {
  const toks = said.split(/\s+/).filter(Boolean).map((t) => { const m = t.match(/^(.*?)([,.]*)$/); return { w: m[1], low: m[1].toLowerCase(), p: m[2] }; });
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (num(toks[i].low) == null || (toks[i].low === 'one' && toks[i + 1]?.low === 'minute')) { out.push(toks[i].w + toks[i].p); continue; }
    // a run of number words, ending at punctuation or the first word that is not part of a number
    let s = '', thousands = false, j = i - 1;
    for (let k = i; k < toks.length; k++) {
      const t = toks[k];
      const d = num(t.low);
      if (d != null) s += d;
      else if (t.low === 'thousand' && s && !s.includes('.')) { s = String(Number(s) * 1000); thousands = true; }
      else if ((t.low === 'decimal' || t.low === 'point') && s && !s.includes('.') && !toks[k - 1].p && num(toks[k + 1]?.low ?? '') != null) s += '.';
      else break;
      j = k;
      if (t.p) break;
    }
    let end = toks[j].p;
    if (thousands) s = Number(s).toLocaleString('en-US');
    // runway two seven left -> runway 27L
    if (toks[i - 1]?.low === 'runway' && !end && SIDE[toks[j + 1]?.low]) { j++; s += SIDE[toks[j].low]; end = toks[j].p; }
    out.push(s + end);
    i = j;
  }
  return out.join(' ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = new URL('../../public/voice/gold-prompts.json', import.meta.url);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.prompts = doc.prompts.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'written')
    .flatMap(([k, v]) => k === 'said' && v ? [[k, v], ['written', written(v)]] : [[k, v]])));
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  for (const p of doc.prompts) if (p.said) console.log(p.written);
}
