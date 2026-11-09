/*
  /api/voice/gold — the real-voice gold set (ml/stt/GOLD.md). The project owner reads the fixed prompts of
  public/voice/gold-prompts.json on /voice/record.html; ml/stt/score_gold.py scores the clips later.

  POST  multipart/form-data {id: prompt id, wav: 16 kHz mono 16-bit PCM WAV, meta: JSON}  -> {ok, id, sec, bytes, count, overwritten}
  GET                                                                                       -> {ids, count, total}
  GET   ?clip=<prompt id>                                                                   -> the saved WAV

  The site is public, the recordings are not: every request carries the key from <GOLD_DIR>/.key in the x-gold-key
  header (the file is read per request, compared in constant time; no file = recording is off). Files are named by the
  server from the prompt id, which must be in the prompt set. Re-recording a prompt overwrites it.
  GOLD_DIR (default: ml/data/gold of the checkout) and GOLD_PROMPTS (default: public/voice/gold-prompts.json) are
  overridable for tests and the dry run.
*/
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WAV = 1_500_000;                   // bytes per clip (~46 s at 16 kHz 16-bit mono)
const MAX_META = 16_384;                     // bytes of client metadata JSON
const MAX_BODY = MAX_WAV + MAX_META + 16_384; // + multipart framing
const MAX_CLIPS = 3000;
const MIN_SEC = 0.2;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// live attempts (push-to-talk in the game or the demo, saved when the owner's key is in the browser): free speech with
// what every recogniser heard and what the game decided, kept apart from the prompt set in <GOLD_DIR>/live/
const LIVE_RE = /^live-\d{13}-[a-z0-9]{4}$/;
const MAX_LIVE = 2000;

interface PromptInfo { group: string; kind: string; icao: string; line: string }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function goldDir(): string {
  if (process.env.GOLD_DIR) return process.env.GOLD_DIR;
  // dev and tests run in the checkout; the live server runs in .next/standalone inside it
  const cwd = process.cwd(), parts = ['ml', 'data', 'gold'];
  return cwd.endsWith(path.join('.next', 'standalone')) ? path.join(cwd, '..', '..', ...parts) : path.join(cwd, ...parts);
}

let promptCache: { file: string; mtime: number; ids: Map<string, PromptInfo> } | null = null;
async function promptSet(): Promise<Map<string, PromptInfo>> {
  const file = process.env.GOLD_PROMPTS || path.join(process.cwd(), 'public', 'voice', 'gold-prompts.json');
  const st = await fs.stat(file);
  if (promptCache && promptCache.file === file && promptCache.mtime === st.mtimeMs) return promptCache.ids;
  const doc = JSON.parse(await fs.readFile(file, 'utf8')) as { prompts: ({ id: string } & PromptInfo)[] };
  const ids = new Map<string, PromptInfo>();
  for (const p of doc.prompts) if (ID_RE.test(p.id)) ids.set(p.id, { group: p.group, kind: p.kind, icao: p.icao, line: p.line });
  promptCache = { file, mtime: st.mtimeMs, ids };
  return ids;
}

/** null when the request may proceed, else the error response. */
async function authorise(req: Request, dir: string): Promise<Response | null> {
  let key = '';
  try { key = (await fs.readFile(path.join(dir, '.key'), 'utf8')).trim(); } catch { /* no key file: recording is off */ }
  if (key.length < 16) return json({ error: 'gold recording is not enabled on this server' }, 503);
  const got = req.headers.get('x-gold-key') ?? '';
  const a = createHash('sha256').update(key).digest(), b = createHash('sha256').update(got).digest();
  if (!got || !timingSafeEqual(a, b)) return json({ error: 'missing or wrong key' }, 401);
  return null;
}

