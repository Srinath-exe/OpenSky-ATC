/*
  Voice input — transcript -> command line (docs/spec/11-VOICE-MODEL.md §1).

  L0 is the rule path: tidy the transcript (fillers, "correction" restarts, punctuation the recogniser adds) and run
  the ordinary typed-command parser with the live engine context. When it parses, the result is the canonical command
  line (what the command bar shows and the player can edit). When it does not, the in-browser S1 model (L1) proposes
  the line, and the verifier (verify.ts) decides whether it is sent, left in the bar to check, or answered "say again".
*/
import { parseCommand, tokenize, resolveCallsign } from '../sim/commands';
import type { ParseCtx } from '../sim/commands';
import { canonicalLine } from './context';
import { roundTrip, featureMap, verifierScore, gateOf, vetoOf, kindVeto } from './verify';
import type { GenSignals, VerifierModel, RoundTrip, Gate } from './verify';
import { VERIFIERS, VERIFIER_DEFAULT_URL } from './verify-model';

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
  /** L1 only: the verifier's P(correct), its gate and the round-trip evidence (src/lib/voice/verify.ts). */
  verify?: { p: number; gate: Gate; model: string; rt: RoundTrip; veto: string | null } | null;
}

/** What the in-browser model returns (src/lib/voice/l1.ts); `signals` is absent from older workers. `model` is the S1
 *  model URL that answered: each model has its own fitted gate (thresholds differ), see verify-model.ts. */
export interface L1Proposal { line: string; confidence: number; ms: number; sayAgain: boolean; signals?: GenSignals | null; model?: string }

/** The fitted gate for an S1 model URL (the shipped model's when unknown). */
export function verifierFor(url?: string | null): { full: VerifierModel; basic: VerifierModel } {
  return (url && VERIFIERS[url]) || VERIFIERS[VERIFIER_DEFAULT_URL];
}
/** Minimal shape of the in-browser model client (src/lib/voice/l1.ts), so this module stays free of DOM types. */
export interface L1Like { complete(said: string, callsigns: string[], ctx?: string): Promise<L1Proposal> }

export interface VoiceOptions {
  /** The verifier gate (default: the one fitted for the answering S1 model, verify-model.ts). null = the old rule, confidence >= minConfidence. */
  verifier?: { full: VerifierModel; basic: VerifierModel } | null;
}

/**
 * Rules first (L0); when they cannot parse the transcript, the in-browser S1 model (L1) proposes the command line
 * from the game state + transcript. Its proposal is parsed like typed text, so nothing unparseable is ever sent, and
 * the verifier decides: send it, leave it in the bar for the player to check, or ask them to say again.
 */
export async function understandVoice(raw: string, ctx: ParseCtx, magVar: number, l1: L1Like | null,
  state: { text: string; callsigns: string[] } | null, minConfidence = 0.5, opts: VoiceOptions = {}): Promise<VoiceResult> {
  const u = understand(raw, ctx, magVar);
  if (u.ok || !l1 || !state || !u.transcript) return { ...u, confidence: u.ok ? 1 : null, sayAgain: false, modelMs: null };
  let r: L1Proposal;
  try { r = await l1.complete(u.transcript, state.callsigns, state.text); }
  catch (e) { return { ...u, error: `${u.error} (voice model unavailable: ${String(e)})`, confidence: null, sayAgain: false, modelMs: null }; }
  return decideL1(u, r, ctx, magVar, minConfidence, opts);
}

/** Everything after the model answered: rules-callsign fusion, parse, verifier gate. Pure (ml/verify/post.cjs runs it on the data). */
export function decideL1(u: Understood, r: L1Proposal, ctx: ParseCtx, magVar: number, minConfidence = 0.5, opts: VoiceOptions = {}): VoiceResult {
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
  const out = canonicalLine(p.ast, magVar);
  const base = { line: out, transcript: u.transcript, source: 'L1' as const, confidence: r.confidence, modelMs: r.ms };
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // a callsign the rules had to correct means the model was unsure of the aircraft: the player checks it before it is sent
  const fusedMsg = `Callsign taken from what you said (${rc.callsign}, the model guessed ${modelCs}): check and press Enter`;
  const vm = opts.verifier === undefined ? verifierFor(r.model) : opts.verifier;
  if (!vm) {
    const sure = r.confidence >= minConfidence && !fused;
    return { ...base, ok: sure, sayAgain: false, error: sure ? null : fused ? fusedMsg : `Not sure (${pct(r.confidence)}): check the command and press Enter` };
  }
  const rt = roundTrip(u.transcript, p.ast, ctx, ctx.magVar ?? magVar);   // the parse turned typed (magnetic) headings TRUE with ctx.magVar
  const full = r.signals ? verifierScore(vm.full, featureMap(r.confidence, rt, r.signals)) : null;   // null: no or broken signals
  const model = full !== null ? vm.full : vm.basic;
  const score = full ?? verifierScore(vm.basic, featureMap(r.confidence, rt, null)) ?? 0;
  const veto = vetoOf(rt) ?? kindVeto(u.transcript, p.ast);
  let gate = fused ? 'check' : gateOf(score, model.thresholds);
  if (gate === 'send' && veto) gate = 'check';
  const verify = { p: score, gate, model: model.name, rt, veto };
  if (fused) return { ...base, ok: false, sayAgain: false, error: fusedMsg, verify };
  if (gate === 'send') return { ...base, ok: true, sayAgain: false, error: null, verify };
  const why = veto ?? (rt.csNum < 0.5 && rt.csName < 0.5 ? 'the aircraft was not heard clearly' : rt.numRecall < 1 ? 'a number may not match what was heard' : `only ${pct(score)} sure`);
  if (gate === 'sayAgain') return { ...base, ok: false, sayAgain: true, error: `Say again: ${why} (proposal ${out})`, verify };
  return { ...base, ok: false, sayAgain: false, error: `Check: ${why}: check the command and press Enter`, verify };
}

export function understand(raw: string, ctx: ParseCtx, magVar = 0): Understood {
  const transcript = tidyTranscript(raw);
  if (!transcript) return { ok: false, line: '', transcript, source: 'none', error: 'Nothing heard' };
  const r = parseCommand(transcript, ctx);
  if (r.ok && r.ast) return { ok: true, line: canonicalLine(r.ast, magVar), transcript, source: 'L0', error: null };
  return { ok: false, line: transcript, transcript, source: 'none', error: r.errors[0]?.message ?? 'Not understood' };
}
