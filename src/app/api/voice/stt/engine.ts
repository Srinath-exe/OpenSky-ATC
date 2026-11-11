/*
  Server speech-to-text for /api/voice/stt (ml/stt/RESULTS2.md, ml/stt/models/SERVER.md), inside the Next.js server
  process. Two engines, each loaded lazily on its first request and kept in memory:

  parakeet  the fast first pass: Parakeet TDT 0.6B "Ultra" int8 through sherpa-onnx-node (~0.4 s a command). The callsigns
            on frequency are hotwords (beam search with a bonus per matching word piece). See "Parakeet" below.
  whisper   Whisper base.en through transformers.js on onnxruntime-node (~1.3 s), asked when the game cannot understand
            Parakeet's guesses (src/lib/voice/asr-server.ts cascadeStt).

  Contextual biasing (Whisper): Whisper reads a text prompt as "what was said before" (<|startofprev|> ... <|startoftranscript|>).
  Putting the callsigns on frequency there ("Speedbird 963, Delta 421, ...") makes the decoder far more likely to write
  those names than generic English look-alikes ("speed bird", "Quantas"). With `alternatives` it decodes a second
  time without the prompt (the encoder pass is shared), so a prompt that pulls the decoder the wrong way still leaves a
  plain transcript for the rules to try (a 2-best list).

  Pure server module: no Next imports, so the benchmark (ml/stt/bench2/transcribe_tjs.cjs) runs exactly this code.
*/
/// <reference path="./sherpa-onnx-node.d.ts" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const STT_REPOS: Record<string, string> = {
  'whisper-tiny.en': 'onnx-community/whisper-tiny.en',
  'whisper-base.en': 'onnx-community/whisper-base.en',
  'whisper-small.en': 'onnx-community/whisper-small.en',
  'distil-small.en': 'onnx-community/distil-small.en',
  'moonshine-tiny': 'onnx-community/moonshine-tiny-ONNX',
  'moonshine-base': 'onnx-community/moonshine-base-ONNX',
};

export interface SttConfig { model: string; encoder: string; decoder: string; threads: number; cacheDir: string }

export function sttConfig(env: Record<string, string | undefined> = process.env): SttConfig {
  const model = env.OPENATC_STT_MODEL && STT_REPOS[env.OPENATC_STT_MODEL] ? env.OPENATC_STT_MODEL : 'whisper-base.en';
  return {
    model,
    encoder: env.OPENATC_STT_ENCODER || 'fp32',
    decoder: env.OPENATC_STT_DECODER || 'q8',
    threads: Math.max(1, Math.min(3, Number(env.OPENATC_STT_THREADS) || 2)),
    cacheDir: env.OPENATC_STT_CACHE || path.join(os.homedir(), '.cache', 'openatc-stt'),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Engine {
  id: string; kind: 'whisper' | 'moonshine';
  processor: any; tokenizer: any; model: any;
  ids: { prev: number; sot: number; nots: number } | null;
  loadMs: number;
}
const engines = new Map<string, Promise<Engine>>();

export function engineKey(c: SttConfig): string { return `${c.model}|${c.encoder}|${c.decoder}|${c.threads}`; }

export function loadEngine(c: SttConfig = sttConfig()): Promise<Engine> {
  const key = engineKey(c);
  let p = engines.get(key);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const t: any = await import('@huggingface/transformers');
      t.env.cacheDir = c.cacheDir;
      const repo = STT_REPOS[c.model];
      const session_options = { intraOpNumThreads: c.threads, interOpNumThreads: 1 };
      const kind = c.model.startsWith('moonshine') ? 'moonshine' : 'whisper';
      const dtype = kind === 'whisper' ? { encoder_model: c.encoder, decoder_model_merged: c.decoder } : c.decoder;
      const [processor, tokenizer, model] = await Promise.all([
        t.AutoProcessor.from_pretrained(repo),
        t.AutoTokenizer.from_pretrained(repo),
        t.AutoModelForSpeechSeq2Seq.from_pretrained(repo, { dtype, device: 'cpu', session_options }),
      ]);
      let ids: Engine['ids'] = null;
      if (kind === 'whisper') {
        const id = (s: string) => { const v = tokenizer.encode(s, { add_special_tokens: false }); if (v.length !== 1) throw new Error(`no token ${s}`); return Number(v[0]); };
        ids = { prev: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), nots: id('<|notimestamps|>') };
      }
      return { id: c.model, kind, processor, tokenizer, model, ids, loadMs: Date.now() - t0 } as Engine;
    })();
    p.catch(() => engines.delete(key));   // a failed load (network, disk) is retried on the next request
    engines.set(key, p);
  }
  return p;
}

