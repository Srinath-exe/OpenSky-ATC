// Real-voice gold set (ml/stt/GOLD.md): the prompt set is well formed, and the recording API (src/app/api/voice/gold)
// guards the public endpoint (key, WAV format, sizes, prompt ids, clip cap), saves, lists, serves and overwrites clips.
// The handlers are called directly with a temp GOLD_DIR and a small GOLD_PROMPTS file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GET, POST } from '../../src/app/api/voice/gold/route';
import { parseCommand } from '../../src/lib/sim/commands';

const KEY = 'test-key-0123456789abcdef';
let dir = '';
const URL_ = 'http://localhost/api/voice/gold';

function wav({ rate = 16000, ch = 1, bits = 16, sec = 1, hz = 440, riff = 'RIFF' } = {}): Uint8Array {
  const n = Math.round(rate * sec), bps = bits / 8, data = n * ch * bps;
  const b = Buffer.alloc(44 + data);
  b.write(riff, 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * bps, 28); b.writeUInt16LE(ch * bps, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40);
  for (let i = 0; i < n * ch; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * Math.floor(i / ch)) / rate) * 8000);
    if (bits === 16) b.writeInt16LE(v, 44 + i * 2); else b.writeUInt8(128 + (v >> 8), 44 + i);
  }
  return new Uint8Array(b);
}

function post(id: string, body: Uint8Array | null, meta: string = '{}', key: string | null = KEY): Promise<Response> {
  const form = new FormData();
  form.set('id', id);
  if (body) form.set('wav', new Blob([body as BlobPart], { type: 'audio/wav' }), 'clip.wav');
  form.set('meta', meta);
  const headers: Record<string, string> = { 'user-agent': 'gold-test' };
  if (key != null) headers['x-gold-key'] = key;
  return POST(new Request(URL_, { method: 'POST', headers, body: form }));
}
const get = (q = '', key: string | null = KEY) => GET(new Request(URL_ + q, { headers: key != null ? { 'x-gold-key': key } : {} }));

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-test-'));
  fs.writeFileSync(path.join(dir, '.key'), KEY + '\n');
  const prompts = [{ id: 'v01', group: 'val', kind: 'heading', icao: 'KJFK', line: 'DAL76 Fly heading 270' },
    { id: 's01', group: 'sydney', kind: 'altitude', icao: 'YSSY', line: 'QFA1 Altitude 5000' }];
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify({ version: 1, prompts }));
  process.env.GOLD_DIR = dir;
  process.env.GOLD_PROMPTS = path.join(dir, 'prompts.json');
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.GOLD_DIR; delete process.env.GOLD_PROMPTS; });

test('prompt set: 100 prompts (60 validation, 30 Sydney, 10 own-way), unique ids, every gold line parses for its aircraft', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/voice/gold-prompts.json'), 'utf8')) as { prompts: any[] };
  const ps = doc.prompts;
  assert.equal(ps.length, 100);
  assert.equal(new Set(ps.map(p => p.id)).size, 100);
  const by = (g: string) => ps.filter(p => p.group === g).length;
  assert.deepEqual([by('val'), by('sydney'), by('free')], [60, 30, 10]);
  assert.ok(ps.filter(p => p.group === 'sydney').every(p => p.icao === 'YSSY'));
  assert.ok(ps.filter(p => p.group !== 'sydney').every(p => p.icao !== 'YSSY'));
  assert.ok(new Set(ps.map(p => p.kind)).size >= 20, 'covers the rarer command kinds too');
  for (const p of ps) {
    assert.match(p.id, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(p.said && p.intent && p.ctx && Array.isArray(p.callsigns), p.id);
    assert.equal(p.show, p.group === 'free' ? 'intent' : 'read');
    if (p.expect === 'say again') { assert.equal(p.line, 'SAY AGAIN'); continue; }
    const cs = p.line.split(' ')[0];
    assert.ok(p.callsigns.includes(cs), `${p.id}: ${cs} on frequency`);
    const r = parseCommand(p.line, { aircraft: p.callsigns.map((callsign: string) => ({ callsign })) });
    assert.ok(r.ok && r.ast, `${p.id}: "${p.line}" parses`);
  }
});

test('key: required on every request, wrong key rejected, no key file = recording off', async () => {
  assert.equal((await post('v01', wav(), '{}', null)).status, 401);
  assert.equal((await post('v01', wav(), '{}', 'wrong-key-0123456789')).status, 401);
  assert.equal((await post('v01', wav(), '{}', KEY.slice(0, -1))).status, 401);
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('?clip=v01', 'nope')).status, 401);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-nokey-'));
  process.env.GOLD_DIR = empty;
  try {
    assert.equal((await post('v01', wav())).status, 503);
    assert.equal((await get()).status, 503);
  } finally { process.env.GOLD_DIR = dir; fs.rmSync(empty, { recursive: true, force: true }); }
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.wav')).length, 0);
});

