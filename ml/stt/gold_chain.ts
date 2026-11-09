// Node side of ml/stt/score_gold.py, compiled to .tmp/gold by it (tsc, CommonJS).
//
//   chain <rows.json> <modelDir>   rows [{key, heard, ctx, line}] -> stdout [{key, l0, chain, model}]
//     Runs the game's own code on every transcript: understand() = rules alone (L0), understandHeard() = the shipped
//     chain (asr-repair cleanup, rules, else the int8 S1 model in the hand-written TS engine, callsign fusion, confidence gate), and the
//     model alone. "same" compares the parsed AST with the gold line's AST (one ParseCtx for both, with the airport's
//     runways / taxiways / fixes / stands when `icao` is given).
//   rules <rows.json>              rules alone -> [{key, gold_ok, ok, same}] (prompt builder: drop ambiguous phrases)
//   ingest <stageDir>              POSTs <stageDir>/*.wav through the real route handler (env GOLD_DIR, GOLD_PROMPTS,
//     GOLD_KEY), then GETs the list: the dry run stores clips exactly the way the recording page does.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { understand } from '../../src/lib/voice/understand';
import type { L1Like } from '../../src/lib/voice/understand';
import { S1Model } from '../../src/lib/voice/s1';
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import { parseCommand, tokenize, resolveCallsign } from '../../src/lib/sim/commands';
import type { ParseCtx } from '../../src/lib/sim/commands';
import * as route from '../../src/app/api/voice/gold/route';
import { fromEngine } from '../../src/lib/sim/dispatch';
import { makeEngine } from '../../tests/engine/helpers';   // reads GOLD_DIR / GOLD_PROMPTS per request

const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? Math.round(v) % 360 : Math.round(v)) : v));

// The airport's runways, taxiways, fixes and stands, exactly as the game passes them (fromEngine): the parser is strict
// when it has them (an unknown fix such as "LAXO" for LAXSO is rejected, as in the game). magVar is left out on purpose:
// the context, the gold lines and the model all speak magnetic headings, so one frame everywhere.
const lists = new Map<string, Pick<ParseCtx, 'runways' | 'taxiways' | 'fixes' | 'stands'> | null>();
function airportLists(icao: string) {
  if (!lists.has(icao)) {
    const log = console.log; console.log = console.error;   // keep stdout for the JSON result
    try { const c = fromEngine(makeEngine(icao, { seed: 1 })); lists.set(icao, { runways: c.runways, taxiways: c.taxiways, fixes: c.fixes, stands: c.stands }); }
    catch (e) { console.error(`no airport data for ${icao} (${String(e).slice(0, 120)}): loose parsing`); lists.set(icao, null); }
    finally { console.log = log; }
  }
  return lists.get(icao) ?? {};
}

function parseCtxOf(ctx: string, icao: string): { pctx: ParseCtx; callsigns: string[] } {
  const callsigns = ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split(' ')[0]);
  return { pctx: { aircraft: callsigns.map((callsign) => ({ callsign })), ...(icao && /^[A-Z]{4}$/.test(icao) ? airportLists(icao) : {}) }, callsigns };
}

