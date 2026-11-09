// What the verifier costs after release, in JS (node; the browser's V8 is the same engine):
//   node ml/verify/bench.cjs [set=val] [n=500] [model name=2m-swap-v1]
// Times decideL1() (fusion + parse + round trip + logistic regression) per proposal, with the generator's real outputs.
const fs = require('fs');
const path = require('path');
const B = path.join(__dirname, '.build/src/lib');
const { understand, decideL1 } = require(path.join(B, 'voice/understand.js'));
const set = process.argv[2] || 'val', n = Number(process.argv[3] || 500), tag = process.argv[4] || '2m-swap-v1';
const OUT = path.join(__dirname, 'out');
const ins = fs.readFileSync(path.join(OUT, `${set}.in.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
const gen = fs.readFileSync(path.join(OUT, tag, `${set}.gen.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
const sig = (g) => ({ csMargin: g.cs_margin, pSay: g.p_say, csMinFull: g.cs_min_full, insMinP: g.ins_min_p, insLp: g.ins_lp, insMinMargin: g.ins_min_margin, digMinP: g.dig_min_p, digMargin: g.dig_margin, rwyMinP: g.rwy_min_p, eosP: g.eos_p, nTok: g.n_tok });
const cases = [];
for (let i = 0; i < Math.min(ins.length, gen.length) && cases.length < n; i++) {
  const ex = ins[i]; const aircraft = ex.ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => { const w = l.split(' '); const a = w.find((x) => /^\d+ft$/.test(x)); return { callsign: w[0], altitude: a ? parseInt(a, 10) : 0 }; });
  const pc = { aircraft }; const u = understand(ex.said, pc, 0); if (u.ok) continue;
  cases.push([u, gen[i], pc]);
}
const ms = []; const t = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
for (const [u, g, pc] of cases) decideL1(u, { line: g.line, confidence: g.conf, ms: 0, sayAgain: /^SAY AGAIN$/.test(g.line), signals: sig(g) }, pc, 0);   // warm-up (JIT)
for (const [u, g, pc] of cases) ms.push(t(() => decideL1(u, { line: g.line, confidence: g.conf, ms: 0, sayAgain: /^SAY AGAIN$/.test(g.line), signals: sig(g) }, pc, 0)));
const legacy = []; for (const [u, g, pc] of cases) legacy.push(t(() => decideL1(u, { line: g.line, confidence: g.conf, ms: 0, sayAgain: /^SAY AGAIN$/.test(g.line) }, pc, 0, 0.5, { verifier: null })));
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log(JSON.stringify({ set, n: cases.length, decide_ms_p50: +q(ms, 0.5).toFixed(3), decide_ms_p95: +q(ms, 0.95).toFixed(3), decide_ms_max: +Math.max(...ms).toFixed(3),
  legacy_ms_p50: +q(legacy, 0.5).toFixed(3), verifier_extra_ms_p50: +(q(ms, 0.5) - q(legacy, 0.5)).toFixed(3) }));
