/*
  The game's voice decision path, bundled for /reports/voice-demo.html (scripts/build-voice.sh -> public/voice/gen/demo-pipeline.js).
  Same code as push-to-talk in the game: transcript repair + n-best (asr-nbest), rules (L0), the S1 model (L1, through
  the page's worker), rules-callsign fusion and the verifier gate (understand.ts / verify.ts). Only the parse context is
  simpler: it is built from the demo's game-state text (aircraft + runways) instead of the live engine.
*/
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import type { HeardResult } from '../../src/lib/voice/asr-nbest';
import type { L1Like } from '../../src/lib/voice/understand';
import type { ParseCtx } from '../../src/lib/sim/commands';
// the game's speech pieces, for the demo's microphone: capture with pre-roll, our server's Whisper, the callsign hints,
// the accent list, and the owner's live-attempt log
export { createMicCapture } from '../../src/lib/voice/asr-capture';
export { postStt } from '../../src/lib/voice/asr-server';
export { biasNames } from '../../src/lib/voice/asr-nbest';
export { saveAttempt, diagKey } from '../../src/lib/voice/asr-diag';
export { VOICE_ACCENTS, defaultAccent } from '../../src/lib/voice/recognizer';

export function contextFromText(text: string): { parse: ParseCtx; state: { text: string; callsigns: string[] } } {
  const lines = text.split('\n');
  const runways = (lines[0] ?? '').split(/\s+/).slice(1).filter(Boolean);
  const aircraft = lines.slice(1).filter((l) => l.trim()).map((l) => ({ callsign: l.split(' ')[0] }));
  return { parse: { aircraft, runways }, state: { text, callsigns: aircraft.map((a) => a.callsign) } };
}

/** alternatives: the recogniser's guesses, best first (one when typed). */
export function decide(alternatives: string[], stateText: string, l1: L1Like): Promise<HeardResult> {
  const { parse, state } = contextFromText(stateText);
  return understandHeard(alternatives, parse, 0, l1, state);
}
