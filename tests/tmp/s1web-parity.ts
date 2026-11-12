// Parity: the browser engine (src/lib/voice/s1.ts) must produce the same tokens as PyTorch on the same weights.
//   python3 ml/edge/parity_ref.py --model public/models/s1-test --n 50 --out <ref.json>
//   (compiled by tsc) node .tmp/parity/tests/tmp/s1web-parity.js public/models/s1-test <ref.json>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { S1Model, sttNormalise } from '../../src/lib/voice/s1';

const [dir, refPath] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const m = new S1Model(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8')) as { ctx: string; said: string; callsigns: string[]; ctx_ids: number[]; said_ids: number[]; tokens: number[]; line: string }[];
let tokOk = 0, outOk = 0; const pre: number[] = [], comp: number[] = [];
for (const r of ref) {
  const ctxIds = m.tok.encode(`<ctx>${r.ctx}`), saidIds = m.tok.encode(`<said> ${sttNormalise(r.said)}<cmd>`);
  if (JSON.stringify(ctxIds) === JSON.stringify(r.ctx_ids) && JSON.stringify(saidIds) === JSON.stringify(r.said_ids)) tokOk++;
  else if (tokOk + outOk < 3) console.log('TOKENIZER DIFF', r.said, saidIds.slice(0, 12), r.said_ids.slice(0, 12));
  pre.push(m.prefill(r.ctx));
  const c = m.complete(r.said, r.callsigns); comp.push(c.ms);
  if (JSON.stringify(c.tokens) === JSON.stringify(r.tokens)) outOk++;
  else console.log('OUTPUT DIFF', JSON.stringify(r.line), '->', JSON.stringify(c.line));
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(JSON.stringify({ n: ref.length, tokenizer_match: tokOk, output_match: outOk, prefill_ms_p50: Math.round(med(pre)), complete_ms_p50: Math.round(med(comp)) }));