/** "speedbird 963" -> "Speedbird 963" (Whisper writes names the way the prompt does). */
const title = (s: string) => s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

/** The biasing prompt: the callsigns on frequency, written as a controller's previous transmissions would be. */
export function buildPrompt(names: string[], style: 'names' | 'phrases' = 'phrases'): string {
  const list = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].slice(0, 24).map(title);
  if (!list.length) return '';
  if (style === 'names') return `Air traffic control. Callsigns: ${list.join(', ')}.`;
  return `Air traffic control. ${list.join(', ')}. Climb, descend and maintain flight level, turn left heading, reduce speed, cleared to land runway, contact tower.`;
}

export interface SttResult {
  text: string; alternatives: string[]; ms: number; model: string;
  /** Raw decodes in order: [with the prompt, without it] (Whisper with alternatives) or [the one decode]. */
  decodes: string[];
}

const HALLUCINATION = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|\[.*\]|\(.*\))$/i;
const clean = (s: string) => { const x = s.replace(/\s+/g, ' ').trim(); return HALLUCINATION.test(x) ? '' : x; };

/**
 * Transcribe 16 kHz mono audio. `names`: the spoken callsigns on frequency (biasing prompt; Whisper only).
 * `alternatives`: also decode without the prompt and return both (prompted first).
 */
export async function transcribe(audio: Float32Array, opts: { names?: string[]; alternatives?: boolean; prompt?: 'none' | 'names' | 'phrases'; config?: SttConfig } = {}): Promise<SttResult> {
  const c = opts.config ?? sttConfig();
  const e = await loadEngine(c);
  const t0 = Date.now();
  if (e.kind === 'moonshine') {
    const inputs = await e.processor(audio);
    const out = await e.model.generate({ ...inputs, max_new_tokens: Math.min(96, Math.ceil(audio.length / 16000) * 8 + 8) });
    const text = clean(e.tokenizer.batch_decode(out, { skip_special_tokens: true })[0] ?? '');
    return { text, alternatives: text ? [text] : [], ms: Date.now() - t0, model: e.id, decodes: [text] };
  }
  const { input_features } = await e.processor(audio);
  // one encoder pass (the expensive part: Whisper always encodes a 30 s window), shared by both decodes
  if (!e.model.forward_params.includes('encoder_outputs')) e.model.forward_params = [...e.model.forward_params, 'encoder_outputs'];
  const { encoder_outputs } = await e.model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features, model_inputs: { input_features }, model_input_name: 'input_features', generation_config: e.model.generation_config,
  });
  const decode = async (prompt: string) => {
    const ids = e.ids!;
    const p: number[] = prompt ? e.tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).slice(-200) : [];
    const init = p.length ? [ids.prev, ...p, ids.sot, ids.nots] : [ids.sot, ids.nots];
    const out = await e.model.generate({ inputs: input_features, encoder_outputs, decoder_input_ids: init, max_new_tokens: 64 });
    const seq: number[] = (out.tolist()[0] as (number | bigint)[]).map(Number).slice(init.length);
    const text = clean(e.tokenizer.decode(seq, { skip_special_tokens: true }));
    // a prompt the decoder simply repeats back is not a transcript
    return prompt && text && prompt.toLowerCase().includes(text.toLowerCase()) && text.split(' ').length > 3 ? '' : text;
  };
  const style = opts.prompt ?? 'phrases';
  // Whisper's prompt window is ~224 tokens: drop callsigns from the end until it fits, so the opening and the first
  // callsigns on frequency are kept (a plain cut would remove them and keep the generic phrase tail)
  let names = opts.names ?? [];
  let prompt = style === 'none' ? '' : buildPrompt(names, style as 'names' | 'phrases');
  while (prompt && names.length && e.tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).length > 200) { names = names.slice(0, -1); prompt = buildPrompt(names, style as 'names' | 'phrases'); }
  const first = await decode(prompt);
  const alts = [first];
  if (opts.alternatives && prompt) alts.push(await decode(''));
  const uniq = [...new Set(alts.filter(Boolean))];
  return { text: uniq[0] ?? '', alternatives: uniq, ms: Date.now() - t0, model: e.id, decodes: alts };
}