test('validation: prompt ids, WAV format, sizes, metadata', async () => {
  const status = async (p: Promise<Response>) => (await p).status;
  assert.equal(await status(post('v99', wav())), 400, 'id not in the prompt set');
  assert.equal(await status(post('../../etc/passwd', wav())), 400, 'path traversal');
  assert.equal(await status(post('v01/../s01', wav())), 400);
  assert.equal(await status(post('V01', wav())), 400);
  assert.equal(await status(post('v01', null)), 400, 'no wav');
  assert.equal(await status(post('v01', new TextEncoder().encode('hello, not audio at all, definitely not a wav file ...'))), 400);
  assert.equal(await status(post('v01', wav({ riff: 'RIFX' }))), 400);
  assert.equal(await status(post('v01', wav({ rate: 44100 }))), 400, '44.1 kHz');
  assert.equal(await status(post('v01', wav({ rate: 48000 }))), 400, '48 kHz');
  assert.equal(await status(post('v01', wav({ ch: 2 }))), 400, 'stereo');
  assert.equal(await status(post('v01', wav({ bits: 8 }))), 400, '8-bit');
  assert.equal(await status(post('v01', wav({ sec: 0.05 }))), 400, 'too short');
  const trunc = wav({ sec: 1 }).slice(0, 2000);
  assert.equal(await status(post('v01', trunc)), 400, 'data chunk runs past the end');
  assert.equal(await status(post('v01', wav({ sec: 50 }))), 413, '> 1.5 MB');
  assert.equal(await status(post('v01', wav(), 'x'.repeat(17000))), 413, 'meta > 16 KB');
  assert.equal(await status(post('v01', wav(), '{not json')), 400);
  const raw = await POST(new Request(URL_, { method: 'POST', headers: { 'x-gold-key': KEY, 'content-type': 'audio/wav' }, body: wav() as BodyInit }));
  assert.equal(raw.status, 415, 'multipart only');
  assert.equal(fs.readdirSync(dir).filter(f => f !== '.key' && f !== 'prompts.json').length, 0, 'nothing written by a rejected request');
});

test('save, list, serve, overwrite', async () => {
  const meta = { browserTranscript: 'delta 76 fly heading 270', browserFinal: true, browserAlternatives: [{ transcript: 'delta 76 fly heading 270', confidence: 0.9 }],
    browserEngine: 'webkitSpeechRecognition', mode: 'hold', inputRate: 16000, clientSec: 1.2, take: 1, track: { echoCancellation: true, sampleRate: 48000, label: 'Mic' },
    injected: '../../x', password: 'should be dropped' };
  const r = await post('v01', wav({ sec: 1.2 }), JSON.stringify(meta));
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json() as { ok: boolean; id: string; sec: number; count: number; overwritten: boolean };
  assert.deepEqual([body.ok, body.id, body.count, body.overwritten], [true, 'v01', 1, false]);
  assert.ok(Math.abs(body.sec - 1.2) < 0.01);
  const saved = fs.readFileSync(path.join(dir, 'v01.wav'));
  assert.equal(saved.toString('ascii', 0, 4), 'RIFF'); assert.equal(saved.readUInt32LE(24), 16000); assert.equal(saved.length, 44 + 1.2 * 32000);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'v01.json'), 'utf8'));
  assert.equal(rec.id, 'v01'); assert.equal(rec.prompt.line, 'DAL76 Fly heading 270'); assert.equal(rec.userAgent, 'gold-test');
  assert.equal(rec.browserTranscript, 'delta 76 fly heading 270'); assert.equal(rec.mode, 'hold'); assert.equal(rec.track.label, 'Mic');
  assert.ok(rec.savedAt && rec.sha256.length === 64);
  assert.equal(rec.injected, undefined); assert.equal(rec.password, undefined);

  const list = await (await get()).json() as { ids: string[]; count: number; total: number };
  assert.deepEqual(list, { ids: ['v01'], count: 1, total: 2 });
  const clip = await get('?clip=v01');
  assert.equal(clip.status, 200); assert.equal(clip.headers.get('content-type'), 'audio/wav');
  assert.ok(Buffer.from(await clip.arrayBuffer()).equals(saved));
  assert.equal((await get('?clip=s01')).status, 404, 'valid prompt, not recorded');
  assert.equal((await get('?clip=../v01')).status, 400);

  const r2 = await post('v01', wav({ sec: 2, hz: 300 }), JSON.stringify({ browserTranscript: 'second take', take: 2 }));
  const b2 = await r2.json() as { count: number; overwritten: boolean };
  assert.deepEqual([r2.status, b2.count, b2.overwritten], [200, 1, true]);
  assert.equal(fs.readFileSync(path.join(dir, 'v01.wav')).length, 44 + 2 * 32000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'v01.json'), 'utf8')).browserTranscript, 'second take');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0, 'atomic writes leave no temp files');
});

test('cap: at most 3000 clips; overwriting still works when full', async () => {
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `x${i}.wav`), '');
  try {
    assert.equal((await post('s01', wav())).status, 507);
    assert.equal((await post('v01', wav())).status, 200);
  } finally { for (let i = 0; i < 3000; i++) fs.rmSync(path.join(dir, `x${i}.wav`)); }
  assert.equal((await post('s01', wav())).status, 200);
  assert.deepEqual(((await (await get()).json()) as { ids: string[] }).ids, ['s01', 'v01']);
});