async function chain(rowsFile: string, modelDir: string) {
  const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')) as { key: string; heard: string; ctx: string; line: string; icao?: string }[];
  const meta = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
  const bin = fs.readFileSync(path.join(modelDir, 'model.bin'));
  const m = new S1Model(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  let cached = '';
  const l1: L1Like = {
    async complete(said, callsigns, ctx) {
      if (ctx && ctx !== cached) { m.prefill(ctx); cached = ctx; }
      const { tokens: _t, ...r } = m.complete(said, callsigns);   // everything the worker posts (incl. verifier signals, when the engine has them)
      return r;
    },
  };
  const out = [];
  for (const r of rows) {
    const { pctx, callsigns } = parseCtxOf(r.ctx, r.icao ?? '');
    const neg = /^SAY AGAIN$/i.test(r.line);
    const gold = neg ? null : parseCommand(r.line, pctx);
    const goldCs = neg ? null : r.line.split(/\s+/)[0];
    const sameAst = (line: string) => !!(gold?.ok && gold.ast && (() => { const p = parseCommand(line, pctx); return p.ok && p.ast && norm(p.ast) === norm(gold.ast); })());
    const csOf = (line: string) => { const c = line.split(/\s+/)[0] ?? ''; return callsigns.includes(c) ? c : null; };
    const heard = String(r.heard ?? '');
    // L0: rules alone
    const u = understand(heard, pctx, 0);
    const rulesCs = u.transcript ? resolveCallsign(tokenize(u.transcript), 0, pctx).callsign : null;
    const l0Cs = u.ok ? csOf(u.line) : rulesCs;
    const l0 = { ok: u.ok, line: u.line, same: neg ? !u.ok && !rulesCs : u.ok && sameAst(u.line), cs: l0Cs, cs_ok: !!goldCs && l0Cs === goldCs };
    // the shipped chain, as the game runs it: the recogniser's text cleaned up (asr-repair), rules, then the model
    const v = await understandHeard([heard], pctx, 0, l1, { text: r.ctx, callsigns });
    const decision = v.ok ? 'sent' : v.sayAgain ? 'sayagain' : v.source === 'L1' ? 'check' : 'fail';
    const vCs = v.source === 'none' ? rulesCs : csOf(v.line);
    const same = neg ? !v.ok && (v.sayAgain || !vCs) : decision !== 'sayagain' && decision !== 'fail' && sameAst(v.line);
    const ch = { ok: v.ok, line: decision === 'sayagain' ? 'SAY AGAIN' : v.ok || v.source === 'L1' ? v.line : '', source: v.source, decision, confidence: v.confidence == null ? null : Math.round(v.confidence * 1000) / 1000,
      same, cs: vCs, cs_ok: !!goldCs && vCs === goldCs, error: v.error, heard: v.heard, notes: v.notes, verify: (v as { verify?: { p: number; gate: string } }).verify ?? null };
    // the model alone, on every transcript (also where the rules succeed)
    const mo = u.transcript ? await l1.complete(u.transcript, callsigns, r.ctx) : { line: '', confidence: 0, ms: 0, sayAgain: true };
    const model = { line: mo.line, same: neg ? mo.sayAgain : !mo.sayAgain && sameAst(mo.line), confidence: Math.round(mo.confidence * 1000) / 1000, ms: Math.round(mo.ms) };
    out.push({ key: r.key, gold_ok: neg || !!(gold?.ok && gold.ast), strict: 'fixes' in pctx, l0, chain: ch, model });
  }
  process.stdout.write(JSON.stringify(out));
}

/** Rules only, for the prompt builder: does the clean phrase mean exactly the gold line? (ok && !same = it means
 *  something else, e.g. "give way to the Qantas, then continue" -> two commands: such a prompt is ambiguous.) */
function rules(rowsFile: string) {
  const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')) as { key: string; heard: string; ctx: string; line: string; icao?: string }[];
  const out = rows.map((r) => {
    const { pctx } = parseCtxOf(r.ctx, r.icao ?? '');
    const g = parseCommand(r.line, pctx), u = understand(r.heard, pctx, 0);
    const p = u.ok ? parseCommand(u.line, pctx) : null;
    return { key: r.key, gold_ok: !!(g.ok && g.ast), ok: u.ok, same: !!(g.ok && g.ast && p?.ok && p.ast && norm(p.ast) === norm(g.ast)) };
  });
  process.stdout.write(JSON.stringify(out));
}

async function ingest(stage: string) {
  const key = process.env.GOLD_KEY ?? '';
  const files = fs.readdirSync(stage).filter((f) => f.endsWith('.wav')).sort();
  let ok = 0;
  for (const f of files) {
    const id = f.slice(0, -4);
    const form = new FormData();
    form.set('id', id);
    form.set('wav', new Blob([fs.readFileSync(path.join(stage, f))], { type: 'audio/wav' }), f);
    form.set('meta', JSON.stringify({ browserTranscript: null, browserEngine: 'none (dry run)', mode: 'hold', take: 1, clientTs: new Date().toISOString() }));
    const res = await route.POST(new Request('http://localhost/api/voice/gold', { method: 'POST', headers: { 'x-gold-key': key, 'user-agent': 'gold-dry-run' }, body: form }));
    if (res.status === 200) ok++; else console.error(id, res.status, await res.text());
  }
  const list = await (await route.GET(new Request('http://localhost/api/voice/gold', { headers: { 'x-gold-key': key } }))).json() as { count: number; total: number };
  console.log(JSON.stringify({ posted: files.length, saved: ok, listed: list.count, total: list.total }));
  if (ok !== files.length || list.count !== files.length) process.exit(1);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === 'chain' ? chain(a, b) : cmd === 'rules' ? Promise.resolve(rules(a)) : cmd === 'ingest' ? ingest(a)
  : Promise.reject(new Error('usage: chain <rows.json> <modelDir> | rules <rows.json> | ingest <stageDir>')))
  .catch((e) => { console.error(e); process.exit(1); });