/* ---------------------------------------------------------------------------------------------------------------------
  Parakeet: Parakeet TDT 0.6B "Ultra" int8 (Moondream's post-training of NVIDIA parakeet-tdt-0.6b-v3, exported to ONNX by
  the k2-fsa sherpa-onnx project; weights CC-BY-4.0) through sherpa-onnx-node (Apache-2.0), in this process.
  Measured as the first pass of a cascade (ml/stt/models/SERVER.md): 78.1% exact commands on US/UK clips and 85.6% on the
  Indian-accent proxy (Whisper alone 76.9% / 78.8%), ~0.4 s a command at 3 threads, Whisper asked for ~24% of them.

  Hotwords: the telephony words of the callsigns on frequency ("speedbird 963" -> "speedbird"), lower and title case, at
  most 25, through modified beam search (4 paths, +1.5 per matching word piece). One biased decode only: the plain
  second decode the benchmark also ran changed nothing in the cascade and doubled the time.

  The model files are never downloaded at run time. Copy them once into the cache dir (ml/stt/RESULTS2.md "Server first pass"):
    d=~/.cache/openatc-stt/parakeet-ultra-int8; s=ml/stt/models/sherpa/sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8
    mkdir -p $d && cp $s/encoder.int8.onnx $s/decoder.int8.onnx $s/joiner.int8.onnx $s/tokens.txt $s/README.md $d/
  (OPENATC_STT_PARAKEET_DIR overrides the directory.) Without them, requests for Parakeet are answered by Whisper.
--------------------------------------------------------------------------------------------------------------------- */
export const PARAKEET_MODEL = 'parakeet-ultra-int8';
/** The name of the Parakeet model actually loaded (OPENATC_STT_PARAKEET_DIR may point at another one, e.g. parakeet-110m-atc-v1). */
export const parakeetModelName = (): string => { const d = process.env.OPENATC_STT_PARAKEET_DIR; return d ? path.basename(d.replace(/\/+$/, '')) : PARAKEET_MODEL; };
export const PARAKEET_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];

export interface ParakeetConfig { dir: string; threads: number }

export function parakeetConfig(env: Record<string, string | undefined> = process.env): ParakeetConfig {
  const c = sttConfig(env);
  return { dir: env.OPENATC_STT_PARAKEET_DIR || path.join(c.cacheDir, PARAKEET_MODEL), threads: c.threads };
}

/** The model files are in place (checked per request: copying them in later needs no restart). */
export function parakeetReady(c: ParakeetConfig = parakeetConfig()): boolean {
  return PARAKEET_FILES.every((f) => fs.existsSync(path.join(c.dir, f)));
}

/**
 * sherpa-onnx splits hotwords into word pieces with a sentencepiece-style vocab; the NeMo builds ship only tokens.txt
 * ("<piece> <id>" per line). Every piece scores -1, so the split with the fewest pieces wins (as srv_run.py writes it).
 */
