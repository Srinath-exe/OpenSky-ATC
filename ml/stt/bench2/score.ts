// Score speech-to-text transcripts end to end with the game's own code (ml/stt/RESULTS2.md).
//   bash ml/stt/bench2/run.sh score <clipdir> <results/*.jsonl ...>
// For each transcript file (one candidate recogniser) and each clip:
//   WER        word error rate against what was said (numbers in one form on both sides, as ml/stt/score.py)
//   rules      understand() on the raw transcript                          (L0, what the game did before)
//   rules+S1   understandVoice() on the raw transcript                     (L0 then the S1 model)
//   +repair    understandHeard() with the repair pass, top-1 only          (src/lib/voice/asr-repair.ts)
//   +n-best    understandHeard() over every alternative the engine gave   (src/lib/voice/asr-nbest.ts)
// "exact" = the command line the game ends up with parses to the gold AST; "sent" = it would be sent without a check;
// "wrong sent" = sent and not the gold command (the costly error).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { understand, understandVoice } from '../../../src/lib/voice/understand';
import type { L1Like, L1Proposal, VoiceResult } from '../../../src/lib/voice/understand';
import { understandHeard } from '../../../src/lib/voice/asr-nbest';
import { parseCommand } from '../../../src/lib/sim/commands';
import type { ParseCtx } from '../../../src/lib/sim/commands';
import { S1Model } from '../../../src/lib/voice/s1';
import { fromEngine } from '../../../src/lib/sim/dispatch';
import { makeEngine } from '../../../tests/engine/helpers';

// The airport's runways, taxiways, fixes and stands, as the game passes them (fromEngine): the parser is strict with
// them, so an invented fix ("LAXSW" for LAXWE) or taxiway is rejected as in the game. --loose scores with the aircraft only.
const LOOSE = process.argv.includes('--loose');
const lists = new Map<string, Pick<ParseCtx, 'runways' | 'taxiways' | 'fixes' | 'stands'> | null>();
function airportLists(icao: string | undefined): Pick<ParseCtx, 'runways' | 'taxiways' | 'fixes' | 'stands'> {
  if (LOOSE || !icao || !/^[A-Z]{4}$/.test(icao)) return {};
  if (!lists.has(icao)) {
    const log = console.log; console.log = console.error;
    try { const c = fromEngine(makeEngine(icao, { seed: 1 })); lists.set(icao, { runways: c.runways, taxiways: c.taxiways, fixes: c.fixes, stands: c.stands }); }
    catch (e) { console.error(`no airport data for ${icao} (${String(e).slice(0, 120)}): loose parsing`); lists.set(icao, null); }
    finally { console.log = log; }
  }
  return lists.get(icao) ?? {};
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadClips } = require(path.resolve(__dirname, '../../../../../ml/stt/bench2/clips.cjs'));
const ROOT = path.resolve(__dirname, '../../../../..');

// ---- WER, normalised like ml/stt/score.py (stt_normalise + words_to_digits) ----
const ONES = 'zero one two three four five six seven eight nine'.split(' ');
const TEENS = 'ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_VAL: Record<string, number> = { ...Object.fromEntries(ONES.map((w, i) => [w, i])), oh: 0, niner: 9, tree: 3, fife: 5, fower: 4, ...Object.fromEntries(TEENS.map((w, i) => [w, 10 + i])) };
const sttNorm = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/(\w)-(\w)/g, '$1 $2').replace(/[^\w\s.]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
function wordsToDigits(words: string[]): string[] {
  const out: string[] = []; let run = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) { const n = words[i + 1]; if (n in WORD_VAL && WORD_VAL[n] > 0 && WORD_VAL[n] < 10) { run += String(TENS[w] + WORD_VAL[n]); i++; continue; } run += String(TENS[w]); continue; }
    if (w in WORD_VAL) { run += String(WORD_VAL[w]); continue; }
    if (run) { out.push(run); run = ''; }
    out.push(w);
  }
  if (run) out.push(run);
  return out;
}
function wer(ref: string, hyp: string): [number, number] {
  const r = wordsToDigits(sttNorm(ref).split(' ').filter(Boolean)), h = wordsToDigits(sttNorm(hyp).split(' ').filter(Boolean));
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i * j === 0 ? i + j : 0)));
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0));
  return [d[r.length][h.length], r.length];
}

const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? Math.round(v) % 360 : Math.round(v)) : v));

interface Clip { wav: string; cond: string; split?: string; ctx: string; line: string; text: string; kind?: string; icao?: string }
interface Row { wav: string; heard: string; alts?: string[]; decodes?: string[]; ms: number; more?: string[]; moreMs?: number }

