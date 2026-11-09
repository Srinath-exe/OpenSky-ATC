// Clip sets for the speech-to-text benchmark: the synthetic bench (ml/stt/bench2/clips/meta.jsonl) or the owner's
// real recordings (ml/data/gold/). Every clip: { wav, path, cond, ctx, line, text }.
const fs = require('fs');
const path = require('path');

function readJsonl(f) { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }

/** Any manifest that gives, per clip, an audio file + the game state (ctx) + the gold command line. */
function loadClips(dir) {
  const cands = ['meta.jsonl', 'manifest.jsonl', 'index.jsonl', 'gold.jsonl', 'clips.jsonl'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  let rows = [];
  if (cands.length) rows = readJsonl(cands[0]);
  else {  // one sidecar .json per recording (ml/data/gold: {id, prompt, browserTranscript, ...}); the prompt set gives ctx/said/line
    const pf = path.resolve(__dirname, '../../../public/voice/gold-prompts.json');
    const prompts = fs.existsSync(pf) ? new Map(JSON.parse(fs.readFileSync(pf, 'utf8')).prompts.map((p) => [p.id, p])) : new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
        const id = j.id || f.replace(/\.json$/, '');
        const p = { ...(prompts.get(id) || {}), ...(j.prompt && typeof j.prompt === 'object' ? j.prompt : {}) };
        rows.push({ ...p, ...j, id, split: p.group || j.group, wav: j.wav || j.audio || j.file || f.replace(/\.json$/, '.wav'), ctx: j.ctx || p.ctx, line: j.line || p.line, said: p.said || j.said });
      } catch { /* not a clip */ }
    }
  }
  return rows.map((r) => {
    const wav = r.wav || r.audio || r.file || r.path;
    return { ...r, wav, path: path.isAbsolute(wav) ? wav : path.join(dir, wav), cond: r.cond || 'real', ctx: r.ctx || r.context || '', line: r.line || r.gold || r.command || '', text: r.text || r.said || r.transcript || r.prompt || '' };
  }).filter((r) => r.wav && fs.existsSync(r.path) && r.ctx && r.line);
}

/** 16-bit / float WAV (any rate, mono or first channel) -> Float32Array at 16 kHz. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8, frames = Math.floor(Math.min(n, b.length - o - 8) / (bytes * fmt.ch));
      let x = new Float32Array(frames);
      for (let i = 0; i < frames; i++) { const p = o + 8 + i * bytes * fmt.ch; x[i] = fmt.bits === 16 ? b.readInt16LE(p) / 32768 : fmt.bits === 32 && fmt.tag === 3 ? b.readFloatLE(p) : fmt.bits === 32 ? b.readInt32LE(p) / 2147483648 : (b[p] - 128) / 128; }
      if (fmt.sr !== 16000) { const r = fmt.sr / 16000, m = Math.floor(frames / r), y = new Float32Array(m); for (let i = 0; i < m; i++) { const s = i * r, k = Math.floor(s), f = s - k; y[i] = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f; } x = y; }
      return x;
    }
    o += 8 + n + (n & 1);
  }
  throw new Error(`not a PCM WAV: ${file}`);
}

/** The words a controller uses for each aircraft (context line: CALLSIGN <spoken name> ARR|DEP ...). */
function namesFromCtx(ctx) {
  return ctx.split('\n').slice(1).map((l) => { const m = l.match(/^\S+ (.+?) (ARR|DEP) /); return m ? m[1] : null; }).filter(Boolean);
}
function aircraftFromCtx(ctx) {
  return ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => { const m = l.match(/^(\S+) (.+?) (ARR|DEP) /); return { callsign: l.split(' ')[0], name: m ? m[2] : '' }; });
}
module.exports = { loadClips, readWav, namesFromCtx, aircraftFromCtx, readJsonl };