export function bpeVocab(tokens: string): string {
  return tokens.split('\n').map((l) => { const i = l.lastIndexOf(' '); return i < 0 ? l : l.slice(0, i); })
    .filter((t) => t && !t.startsWith('<')).map((t) => `${t}\t-1\n`).join('');
}

/** Per-request hotwords: "speedbird 963", "air france 684" -> "speedbird/Speedbird/air france/Air France". */
export function hotwordsFor(names: string[]): string {
  const words: string[] = [];
  for (const n of names) {
    const w = n.split(/\s+/).filter((t) => t && !/^\d+$/.test(t)).join(' ').trim().toLowerCase();
    if (w && !words.includes(w)) words.push(w);
  }
  return words.slice(0, 25).flatMap((w) => [...new Set([w, title(w)])]).join('/');
}

interface Parakeet { rec: import('sherpa-onnx-node').OfflineRecognizer; loadMs: number }
const parakeets = new Map<string, Promise<Parakeet>>();

/** Writes the vocab and a placeholder hotwords file (sherpa wants one at load; each request brings its own list). */
function parakeetAux(c: ParakeetConfig): { vocab: string; hotwords: string } {
  const tokens = fs.readFileSync(path.join(c.dir, 'tokens.txt'), 'utf8');
  for (const dir of [c.dir, path.join(os.tmpdir(), 'openatc-stt-parakeet')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const vocab = path.join(dir, 'bpe.vocab'), hotwords = path.join(dir, 'hotwords.txt');
      fs.writeFileSync(vocab, bpeVocab(tokens)); fs.writeFileSync(hotwords, 'SPEEDBIRD\n');
      return { vocab, hotwords };
    } catch { /* read-only model dir: the temp dir */ }
  }
  throw new Error('cannot write the Parakeet hotword files');
}

export function loadParakeet(c: ParakeetConfig = parakeetConfig()): Promise<Parakeet> {
  const key = `${c.dir}|${c.threads}`;
  let p = parakeets.get(key);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const mod = await import('sherpa-onnx-node');
      const sherpa = mod.OfflineRecognizer ? mod : (mod as unknown as { default: typeof mod }).default;   // CJS through ESM interop
      const aux = parakeetAux(c);
      const f = (name: string) => path.join(c.dir, name);
      // createAsync / decodeAsync run on libuv's pool: the server keeps answering other requests meanwhile
      const rec = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') }, tokens: f('tokens.txt'),
          numThreads: c.threads, provider: 'cpu', modelType: 'nemo_transducer', modelingUnit: 'bpe', bpeVocab: aux.vocab, debug: 0,
        },
        decodingMethod: 'modified_beam_search', maxActivePaths: 4, hotwordsFile: aux.hotwords, hotwordsScore: 1.5,
      });
      return { rec, loadMs: Date.now() - t0 };
    })();
    p.catch(() => parakeets.delete(key));   // a failed load is retried on the next request
    parakeets.set(key, p);
  }
  return p;
}

/** Transcribe 16 kHz mono audio with Parakeet, biased towards `names` (the spoken callsigns on frequency). One guess. */
export async function transcribeParakeet(audio: Float32Array, opts: { names?: string[]; config?: ParakeetConfig } = {}): Promise<SttResult> {
  const e = await loadParakeet(opts.config ?? parakeetConfig());
  const t0 = Date.now();
  const hw = hotwordsFor(opts.names ?? []);
  const s = hw ? e.rec.createStream(hw) : e.rec.createStream();
  s.acceptWaveform({ samples: audio, sampleRate: 16000 });
  const text = clean((await e.rec.decodeAsync(s)).text ?? '');
  return { text, alternatives: text ? [text] : [], ms: Date.now() - t0, model: parakeetModelName(), decodes: [text] };
}
