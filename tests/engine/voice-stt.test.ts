// Speech-to-text layer (ml/stt/RESULTS2.md): transcript repair, n-best selection, and the /api/voice/stt guards.
//   scripts/test-sim.sh tests/engine/voice-stt.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repairTranscript, phoneticKey, aircraftFromContext, normaliseTokens, runDigits } from '../../src/lib/voice/asr-repair';
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import { understand } from '../../src/lib/voice/understand';
import { handleStt, RateLimiter, Gate, decodeAudio, parseNames, pickEngine, firstEngine, STT_LIMITS } from '../../src/app/api/voice/stt/handler';
import type { SttDeps, SttEngineId } from '../../src/app/api/voice/stt/handler';
import { buildPrompt, bpeVocab, hotwordsFor, parakeetConfig, parakeetReady } from '../../src/app/api/voice/stt/engine';
import { cascadeStt, better } from '../../src/lib/voice/asr-server';
import type { SttEngine, SttReply } from '../../src/lib/voice/asr-server';

const CTX = ['@APP 27L', 'BAW273 speedbird 273 ARR APP approach 9000ft h270 27L', 'AFR684 air france 684 ARR APP approach 11000ft h090 27L',
  'UAL335 united 335 DEP TWR lineup h270 27L', 'DAL572 delta 572 DEP GND taxi h180 27L', 'QFA76 qantas 76 ARR APP approach 7000ft h010 27L',
  'UPS973 ups 973 ARR APP approach 5000ft h300 27L'].join('\n');
const AC = aircraftFromContext(CTX);
const PCTX = { aircraft: AC.map((a) => ({ callsign: a.callsign })) };
const STATE = { text: CTX, callsigns: AC.map((a) => a.callsign) };
const fix = (s: string) => repairTranscript(s, AC);

test('context gives every aircraft with its spoken name', () => {
  assert.deepEqual(AC.slice(0, 2), [{ callsign: 'BAW273', name: 'speedbird 273' }, { callsign: 'AFR684', name: 'air france 684' }]);
});

test('phonetic key: spelling and voicing variants collide', () => {
  for (const [a, b] of [['speedbird', 'speedpert'], ['qantas', 'quantas'], ['heading', 'heating'], ['climb', 'klim'], ['descend', 'decent']]) assert.equal(phoneticKey(a), phoneticKey(b), `${a} / ${b}`);
  assert.notEqual(phoneticKey('delta'), phoneticKey('united'));
});

test('numbers: Whisper digit groupings, ICAO words and homophones become one spoken form', () => {
  assert.deepEqual(normaliseTokens('Climb 1, 3000.'), ['climb', 'one', 'three', 'thousand']);
  assert.deepEqual(normaliseTokens('heading 2-7-0'), ['heading', 'two', 'seven', 'zero']);
  assert.deepEqual(normaliseTokens('descend 4,000'), ['descend', 'four', 'thousand']);
  assert.deepEqual(normaliseTokens('contact tower 118.5'), ['contact', 'tower', 'one', 'one', 'eight', 'decimal', 'five']);
  assert.equal(fix('Air France 684, Climb to flight level 9 or 0.').text, 'air france 684 climb to flight level nine zero');
  assert.match(fix('united 335 fly heading one to six').text, /heading one two six$/);
  assert.match(fix('united 335 heading two for zero').text, /heading two four zero$/);
  assert.match(fix('united 335 heading to one one').text, /heading two one one$/);
  assert.match(fix('qantas 76 descend to four thousand').text, /descend to four thousand$/, '"descend to" keeps its "to"');
  assert.equal(fix('Thank you.').text, '');
  assert.match(fix('qantas 76 reduce 160 not').text, /one six zero knots$/);
  assert.match(fix('speedbird 273 expedite descent').text, /expedite descent$/, 'expedite descent stays');
  assert.match(fix('united 335 descent to 4000').text, /descend to four thousand$/);
  assert.match(fix('Delta 5.7.2 hold position').text, /^delta 572 hold position$/, 'a "." inside the callsign number is a separator');
  assert.match(fix('qantas 76 cleared ILL\'s approach runway 27').text, /cleared ils approach/);
});