type Wav = { ok: true; wav: Buffer; sec: number } | { ok: false; error: string };
/** RIFF/WAVE, PCM, 16 kHz, mono, 16-bit. Returns a canonical 44-byte-header copy (extra chunks dropped). */
function checkWav(b: Buffer): Wav {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, error: 'not a RIFF/WAVE file' };
  let o = 12, fmt: Buffer | null = null, data: Buffer | null = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4), body = o + 8;
    if (body + n > b.length) return { ok: false, error: `chunk "${id}" runs past the end of the file` };
    if (id === 'fmt ') fmt = b.subarray(body, body + n);
    else if (id === 'data') { data = b.subarray(body, body + n); break; }
    o = body + n + (n & 1);
  }
  if (!fmt || fmt.length < 16) return { ok: false, error: 'no fmt chunk' };
  if (!data) return { ok: false, error: 'no data chunk' };
  const format = fmt.readUInt16LE(0), channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  if (format !== 1) return { ok: false, error: `PCM only (format ${format})` };
  if (channels !== 1) return { ok: false, error: `mono only (${channels} channels)` };
  if (rate !== 16000) return { ok: false, error: `16 kHz only (${rate} Hz)` };
  if (bits !== 16) return { ok: false, error: `16-bit only (${bits}-bit)` };
  const pcm = data.subarray(0, data.length - (data.length & 1));
  const sec = pcm.length / 32000;
  if (sec < MIN_SEC) return { ok: false, error: `too short (${sec.toFixed(2)} s)` };
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return { ok: true, wav: Buffer.concat([h, pcm]), sec };
}

/** The request body, or null when it is larger than `cap` (stops reading as soon as it is). */
async function readCapped(req: Request, cap: number): Promise<Buffer | null> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > cap) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Only the known client fields, bounded. */
function cleanMeta(raw: unknown): Record<string, unknown> {
  const m = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const alts = Array.isArray(m.browserAlternatives) ? m.browserAlternatives.slice(0, 8).map((a) => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    return { transcript: str(x.transcript, 1000), confidence: num(x.confidence) };
  }) : [];
  const track: Record<string, string | number | boolean> = {};
  if (m.track && typeof m.track === 'object' && !Array.isArray(m.track)) {
    for (const [k, v] of Object.entries(m.track as Record<string, unknown>).slice(0, 24)) {
      if (/^[A-Za-z]{1,32}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) track[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    }
  }
  return {
    browserTranscript: str(m.browserTranscript, 2000), browserFinal: typeof m.browserFinal === 'boolean' ? m.browserFinal : null,
    browserAlternatives: alts, browserEngine: str(m.browserEngine, 40), browserError: str(m.browserError, 200),
    mode: m.mode === 'hold' || m.mode === 'toggle' ? m.mode : null, inputRate: num(m.inputRate), clientSec: num(m.clientSec),
    take: num(m.take), clientTs: str(m.clientTs, 40), track,
  };
}

function cleanLive(raw: unknown): Record<string, unknown> {
  const m = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 8).map((x) => str(x, 500)).filter((x): x is string => !!x) : []);
  const tr = (m.transcripts && typeof m.transcripts === 'object' && !Array.isArray(m.transcripts) ? m.transcripts : {}) as Record<string, unknown>;
  const transcripts: Record<string, string[]> = {};
  for (const k of ['browser', 'server', 'local', 'native']) { const l = list(tr[k]); if (l.length) transcripts[k] = l; }
  return {
    page: m.page === 'game' || m.page === 'demo' ? m.page : null, engine: str(m.engine, 20), accent: str(m.accent, 12), ctx: str(m.ctx, 8000),
    transcripts, heard: str(m.heard, 500), line: str(m.line, 300), ok: typeof m.ok === 'boolean' ? m.ok : null, source: str(m.source, 8),
    sayAgain: typeof m.sayAgain === 'boolean' ? m.sayAgain : null, error: str(m.error, 300), confidence: num(m.confidence),
    expected: str(m.expected, 300), example: num(m.example), clientTs: str(m.clientTs, 40),
  };
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function savedIds(dir: string, prompts: Map<string, PromptInfo>): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.wav') && prompts.has(n.slice(0, -4))).map((n) => n.slice(0, -4)).sort();
}

