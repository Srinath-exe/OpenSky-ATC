// ============================================================
//  Command parser — turns aviation-phraseology text into engine calls.
//
//  Grammar (callsign first, then a verb phrase). Examples:
//    BAW117 PUSHBACK
//    BAW117 TAXI RWY 27L          / BAW117 TAXI TO B12
//    BAW117 HOLD SHORT            / BAW117 CROSS
//    BAW117 LINE UP               / BAW117 CLEARED TAKEOFF
//    DAL55  CLEARED LAND
//    DAL55  TURN HEADING 240 LEFT / DAL55 FLY HDG 240 / DAL55 H240
//    DAL55  CLIMB 8000            / DAL55 DESCEND 3000 / DAL55 ALT 5000
//    DAL55  SPEED 180             / DAL55 S180
//    DAL55  ILS 27L               / DAL55 CLEARED ILS 27L
//    DAL55  DCT BIG               / DAL55 DIRECT BIG
//    DAL55  EXPEDITE
//    DAL55  GO AROUND
// ============================================================
import { SimEngine } from './engine';

export interface CommandResult {
  ok: boolean;
  reply: string;
  callsign?: string;
}

const RUNWAY_RE = /^\d{1,2}[LRC]?$/;

export function parseCommand(engine: SimEngine, raw: string): CommandResult {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, reply: '' };

  const tokens = text.toUpperCase().split(' ');
  const callsign = tokens.shift()!;
  if (!engine.find(callsign)) return { ok: false, reply: `No aircraft "${callsign}" on frequency`, callsign };

  const rest = tokens.join(' ');
  const has = (...words: string[]) => words.every(w => rest.includes(w));
  const num = (): number | null => {
    const m = rest.match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  };
  // First numeric token
  const firstNum = (): number | null => {
    const m = rest.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };
  // All alphabetic tokens after a given keyword
  const after = (kw: string) => {
    const i = tokens.indexOf(kw);
    return i >= 0 ? tokens.slice(i + 1) : [];
  };

  // ── ground commands ────────────────────────────────────────────────────────
  if (has('PUSHBACK') || has('PUSH'))         return reply(engine.cmdPushback(callsign), callsign);
  if (has('HOLD', 'SHORT'))                   return reply(engine.cmdHoldShort(callsign), callsign);
  if (has('CROSS') || has('CONTINUE'))        return reply(engine.cmdCross(callsign), callsign);
  if (has('LINE', 'UP') || has('LUAW') || has('WAIT')) return reply(engine.cmdLineUp(callsign), callsign);
  if (has('CLEARED', 'TAKEOFF') || has('TAKEOFF') || has('CLEARED', 'DEPARTURE'))
    return reply(engine.cmdTakeoff(callsign), callsign);
  if (has('CLEARED', 'LAND') || (has('LAND') && !has('ILS')))
    return reply(engine.cmdClearedLand(callsign), callsign);

  if (has('TAXI')) {
    const idx = tokens.findIndex(t => t === 'TAXI');
    const afterTaxi = tokens.slice(idx + 1);
    const viaIdx = afterTaxi.indexOf('VIA');
    const destPart = (viaIdx >= 0 ? afterTaxi.slice(0, viaIdx) : afterTaxi).filter(t => !['TO', 'RWY', 'RUNWAY', 'GATE', 'STAND'].includes(t));
    const dest = destPart[0];
    if (!dest) return { ok: false, reply: `${callsign}: taxi where?`, callsign };
    const via = viaIdx >= 0 ? afterTaxi.slice(viaIdx + 1).filter(t => /^[A-Z0-9]{1,3}$/.test(t)) : undefined;
    return reply(engine.cmdTaxiTo(callsign, dest, via), callsign);
  }

  // ── airborne heading ───────────────────────────────────────────────────────
  if (has('HEADING') || has('HDG') || has('TURN') || rest.match(/^H\d{1,3}/)) {
    const n = firstNum();
    if (n == null) return { ok: false, reply: `${callsign}: heading?`, callsign };
    const dir = has('LEFT') || has(' L') ? 'L' : has('RIGHT') || has(' R') ? 'R' : undefined;
    return reply(engine.cmdHeading(callsign, n, dir), callsign);
  }

  // ── airborne altitude ──────────────────────────────────────────────────────
  if (has('CLIMB') || has('DESCEND') || has('ALT') || has('ALTITUDE') || has('MAINTAIN') || rest.match(/^A\d/)) {
    let n = firstNum();
    if (n == null) return { ok: false, reply: `${callsign}: altitude?`, callsign };
    if (n < 1000) n *= 1000; // "climb 8" → 8000 ft
    const xp = has('EXPEDITE') || has('EXPD');
    return reply(engine.cmdAltitude(callsign, n, xp), callsign);
  }

  // ── airborne speed ─────────────────────────────────────────────────────────
  if (has('SPEED') || has('SPD') || rest.match(/^S\d{2,3}/)) {
    const n = firstNum();
    if (n == null) return { ok: false, reply: `${callsign}: speed?`, callsign };
    return reply(engine.cmdSpeed(callsign, n), callsign);
  }

  // ── ILS approach ───────────────────────────────────────────────────────────
  if (has('ILS') || has('LOC') || has('LLZ') || has('APPROACH')) {
    // Find runway token (e.g. "27L", "09R")
    const rwyTok = tokens.find(t => RUNWAY_RE.test(t));
    if (!rwyTok) {
      // Try to find any runway-like token in rest
      const m = rest.match(/\b(\d{1,2}[LRC]?)\b/);
      const rwy = m ? m[1] : null;
      if (!rwy) return { ok: false, reply: `${callsign}: ILS which runway?`, callsign };
      return reply(engine.cmdILS(callsign, rwy), callsign);
    }
    return reply(engine.cmdILS(callsign, rwyTok), callsign);
  }

  // ── direct-to ─────────────────────────────────────────────────────────────
  if (has('DCT') || has('DIRECT')) {
    const kw = has('DCT') ? 'DCT' : 'DIRECT';
    const fixes = after(kw).filter(t => /^[A-Z]{2,5}$/.test(t));
    if (!fixes.length) return { ok: false, reply: `${callsign}: direct where?`, callsign };
    return reply(engine.cmdDirect(callsign, fixes[0]), callsign);
  }

  // ── hold at fix ──────────────────────────────────────────────────────────
  // e.g. "BAW117 HOLD BIG", "BAW117 HOLD BIG LEFT", "BAW117 HOLD BIG 090"
  if (has('HOLD') && !has('SHORT') && !has('HOLD', 'SHORT')) {
    // "HOLD" without "SHORT" = orbit a fix
    const kw = tokens.indexOf('HOLD');
    const holdArgs = tokens.slice(kw + 1).filter(t => !['AT'].includes(t));
    const fixTok = holdArgs.find(t => /^[A-Z]{2,5}$/.test(t));
    if (!fixTok) return { ok: false, reply: `${callsign}: hold at which fix?`, callsign };
    const turnDir = holdArgs.includes('LEFT') || holdArgs.includes('L') ? 'L' as const
      : holdArgs.includes('RIGHT') || holdArgs.includes('R') ? 'R' as const
        : undefined;
    const inboundNum = holdArgs.find(t => /^\d{3}$/.test(t));
    const inbound = inboundNum ? parseInt(inboundNum, 10) : undefined;
    return reply(engine.cmdHold(callsign, fixTok, inbound, turnDir), callsign);
  }

  // ── expedite ──────────────────────────────────────────────────────────────
  if (has('EXPEDITE') || has('EXPD')) return reply(engine.cmdExpedite(callsign), callsign);

  // ── go-around ─────────────────────────────────────────────────────────────
  if (has('GO') || has('AROUND') || has('GOAROUND') || has('MISSED')) return reply(engine.cmdGoAround(callsign), callsign);

  return { ok: false, reply: `${callsign}: unable — say again`, callsign };
}

function reply(text: string, callsign: string): CommandResult {
  const ok = !/unable|unknown|no route|no aircraft|where|\?$|not /i.test(text);
  return { ok, reply: text, callsign };
}

export function isRunwayToken(t: string): boolean { return RUNWAY_RE.test(t.toUpperCase()); }