test('repair never breaks a transcript the rules already read (the engine phrasing of the gold prompts)', () => {
  // the prompts the owner reads (public/voice/gold-prompts.json) are the engine's own phrasing: the rules parse them
  // compiled to .tmp/<dir>/tests/engine: the repo root is four levels up
  const prompts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../public/voice/gold-prompts.json'), 'utf8')).prompts as { said: string; ctx: string; line: string }[];
  let raw = 0, rep = 0;
  for (const p of prompts) {
    const ac = aircraftFromContext(p.ctx); const ctx = { aircraft: ac.map((a) => ({ callsign: a.callsign })) };
    const cs = p.line.split(' ')[0];
    const a = understand(p.said, ctx, 0), b = understand(repairTranscript(p.said, ac).text, ctx, 0);
    const okA = a.ok && a.line.split(' ')[0] === cs, okB = b.ok && b.line.split(' ')[0] === cs;
    assert.ok(!okA || okB, `repair broke: ${p.said}`);
    raw += +okA; rep += +okB;
  }
  assert.ok(rep >= raw, `${rep} < ${raw}`);
});

test('callsign: phonetic match to the aircraft on frequency', () => {
  const a = fix('Speedpert 2: 73klim 13000');
  assert.equal(a.text, 'speedbird 273 climb one three thousand'); assert.equal(a.callsign, 'BAW273'); assert.equal(a.fuzzy, false);
  assert.equal(fix('Quantas 76 descend and maintain 4,000').callsign, 'QFA76');
  assert.equal(fix('U.P.S. 973 fly heading 102').callsign, 'UPS973');
  // the start was cut off (late microphone): the end of the name + the full number still identify the aircraft
  assert.equal(fix('bird two seven three climb one three thousand').callsign, 'BAW273');
});

test('callsign: no guess when it is ambiguous or not a callsign at all', () => {
  assert.equal(fix('seven three climb one three thousand').callsign, null, '73 ends both BAW273 and UPS973');
  const v = fix('turn left heading 2-7-0');
  assert.equal(v.callsign, null); assert.equal(v.text, 'turn left heading two seven zero');
});

test('callsign: a digit change is flagged for a check', () => {
  const r = fix('delta 582 roger');
  assert.equal(r.callsign, 'DAL572'); assert.equal(r.fuzzy, true);
});

test('n-best: the first alternative the rules can parse wins', async () => {
  const r = await understandHeard(['Speed bird to 73 a climb lever 130', 'Speedbird 2, 73, Climb 1, 3000.'], PCTX, 0, null, STATE);
  assert.equal(r.ok, true); assert.equal(r.alt, 1); assert.match(r.line, /^BAW273 /);
});

test('n-best: a sound-alike callsign with a changed digit is not sent unchecked', async () => {
  const r = await understandHeard(['delta 582 roger'], PCTX, 0, null, STATE);
  assert.equal(r.ok, false); assert.match(r.line, /^DAL572 Roger/i); assert.match(r.error ?? '', /check/i);
});

test('numbers: thousand and hundred scale only their own group', () => {
  assert.equal(runDigits(['three', 'thousand', 'five', 'hundred']), '3500');
  assert.equal(runDigits(['one', 'three', 'thousand']), '13000');
  assert.equal(runDigits(['five', 'hundred', 'fifty']), '550');
  assert.equal(runDigits(['nine', 'sixty', 'three']), '963');
});

test('n-best: a sound-alike callsign does not stop a later guess with the exact callsign', async () => {
  const r = await understandHeard(['speedbird two seven four climb one three thousand', 'speedbird 273 climb one three thousand'], PCTX, 0, null, STATE);
  assert.equal(r.ok, true); assert.equal(r.alt, 1); assert.match(r.line, /^BAW273 /);
});

