/*
  Live-attempt log for the owner (ml/stt/GOLD.md "live"): when the gold-set key is in this browser (the recording page
  /voice/record.html#k=... stores it), every push-to-talk in the game or the demo is saved to the server with what each
  recogniser heard and what the game decided, so speech-to-text can be tuned on the owner's real voice. Nobody else's
  browser has the key, so for everyone else this does nothing. Fire and forget: a failed upload never affects play.
*/
const KEY = 'atc-gold-key';

export function diagKey(): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) || null : null; } catch { return null; }
}

/** 16 kHz mono 16-bit PCM WAV. */
export function wav16(audio: Float32Array): Blob {
  const n = audio.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, audio[i])); v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

export interface AttemptMeta {
  page: 'game' | 'demo'; engine: string; accent?: string; ctx?: string;
  transcripts: { browser?: string[]; server?: string[]; local?: string[]; native?: string[] };
  heard?: string; line?: string; ok?: boolean; source?: string; sayAgain?: boolean; error?: string | null; confidence?: number | null;
  expected?: string; example?: number;
}

export function saveAttempt(audio: Float32Array | null, meta: AttemptMeta): void {
  const key = diagKey();
  if (!key || !audio || audio.length < 16000 * 0.2 || audio.length > 16000 * 30) return;
  const id = `live-${Date.now()}-${Math.random().toString(36).slice(2).padEnd(4, '0').slice(0, 4)}`;
  const fd = new FormData();
  fd.append('id', id); fd.append('wav', wav16(audio), `${id}.wav`);
  fd.append('meta', JSON.stringify({ ...meta, ctx: meta.ctx?.slice(0, 8000), clientTs: new Date().toISOString() }));
  void fetch('/api/voice/gold', { method: 'POST', headers: { 'x-gold-key': key }, body: fd }).catch(() => undefined);
}
