// The owner's saved live clips through both Parakeet models, scored on what the game makes of them (the voice chain).
import * as fs from 'node:fs';
import { transcribeParakeet, parakeetConfig } from '../../src/app/api/voice/stt/engine';
import { decodeAudio } from '../../src/app/api/voice/stt/handler';
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import { parseCommand } from '../../src/lib/sim/commands';
import { canonicalLine } from '../../src/lib/voice/context';
import { aircraftFromContext } from '../../src/lib/voice/asr-repair';
const norm = (s: string) => s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
const wer = (r: string[], h: string[]) => { const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]); for (let j = 1; j <= h.length; j++) d[0][j] = j; for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); return d[r.length][h.length] / Math.max(1, r.length); };
(async () => {
  const dir = 'ml/data/gold/live'; const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const models = { '110m': '/root/.cache/openatc-stt/parakeet-110m-atc-v1', 'ultra': '/root/.cache/openatc-stt/parakeet-ultra-int8' };
  const res: Record<string, { w: number; cmd: number; n: number }> = {};
  for (const f of files) {
    const meta = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); if (!meta.expected || !meta.ctx) continue;
    const wav = fs.readFileSync(`${dir}/${f.replace('.json', '.wav')}`); const audio = decodeAudio(new Uint8Array(wav)) as unknown as Float32Array;
    const ac = aircraftFromContext(meta.ctx); const pctx = { aircraft: ac.map((a) => ({ callsign: a.callsign })) } as any;
    const exp = parseCommand(meta.expected.replace(/fife/gi, 'five').replace(/niner/gi, 'nine').replace(/tree/gi, 'three'), pctx);
    const want = exp.ok && exp.ast ? canonicalLine(exp.ast, 0) : null;
    const row: string[] = [];
    for (const [k, d] of Object.entries(models)) {
      const r = await transcribeParakeet(audio, { names: ac.map((a) => a.name), config: { ...parakeetConfig(), dir: d } });
      const u = await understandHeard([r.text], pctx, 0, null, { text: meta.ctx, callsigns: ac.map((a) => a.callsign) });
      const s = (res[k] ??= { w: 0, cmd: 0, n: 0 }); s.n++; s.w += wer(norm(meta.expected), norm(r.text)); const good = !!want && u.ok && u.line === want; if (good) s.cmd++;
      row.push(`${k}: ${good ? 'OK ' : 'bad'} "${r.text}"`);
    }
    console.log(`${meta.expected}\n   want ${want}\n   ${row.join('\n   ')}`);
  }
  for (const [k, s] of Object.entries(res)) console.log(`${k}: ${s.n} clips, commands right ${s.cmd}/${s.n}, mean WER ${(s.w / s.n).toFixed(2)}`);
})();
