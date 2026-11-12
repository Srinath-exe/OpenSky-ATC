import { makeEngine, text } from '../engine/helpers';
import { CHAPTERS, setRunner } from '../../src/game/Tutorial/lessons';
import { voiceContext } from '../../src/lib/voice/context';
import { biasNames } from '../../src/lib/voice/asr-nbest';
const e = makeEngine('KSFO', { seed: 7, pilotDelay: 2, ends: ['28L', '28R', '01L', '01R'] } as any);
setRunner((eng, line) => text(eng as any, line));
for (const id of ['g-push', 'g-giveway', 't-land', 'a-ils']) {
  CHAPTERS.find((c) => c.id === id)!.setup(e);
  const v = voiceContext(e, e.playerPosition); const b = biasNames(v);
  console.log(id, 'aircraft in sim', e.aircraft.length, 'parked', (e as any).parked?.length, '| voice context callsigns', v.callsigns.length, 'bias names', b.length, b.slice(0, 6).join(', '));
}
