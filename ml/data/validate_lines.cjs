// Keep only rows whose label parses with the game's own parser (lenient: callsigns from the row's traffic list).
//   node ml/data/validate_lines.cjs <in.json> <out.jsonl>     (needs .tmp/gold, built by ml/stt/score_gold.py / tsc)
const fs = require('fs');
const { parseCommand } = require('../../.tmp/gold/src/lib/sim/commands.js');
const [inp, out] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(inp, 'utf8'));
const fd = fs.openSync(out, 'w'); let ok = 0, bad = 0; const badEx = [];
for (const r of rows) {
  if (r.line !== 'SAY AGAIN') {
    const cs = r.ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => ({ callsign: l.split(' ')[0] }));
    const p = parseCommand(r.line, { aircraft: cs });
    if (!p.ok || !p.ast) { bad++; if (badEx.length < 8) badEx.push(r.line); continue; }
    const n = r.line.split(' ').length; void n;
  }
  const { key, split, heard, ...keep } = r; void key; void heard;
  fs.writeSync(fd, JSON.stringify({ ...keep, split }) + '\n'); ok++;
}
fs.closeSync(fd);
console.log(JSON.stringify({ ok, bad, badEx }));
