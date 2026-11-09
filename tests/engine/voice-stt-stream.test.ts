import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SttStream, StreamStore, STREAM_LIMITS } from '../../src/app/api/voice/stt/stream';

const RATE = 16000;
/** Speech-like bursts (a 200 Hz tone at -12 dBFS) with quiet gaps (-70 dBFS noise): [ms, loud?][] */
function audio(parts: [number, boolean][]): Float32Array {
  const n = parts.reduce((s, [ms]) => s + (ms * RATE) / 1000, 0);
  const out = new Float32Array(n); let o = 0, seed = 7;
  for (const [ms, loud] of parts) {
    for (let i = 0; i < (ms * RATE) / 1000; i++, o++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[o] = loud ? 0.35 * Math.sin((2 * Math.PI * 200 * o) / RATE) : ((seed / 4294967296) * 2 - 1) * 3e-4;
    }
  }
  return out;
}
const mock = () => {
  const calls: number[] = [];
  return { calls, fn: async (a: Float32Array) => { calls.push(a.length); return { text: `p${calls.length}.`, ms: 5, model: 'mock' }; } };
};
const feed = (s: SttStream, a: Float32Array, chunk = 4800) => { for (let i = 0; i < a.length; i += chunk) s.push(a.subarray(i, i + chunk)); };

test('phrases separated by a pause are decoded while speaking; the last at the end', async () => {
  const m = mock();
  const s = new SttStream(['speedbird 327'], m.fn);
  feed(s, audio([[300, false], [1200, true], [500, false], [1400, true], [250, false]]));
  assert.equal(m.calls.length, 1, 'the first phrase is sent before the end');
  const r = await s.end();
  assert.equal(r.segments, 2);
  assert.equal(r.text, 'p1 p2');   // trailing full stops dropped, joined
  assert.equal(m.calls.reduce((a, b) => a + b, 0), (300 + 1200 + 500 + 1400 + 250) * 16, 'every sample decoded once');
});

test('a short pause inside a phrase, or a phrase shorter than the minimum, is not cut', async () => {
  const m = mock();
  const s = new SttStream([], m.fn);
  feed(s, audio([[300, false], [600, true], [200, false], [600, true], [300, false]]));
  assert.equal(m.calls.length, 0);
  const r = await s.end();
  assert.equal(r.segments, 1);
});

test('chunk size does not change the cuts', async () => {
  const a = audio([[300, false], [1000, true], [450, false], [900, true], [400, false], [1100, true]]);
  const cuts: number[][] = [];
  for (const chunk of [128, 1000, 4800, 32000]) {
    const m = mock(); const s = new SttStream([], m.fn); feed(s, a, chunk); await s.end(); cuts.push(m.calls);
  }
  for (const c of cuts) assert.deepEqual(c, cuts[0]);
});

test('audio beyond the limit is dropped; a failed phrase leaves an empty piece', async () => {
  let k = 0;
  const s = new SttStream([], async (a) => {
    if (++k === 1) throw new Error('busy');
    return { text: a.some((v) => Math.abs(v) > 0.01) ? 'ok' : '', ms: 1, model: 'm' };   // silence decodes to nothing
  });
  feed(s, audio([[300, false], [1000, true], [500, false], [1000, true]]));
  s.push(new Float32Array(STREAM_LIMITS.maxSeconds * RATE));
  assert.ok(s.seconds <= STREAM_LIMITS.maxSeconds);
  const r = await s.end();
  assert.equal(r.text, 'ok');
});

test('the store forgets idle streams and caps their number', () => {
  const st = new StreamStore();
  const s = new SttStream([], mock().fn);
  assert.ok(st.create('abcdefgh', s));
  s.lastSeen = Date.now() - STREAM_LIMITS.idleMs - 1;
  assert.equal(st.get('abcdefgh'), undefined);
  for (let i = 0; i < STREAM_LIMITS.maxSessions; i++) assert.ok(st.create(`id${i}xxxxxx`, new SttStream([], mock().fn)));
  assert.equal(st.create('onetoomany', new SttStream([], mock().fn)), false);
});
