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
// the game's speech pieces, for the demo's microphone: capture with pre-roll, our server's engines (Parakeet, then
// Whisper when not understood), the callsign hints, the accent list, and the owner's live-attempt log
export { createMicCapture } from '../../src/lib/voice/asr-capture';
export { cascadeStt } from '../../src/lib/voice/asr-server';
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

// the TTS -> STT loopback page (/reports/voice-loopback.html): the game's pilot-line text path, the voice per callsign,
// the server's engines one at a time, and WAV encoding for playback
export { speakableAtc, speechChunks, voiceFor, PILOT_VOICES } from '../../src/lib/tts/pilotSpeech';
export { telephony } from '../../src/lib/sim/phraseology';
export { postStt } from '../../src/lib/voice/asr-server';
export { wav16 } from '../../src/lib/voice/asr-diag';
export { isSilent } from '../../src/lib/voice/asr-capture';

// the voice round trip page (/reports/voice-roundtrip.html): streaming speech-to-text, the cascade's whole-recording
// path, and the pilot's readback exactly as the game words it (phraseology.ts readback(), the sim's own call)
export { openSttStream } from '../../src/lib/voice/asr-stream';
export { firstPass } from '../../src/lib/voice/asr-server';
import { parseCommand } from '../../src/lib/sim/commands';
import { readback, AIRLINE_TELEPHONY } from '../../src/lib/sim/phraseology';
import type { PhraseVariant } from '../../src/lib/sim/phraseology';

/** The pilot's readback for a command line in the page's game state ('' when the command has none, e.g. "roger").
 *  Without the live engine the aircraft's state is unknown, so state-dependent words fall back to the neutral form. */
export function pilotReadback(line: string, stateText: string, icao = ''): { text: string; callsign: string | null } {
  const { parse } = contextFromText(stateText);
  const p = parseCommand(line, parse);
  if (!p.ok || !p.ast) return { text: '', callsign: p.callsign };
  const variant: PhraseVariant = /^[KP]/.test(icao) ? 'FAA' : 'ICAO';
  const tel = (cs: string) => { const m = cs.match(/^([A-Z]{3})(\d+[A-Z]{0,2})$/); const t = m && AIRLINE_TELEPHONY[m[1]]; return t ? `${t} ${m![2]}` : cs; };
  const ctx = { variant, telephony: tel, unit: () => '', freq: () => '', wind: null, qnh: null, atisLetter: null, magVar: 0,
    transitionAltFt: variant === 'FAA' ? 18000 : /^Y/.test(icao) ? 10000 : 6000, time: 0, aircraft: null, spokenType: (x: string) => x };
  try { return { text: readback(p.ast, ctx, variant), callsign: p.callsign }; } catch { return { text: '', callsign: p.callsign }; }
}
export { NeuralPilotVoice } from '../../src/components/atc/pilotVoice';
export { S1_MODEL_URL } from '../../src/lib/voice/l1';
