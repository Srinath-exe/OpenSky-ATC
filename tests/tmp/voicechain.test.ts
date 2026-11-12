import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner, type Live } from '../../src/game/Tutorial/lessons';
import { spokenCall } from '../../src/game/Tutorial/spoken';
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import { voiceContext, canonicalLine } from '../../src/lib/voice/context';
import { fromEngine } from '../../src/lib/sim/dispatch';
import { parseCommand } from '../../src/lib/sim/commands';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
const asr = (s: string) => s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
let ok = 0, bad = 0;
(async () => {
  for (const ch of CHAPTERS) {
    if (ch.ui) continue;
    const ctx = ch.resume?.(e) ?? ch.setup(e); const L: Live = { e, ctx, events: [], t0: e.time, selectedId: null }; ch.cues?.(L);
    for (const g of ch.goals) {
      if (g.optional) continue;
      let t = 0; while (g.when && !g.when(L) && t < 600) { L.events.push(...e.step(30)); t++; }
      const line = g.say?.(L);
      if (line) {
        const spoken = spokenCall(e, line) ?? line; const heard = asr(spoken);
        const pos = e.playerPosition; const pctx = fromEngine(e, { lastCallsign: null, position: pos });
        const want = parseCommand(line, pctx); const wantLine = want.ok && want.ast ? canonicalLine(want.ast, e.magVar ?? 0) : line;
        const r = await understandHeard([heard], pctx, e.magVar ?? 0, null, voiceContext(e, pos));
        const good = r.ok && r.line === wantLine;
        good ? ok++ : bad++;
        console.log(`${good ? ' ok ' : 'BAD '} ${ch.id.padEnd(10)} heard "${heard}"\n      want ${wantLine}\n      got  ${r.ok ? r.line : 'NOT UNDERSTOOD'}${r.error ? '  (' + r.error + ')' : ''}${r.sayAgain ? ' [say again]' : ''}`);
        text(e, line);
      }
      t = 0; while (!g.done(L) && t < 600) { L.events.push(...e.step(30)); t++; const l2 = g.say?.(L); if (l2 && l2 !== line && t % 20 === 0) text(e, l2); }
    }
  }
  console.log(`understood ${ok}, not ${bad}`);
})();