test('n-best: repair off and n-best off fall back to the plain rules', async () => {
  const r = await understandHeard(['Speedpert 2: 73klim 13000'], PCTX, 0, null, STATE, { repair: false });
  assert.equal(r.ok, false);
});

// ---------- /api/voice/stt guards ----------
const pcm = (sec: number) => new Uint8Array(Math.round(sec * 16000) * 2);
const req = (body: Uint8Array, headers: Record<string, string> = {}) => new Request('http://x/api/voice/stt', { method: 'POST', body: body as unknown as BodyInit, headers: { 'content-type': 'audio/l16', 'x-real-ip': '1.2.3.4', ...headers } });
function deps(over: Partial<SttDeps> = {}): SttDeps & { calls: { names: string[] }[] } {
  const calls: { names: string[] }[] = [];
  return { calls, limiter: new RateLimiter(), gate: new Gate(1), transcribe: async (_a, names) => { calls.push({ names }); return { text: 'speedbird 273 roger', alternatives: ['speedbird 273 roger'], ms: 5, model: 'fake' }; }, ...over };
}

test('stt route: transcribes PCM with the callsign names as hints', async () => {
  const d = deps();
  const res = await handleStt(req(pcm(2), { 'x-stt-names': encodeURIComponent(JSON.stringify(['Speedbird 273', '<script>x', 42])) }), d);
  assert.equal(res.status, 200);
  const j = await res.json() as { text: string; sec: number };
  assert.equal(j.text, 'speedbird 273 roger'); assert.equal(j.sec, 2);
  assert.deepEqual(d.calls[0].names, ['speedbird 273', 'script x']);
});

test('stt route: size, length, format and empty audio', async () => {
  const d = deps();
  assert.equal((await handleStt(req(new Uint8Array(STT_LIMITS.maxBytes + 2)), d)).status, 413, 'body over 1 MB');
  assert.equal((await handleStt(req(pcm(16)), deps())).status, 413, 'over 15 s');
  assert.equal((await handleStt(req(pcm(1), { 'content-type': 'text/plain' }), deps())).status, 415);
  const short = await handleStt(req(pcm(0.1)), d);
  assert.equal(short.status, 200); assert.equal((await short.json() as { text: string }).text, '');
  assert.equal(d.calls.length, 0, 'nothing transcribed');
});

test('stt route: per-IP rate limit', async () => {
  const d = deps({ limiter: new RateLimiter(30, 3) });
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await handleStt(req(pcm(0.5)), d)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await handleStt(req(pcm(0.5), { 'x-real-ip': '5.6.7.8' }), d)).status, 200, 'another client is not limited');
});

test('stt route: busy queue -> 503, slow model -> 504', async () => {
  let release: () => void = () => undefined;
  const slow = new Promise<void>((r) => { release = r; });
  const d = deps({ gate: new Gate(1, 1), transcribe: async () => { await slow; return { text: 'x', alternatives: ['x'], ms: 1, model: 'fake' }; } });
  const first = handleStt(req(pcm(1)), d);
  const second = handleStt(req(pcm(1), { 'x-real-ip': '2.2.2.2' }), d);
  const third = await handleStt(req(pcm(1), { 'x-real-ip': '3.3.3.3' }), d);
  assert.equal(third.status, 503);
  release();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  const t = await handleStt(req(pcm(1)), deps({ timeoutMs: 20, transcribe: () => new Promise((r) => setTimeout(() => r({ text: '', alternatives: [], ms: 0, model: 'fake' }), 200)) }));
  assert.equal(t.status, 504);
});

test('stt gate: a finished job hands its slot to the next waiter (never two at once)', async () => {
  const g = new Gate(1, 4); let active = 0, peak = 0;
  const job = (ms: number) => g.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, ms)); active--; return ms; });
  const a = job(20); const b = job(5);
  await a; const c = job(5);   // arrives in the same tick the slot is handed to b
  await Promise.all([b, c]);
  assert.equal(peak, 1); assert.equal(g.busy, 0);
});

