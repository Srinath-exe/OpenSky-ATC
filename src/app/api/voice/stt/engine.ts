/*
  Server speech-to-text for /api/voice/stt (ml/stt/RESULTS2.md): Whisper through transformers.js on onnxruntime-node,
  inside the Next.js server process. The model loads lazily on the first request and stays in memory.

  Contextual biasing: Whisper reads a text prompt as "what was said before" (<|startofprev|> ... <|startoftranscript|>).
  Putting the callsigns on frequency there ("Speedbird 963, Delta 421, ...") makes the decoder far more likely to write
  those names than generic English look-alikes ("speed bird", "Quantas"). With `alternatives` it decodes a second
  time without the prompt (the encoder pass is shared), so a prompt that pulls the decoder the wrong way still leaves a
  plain transcript for the rules to try (a 2-best list).

  Pure server module: no Next imports, so the benchmark (ml/stt/bench2/transcribe_tjs.cjs) runs exactly this code.
*/
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

/**
 * Transcribe 16 kHz mono audio. `names`: the spoken callsigns on frequency (biasing prompt; Whisper only).
 * `alternatives`: also decode without the prompt and return both (prompted first).
 */
export async function transcribe(audio: Float32Array, opts: { names?: string[]; alternatives?: boolean; prompt?: 'none' | 'names' | 'phrases'; config?: SttConfig } = {}): Promise<SttResult> {
  const c = opts.config ?? sttConfig();
  const e = await loadEngine(c);
  const t0 = Date.now();
  const clean = (s: string) => { const x = s.replace(/\s+/g, ' ').trim(); return HALLUCINATION.test(x) ? '' : x; };
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
