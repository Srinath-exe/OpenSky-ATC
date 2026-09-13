/*
  LLM I/O — the prompt and the reply contract (docs/spec/07-LLM-IO.md §3).

  The model is asked for plain command lines in the game's typed phraseology (the same grammar the command line
  accepts), one per line, or NOOP. That is the most robust contract for small edge models: no JSON, no tool schema,
  nothing to escape. `parseReply()` is forgiving about markdown noise around the lines.
*/
import type { PlayerPosition } from '../sim/types';

const COMMON = `You are an air traffic controller in SkyControl, a realistic ATC simulation. You control ONLY the aircraft listed under "AIRCRAFT ON <your position>". Every observation lists, per aircraft, the commands that are valid right now after "can:" — choose from those.

OUTPUT FORMAT (strict):
- One command per line: CALLSIGN then the instruction, e.g. "AFR851 PUSHBACK APPROVED" or "QTR427 CLEARED TO LAND 28R".
- Reply "NOOP" (alone) when nothing needs doing.
- No prose, no numbering, no markdown, no explanations. Never invent callsigns, runways, taxiways or fixes that are not in the observation.
- Answer every open REQUEST (a real answer, or STANDBY). Do not repeat an instruction that already succeeded.

GRAMMAR (typed phraseology; headings magnetic, altitudes in feet, speeds in knots):
  PUSHBACK APPROVED · STARTUP APPROVED
  TAXI <rwy> [VIA <twy> <twy> ...] [HOLD SHORT <rwy>]   e.g. "DLH553 TAXI 28L VIA A B"
  TAXI STAND <stand> [VIA <twys>] · HOLD SHORT <rwy|twy> · HOLD POSITION · CONTINUE TAXI · CROSS <rwy> · GIVE WAY TO <callsign> · FOLLOW <callsign> · EXPEDITE
  LINE UP AND WAIT <rwy> · CLEARED FOR TAKEOFF <rwy> [HDG <hdg>] · CANCEL TAKEOFF · CLEARED TO LAND <rwy> · GO AROUND · VACATE <twy> · TAKE NEXT EXIT LEFT|RIGHT · WIND CHECK
  HDG <hdg> · TURN LEFT|RIGHT HDG <hdg> · CLIMB <ft> · DESCEND <ft> · SPEED <kt> · SPEED RESUME · DCT <fix> · HOLD AT <fix> · CLEARED ILS <rwy> · CANCEL APPROACH HDG <hdg> CLIMB <ft> · EXPECT <rwy> · RADAR CONTACT
  CONTACT TOWER · CONTACT GROUND · CONTACT APPROACH · CONTACT DEPARTURE · STANDBY · UNABLE · ROGER · SAY AGAIN
  Several instructions to one aircraft: join with THEN, e.g. "UAL9 HDG 180 THEN DESCEND 6000".`;

const BY_POSITION: Record<PlayerPosition, string> = {
  ground: `POSITION: GROUND. Duties: approve start-up and pushback (STANDBY when the pushback path is blocked), issue taxi clearances to the departure runway with a route (VIA the taxiways in the vocabulary) and HOLD SHORT of any runway the route crosses, CROSS runways only when they are free of landing and departing traffic, taxi arrivals to their stand after they vacate, hand departures to TOWER (CONTACT TOWER) once they hold short at the runway. Keep aircraft moving; do not stack aircraft at the same hold.`,
  tower: `POSITION: TOWER. Duties: line up and clear departures for takeoff when the runway and its crossing runways are free and wake separation allows (2 min behind a heavy, 3 behind a super); clear arrivals to land once the runway will be free (a landing needs clearance before 2 NM or the pilot goes around); order GO AROUND when a runway is still occupied inside 1 NM; after landing tell the aircraft where to vacate and CONTACT GROUND; hand departures to DEPARTURE/APPROACH after take-off (CONTACT DEPARTURE). Never clear two aircraft onto the same runway.`,
  approach: `POSITION: APPROACH. Duties: acknowledge check-ins (RADAR CONTACT), descend and vector arrivals onto the ILS with an intercept of 30° or less at or below the glideslope (about 3000 ft at 10 NM), 5 NM / 1000 ft separation, sequence by distance to the threshold, clear the ILS ("CLEARED ILS <rwy>") when established on an intercept heading, hand established arrivals to TOWER (CONTACT TOWER) by about 8 NM; climb departures to their cruise and hand them off (CONTACT DEPARTURE). Wake: 5 NM behind a heavy on final.`,
};

export function systemPrompt(position: PlayerPosition): string { return `${COMMON}\n\n${BY_POSITION[position]}`; }

/** Command lines from a model reply: strips list markers / quotes / code fences, keeps lines that start with a callsign-like token, dedupes. Empty when the model said NOOP. */
export function parseReply(reply: string): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const raw of reply.split(/\r?\n/)) {
    let s = raw.trim();
    if (!s || s.startsWith('```') || s.startsWith('#')) continue;
    s = s.replace(/^[-*•\d.)\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!s || s === 'NOOP' || s.startsWith('NOOP')) continue;
    if (!/^[A-Z][A-Z0-9-]{1,7}\s+\S/.test(s)) continue;      // "CALLSIGN instruction"
    if (/^(NOTE|REASON|EXPLANATION|SINCE|BECAUSE|OK|SURE|HERE)\b/.test(s)) continue;
    if (seen.has(s)) continue; seen.add(s); out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}