test('stt route: a request that timed out while queued is not transcribed later', async () => {
  let release: () => void = () => undefined;
  const slow = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const d = deps({ gate: new Gate(1, 4), timeoutMs: 30, transcribe: async () => { calls++; await slow; return { text: 'x', alternatives: ['x'], ms: 1, model: 'fake' }; } });
  const first = handleStt(req(pcm(1)), d);
  const queued = await handleStt(req(pcm(1), { 'x-real-ip': '9.9.9.9' }), d);
  assert.equal(queued.status, 504);
  release(); await first; await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'the abandoned job was skipped');
});

test('stt route: WAV decoding and header parsing', () => {
  const n = 1600, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  v.setInt16(44, 16384, true);
  const a = decodeAudio(b, 'audio/wav');
  assert.ok(a instanceof Float32Array); assert.equal(a.length, n); assert.equal(a[0], 0.5);
  v.setUint32(24, 44100, true);
  assert.match(String(decodeAudio(b, 'audio/wav')), /16 kHz/);
  assert.deepEqual(parseNames('not json'), []);
  assert.equal(parseNames(encodeURIComponent(JSON.stringify(Array(99).fill('delta 1')))).length, STT_LIMITS.maxNames);
});

test('server prompt lists the callsigns as Whisper should write them', () => {
  const p = buildPrompt(['speedbird 273', 'air france 684', 'speedbird 273']);
  assert.match(p, /Speedbird 273, Air France 684\./);
  assert.equal(buildPrompt([]), '');
});

// ---------- two server engines: Parakeet first, Whisper when not understood (ml/stt/models/SERVER.md) ----------
test('stt engine: ?engine= or X-STT-Engine picks it, else OPENATC_STT_FIRST (default parakeet)', async () => {
  const r = (q = '', h: Record<string, string> = {}) => new Request(`http://x/api/voice/stt${q}`, { method: 'POST', headers: h });
  assert.equal(firstEngine({}), 'parakeet');
  assert.equal(firstEngine({ OPENATC_STT_FIRST: 'whisper' }), 'whisper');
  assert.equal(firstEngine({ OPENATC_STT_FIRST: 'nonsense' }), 'parakeet');
  assert.equal(pickEngine(r(), {}), 'parakeet');
  assert.equal(pickEngine(r(), { OPENATC_STT_FIRST: ' Whisper ' }), 'whisper');
  assert.equal(pickEngine(r('?engine=whisper'), {}), 'whisper');
  assert.equal(pickEngine(r('?engine=parakeet'), { OPENATC_STT_FIRST: 'whisper' }), 'parakeet', 'the request wins over the default');
  assert.equal(pickEngine(r('', { 'x-stt-engine': 'WHISPER' }), {}), 'whisper');
  assert.equal(pickEngine(r('?engine=parakeet', { 'x-stt-engine': 'whisper' }), {}), 'parakeet', 'the query wins over the header');
  assert.equal(pickEngine(r('?engine=gpt', { 'x-stt-engine': 'x' }), { OPENATC_STT_FIRST: 'whisper' }), 'whisper', 'unknown: the default');
  // the route hands the choice to the engine, behind the same guards
  const seen: SttEngineId[] = [];
  const d = deps({ env: { OPENATC_STT_FIRST: 'whisper' }, transcribe: async (_a, _n, _alt, engine) => { seen.push(engine); return { text: '', alternatives: [], ms: 1, model: engine }; } });
  await handleStt(req(pcm(1)), d);
  await handleStt(new Request('http://x/api/voice/stt?engine=parakeet', { method: 'POST', body: pcm(1) as unknown as BodyInit, headers: { 'content-type': 'audio/l16' } }), d);
  assert.deepEqual(seen, ['whisper', 'parakeet']);
});

