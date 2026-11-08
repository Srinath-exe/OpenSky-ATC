// L0 scoring for transcripts: does the rules parser turn what was heard into the same command as the gold line?
//   node ml/stt/score_l0.cjs rows.json > out.json      rows: [{heard, line, ctx}]
// Both the transcript and the gold line are parsed with the same aircraft list, so the ASTs are comparable.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { parseCommand } = require(path.join(ROOT, '.tmp/ml/src/lib/sim/commands.js'));
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const norm = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? Math.round(v) % 360 : Math.round(v)) : v));
const out = rows.map((r) => {
  const aircraft = r.ctx.split('\n').slice(1).map((l) => ({ callsign: l.split(' ')[0] }));
  const g = parseCommand(r.line, { aircraft });
  const h = parseCommand(String(r.heard || '').replace(/[.!?]+$/, ''), { aircraft });
  return { ok: !!(h.ok && h.ast), same: !!(g.ok && h.ok && norm(g.ast) === norm(h.ast)), callsign: h.callsign || null };
});
process.stdout.write(JSON.stringify(out));
