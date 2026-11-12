/*
  The models this game runs, and the player's control over them (Settings > AI models): what each one does, how big it
  is, whether it is on this device yet, how fast it runs here. "Download" fetches the files (with progress) into the
  browser's cache and then loads the model once in its own worker and times one real inference, so the numbers shown
  are this device's. Records are kept in localStorage; the files themselves sit in the browser's HTTP cache (/models/*
  is served immutable for a year) or, for the speech model, in transformers.js's Cache Storage.
*/
import { useSyncExternalStore } from 'react';
import { L1Client, S1_MODEL_URL } from '@/lib/voice/l1';
import { LS, EV_VOICE_ENGINE, readJson, writeJson } from '@/game/persist';
import type { VoiceEngine } from '@/lib/voice/recognizer';

export type ModelId = 's1' | 'stt' | 'tts';
export interface ModelInfo {
  id: ModelId;
  name: string;
  /** what it does for the player, one line */
  role: string;
  model: string;
  /** download, MB (the model files; runtimes from the CDN are listed in `extra`) */
  sizeMB: number;
  extra?: string;
  /** memory once loaded, MB (estimate: weights plus the runtime's working set) */
  ramMB: number;
  /** what runs instead when this one is not used */
  instead: string;
  files: string[];
}

export const MODELS: ModelInfo[] = [
  { id: 's1', name: 'Command model', role: 'The main model: turns what you said into the command the game carries out, and checks the readback', model: 'S1-2M (2 M parameters, RL-tuned on ATC transcripts)', sizeMB: 2.1, ramMB: 15, instead: 'Always on this device; without it the rules alone parse your words', files: [`${S1_MODEL_URL}/model.json`, `${S1_MODEL_URL}/model.bin`] },
  { id: 'stt', name: 'Speech to text', role: 'Hears your push-to-talk and writes it down, with the callsigns on frequency as hints', model: 'Moonshine base (61 M parameters, ONNX, WebGPU or WebAssembly)', sizeMB: 63, extra: 'plus transformers.js from the CDN (~2 MB)', ramMB: 350, instead: 'The server (Parakeet + Whisper, tuned for ATC): audio streams to this game\'s server, not stored. The server hears aviation words much better: use this device only when you need it offline', files: [] },
  { id: 'tts', name: 'Pilot voices', role: 'Speaks every pilot readback and request, four voices over a radio filter', model: 'Paradee-8M v1.2 (8 M parameters, int8 ONNX)', sizeMB: 8.2, extra: 'plus ONNX Runtime Web from the CDN (~11 MB)', ramMB: 90, instead: 'The browser\'s built-in voice (the same for every pilot)', files: ['/models/tts/paradee-8m-v1.2/config.json', '/models/tts/paradee-8m-v1.2/paradee_int8.onnx', '/models/tts/atc-lexicon-v1.json'] },
];

export interface ModelState { state: 'none' | 'downloading' | 'ready' | 'error'; progress: number; bytes: number; loadMs: number | null; runMs: number | null; device: string; at: number | null; message: string }
const KEY = 'skycontrol_models_v1';
const blank = (): ModelState => ({ state: 'none', progress: 0, bytes: 0, loadMs: null, runMs: null, device: '', at: null, message: '' });
let states: Record<ModelId, ModelState> = { s1: blank(), stt: blank(), tts: blank() };
let net: { rttMs: number | null; at: number | null } = { rttMs: null, at: null };
let loaded = false;
const subs = new Set<() => void>();
let snap = { states, net };
function emit() { snap = { states: { ...states }, net: { ...net } }; for (const f of subs) f(); }
function hydrate() {
  if (loaded || typeof window === 'undefined') return; loaded = true;
  const saved = readJson<Partial<Record<ModelId, ModelState>>>(KEY, {});
  for (const m of MODELS) { const r = saved[m.id]; if (r && r.state === 'ready') states[m.id] = { ...blank(), ...r }; }
  snap = { states: { ...states }, net };
}
function save() { const out: Partial<Record<ModelId, ModelState>> = {}; for (const m of MODELS) if (states[m.id].state === 'ready') out[m.id] = states[m.id]; writeJson(KEY, out); }
function put(id: ModelId, p: Partial<ModelState>) { states = { ...states, [id]: { ...states[id], ...p } }; emit(); }
const subscribe = (f: () => void) => { hydrate(); subs.add(f); return () => { subs.delete(f); }; };
const SERVER_SNAP = { states: { s1: blank(), stt: blank(), tts: blank() }, net: { rttMs: null, at: null } };
export function useModels() { return useSyncExternalStore(subscribe, () => { hydrate(); return snap; }, () => SERVER_SNAP); }

// ── voice preferences, shared by every settings view (one store, so two views never disagree) ──
const vsubs = new Set<() => void>();
let vsnap: { engine: VoiceEngine; pilot: 'neural' | 'browser' } | null = null;
function readVoice() { return { engine: readJson<VoiceEngine>(LS.voiceEngine, 'server'), pilot: readJson<'neural' | 'browser'>(LS.pilotVoice, 'neural') === 'browser' ? 'browser' as const : 'neural' as const }; }
export function useVoicePrefs() {
  return useSyncExternalStore((f) => { vsubs.add(f); return () => { vsubs.delete(f); }; }, () => (vsnap ??= readVoice()), () => ({ engine: 'server' as VoiceEngine, pilot: 'neural' as const }));
}
export function setVoiceEngine(v: VoiceEngine) { writeJson(LS.voiceEngine, v); vsnap = readVoice(); for (const f of vsubs) f(); window.setTimeout(() => window.dispatchEvent(new Event(EV_VOICE_ENGINE)), 0); }
export function setPilotVoice(v: 'neural' | 'browser') { writeJson(LS.pilotVoice, v); vsnap = readVoice(); for (const f of vsubs) f(); }