test('parakeet hotwords: telephony words of the callsigns on frequency, lower and title case, at most 25', () => {
  assert.equal(hotwordsFor(['speedbird 273', 'air france 684', 'speedbird 50', 'n123ab', '42']), 'speedbird/Speedbird/air france/Air France/n123ab/N123ab');
  assert.equal(hotwordsFor([]), '');
  const many = Array.from({ length: 40 }, (_, i) => `airline${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''} ${i}`);
  assert.equal(hotwordsFor(many).split('/').length, 50);
  // the sentencepiece-style vocab sherpa needs, from the model's tokens.txt (as ml/stt/models/srv_run.py writes it)
  assert.equal(bpeVocab('<unk> 0\n<|nospeech|> 1\n▁the 2\ns 3\n▁Speed 4\n'), '▁the\t-1\ns\t-1\n▁Speed\t-1\n');
  assert.equal(parakeetReady({ dir: '/nonexistent/parakeet', threads: 2 }), false);
  assert.match(parakeetConfig({ OPENATC_STT_CACHE: '/c' }).dir, /^\/c\/parakeet-ultra-int8$/);
  assert.equal(parakeetConfig({ OPENATC_STT_PARAKEET_DIR: '/m', OPENATC_STT_THREADS: '9' }).dir, '/m');
  assert.equal(parakeetConfig({ OPENATC_STT_THREADS: '9' }).threads, 3, 'never more than 3 threads');
});

/** A fake server: each engine's guesses for the one transmission, and the calls it got. */
function fakeServer(replies: Partial<Record<SttEngine | 'default', SttReply | Error>>) {
  const calls: { engine: SttEngine | undefined; names: string[]; samples: number }[] = [];
  const post = async (audio: Float32Array, names: string[], engine?: SttEngine): Promise<SttReply> => {
    calls.push({ engine, names, samples: audio.length });
    const r = replies[engine ?? 'default'];
    if (!r) throw new Error('no reply');
    if (r instanceof Error) throw r;
    return r;
  };
  return { post, calls };
}
const reply = (model: string, ...alternatives: string[]): SttReply => ({ text: alternatives[0] ?? '', alternatives, ms: 1, model });
const read = (alts: string[]) => understandHeard(alts, PCTX, 0, null, STATE);
const AUDIO = new Float32Array(16000);

test('stt cascade: Parakeet understood -> Whisper is not asked', async () => {
  const s = fakeServer({ default: reply('parakeet-ultra-int8', 'Speedbird 273 climb one three thousand') });
  const r = await cascadeStt(AUDIO, ['speedbird 273'], read, { post: s.post });
  assert.equal(r.result?.ok, true); assert.match(r.result?.line ?? '', /^BAW273 /);
  assert.deepEqual(s.calls.map((c) => c.engine), [undefined], 'one request, to the server\'s first pass');
  assert.deepEqual(r.alts, ['Speedbird 273 climb one three thousand']);
});

test('stt cascade: not understood -> Whisper on the same audio, both lists read together', async () => {
  const s = fakeServer({ default: reply('parakeet-ultra-int8', 'Speed bird to 73 a climb lever 130'), whisper: reply('whisper-base.en', 'Speedbird 2, 73, Climb 1, 3000.', 'speed bird 273 climb') });
  const lists: string[][] = [];
  const r = await cascadeStt(AUDIO, ['speedbird 273'], (a) => { lists.push(a); return read(a); }, { post: s.post });
  assert.deepEqual(s.calls.map((c) => c.engine), [undefined, 'whisper']);
  assert.ok(s.calls.every((c) => c.samples === AUDIO.length && c.names[0] === 'speedbird 273'), 'same audio and callsigns');
  assert.deepEqual(lists[1], ['Speed bird to 73 a climb lever 130', 'Speedbird 2, 73, Climb 1, 3000.', 'speed bird 273 climb'], 'interleaved, Parakeet first');
  assert.equal(r.result?.ok, true); assert.match(r.result?.line ?? '', /^BAW273 /);
  assert.equal(r.alts.length, 3);
});

