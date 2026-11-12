// The tutorial's sound: narration and radio voices (with word timings for the synced captions), sound effects and a
// music bed, made with ElevenLabs from src/game/Tutorial/voice.json into public/learn/audio/. Cached by text: only new or
// changed lines are made again. The key stays on this machine (ELEVENLABS_API_KEY in .env.local); the browser only ever
// gets the files.
//   node scripts/learn_audio.mjs            (FORCE=id1,id2 to remake some)
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const env = fs.existsSync(`${ROOT}/.env.local`) ? Object.fromEntries(fs.readFileSync(`${ROOT}/.env.local`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
const KEY = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('no ELEVENLABS_API_KEY'); process.exit(1); }
const S = JSON.parse(fs.readFileSync(`${ROOT}/src/game/Tutorial/voice.json`, 'utf8'));
const OUT = `${ROOT}/public/learn/audio`; fs.mkdirSync(OUT, { recursive: true });
const IDX = `${OUT}/index.json`;
const idx = fs.existsSync(IDX) ? JSON.parse(fs.readFileSync(IDX, 'utf8')) : { lines: {}, sfx: {}, music: {} };
const force = new Set((process.env.FORCE || '').split(',').filter(Boolean));
const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
const API = 'https://api.elevenlabs.io/v1';
async function post(url, body, json = true) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${API}${url}`, { method: 'POST', headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: json ? 'application/json' : 'audio/mpeg' }, body: JSON.stringify(body) });
    if (r.ok) return json ? r.json() : Buffer.from(await r.arrayBuffer());
    const t = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); continue; }
    throw new Error(`${r.status} ${t.slice(0, 300)}`);
  }
  throw new Error('gave up');
}
// characters with times -> words with [start, end] seconds (spaces split words; punctuation stays on its word)
function words(al) {
  const out = []; let w = '', t0 = 0, t1 = 0;
  al.characters.forEach((c, i) => {
    if (/\s/.test(c)) { if (w) out.push([w, +t0.toFixed(3), +t1.toFixed(3)]); w = ''; return; }
    if (!w) t0 = al.character_start_times_seconds[i];
    w += c; t1 = al.character_end_times_seconds[i];
  });
  if (w) out.push([w, +t0.toFixed(3), +t1.toFixed(3)]);
  return out;
}
const save = () => fs.writeFileSync(IDX, JSON.stringify(idx));

// every call the lessons suggest, in the controller's voice (src/game/Tutorial/calls.json, written by the tutor tests)
const CALLS = fs.existsSync(`${ROOT}/src/game/Tutorial/calls.json`) ? JSON.parse(fs.readFileSync(`${ROOT}/src/game/Tutorial/calls.json`, 'utf8')) : {};
for (const [id, text] of Object.entries(CALLS)) S.lines.push({ id, voice: 'controller', text, call: true });
for (const L of S.lines) {
  const voice = S.voices[L.voice]; const h = hash([voice, L.text, 'v2']);
  if (idx.lines[L.id]?.h === h && !force.has(L.id) && fs.existsSync(`${OUT}/${L.id}.mp3`)) continue;
  const settings = L.voice === 'narrator' ? { stability: 0.42, similarity_boost: 0.82, style: 0.38, use_speaker_boost: true } : { stability: 0.55, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true };
  const r = await post(`/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, { text: L.text, model_id: 'eleven_multilingual_v2', voice_settings: settings });
  fs.writeFileSync(`${OUT}/${L.id}.mp3`, Buffer.from(r.audio_base64, 'base64'));
  const w = words(r.alignment);
  idx.lines[L.id] = { h, dur: w.length ? w[w.length - 1][2] : 0, radio: !!L.radio, words: w };
  save(); console.log('line', L.id, idx.lines[L.id].dur.toFixed(2) + 's');
}
for (const X of S.sfx) {
  const h = hash([X.prompt, X.seconds]);
  if (idx.sfx[X.id]?.h === h && !force.has(X.id) && fs.existsSync(`${OUT}/sfx-${X.id}.mp3`)) continue;
  const b = await post('/sound-generation', { text: X.prompt, duration_seconds: X.seconds, prompt_influence: 0.5 }, false);
  fs.writeFileSync(`${OUT}/sfx-${X.id}.mp3`, b); idx.sfx[X.id] = { h, loop: !!X.loop }; save(); console.log('sfx', X.id);
}
for (const M of S.music || []) {
  const h = hash([M.prompt, M.ms]);
  if (idx.music[M.id]?.h === h && !force.has(M.id) && fs.existsSync(`${OUT}/music-${M.id}.mp3`)) continue;
  try {
    const b = await post('/music', { prompt: M.prompt, music_length_ms: M.ms }, false);
    fs.writeFileSync(`${OUT}/music-${M.id}.mp3`, b); idx.music[M.id] = { h }; save(); console.log('music', M.id);
  } catch (e) { console.log('music', M.id, 'not made:', String(e).slice(0, 160)); }
}
console.log('done', Object.keys(idx.lines).length, 'lines', Object.keys(idx.sfx).length, 'sfx', Object.keys(idx.music).length, 'music');