export async function POST(req: Request): Promise<Response> {
  const dir = goldDir();
  const denied = await authorise(req, dir);
  if (denied) return denied;
  const ct = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;/i.test(ct)) return json({ error: 'multipart/form-data body required (id, wav, meta)' }, 415);
  const body = await readCapped(req, MAX_BODY);
  if (!body) return json({ error: `body larger than ${MAX_BODY} bytes` }, 413);
  let form: FormData;
  try { form = await new Response(new Uint8Array(body), { headers: { 'content-type': ct } }).formData(); }
  catch { return json({ error: 'malformed multipart body' }, 400); }
  const id = form.get('id');
  const prompts = await promptSet();
  const live = typeof id === 'string' && LIVE_RE.test(id);
  if (typeof id !== 'string' || (!live && (!ID_RE.test(id) || !prompts.has(id)))) return json({ error: 'unknown prompt id' }, 400);
  const file = form.get('wav');
  if (!file || typeof file === 'string') return json({ error: 'wav file required' }, 400);
  if (file.size > MAX_WAV) return json({ error: `clip larger than ${MAX_WAV} bytes` }, 413);
  const metaRaw = form.get('meta') ?? '{}';
  if (typeof metaRaw !== 'string') return json({ error: 'meta must be a JSON string' }, 400);
  if (Buffer.byteLength(metaRaw) > MAX_META) return json({ error: `meta larger than ${MAX_META} bytes` }, 413);
  let meta: unknown;
  try { meta = JSON.parse(metaRaw); } catch { return json({ error: 'meta is not valid JSON' }, 400); }
  const w = checkWav(Buffer.from(await file.arrayBuffer()));
  if (!w.ok) return json({ error: w.error }, 400);

  if (live) {
    const ldir = path.join(dir, 'live');
    await fs.mkdir(ldir, { recursive: true });
    if ((await fs.readdir(ldir)).filter((n) => n.endsWith('.wav')).length >= MAX_LIVE) return json({ error: `live attempts are full (${MAX_LIVE})` }, 507);
    const rec = { id, savedAt: new Date().toISOString(), userAgent: (req.headers.get('user-agent') ?? '').slice(0, 400), bytes: w.wav.length,
      sec: Math.round(w.sec * 1000) / 1000, sha256: createHash('sha256').update(w.wav).digest('hex'), ...cleanLive(meta) };
    await writeAtomic(path.join(ldir, `${id}.json`), JSON.stringify(rec, null, 1));
    await writeAtomic(path.join(ldir, `${id}.wav`), w.wav);
    return json({ ok: true, id, sec: rec.sec, live: true });
  }
  await fs.mkdir(dir, { recursive: true });
  const before = await savedIds(dir, prompts);
  const overwritten = before.includes(id);
  const all = (await fs.readdir(dir)).filter((n) => n.endsWith('.wav')).length;
  if (!overwritten && all >= MAX_CLIPS) return json({ error: `the gold set is full (${MAX_CLIPS} clips)` }, 507);
  const p = prompts.get(id)!;
  const record = {
    id, prompt: p, savedAt: new Date().toISOString(), userAgent: (req.headers.get('user-agent') ?? '').slice(0, 400),
    bytes: w.wav.length, sec: Math.round(w.sec * 1000) / 1000, sha256: createHash('sha256').update(w.wav).digest('hex'), ...cleanMeta(meta),
  };
  // metadata first, then the audio: a failed audio write leaves the previous take's WAV with a sha256 that no longer
  // matches (detectable), never new audio described by the old take's metadata; a new prompt's orphan JSON is removed
  const jsonPath = path.join(dir, `${id}.json`);
  await writeAtomic(jsonPath, JSON.stringify(record, null, 1));
  try { await writeAtomic(path.join(dir, `${id}.wav`), w.wav); }
  catch (err) { if (!overwritten) await fs.rm(jsonPath, { force: true }).catch(() => undefined); throw err; }
  return json({ ok: true, id, sec: record.sec, bytes: record.bytes, count: before.length + (overwritten ? 0 : 1), overwritten });
}

export async function GET(req: Request): Promise<Response> {
  const dir = goldDir();
  const denied = await authorise(req, dir);
  if (denied) return denied;
  const prompts = await promptSet();
  const clip = new URL(req.url).searchParams.get('clip');
  if (clip != null) {
    if (!ID_RE.test(clip) || !prompts.has(clip)) return json({ error: 'unknown prompt id' }, 400);
    let buf: Buffer;
    try { buf = await fs.readFile(path.join(dir, `${clip}.wav`)); } catch { return json({ error: 'not recorded' }, 404); }
    return new Response(new Uint8Array(buf), { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } });
  }
  const ids = await savedIds(dir, prompts);
  return json({ ids, count: ids.length, total: prompts.size });
}