test('stt cascade: Whisper already answered, failures and the Server recogniser\'s own first pass', async () => {
  // the server's first pass was Whisper (OPENATC_STT_FIRST=whisper, or no Parakeet files): no second request
  let s = fakeServer({ default: reply('whisper-base.en', 'delta 582 roger'), whisper: reply('whisper-base.en', 'x') });
  let r = await cascadeStt(AUDIO, [], read, { post: s.post });
  assert.equal(s.calls.length, 1); assert.equal(r.result?.ok, false);
  // Parakeet failed (busy, timed out): Whisper still gets the audio; the error is reported
  s = fakeServer({ default: new Error('speech server busy, try again'), whisper: reply('whisper-base.en', 'speedbird 273 climb one three thousand') });
  r = await cascadeStt(AUDIO, [], read, { post: s.post });
  assert.deepEqual(s.calls.map((c) => c.engine), [undefined, 'whisper']); assert.equal(r.result?.ok, true); assert.match(r.error ?? '', /busy/);
  // both failed: nothing, no throw
  s = fakeServer({});
  r = await cascadeStt(AUDIO, [], read, { post: s.post });
  assert.equal(r.result, null); assert.deepEqual(r.alts, []);
  // the Server recogniser already has Parakeet's reply (and the game already read it): only Whisper is asked
  s = fakeServer({ whisper: reply('whisper-base.en', 'speedbird 273 climb one three thousand') });
  r = await cascadeStt(AUDIO, [], read, { post: s.post, asked: reply('parakeet-ultra-int8', 'speed bird 274 climb') });
  assert.deepEqual(s.calls.map((c) => c.engine), ['whisper']); assert.equal(r.result?.ok, true);
  assert.deepEqual(r.alts, ['speed bird 274 climb', 'speedbird 273 climb one three thousand']);
});

test('stt cascade: the later reading wins only when understood or more confident', () => {
  const a = { ok: false, confidence: 0.6 }, b = { ok: false, confidence: 0.4 }, c = { ok: true, confidence: 0.1 };
  assert.equal(better(a, b), a); assert.equal(better(b, a), a); assert.equal(better(a, c), c);
  assert.equal(better(null, b), b); assert.equal(better(a, null), a); assert.equal(better(null, null), null);
});

// the owner's real recordings (ml/data/gold, 2026-11-09): what Parakeet and Google wrote, read by the rules after cleanup
test('real-voice slips: runway to five, a clipped name, hand off to, speed to', () => {
  const ctx = (lines: string[]) => { const ac = aircraftFromContext(lines.join('\n')); return { ac, pctx: { aircraft: ac.map((a) => ({ callsign: a.callsign })), runways: ['25L', '25R', '07L', '07R'] } }; };
  const hk = ctx(['@GND 25L', 'HKE528 hong kong express 528 DEP GND stand h070 25L', 'CPA222 cathay 222 DEP GND stand h070 25L']);
  const r1 = repairTranscript('Hong Kong Express five to eight, pushback approved, expect runway to five left.', hk.ac);
  assert.match(r1.text, /528 pushback approved expect runway two five left$/);
  assert.equal(understand(r1.text, hk.pctx).line, 'HKE528 Pushback approved, expect 25L');
  const jb = ctx(['@APP 22L', 'JBU422 jetblue 422 ARR APP approach 5000ft h040 22L', 'VIR48 virgin 48 ARR APP approach 7000ft h040 22L']);
  assert.equal(repairTranscript('Jack Blue, four twenty-two, Roger.', jb.ac).text, 'jetblue 422 roger');
  const ez = ctx(['@APP 27L', 'EZY532 easy 532 ARR APP approach 5000ft h270 27L', 'BAW327 speedbird 327 ARR APP approach 8000ft h270 27L']);
  assert.match(repairTranscript('Easy five three two hand off to cover.', ez.ac).text, /contact tower$/);
  assert.match(repairTranscript('easy 532 Handoffs to Tower.', ez.ac).text, /contact tower$/);
  assert.match(repairTranscript('Air India 504 cleared wireless approach Ranveer 29 lakh', ez.ac).text, /cleared ils approach runway two nine left$/);
  // "speed to 90" is a missing digit, never 290
  assert.match(repairTranscript('easy 532 increase speed to 90 knots', ez.ac).text, /speed to nine zero knots$/);
});
