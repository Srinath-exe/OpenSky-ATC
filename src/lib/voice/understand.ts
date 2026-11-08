/*
  Voice input — transcript -> command line (docs/spec/11-VOICE-MODEL.md §1, layer L0).

  L0 is the rule path: tidy the transcript (fillers, "correction" restarts, punctuation the recogniser adds) and run
  the ordinary typed-command parser with the live engine context. When it parses, the result is the canonical command
  line (what the command bar shows and the player can edit). When it does not, the tidied transcript comes back with
  the parser's reason, and the learned model (L1) is the next step; until it ships, the player fixes the line by hand.
*/
import { parseCommand, tokenize, resolveCallsign } from '../sim/commands';
import type { ParseCtx } from '../sim/commands';
import { canonicalLine } from './context';

export interface Understood {
  ok: boolean;
  /** Canonical command line when ok, else the tidied transcript (the player edits it). */
  line: string;
  transcript: string;
  source: 'L0' | 'none';
  error: string | null;
}

const FILLER_RE = /\b(uh+|um+|erm|er|ah+|hmm+)\b/gi;

/** Clean a recogniser transcript: fillers out, no trailing sentence punctuation. ("correction" is grammar: the parser handles it.) */
export function tidyTranscript(raw: string): string {
  return raw.replace(FILLER_RE, ' ').replace(/\s+([,.])/g, '$1').replace(/([,.])[,.\s]+/g, '$1 ').replace(/^[\s,.;]+/, '').replace(/[.!?,\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

export interface VoiceResult extends Omit<Understood, 'source'> {
  source: 'L0' | 'L1' | 'none';
  /** Model confidence (temperature-scaled) for L1, 1 for a rules parse, null when nothing ran. */
  confidence: number | null;
  sayAgain: boolean;
  modelMs: number | null;
}

/** Minimal shape of the in-browser model client (src/lib/voice/l1.ts), so this module stays free of DOM types. */
export interface L1Like { complete(said: string, callsigns: string[], ctx?: string): Promise<{ line: string; confidence: number; ms: number; sayAgain: boolean }> }

/**
 * Rules first (L0); when they cannot parse the transcript, the in-browser S1 model (L1) proposes the command line
 * from the game state + transcript. Its proposal is parsed like typed text, so nothing unparseable is ever sent, and
 * it only counts as understood when the model's confidence reaches `minConfidence`.
 */
export async function understandVoice(raw: string, ctx: ParseCtx, magVar: number, l1: L1Like | null,
  state: { text: string; callsigns: string[] } | null, minConfidence = 0.5): Promise<VoiceResult> {
  const u = understand(raw, ctx, magVar);
  if (u.ok || !l1 || !state || !u.transcript) return { ...u, confidence: u.ok ? 1 : null, sayAgain: false, modelMs: null };
  let r: { line: string; confidence: number; ms: number; sayAgain: boolean };
  try { r = await l1.complete(u.transcript, state.callsigns, state.text); }
  catch (e) { return { ...u, error: `${u.error} (voice model unavailable: ${String(e)})`, confidence: null, sayAgain: false, modelMs: null }; }
  // Rules + model: when the rules can resolve the callsign from what was said (exact, telephony, or unique last digits)
  // but not the rest of the sentence, their callsign wins over the model's guess; the model keeps the instruction.
  let line = r.line; let fused = false;
  const rc = resolveCallsign(tokenize(u.transcript), 0, ctx);
  const modelCs = line.split(/\s+/)[0] ?? '';
  if (rc.callsign && /^[A-Z]{2,3}\d/.test(modelCs) && rc.callsign !== modelCs) { line = `${rc.callsign}${line.slice(modelCs.length)}`; fused = true; }
  if (r.sayAgain && !rc.callsign) return { ...u, ok: false, source: 'L1', error: `Say again: “${u.transcript}” did not match an aircraft`, confidence: r.confidence, sayAgain: true, modelMs: r.ms };
  if (r.sayAgain) return { ...u, ok: false, source: 'L1', error: `Say again: the instruction for ${rc.callsign} was not understood`, confidence: r.confidence, sayAgain: true, modelMs: r.ms };
  const p = parseCommand(line, ctx);
  if (!p.ok || !p.ast) return { ...u, ok: false, line: line || u.line, source: 'L1', error: `Model suggestion did not parse: ${p.errors[0]?.message ?? '?'}`, confidence: r.confidence, sayAgain: false, modelMs: r.ms };
  // a callsign the rules had to correct means the model was unsure of the aircraft: the player checks it before it is sent
  const sure = r.confidence >= minConfidence && !fused;
  return { ok: sure, line: canonicalLine(p.ast, magVar), transcript: u.transcript, source: 'L1',
    error: sure ? null : fused ? `Callsign taken from what you said (${rc.callsign}, the model guessed ${modelCs}): check and press Enter` : `Not sure (${Math.round(r.confidence * 100)}%): check the command and press Enter`,
    confidence: r.confidence, sayAgain: false, modelMs: r.ms };
}

export function understand(raw: string, ctx: ParseCtx, magVar = 0): Understood {
  const transcript = tidyTranscript(raw);
  if (!transcript) return { ok: false, line: '', transcript, source: 'none', error: 'Nothing heard' };
  const r = parseCommand(transcript, ctx);
  if (r.ok && r.ast) return { ok: true, line: canonicalLine(r.ast, magVar), transcript, source: 'L0', error: null };
  return { ok: false, line: transcript, transcript, source: 'none', error: r.errors[0]?.message ?? 'Not understood' };
}