// ── downloads ──
/** Fetch files with progress (the response lands in the HTTP cache, where the game's loaders find it). */
async function fetchAll(id: ModelId, urls: string[]): Promise<number> {
  const sizes = await Promise.all(urls.map(async (u) => { try { const r = await fetch(u, { method: 'HEAD' }); return Number(r.headers.get('content-length')) || 0; } catch { return 0; } }));
  const total = sizes.reduce((a, b) => a + b, 0); let got = 0;
  for (const u of urls) {
    const r = await fetch(u); if (!r.ok || !r.body) throw new Error(`${u}: ${r.status}`);
    const rd = r.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; got += value.byteLength; put(id, { progress: total ? Math.min(0.95, got / total * 0.95) : 0.5, bytes: got }); }
  }
  return got;
}
function onceWorker(url: string, msgs: Array<Record<string, unknown>>, onProgress?: (m: { loaded: number; total: number; file: string }) => void, timeoutMs = 180000): Promise<Array<Record<string, any>>> {
  return new Promise((ok, err) => {
    const w = new Worker(url, { type: 'module' }); const out: Array<Record<string, any>> = []; let i = 0;
    const t = setTimeout(() => { w.terminate(); err(new Error('timed out')); }, timeoutMs);
    const next = () => { if (i >= msgs.length) { clearTimeout(t); w.terminate(); ok(out); return; } w.postMessage(msgs[i++]); };
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { onProgress?.(m); return; }
      if (m.type === 'error') { clearTimeout(t); w.terminate(); err(new Error(m.message)); return; }
      if (['ready', 'audio', 'result', 'completion', 'prefilled'].includes(m.type)) { out.push(m); next(); }
    };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); err(new Error(e.message || 'worker failed')); };
    next();
  });
}
const running = new Set<ModelId>();
export async function downloadModel(id: ModelId): Promise<boolean> {
  if (running.has(id)) return false; running.add(id);
  put(id, { state: 'downloading', progress: 0, message: '' });
  const t0 = performance.now();
  try {
    if (id === 's1') {
      const bytes = await fetchAll(id, MODELS[0].files);
      const c = new L1Client(); const tl = performance.now(); await c.load(); const loadMs = performance.now() - tl;
      const r = await c.complete('united two one four climb and maintain five thousand', ['UAL214']); c.dispose();
      put(id, { state: 'ready', progress: 1, bytes, loadMs: Math.round(loadMs), runMs: Math.round(r.ms), device: 'WebAssembly', at: Date.now() });
    } else if (id === 'tts') {
      const bytes = await fetchAll(id, MODELS[2].files);
      const out = await onceWorker('/voice/tts-worker.js', [{ type: 'load', id: 1 }, { type: 'speak', id: 2, text: 'Climb and maintain five thousand, United two one four.', voice: 'am_puck', speed: 1 }]);
      put(id, { state: 'ready', progress: 1, bytes, loadMs: Math.round(performance.now() - t0), runMs: out[1]?.ms ?? null, device: 'WebAssembly', at: Date.now() });
    } else {
      const files = new Map<string, { loaded: number; total: number }>();
      const audio = new Float32Array(16000 * 2); for (let i = 0; i < audio.length; i++) audio[i] = (Math.random() - 0.5) * 0.002;
      const out = await onceWorker('/voice/stt-worker.js?model=base', [{ type: 'load' }, { type: 'transcribe', id: 1, audio, names: [] }], (m) => {
        files.set(m.file, { loaded: m.loaded, total: m.total }); let l = 0, t = 0; files.forEach((f) => { l += f.loaded; t += f.total; });
        put(id, { progress: t ? Math.min(0.95, l / t * 0.95) : 0.05, bytes: l });
      }, 600000);
      let bytes = 0; files.forEach((f) => { bytes += f.total || f.loaded; });
      put(id, { state: 'ready', progress: 1, bytes: bytes || states.stt.bytes, loadMs: out[0]?.ms ?? null, runMs: out[1]?.ms ?? null, device: out[0]?.device ?? out[1]?.device ?? '', at: Date.now() });
    }
    save(); return true;
  } catch (e) {
    put(id, { state: 'error', message: String((e as Error).message || e).slice(0, 160) }); return false;
  } finally { running.delete(id); }
}

/** Round trip to this game's server (median of three small no-cache requests): what an on-device model saves per call. */
export async function measureServer(): Promise<number | null> {
  const ts: number[] = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); try { await fetch(`/icon.svg?rtt=${Date.now()}-${i}`, { cache: 'no-store' }); ts.push(performance.now() - t); } catch { /* offline */ } }
  ts.sort((a, b) => a - b); net = { rttMs: ts.length ? Math.round(ts[Math.floor(ts.length / 2)]) : null, at: Date.now() }; emit(); return net.rttMs;
}

/** Everything on this device: download all three, switch the pilot voices to it (and speech too only when asked: the
 *  on-device recogniser is much less accurate than the server's), ask the browser to keep the files. */
export async function goOnDevice(opts: { speech?: boolean } = {}): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
  for (const m of MODELS) if (states[m.id].state !== 'ready') await downloadModel(m.id);
  if (states.stt.state === 'ready' && opts.speech) setVoiceEngine('local');
  if (states.tts.state === 'ready') setPilotVoice('neural');
}

export async function storageUse(): Promise<{ usedMB: number; quotaMB: number; persisted: boolean } | null> {
  try { const e = await navigator.storage.estimate(); const persisted = (await navigator.storage.persisted?.()) ?? false; return { usedMB: (e.usage ?? 0) / 1e6, quotaMB: (e.quota ?? 0) / 1e6, persisted }; } catch { return null; }
}