function loadModel(): L1Like & { m: S1Model } {
  const name = process.env.S1_MODEL || '2m-swap-v1';   // S1_MODEL=2m-grpo-v1 scores the other checkpoint with its own gate
  const dir = path.join(ROOT, 'public/models/s1', name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const bin = fs.readFileSync(path.join(dir, 'model.bin'));
  const m = new S1Model(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  const cache = new Map<string, L1Proposal>();
  let lastCtx = '';
  return {
    m,
    async complete(said: string, callsigns: string[], ctx?: string) {
      const key = `${ctx}\u0000${said}`;
      const hit = cache.get(key); if (hit) return hit;
      if (ctx && ctx !== lastCtx) { m.prefill(ctx); lastCtx = ctx; }
      const r = m.complete(said, callsigns);
      // the per-token signals feed the verifier gate, as the game's worker does (s1-worker.js)
      const v = { line: r.line, confidence: r.confidence, ms: r.ms, sayAgain: r.sayAgain, signals: r.signals as unknown as L1Proposal['signals'], model: `/models/s1/${name}` };
      cache.set(key, v); return v;
    },
  };
}

type Metric = { exact: number; sent: number; wrong: number; cs: number };
const CONFIGS = ['rules', 'rules+S1', 'repair', 'repair+S1', 'nbest', 'nbest+S1'] as const;
type Config = typeof CONFIGS[number];

async function main() {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const out = flag('--out'), details = flag('--details');
  const skip = new Set(['--out', '--details', '--every', '--cond', '--combo'].flatMap((k) => { const i = argv.indexOf(k); return i >= 0 ? [i, i + 1] : []; }));
  const files = argv.filter((a, i) => !skip.has(i) && a !== '--loose');
  const [dir, ...results] = files;
  const every = Number(flag('--every') ?? 1);   // --every 2: only utterances with an even id (the subset every engine ran on)
  const conds = flag('--cond')?.split(',') ?? null;
  const clips = new Map<string, Clip>((loadClips(dir) as (Clip & { id?: string })[]).filter((c) => (every <= 1 || !c.id || Number(c.id) % every === 0) && (!conds || conds.includes(c.cond))).map((c) => [c.wav, c]));
  const l1 = loadModel();
  const summary: Record<string, unknown>[] = [];
  const det: Record<string, unknown>[] = [];
  const views: [string, Row[]][] = [];
  for (const f of results) {
    const name = path.basename(f).replace(/\.jsonl$/, '');
    const rows: Row[] = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r: Row) => clips.has(r.wav));
    if (!rows.length) continue;
    views.push([name, rows]);
    // Whisper with the prompt and without it, as separate recognisers (the biasing ablation)
    if (rows.every((r) => r.decodes && r.decodes.length === 2)) {
      views.push([`${name}@prompt`, rows.map((r) => ({ ...r, heard: r.decodes![0], alts: [r.decodes![0]] }))]);
      views.push([`${name}@plain`, rows.map((r) => ({ ...r, heard: r.decodes![1], alts: [r.decodes![1]] }))]);
    }
  }
  // --combo a+b: both recognisers on the same transmission; their guesses interleaved (a1, b1, a2, b2, ...)
  for (const spec of (flag('--combo') ?? '').split(',').filter(Boolean)) {
    // a>b: b only as a second opinion when a's guesses are not understood (what the game's Browser engine does)
    if (spec.includes('>')) {
      const [a, b] = spec.split('>'); const A = views.find((v) => v[0] === a)?.[1], Bv = views.find((v) => v[0] === b)?.[1];
      if (!A || !Bv) continue;
      const byWav = new Map(Bv.map((r) => [r.wav, r]));
      views.push([`${a}>${b}`, A.filter((r) => byWav.has(r.wav)).map((r) => { const o = byWav.get(r.wav)!; return { ...r, more: o.alts?.length ? o.alts : [o.heard].filter(Boolean), moreMs: o.ms }; })]);
      continue;
    }
    const [a, b] = spec.split('+'); const A = views.find((v) => v[0] === a)?.[1], Bv = views.find((v) => v[0] === b)?.[1];
    if (!A || !Bv) continue;
    const byWav = new Map(Bv.map((r) => [r.wav, r]));
    const mix = (x: string[], y: string[]) => Array.from({ length: Math.max(x.length, y.length) }, (_, i) => [x[i], y[i]]).flat().filter((v): v is string => !!v);
    views.push([`${a}+${b}`, A.filter((r) => byWav.has(r.wav)).map((r) => { const o = byWav.get(r.wav)!; return { wav: r.wav, heard: r.heard || o.heard, alts: mix(r.alts?.length ? r.alts : [r.heard], o.alts?.length ? o.alts : [o.heard]), ms: Math.max(r.ms, o.ms) }; })]);
  }
  for (const [name, rows] of views) {
    const agg = new Map<string, { n: number; we: number; wn: number; m: Record<Config, Metric>; ms: number[] }>();
    const bucket = (k: string) => { let b = agg.get(k); if (!b) { b = { n: 0, we: 0, wn: 0, m: Object.fromEntries(CONFIGS.map((c) => [c, { exact: 0, sent: 0, wrong: 0, cs: 0 }])) as Record<Config, Metric>, ms: [] }; agg.set(k, b); } return b; };
    for (const r of rows) {
      const c = clips.get(r.wav)!;
      const aircraft = c.ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => ({ callsign: l.split(' ')[0] }));
      const ctx: ParseCtx = { aircraft, ...airportLists(c.icao) };
      const state = { text: c.ctx, callsigns: aircraft.map((a) => a.callsign) };
      const g = parseCommand(c.line, ctx);
      const goldCs = c.line.split(/\s+/)[0];
      const score = (v: VoiceResult): Metric => {
        const p = v.line ? parseCommand(v.line, ctx) : null;
        const same = !!(g.ok && p?.ok && p.ast && norm(p.ast) === norm(g.ast));
        const cs = !!(p?.ok && p.ast && 'callsign' in p.ast && p.ast.callsign === goldCs);
        return { exact: +same, sent: +(same && v.ok), wrong: +(!same && v.ok), cs: +cs };
      };
      const heard = r.heard ?? '';
      const alts = r.alts && r.alts.length ? r.alts : heard ? [heard] : [];
      const raw0 = understand(heard, ctx, 0);
      const res: Record<Config, VoiceResult> = {
        rules: { ...raw0, confidence: raw0.ok ? 1 : null, sayAgain: false, modelMs: null },
        'rules+S1': await understandVoice(heard, ctx, 0, l1, state),
        repair: await understandHeard(alts.slice(0, 1), ctx, 0, null, state, { nbest: false }),
        'repair+S1': await understandHeard(alts.slice(0, 1), ctx, 0, l1, state, { nbest: false }),
        nbest: await understandHeard(alts, ctx, 0, null, state),
        'nbest+S1': await understandHeard(alts, ctx, 0, l1, state),
      };
      let ms = r.ms;
      if (r.more) {   // second opinion: CommLog's rule
        const mixed = Array.from({ length: Math.max(alts.length, r.more.length) }, (_, i) => [alts[i], r.more![i]]).flat().filter((x): x is string => !!x);
        for (const [k, model] of [['nbest', null], ['nbest+S1', l1]] as const) {
          const first = res[k];
          if (first.ok) continue;
          const second = await understandHeard(mixed, ctx, 0, model, state);
          res[k] = second.ok || (second.confidence ?? 0) > (first.confidence ?? 0) ? second : first;
          if (k === 'nbest+S1') ms = Math.max(r.ms, r.moreMs ?? 0);
        }
      }
      const [we, wn] = wer(c.text, heard);
      const perClip: Record<string, Metric> = {};
      for (const k of ['all', c.cond, `${c.split ?? 'gold'}`, `${c.cond}/${c.split ?? 'gold'}`]) {
        const b = bucket(k); b.n++; b.we += we; b.wn += wn; b.ms.push(ms);
        for (const cf of CONFIGS) { const s = perClip[cf] ?? (perClip[cf] = score(res[cf])); const m = b.m[cf]; m.exact += s.exact; m.sent += s.sent; m.wrong += s.wrong; m.cs += s.cs; }
      }
      if (details) det.push({ cand: name, wav: r.wav, cond: c.cond, text: c.text, gold: c.line, heard, alts, ...Object.fromEntries(CONFIGS.map((cf) => [cf, { line: res[cf].line, ok: res[cf].ok, exact: perClip[cf].exact, src: res[cf].source, alt: (res[cf] as { alt?: number }).alt, heard: (res[cf] as { heard?: string }).heard, gate: res[cf].verify?.gate }])), notes: (res['nbest+S1'] as { notes?: string[] }).notes });
    }
    for (const [k, b] of agg) {
      const ms = [...b.ms].sort((x, y) => x - y);
      const row: Record<string, unknown> = { cand: name, group: k, n: b.n, wer: +(b.we / b.wn).toFixed(3), ms_p50: ms[ms.length >> 1], ms_p95: ms[Math.floor(ms.length * 0.95)] };
      for (const cf of CONFIGS) { const m = b.m[cf]; row[cf] = +(m.exact / b.n).toFixed(3); row[`${cf}:sent`] = +(m.sent / b.n).toFixed(3); row[`${cf}:wrong`] = +(m.wrong / b.n).toFixed(3); row[`${cf}:cs`] = +(m.cs / b.n).toFixed(3); }
      summary.push(row);
      if (k === 'all' || !k.includes('/')) console.log(`${name.padEnd(34)} ${k.padEnd(7)} n=${String(b.n).padStart(4)} WER ${(b.we / b.wn * 100).toFixed(1).padStart(5)}%  ` + CONFIGS.map((cf) => `${cf} ${(b.m[cf].exact / b.n * 100).toFixed(1)}`).join('  ') + `  p50 ${ms[ms.length >> 1]} ms`);
    }
  }
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 1));
  if (details) fs.writeFileSync(details, det.map((d) => JSON.stringify(d)).join('\n') + '\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
