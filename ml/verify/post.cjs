// Label the generator's proposals and add the round-trip features, with the game's own code (ml/verify/.build).
//   node ml/verify/post.cjs <model name> <set> [<set> ...]   reads out/<set>.in.jsonl + out/<model>/<set>.gen.jsonl, writes out/<model>/<set>.feat.jsonl
// Per row: the production chain exactly as src/lib/voice/understand.ts runs it — rules first (L0), then the model's
// proposal through decideL1 (rules-callsign fusion, parse, canonical line) — and whether the final command equals the
// gold one (ASTs compared like ml/stt/score_l0.cjs), plus roundTrip() of the final command against the transcript.
const fs = require('fs');
const path = require('path');
const B = path.join(__dirname, '.build/src/lib');
const { parseCommand } = require(path.join(B, 'sim/commands.js'));
const { understand, decideL1 } = require(path.join(B, 'voice/understand.js'));
const { roundTrip, roundTripScore } = require(path.join(B, 'voice/verify.js'));
const OUT = path.join(__dirname, 'out');
const norm = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? Math.round(v) % 360 : Math.round(v)) : v));

function parseCtxOf(ctx) {
  const lines = ctx.split('\n');
  const head = lines[0].split(' ').slice(1).filter(Boolean);
  const aircraft = lines.slice(1).filter((l) => l.trim()).map((l) => {
    const w = l.split(' '); const alt = w.find((x) => /^\d+ft$/.test(x));
    return { callsign: w[0], altitude: alt ? parseInt(alt, 10) : 0 };
  });
  return { aircraft, runways: head.length ? undefined : undefined };
}

const [TAG, ...SETS] = process.argv.slice(2);
const MD = path.join(OUT, TAG);
for (const set of SETS) {
  if (!fs.existsSync(path.join(MD, `${set}.gen.jsonl`))) { console.log(JSON.stringify({ set, skipped: 'no generator output' })); continue; }
  const ins = fs.readFileSync(path.join(OUT, `${set}.in.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const gens = fs.readFileSync(path.join(MD, `${set}.gen.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const out = fs.openSync(path.join(MD, `${set}.feat.jsonl`), 'w');
  const n = Math.min(ins.length, gens.length);
  for (let i = 0; i < n; i++) {
    const ex = ins[i], g = gens[i];
    const pc = parseCtxOf(ex.ctx);
    const u = understand(ex.said, pc, 0);
    const goldSay = ex.line === 'SAY AGAIN';
    const gp = goldSay ? null : parseCommand(ex.line, pc);
    const gold = gp && gp.ok ? norm(gp.ast) : null;
    const l0Correct = u.ok ? (goldSay ? false : norm(parseCommand(u.line, pc).ast) === gold) : null;
    const sayAgain = /^SAY AGAIN$/i.test(g.line);
    const d = decideL1(u.ok ? { ...u, ok: false } : u, { line: g.line, confidence: g.conf, ms: 0, sayAgain }, pc, 0, 0.5, { verifier: null });
    const fused = /Callsign taken from what you said/.test(d.error || '');
    let parsed = false, correct = false, rt = null, finalLine = d.line;
    if (d.sayAgain) correct = goldSay;
    else {
      const p = parseCommand(d.line, pc);
      parsed = !!(p.ok && p.ast) && !/did not parse/.test(d.error || '');
      if (parsed) { correct = !goldSay && norm(p.ast) === gold; rt = roundTrip(u.transcript, p.ast, pc, 0); }
    }
    const row = { set, id: ex.id, rec: ex.rec || null, kind: ex.kind, icao: ex.icao, said: ex.said, gold: ex.line, line: finalLine, model_line: g.line,
      forced: ex.force != null, l0_ok: u.ok, l0_correct: l0Correct, say: d.sayAgain, fused, parsed, correct, gold_say: goldSay,
      ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'id' && k !== 'line')),
      ...(rt ? Object.fromEntries(Object.entries(rt).map(([k, v]) => ['rt_' + k, v])) : {}), rt_score: rt ? roundTripScore(rt) : null };
    fs.writeSync(out, JSON.stringify(row) + '\n');
  }
  fs.closeSync(out);
  console.log(JSON.stringify({ set, rows: n }));
}
