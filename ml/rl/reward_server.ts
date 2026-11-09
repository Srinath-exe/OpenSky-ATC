// Long-lived engine process for RL rewards: JSON lines over stdin/stdout, one request per line, batched.
//   request : {"id": 1, "items": [{"ctx": "...", "line": "UPS973 Fly heading 102"}, ...]}
//   response: {"id": 1, "out": [{"ok": true, "cs": "UPS973", "kinds": ["heading"], "ast": "<normalised json>",
//                               "words": "ups nine seven three fly heading one zero two", "err": null}, ...]}
// The parser gets the aircraft list from the state text (as ml/stt/score_l0.cjs does), so an unknown callsign
// fails to parse. "words" is the engine's own controller transmission for the AST (phraseology.transmission),
// i.e. the command rendered back to speech, used by the label-free verifier reward.
import * as readline from 'readline';
import { parseCommand } from '../../src/lib/sim/commands';
import { transmission, AIRLINE_TELEPHONY, spokenDigits } from '../../src/lib/sim/phraseology';

const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? Math.round(v) % 360 : Math.round(v)) : v));

function tel(cs: string): string {
  const m = /^([A-Z]{3})(\d+[A-Z]{0,2})$/.exec(cs);
  if (!m) return cs;
  const name = AIRLINE_TELEPHONY[m[1]];
  return name ? `${name} ${spokenDigits(m[2], 'FAA')}` : cs;
}

function phraseCtx(alt: number, hdg: number): any {
  return {
    variant: 'FAA', telephony: tel, unit: (p: string) => p, freq: () => '', wind: null, qnh: null, atisLetter: null,
    magVar: 0, transitionAltFt: 18000, time: 0, aircraft: null, spokenType: (t: string) => t,
    _alt: alt, _hdg: hdg,
  };
}

const kindsOf = (ast: any): string[] => (ast?.kind === 'sequence' ? ast.parts.map((p: any) => p.kind) : ast ? [ast.kind] : []);

function one(ctx: string, line: string) {
  const rows = ctx.split('\n').slice(1).filter(l => l.trim());
  const aircraft = rows.map(l => ({ callsign: l.split(' ')[0] }));
  let r;
  try { r = parseCommand(String(line || '').trim(), { aircraft }); } catch (e) { return { ok: false, cs: null, kinds: [], ast: null, words: null, err: 'throw' }; }
  if (!r.ok || !r.ast) return { ok: false, cs: r.callsign ?? null, kinds: [], ast: null, words: null, err: r.errors[0]?.code ?? 'fail' };
  let words: string | null = null;
  try { words = transmission(r.ast, phraseCtx(0, 0)); } catch { words = null; }
  return { ok: true, cs: r.callsign ?? null, kinds: kindsOf(r.ast), ast: norm(r.ast), words, err: null };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (l) => {
  if (!l.trim()) return;
  const req = JSON.parse(l);
  const out = (req.items as Array<{ ctx: string; line: string }>).map(it => one(it.ctx, it.line));
  process.stdout.write(JSON.stringify({ id: req.id, out }) + '\n');
});
