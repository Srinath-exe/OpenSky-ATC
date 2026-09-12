// Text parser: every AST kind, terse + verbose forms, shorthand, sequences,
// conditionals, telephony / last-digit callsigns, vehicle + runway-status
// commands, and error codes. Table-driven: one node:test per line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, tokenize, resolveCallsign, verbsFor } from '../../src/lib/sim/commands';
import type { ParseErrorCode } from '../../src/lib/sim/commands';
import type { CommandAST } from '../../src/lib/sim/commandAst';
import { mkParseCtx } from './helpers';

const ctx = mkParseCtx();

type Expect = Record<string, unknown> | { error: ParseErrorCode };
/** Deep partial match: every key in `exp` must equal the value in `got` (arrays compared element-wise, objects recursively). */
function matches(got: unknown, exp: unknown, path = ''): string | null {
  if (Array.isArray(exp)) {
    if (!Array.isArray(got)) return `${path}: expected array`;
    if (got.length !== exp.length) return `${path}: length ${got.length} != ${exp.length} (${JSON.stringify(got)})`;
    for (let i = 0; i < exp.length; i++) { const m = matches(got[i], exp[i], `${path}[${i}]`); if (m) return m; }
    return null;
  }
  if (exp && typeof exp === 'object') {
    if (!got || typeof got !== 'object') return `${path}: expected object, got ${JSON.stringify(got)}`;
    for (const [k, v] of Object.entries(exp as Record<string, unknown>)) { const m = matches((got as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k); if (m) return m; }
    return null;
  }
  return Object.is(got, exp) ? null : `${path}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`;
}

const CASES: Array<[string, Expect, Partial<typeof ctx>?]> = [
  // ── ground: pushback / startup ────────────────────────────────────────────
  ['BAW117 pushback approved', { kind: 'pushback', callsign: 'BAW117', dir: 'any', startup: false, expectRunway: null }],
  ['BAW117 push face north expect runway 27R', { kind: 'pushback', dir: 'N', expectRunway: '27R' }],
  ['BAW117 pushback approved facing west, tail to A', { kind: 'pushback', dir: 'W', tailTo: 'A' }],
  ['BAW117 start up and push', { kind: 'pushback', startup: true }],
  ['BAW117 pushback and start approved expect 27R', { kind: 'pushback', startup: true, expectRunway: '27R' }],
  ['BAW117 startup approved expect 27R', { kind: 'startup', expectRunway: '27R' }],
  ['BAW117 start-up approved', { kind: 'startup', expectRunway: null }],
  ['SWR7 start', { kind: 'startup', callsign: 'SWR7' }],
  // ── taxi ──────────────────────────────────────────────────────────────────
  ['BAW117 taxi runway 27R via A B hold short of runway 27L', { kind: 'taxi', dest: { kind: 'runway', runway: '27R', intersection: null }, via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27L' } }],
  ['BAW117 taxi to holding point runway 27R via A, B, hold short 27L', { kind: 'taxi', via: ['A', 'B'], holdShortOf: { kind: 'runway', runway: '27L' } }],
  ['BAW117 taxi 27R', { kind: 'taxi', dest: { kind: 'runway', runway: '27R' }, via: [], auto: true }],
  ['BAW117 taxi 27R at A1 via A', { kind: 'taxi', dest: { kind: 'runway', runway: '27R', intersection: 'A1' }, via: ['A'] }],
  ['BAW117 taxi to stand 512 via N', { kind: 'taxi', dest: { kind: 'stand', ref: '512' }, via: ['N'] }],
  ['DLH2 taxi to stand 201', { kind: 'taxi', dest: { kind: 'stand', ref: '201' }, auto: true }],
  ['DLH2 taxi gate 201', { kind: 'taxi', dest: { kind: 'stand', ref: '201' } }],
  ['RYR4 taxi stand 55 via A B cross 27R', { kind: 'taxi', dest: { kind: 'stand', ref: '55' }, cross: ['27R'] }],
  ['BAW117 taxi 27R via A expedite', { kind: 'taxi', expedite: true }],
  ['BAW117 taxi', { kind: 'taxi', dest: { kind: 'runway', runway: '27R' } }],
  ['DLH2 taxi', { kind: 'taxi', dest: { kind: 'stand', ref: '201' } }],
  ['BAW117 taxi and hold at the intersection of A and B', { kind: 'taxi', dest: { kind: 'node', nodeId: 'A/B' } }],
  ['BAW117 taxi A B', { kind: 'taxi', dest: { kind: 'node', label: 'A/B' } }],
  ['BAW117 runway 27R taxi via A B', { kind: 'taxi', dest: { kind: 'runway', runway: '27R' }, via: ['A', 'B'] }],
  ['AFR1170 amend route via B C', { kind: 'taxi', dest: { kind: 'runway', runway: '27R' }, via: ['B', 'C'], auto: false }],
  ['BAW117 taxi 27R via A B, hold short runway 27L, cross 09L', { kind: 'taxi', holdShortOf: { kind: 'runway', runway: '27L' }, cross: ['09L'] }],
  // ── hold short / position / continue ─────────────────────────────────────
  ['AFR1170 hold short 27L', { kind: 'holdShort', of: { kind: 'runway', runway: '27L' } }],
  ['AFR1170 HS 27L', { kind: 'holdShort', of: { kind: 'runway', runway: '27L' } }],
  ['AFR1170 hold short of taxiway B', { kind: 'holdShort', of: { kind: 'taxiway', taxiway: 'B' } }],
  ['AFR1170 hold short', { kind: 'holdShort', of: { kind: 'runway', runway: '27L' } }],
  ['AFR1170 hold position', { kind: 'holdPosition', reason: null }],
  ['AFR1170 hold position traffic from the left', { kind: 'holdPosition', reason: 'traffic from the left' }],
  ['AFR1170 hold', { kind: 'holdPosition' }],
  ['AFR1170 stop', { kind: 'holdPosition' }],
  ['AFR1170 continue taxi', { kind: 'continue', holdShortOf: null }],
  ['AFR1170 continue taxi hold short 27L', { kind: 'continue', holdShortOf: { kind: 'runway', runway: '27L' } }],
  ['AFR1170 CONT', { kind: 'continue' }],
  ['AFR1170 resume taxi', { kind: 'continue' }],
  // ── cross / give way ──────────────────────────────────────────────────────
  ['AFR1170 cross 27L', { kind: 'cross', runway: '27L', expedite: false, behind: null }],
  ['AFR1170 cross runway 27L expedite', { kind: 'cross', runway: '27L', expedite: true }],
  ['AFR1170 cross', { kind: 'cross', runway: '27L' }],
  ['AFR1170 cross 27L behind UAE5', { kind: 'cross', runway: '27L', behind: 'UAE5' }],
  ['AFR1170 behind the landing A388 cross runway 27L behind', { kind: 'cross', runway: '27L', behind: 'UAE5' }],
  ['AFR1170 give way to BAW117', { kind: 'giveWay', to: 'BAW117', mode: 'give_way' }],
  ['AFR1170 GW BAW117', { kind: 'giveWay', to: 'BAW117' }],
  ['AFR1170 follow BAW117', { kind: 'giveWay', to: 'BAW117', mode: 'follow' }],
  ['AFR1170 follow the A388', { kind: 'giveWay', to: 'UAE5', mode: 'follow' }],
  ['AFR1170 follow the follow me', { kind: 'giveWay', to: 'FOLLOW1', mode: 'follow' }],
  ['AFR1170 give way to the A320', { error: 'ambiguous_callsign' }],
  // ── line up / takeoff / cancel ────────────────────────────────────────────
  ['AFR1170 line up and wait 27R', { kind: 'lineup', runway: '27R', behind: null, intersection: null }],
  ['AFR1170 LUAW 27R', { kind: 'lineup', runway: '27R' }],
  ['AFR1170 LUAW', { kind: 'lineup', runway: '27R' }],
  ['AFR1170 runway 27R line up and wait', { kind: 'lineup', runway: '27R' }],
  ['AFR1170 line up 27R at A1', { kind: 'lineup', runway: '27R', intersection: 'A1' }],
  ['AFR1170 behind the landing A388 line up and wait runway 27L behind', { kind: 'lineup', runway: '27L', behind: 'UAE5' }],
  ['AFR1170 line up 27R behind UAE5', { kind: 'lineup', runway: '27R', behind: 'UAE5' }],
  ['EZY99 cleared for takeoff 27R', { kind: 'takeoff', runway: '27R', immediate: false, afterDepHdg: null }],
  ['EZY99 cleared for takeoff', { kind: 'takeoff', runway: '27R' }],
  ['EZY99 CTO', { kind: 'takeoff', runway: '27R' }],
  ['EZY99 CTO HDG 270 IMM', { kind: 'takeoff', immediate: true, afterDepHdg: 270 }],
  ['EZY99 runway 27R cleared for takeoff', { kind: 'takeoff', runway: '27R' }],
  ['EZY99 cleared for immediate takeoff 27R', { kind: 'takeoff', immediate: true }],
  ['EZY99 fly runway heading climb 5000 cleared for takeoff 27R', { kind: 'takeoff', runway: '27R', afterDepHdg: 'runway', initialAlt: 5000 }],
  ['EZY99 after departure turn left heading 250 runway 27R cleared for takeoff', { kind: 'takeoff', afterDepHdg: 250 }],
  ['EZY99 cleared for takeoff 27R turn left 20 degrees', { kind: 'takeoff', turn: { dir: 'L', deg: 20 } }],
  ['EZY99 cleared for takeoff 27R on reaching contact departure', { kind: 'takeoff', contactDeparture: true }],
  ['EZY99 cancel takeoff', { kind: 'cancelTakeoff', reason: null }],
  ['EZY99 cancel takeoff clearance, I say again cancel takeoff, vehicle on runway', { kind: 'cancelTakeoff', reason: 'vehicle on runway' }],
  ['EZY99 stop immediately', { kind: 'cancelTakeoff' }],
  ['EZY99 abort takeoff', { kind: 'cancelTakeoff' }],
  ['EZY99 cancel line up vacate via A', { kind: 'cancelLineup', via: 'A' }],
  ['EZY99 vacate via A', { kind: 'cancelLineup', via: 'A' }],
  ['EZY99 vacate runway', { kind: 'cancelLineup', via: null }],
  ['EZY99 hold position', { kind: 'holdPosition' }],
  // ── landing / go-around / exit / expedite / wind ──────────────────────────
  ['UAE5 cleared to land 27L', { kind: 'clearedLand', runway: '27L', lahso: null, exit: null }],
  ['UAE5 cleared to land', { kind: 'clearedLand', runway: '27L' }],
  ['UAE5 CTL 27L', { kind: 'clearedLand', runway: '27L' }],
  ['UAE5 CTL 27L EXIT A LAHSO 09L', { kind: 'clearedLand', lahso: '09L', exit: { kind: 'taxiway', taxiway: 'A' } }],
  ['UAE5 cleared to land runway 27L hold short of 09L', { kind: 'clearedLand', lahso: '09L' }],
  ['UAE5 cleared to land 27L exit at A', { kind: 'clearedLand', exit: { kind: 'taxiway', taxiway: 'A' } }],
  ['UAE5 cleared to land 27L next exit left', { kind: 'clearedLand', exit: { kind: 'next', dir: 'L' } }],
  ['UAE5 cleared to land 27L, number 2', { kind: 'clearedLand', number: 2 }],
  ['UAE5 continue approach number 2 expect late landing clearance', { kind: 'continueApproach', number: 2 }],
  ['UAE5 continue approach', { kind: 'continueApproach', number: null }],
  ['UAE5 go around', { kind: 'goAround', heading: null, alt: null, contact: null }],
  ['UAE5 go around, I say again, go around, fly runway heading climb 3000 contact approach', { kind: 'goAround', heading: 'runway', alt: 3000, contact: 'approach' }],
  ['UAE5 GA HDG 270 ALT 3000', { kind: 'goAround', heading: 270, alt: 3000 }],
  ['UAE5 go around traffic on the runway', { kind: 'goAround', reason: 'traffic on the runway' }],
  ['UAE5 wind check', { kind: 'windCheck' }],
  ['UAE5 say wind', { kind: 'windCheck' }],
  ['RYR4 exit at A', { kind: 'exitAt', exit: { kind: 'taxiway', taxiway: 'A' } }],
  ['RYR4 vacate left', { kind: 'exitAt', exit: { kind: 'next', dir: 'L' } }],
  ['RYR4 vacate runway via A', { kind: 'exitAt', exit: { kind: 'taxiway', taxiway: 'A' } }],
  ['RYR4 take next available exit on the left', { kind: 'exitAt', exit: { kind: 'next', dir: 'L' } }],
  ['RYR4 next exit right', { kind: 'exitAt', exit: { kind: 'next', dir: 'R' } }],
  ['RYR4 exit at A hold short 27R contact ground', { kind: 'exitAt', holdShortOf: { kind: 'runway', runway: '27R' }, contactGround: true }],
  ['RYR4 exit at A expedite', { kind: 'exitAt', expedite: true }],
  ['UAE5 plan to vacate at A', { kind: 'exitAt', exit: { kind: 'taxiway', taxiway: 'A' } }],
  ['RYR4 expedite', { kind: 'expedite', on: true, scope: 'vacating' }],
  ['AFR1170 expedite taxi', { kind: 'expedite', scope: 'taxi' }],
  ['DLH2 expedite descent', { kind: 'expedite', scope: 'descent' }],
  ['DLH2 EXP', { kind: 'expedite', scope: 'climb' }],
  // ── contact / handoff ─────────────────────────────────────────────────────
  ['RYR4 when vacated contact ground', { kind: 'contact', position: 'ground', when: 'when_vacated' }],
  ['RYR4 contact ground when vacated', { kind: 'contact', position: 'ground', when: 'when_vacated' }],
  ['RYR4 contact ground 121.9', { kind: 'contact', position: 'ground', when: 'now' }],
  ['UAE5 contact tower', { kind: 'contact', position: 'tower', when: 'now' }],
  ['UAE5 CT TWR', { kind: 'contact', position: 'tower' }],
  ['BAW117 contact tower at the holding point', { kind: 'contact', position: 'tower', when: 'at_hold' }],
  ['BAW117 at the holding point contact tower', { kind: 'contact', position: 'tower', when: 'at_hold' }],
  ['THY8 contact departure', { kind: 'contact', position: 'departure' }],
  ['THY8 on reaching contact departure', { kind: 'contact', position: 'departure', when: 'on_reaching' }],
  ['THY8 contact london control 127.4 good day', { kind: 'contact', position: 'external' }],
  ['DLH2 contact approach', { kind: 'contact', position: 'approach' }],
  // ── heading ───────────────────────────────────────────────────────────────
  ['DLH2 turn left heading 240', { kind: 'heading', hdg: 240, dir: 'L', when: null, relative: null }],
  ['DLH2 turn right heading 090', { kind: 'heading', hdg: 90, dir: 'R' }],
  ['DLH2 L240', { kind: 'heading', hdg: 240, dir: 'L' }],
  ['DLH2 R240', { kind: 'heading', hdg: 240, dir: 'R' }],
  ['DLH2 H240', { kind: 'heading', hdg: 240, dir: null }],
  ['DLH2 fly heading 240', { kind: 'heading', hdg: 240, dir: null }],
  ['DLH2 heading 240 left', { kind: 'heading', hdg: 240, dir: 'L' }],
  ['DLH2 HDG 360', { kind: 'heading', hdg: 360 }],
  ['DLH2 turn right 20 degrees', { kind: 'heading', hdg: 110, dir: 'R', relative: { dir: 'R', deg: 20 } }],
  ['DLH2 turn left two zero degrees', { kind: 'heading', hdg: 70, relative: { dir: 'L', deg: 20 } }],
  ['DLH2 turn left heading two four zero', { kind: 'heading', hdg: 240, dir: 'L' }],
  ['DLH2 fly runway heading', { kind: 'heading', hdg: 270 }],
  ['DLH2 fly present heading', { kind: 'heading', hdg: 90 }],
  ['DLH2 turn left heading 250', { kind: 'heading', hdg: 255 }, { magVar: 5 }],
  // ── altitude ──────────────────────────────────────────────────────────────
  ['DLH2 descend 3000', { kind: 'altitude', ft: 3000, expedite: false, when: null }],
  ['DLH2 D3000', { kind: 'altitude', ft: 3000 }],
  ['DLH2 descend to 3000 expedite', { kind: 'altitude', ft: 3000, expedite: true }],
  ['DLH2 descend and maintain 3000', { kind: 'altitude', ft: 3000 }],
  ['DLH2 climb FL80', { kind: 'altitude', ft: 8000 }],
  ['DLH2 climb flight level 80', { kind: 'altitude', ft: 8000 }],
  ['DLH2 climb flight level one three zero', { kind: 'altitude', ft: 13000 }],
  ['DLH2 C80', { kind: 'altitude', ft: 8000 }],
  ['DLH2 A3000', { kind: 'altitude', ft: 3000 }],
  ['DLH2 descend FL 80', { kind: 'altitude', ft: 8000 }],
  ['DLH2 descend 4000 at pilots discretion', { kind: 'altitude', ft: 4000, when: { type: 'when_ready' } }],
  ['DLH2 maintain 5000', { kind: 'altitude', ft: 5000 }],
  ['DLH2 descend 8', { kind: 'altitude', ft: 8000 }],
  ['DLH2 descend three thousand five hundred', { kind: 'altitude', ft: 3500 }],
  ['DLH2 climb 5000 expedite', { kind: 'altitude', ft: 5000, expedite: true }],
  // ── speed ─────────────────────────────────────────────────────────────────
  ['DLH2 speed 180', { kind: 'speed', kts: 180, untilNM: null }],
  ['DLH2 S180', { kind: 'speed', kts: 180 }],
  ['DLH2 reduce speed 180', { kind: 'speed', kts: 180 }],
  ['DLH2 reduce speed to 180 knots until 4 mile final', { kind: 'speed', kts: 180, untilNM: 4 }],
  ['DLH2 maintain 180 knots', { kind: 'speed', kts: 180 }],
  ['DLH2 increase speed 250', { kind: 'speed', kts: 250 }],
  ['DLH2 resume normal speed', { kind: 'speed', kts: 'resume' }],
  ['DLH2 no speed restrictions', { kind: 'speed', kts: 'resume' }],
  ['DLH2 S RESUME', { kind: 'speed', kts: 'resume' }],
  ['DLH2 reduce to minimum clean speed', { kind: 'speed', kts: 210 }],
  // ── direct / SID / hold ───────────────────────────────────────────────────
  ['DLH2 direct OCK', { kind: 'direct', fix: 'OCK', thenHdg: null }],
  ['DLH2 DCT OCK', { kind: 'direct', fix: 'OCK' }],
  ['DLH2 D OCK', { kind: 'direct', fix: 'OCK' }],
  ['DLH2 proceed direct OCK then heading 240', { kind: 'direct', fix: 'OCK', thenHdg: 240 }],
  ['DLH2 direct OCK T 240', { kind: 'direct', fix: 'OCK', thenHdg: 240 }],
  ['THY8 resume own navigation', { kind: 'resumeSid' }],
  ['THY8 resume SID', { kind: 'resumeSid' }],
  ['THY8 climb via SID', { kind: 'resumeSid' }],
  ['DLH2 hold at OCK', { kind: 'hold', fix: 'OCK', inbound: null, dir: null, legTimeMin: 1, legNM: null }],
  ['DLH2 hold at OCK inbound 090 left turns 1 minute legs', { kind: 'hold', fix: 'OCK', inbound: 90, dir: 'L', legTimeMin: 1 }],
  ['DLH2 HOLD OCK I 090 L LEG 4 NM EFC 1245', { kind: 'hold', fix: 'OCK', inbound: 90, dir: 'L', legNM: 4, legTimeMin: null, efc: 12 * 3600 + 45 * 60 }],
  ['DLH2 hold at OCK as published expect further clearance at 1245', { kind: 'hold', fix: 'OCK', efc: 12 * 3600 + 45 * 60 }],
  ['DLH2 hold at OCK right turns 4 mile legs', { kind: 'hold', fix: 'OCK', dir: 'R', legNM: 4 }],
  ['DLH2 hold at OCK expect 20 minutes delay', { kind: 'hold', fix: 'OCK', efc: 3600 + 20 * 60 }],
  ['DLH2 hold at OCK EFC 45', { kind: 'hold', fix: 'OCK', efc: 3600 + 45 * 60 }],
  // ── approach clearances ───────────────────────────────────────────────────
  ['DLH2 cleared ILS 27L', { kind: 'ils', runway: '27L', reportEstablished: true }],
  ['DLH2 I27L', { kind: 'ils', runway: '27L' }],
  ['DLH2 I 27L', { kind: 'ils', runway: '27L' }],
  ['DLH2 cleared ILS approach runway 27L report established', { kind: 'ils', runway: '27L', reportEstablished: true }],
  ['DLH2 cleared ILS 27L no report', { kind: 'ils', runway: '27L', reportEstablished: false }],
  ['DLH2 cleared ILS', { kind: 'ils', runway: '27L' }],
  ['DLH2 cleared ILS runway 27 left approach', { kind: 'ils', runway: '27L' }],
  ['DLH2 cleared localizer 27L maintain 3000', { kind: 'loc', runway: '27L', maintainAlt: 3000 }],
  ['DLH2 LOC 27L', { kind: 'loc', runway: '27L', maintainAlt: null }],
  ['DLH2 cleared visual approach 27L follow UAE5', { kind: 'visual', runway: '27L', follow: 'UAE5' }],
  ['DLH2 VIS 27L', { kind: 'visual', runway: '27L', follow: null }],
  ['UAE5 cancel approach clearance turn left heading 180 climb 4000', { kind: 'cancelApproach', hdg: 180, alt: 4000, dir: 'L' }],
  ['UAE5 cancel approach, left heading 180, altitude 4000', { kind: 'cancelApproach', hdg: 180, alt: 4000, dir: 'L' }],
  ['UAE5 cancel approach', { error: 'missing_param' }],
  ['UAE5 cancel', { error: 'missing_param' }],
  ['DLH2 expect runway 27L', { kind: 'expectRunway', runway: '27L', approach: 'ILS' }],
  ['DLH2 expect ILS 27L', { kind: 'expectRunway', runway: '27L', approach: 'ILS' }],
  ['DLH2 expect vectors visual approach 27L', { kind: 'expectRunway', runway: '27L', approach: 'VISUAL' }],
  ['DLH2 change of runway expect ILS 27R', { kind: 'expectRunway', runway: '27R' }],
  ['UAE5 change to runway 27R', { kind: 'ils', runway: '27R' }],
  ['BAW117 change of runway 09R', { kind: 'expectRunway', runway: '09R' }],
  // ── squawk / radar ────────────────────────────────────────────────────────
  ['DLH2 squawk 4521', { kind: 'squawk', code: '4521' }],
  ['DLH2 SQ 4521', { kind: 'squawk', code: '4521' }],
  ['DLH2 squawk four five two one', { kind: 'squawk', code: '4521' }],
  ['DLH2 squawk ident', { kind: 'ident' }],
  ['DLH2 ident', { kind: 'ident' }],
  ['DLH2 radar contact descend 5000 expect ILS 27L', { kind: 'radarContact', descendTo: 5000, expectRunway: '27L' }],
  ['DLH2 RC', { kind: 'radarContact', descendTo: null, expectRunway: null }],
  ['DLH2 radar contact, descend 5000, QNH 1013', { kind: 'radarContact', descendTo: 5000 }],
  // ── meta ──────────────────────────────────────────────────────────────────
  ['DLH2 say again', { kind: 'sayAgain' }],
  ['DLH2 correction heading 250', { kind: 'correction', field: 'heading', value: 250 }],
  ['DLH2 negative heading 250 I say again heading 250', { kind: 'correction', field: 'heading', value: 250 }],
  ['DLH2 correction altitude FL80', { kind: 'correction', field: 'altitude', value: 8000 }],
  ['DLH2 correction runway 27R', { kind: 'correction', field: 'runway', value: '27R' }],
  ['DLH2 disregard', { kind: 'disregard' }],
  ['DLH2 standby', { kind: 'standby' }],
  ['DLH2 stand by', { kind: 'standby' }],
  ['BAW117 unable', { kind: 'unable', reason: 'traffic' }],
  ['BAW117 unable wake', { kind: 'unable', reason: 'wake' }],
  ['BAW117 unable runway closed', { kind: 'unable', reason: 'runway_closed' }],
  ['BAW117 negative', { kind: 'unable' }],
  ['BAW117 expect 10 minutes delay', { kind: 'unable', reason: 'delay' }],
  ['DLH2 report heading and altitude', { kind: 'report', items: ['heading', 'altitude'] }],
  ['DLH2 say heading', { kind: 'report', items: ['heading'] }],
  ['BAW117 report position', { kind: 'report', items: ['position'] }],
  ['BAW117 report ready', { kind: 'report', items: ['ready'] }],
  ['DLH2 report established', { kind: 'report', items: ['established'] }],
  ['DLH2 say souls on board and fuel remaining', { kind: 'report', items: ['pob', 'fuel'] }],
  ['DLH2 report', { kind: 'report', items: ['position'] }],
  ['DLH2 roger', { kind: 'roger' }],
  ['DLH2 read you five', { kind: 'report', items: ['readyou5'] }],
  // ── emergency ─────────────────────────────────────────────────────────────
  ['THY8 roger mayday', { kind: 'emergencyAck', ask: ['pob', 'fuel', 'intentions'], squawk: true }],
  ['THY8 roger mayday squawk 7700 say souls on board and fuel remaining', { kind: 'emergencyAck', ask: ['pob', 'fuel'], squawk: true }],
  ['THY8 roger mayday say intentions', { kind: 'emergencyAck', ask: ['intentions'], squawk: false }],
  ['THY8 mayday acknowledged', { kind: 'emergencyAck' }],
  ['THY8 priority runway 27L number one straight in cleared ILS 27L', { kind: 'priority', runway: '27L', straightIn: true, numberOne: true, clearIls: true, sterile: false }],
  ['THY8 number one runway 27L', { kind: 'priority', runway: '27L', numberOne: true, clearIls: false }],
  ['THY8 priority 27L runway sterile', { kind: 'priority', runway: '27L', sterile: true }],
  ['UAE5 stop on the runway', { kind: 'stopOnRunway', mode: 'stop', via: null }],
  ['UAE5 vacate if able via A', { kind: 'stopOnRunway', mode: 'vacate_if_able', via: 'A' }],
  ['THY8 roger mayday cancelled', { kind: 'emergencyCancelAck' }],
  ['THY8 cancel mayday', { kind: 'emergencyCancelAck' }],
  // ── system: vehicles ──────────────────────────────────────────────────────
  ['dispatch fire 1 fire 2 to runway 27L', { kind: 'dispatchVehicle', type: 'arff', ids: ['FIRE1', 'FIRE2'], count: 2, target: { kind: 'runway', runway: '27L' } }],
  ['dispatch 2 fire to runway 27L', { kind: 'dispatchVehicle', type: 'arff', ids: [], count: 2, target: { kind: 'runway', runway: '27L' } }],
  ['dispatch fire to DLH2', { kind: 'dispatchVehicle', type: 'arff', target: { kind: 'aircraft', id: 2, callsign: 'DLH2' } }],
  ['dispatch follow me to stand 512', { kind: 'dispatchVehicle', type: 'followme', count: 1, target: { kind: 'stand', ref: '512' } }],
  ['send ambulance to stand 512', { kind: 'dispatchVehicle', type: 'ambulance', target: { kind: 'stand', ref: '512' } }],
  ['recall fire 1', { kind: 'recallVehicle', id: 'FIRE1' }],
  ['fire 1 cross 27L', { kind: 'vehicleOp', id: 'FIRE1', op: 'cross', runway: '27L' }],
  ['fire 1 hold', { kind: 'vehicleOp', id: 'FIRE1', op: 'hold' }],
  ['FIRE1 continue', { kind: 'vehicleOp', id: 'FIRE1', op: 'continue' }],
  ['OPS1 RTB', { kind: 'vehicleOp', id: 'OPS1', op: 'rtb' }],
  ['ops 1 return to base', { kind: 'vehicleOp', id: 'OPS1', op: 'rtb' }],
  ['VEH FIRE1 CROSS 27L', { kind: 'vehicleOp', id: 'FIRE1', op: 'cross', runway: '27L' }],
  ['dispatch fire 9 to runway 27L', { error: 'unknown_vehicle' }],
  // ── system: runway status / hold all / broadcast ──────────────────────────
  ['close runway 27L', { kind: 'runwayStatus', runway: '27L', status: 'closed', reason: null }],
  ['runway 27L closed debris', { kind: 'runwayStatus', runway: '27L', status: 'closed', reason: 'debris' }],
  ['RWY 27L CLOSE', { kind: 'runwayStatus', runway: '27L', status: 'closed' }],
  ['reopen 27L', { kind: 'reopenRunway', runway: '27L', afterInspection: false }],
  ['reopen runway 27L after inspection', { kind: 'reopenRunway', runway: '27L', afterInspection: true }],
  ['inspect 27L', { kind: 'runwayStatus', runway: '27L', status: 'inspection' }],
  ['runway 27L open', { kind: 'runwayStatus', runway: '27L', status: 'open' }],
  ['runway 27L sterile', { kind: 'runwayStatus', runway: '27L', status: 'sterile' }],
  ['hold all', { kind: 'holdAll', scope: 'all', runway: null }],
  ['hold all departures 27L', { kind: 'holdAll', scope: 'departures', runway: '27L' }],
  ['hold crossings', { kind: 'holdAll', scope: 'crossings' }],
  ['resume all', { kind: 'resumeAll' }],
  ['resume normal operations', { kind: 'resumeAll' }],
  ['broadcast Runway 27L closed for 10 minutes', { kind: 'broadcast', text: 'Runway 27L closed for 10 minutes' }],
  ['all stations hold position emergency in progress', { kind: 'holdAll', scope: 'all' }],
  ['all stations runway change in progress', { kind: 'broadcast', text: 'runway change in progress' }],
  ['broadcast', { error: 'missing_param' }],
  // ── callsign forms ────────────────────────────────────────────────────────
  ['speedbird 117 taxi 27R', { kind: 'taxi', callsign: 'BAW117' }],
  ['speedbird one one seven taxi 27R', { kind: 'taxi', callsign: 'BAW117' }],
  ['BAW 117 taxi 27R', { kind: 'taxi', callsign: 'BAW117' }],
  ['BA117 taxi 27R', { kind: 'taxi', callsign: 'BAW117' }],
  ['117 taxi 27R', { kind: 'taxi', callsign: 'BAW117' }],
  ['1170 hold position', { kind: 'holdPosition', callsign: 'AFR1170' }],
  ['lufthansa two descend 3000', { kind: 'altitude', callsign: 'DLH2' }],
  ['emirates 5 heavy cleared to land 27L', { kind: 'clearedLand', callsign: 'UAE5' }],
  ['dlh2 descend 3000 then cleared ils 27l', { kind: 'sequence', callsign: 'DLH2' }],
  ['descend 3000', { kind: 'altitude', callsign: 'DLH2', ft: 3000 }, { lastCallsign: 'DLH2' }],
  ['D3000', { kind: 'altitude', callsign: 'DLH2' }, { lastCallsign: 'DLH2' }],
  ['XYZ1 taxi 27R', { error: 'unknown_callsign' }],
  ['descend 3000', { error: 'unknown_callsign' }],
  ['70 hold position', { error: 'ambiguous_callsign' }],
  // ── sequences (THEN / commas / folding / ordering) ─────────────────────────
  ['DLH2 descend 3000 then cleared ILS 27L', { kind: 'sequence', parts: [{ kind: 'altitude', ft: 3000 }, { kind: 'ils', runway: '27L' }] }],
  ['DLH2 descend 3000, cleared ILS 27L, report established', { kind: 'sequence', parts: [{ kind: 'altitude', ft: 3000 }, { kind: 'ils', runway: '27L', reportEstablished: true }] }],
  ['DLH2 turn left heading 240 descend 3000 speed 180', { kind: 'sequence', parts: [{ kind: 'heading', hdg: 240, dir: 'L' }, { kind: 'altitude', ft: 3000 }, { kind: 'speed', kts: 180 }] }],
  ['DLH2 speed 180 then descend 4000', { kind: 'sequence', parts: [{ kind: 'altitude', ft: 4000 }, { kind: 'speed', kts: 180 }] }],
  ['DLH2 altitude 4000 then speed 180', { kind: 'sequence', parts: [{ kind: 'altitude', ft: 4000 }, { kind: 'speed', kts: 180 }] }],
  ['DLH2 direct OCK then heading 240', { kind: 'direct', fix: 'OCK', thenHdg: 240 }],
  ['DLH2 turn left heading 240 then direct OCK', { error: 'incompatible_parts' }],
  ['DLH2 descend 3000 hold at OCK cleared ILS 27L', { error: 'incompatible_parts' }],
  ['DLH2 turn left heading 240 climb 5000 speed 200 cleared ILS 27L report established', { kind: 'sequence', parts: [{ kind: 'heading' }, { kind: 'altitude' }, { kind: 'speed' }, { kind: 'ils' }] }],
  ['DLH2 turn left heading 240 climb 5000 speed 200 cleared ILS 27L then contact tower', { error: 'too_many_parts' }],
  ['DLH2 climb 3000 climb 4000', { kind: 'altitude', ft: 4000 }],
  ['UAE5 cleared to land 27L then contact ground when vacated', { kind: 'sequence', parts: [{ kind: 'clearedLand', runway: '27L' }, { kind: 'contact', position: 'ground', when: 'when_vacated' }] }],
  ['BAW117 taxi 27R via A then contact tower at the holding point', { kind: 'sequence', parts: [{ kind: 'taxi' }, { kind: 'contact', position: 'tower', when: 'at_hold' }] }],
  ['BAW117 pushback approved then taxi 27R', { kind: 'sequence', parts: [{ kind: 'pushback' }, { kind: 'taxi', dest: { kind: 'runway', runway: '27R' } }] }],
  ['DLH2 cleared ILS 27L then contact tower 118.5', { kind: 'sequence', parts: [{ kind: 'ils' }, { kind: 'contact', position: 'tower' }] }],
  // ── conditionals (AT / AFTER / WHEN PASSING / ON REACHING / AFTER PUSHBACK) ─
  ['DLH2 when passing 4000 turn left heading 240', { kind: 'heading', hdg: 240, dir: 'L', when: { type: 'at_or_below_alt', ft: 4000 } }],
  ['DLH2 at 4000 turn left heading 240', { kind: 'heading', when: { type: 'at_or_below_alt', ft: 4000 } }],
  ['DLH2 turn right heading 090 when passing 4000', { kind: 'heading', hdg: 90, when: { type: 'at_or_below_alt', ft: 4000 } }],
  ['THY8 passing 4000 turn left heading 240', { kind: 'heading', when: { type: 'at_or_above_alt', ft: 4000 } }],
  ['DLH2 turn left heading 240 at or above 5000', { kind: 'heading', when: { type: 'at_or_above_alt', ft: 5000 } }],
  ['DLH2 after OCK turn left heading 240', { kind: 'heading', when: { type: 'after_fix', fix: 'OCK' } }],
  ['DLH2 after passing OCK descend 3000', { kind: 'altitude', ft: 3000, when: { type: 'after_fix', fix: 'OCK' } }],
  ['DLH2 fly heading 240 after OCK', { kind: 'heading', when: { type: 'after_fix', fix: 'OCK' } }],
  ['DLH2 descend 3000 when ready', { kind: 'altitude', when: { type: 'when_ready' } }],
  ['DLH2 on reaching 4000 contact departure', { kind: 'contact', position: 'departure', when: 'on_reaching' }],
  ['DLH2 when passing 4000 turn left heading 240 then descend 3000', { kind: 'sequence', parts: [{ kind: 'heading', when: { type: 'at_or_below_alt', ft: 4000 } }, { kind: 'altitude', ft: 3000, when: null }] }],
  // ── errors with codes ─────────────────────────────────────────────────────
  ['', { error: 'empty' }],
  ['   ', { error: 'empty' }],
  ['BAW117', { error: 'unknown_verb' }],
  ['BAW117 frobnicate', { error: 'unknown_verb' }],
  ['BAW117 taxi 27R via', { error: 'missing_param' }],
  ['BAW117 taxi 27R via Q', { error: 'unknown_taxiway' }],
  ['BAW117 taxi 18L', { error: 'unknown_runway' }],
  ['BAW117 taxi to stand 999', { error: 'unknown_stand' }],
  ['BAW117 taxi to stand', { error: 'missing_param' }],
  ['DLH2 direct ZZZZ', { error: 'unknown_fix' }],
  ['DLH2 direct', { error: 'missing_param' }],
  ['DLH2 heading 400', { error: 'invalid_heading' }],
  ['DLH2 heading 000', { error: 'invalid_heading' }],
  ['DLH2 turn left', { error: 'missing_param' }],
  ['DLH2 turn left 200 degrees', { error: 'invalid_heading' }],
  ['DLH2 descend 3050', { error: 'invalid_altitude' }],
  ['DLH2 climb FL500', { error: 'invalid_altitude' }],
  ['DLH2 descend', { error: 'missing_param' }],
  ['DLH2 speed 400', { error: 'invalid_speed' }],
  ['DLH2 speed 90', { error: 'invalid_speed' }],
  ['DLH2 speed', { error: 'missing_param' }],
  ['DLH2 squawk 8888', { error: 'invalid_squawk' }],
  ['DLH2 squawk 12', { error: 'missing_param' }],
  ['DLH2 hold at OCK inbound 400', { error: 'invalid_heading' }],
  ['DLH2 hold at ZZZZ', { error: 'unknown_fix' }],
  ['DLH2 cleared ILS 18L', { error: 'unknown_runway' }],
  ['DLH2 cleared for the option', { error: 'unsupported' }],
  ['DLH2 cleared RNAV 27L', { error: 'unsupported' }],
  ['DLH2 descend via STAR', { error: 'unsupported' }],
  ['AFR1170 give way to', { error: 'missing_param' }],
  ['AFR1170 follow ZZZ9', { error: 'unknown_aircraft' }],
  ['DLH2 correction', { error: 'missing_param' }],
  ['DLH2 correction heading', { error: 'missing_param' }],
  ['BAW117 hold all', { error: 'unknown_verb' }],
  ['BAW117 resume', { error: 'unknown_verb' }],
  ['BAW117 cleared', { error: 'unknown_verb' }],
  ['BAW117 runway 27R', { error: 'unknown_verb' }],
  ['recall', { error: 'missing_param' }],
  ['fire 1', { error: 'missing_param' }],
  ['fire 1 dance', { error: 'unknown_verb' }],
  ['close runway 18L', { error: 'unknown_runway' }],
  ['dispatch to runway 27L', { error: 'missing_param' }],
  ['dispatch fire to the map point', { error: 'unsupported' }],
];

for (const [text, exp, over] of CASES) {
  test(`parse: "${text}"`, () => {
    const r = parseCommand(text, over ? mkParseCtx(over) : ctx);
    if ('error' in exp && typeof exp.error === 'string' && Object.keys(exp).length === 1) {
      assert.equal(r.ok, false, `expected error ${exp.error}, got ${JSON.stringify(r.ast)}`);
      assert.equal(r.errors[0]?.code, exp.error, `error code (${r.errors[0]?.message})`);
      assert.ok(Array.isArray(r.errors[0]?.expected), 'errors carry expected[]');
      assert.equal(r.ast, null);
      return;
    }
    assert.equal(r.ok, true, `parse failed: ${r.errors[0]?.code}: ${r.errors[0]?.message}`);
    const m = matches(r.ast, exp);
    assert.equal(m, null, `${m}\n  ast=${JSON.stringify(r.ast)}`);
  });
}

test('parse: at least 120 table cases', () => { assert.ok(CASES.length >= 120, `only ${CASES.length}`); });

test('parse: every CommandAST kind is reachable from text', () => {
  const kinds = new Set<string>();
  for (const [text, exp, over] of CASES) {
    if ('error' in exp) continue;
    const r = parseCommand(text, over ? mkParseCtx(over) : ctx);
    if (!r.ok || !r.ast) continue;
    const ast = r.ast as CommandAST;
    kinds.add(ast.kind);
    if (ast.kind === 'sequence') for (const p of ast.parts) kinds.add(p.kind);
  }
  const all = [
    'startup', 'pushback', 'taxi', 'holdShort', 'holdPosition', 'continue', 'cross', 'giveWay', 'lineup', 'takeoff', 'cancelTakeoff', 'cancelLineup', 'exitAt', 'expedite',
    'clearedLand', 'continueApproach', 'goAround', 'windCheck', 'contact',
    'heading', 'altitude', 'speed', 'direct', 'hold', 'ils', 'loc', 'visual', 'cancelApproach', 'expectRunway', 'resumeSid', 'squawk', 'ident', 'radarContact',
    'sayAgain', 'correction', 'disregard', 'standby', 'unable', 'report', 'roger',
    'emergencyAck', 'priority', 'stopOnRunway', 'emergencyCancelAck',
    'holdAll', 'resumeAll', 'reopenRunway', 'dispatchVehicle', 'recallVehicle', 'vehicleOp', 'runwayStatus', 'broadcast', 'sequence',
  ];
  const missing = all.filter(k => !kinds.has(k));
  assert.deepEqual(missing, [], `kinds never produced: ${missing.join(', ')}`);
});

test('parse: result carries callsign, tokens and detached conditions', () => {
  const r = parseCommand('BAW117 after pushback taxi 27R via A', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.callsign, 'BAW117');
  assert.equal(r.tokens.length, 7);
  assert.deepEqual(r.detachedConditions, [{ kind: 'taxi', condition: { type: 'after_pushback' } }]);
  const r2 = parseCommand('THY8 on reaching 4000 contact departure', ctx);
  assert.equal((r2.ast as { when: string }).when, 'on_reaching');
  assert.equal(r2.detachedConditions?.[0]?.condition.type, 'at_or_above_alt');
});

test('parse: ambiguous callsign lists candidates', () => {
  const r = parseCommand('70 hold position', ctx);
  assert.equal(r.ok, false);
  assert.deepEqual([...(r.ambiguous ?? [])].sort(), ['AFR1170', 'EIN70'].sort());
  assert.deepEqual(r.errors[0].expected, r.ambiguous);
});

test('parse: lenient mode without identifier lists accepts any shaped identifier', () => {
  const r = parseCommand('ABC123 taxi 18L via Z hold short of 36R', {});
  assert.equal(r.ok, true, r.errors[0]?.message);
  assert.equal((r.ast as { dest: { runway: string } }).dest.runway, '18L');
  assert.equal(parseCommand('ABC123 direct ZZZZ', {}).ok, true);
  assert.equal(parseCommand('ABC123 direct ZZZZZZ', {}).errors[0]?.code, 'unknown_fix');
  assert.equal(parseCommand('ABC123 direct ZZZZ', { strict: true, fixes: [] }).errors[0]?.code, 'unknown_fix');
});

test('parse: identifiers are upper-cased and runway sides normalised', () => {
  const r = parseCommand('baw117 taxi runway 27 right via a b hold short of runway 27 left', ctx);
  assert.equal(r.ok, true, r.errors[0]?.message);
  const ast = r.ast as { dest: { runway: string }; via: string[]; holdShortOf: { runway: string } };
  assert.equal(ast.dest.runway, '27R');
  assert.deepEqual(ast.via, ['A', 'B']);
  assert.equal(ast.holdShortOf.runway, '27L');
  assert.equal((parseCommand('DLH2 cleared ILS 9L', ctx).ast as { runway: string }).runway, '09L');
});

test('parse: heading tokens are magnetic, AST is TRUE (magVar applied)', () => {
  const east = parseCommand('DLH2 fly heading 090', mkParseCtx({ magVar: 12 }));
  assert.equal((east.ast as { hdg: number }).hdg, 102);
  const west = parseCommand('DLH2 fly heading 010', mkParseCtx({ magVar: -12 }));
  assert.equal((west.ast as { hdg: number }).hdg, 358);
  const wrap = parseCommand('DLH2 fly heading 355', mkParseCtx({ magVar: 5 }));
  assert.equal((wrap.ast as { hdg: number }).hdg, 360);
});

test('parse: relative turn uses the aircraft heading', () => {
  const r = parseCommand('DLH2 turn left 30 degrees', ctx); // DLH2 heading 090
  assert.equal((r.ast as { hdg: number }).hdg, 60);
  const r2 = parseCommand('BAW117 turn right 100 degrees', ctx); // heading 270 -> 010
  assert.equal((r2.ast as { hdg: number }).hdg, 10);
});

test('tokenize: spoken digits, flight levels, thousands, punctuation, HEAVY suffix', () => {
  const t = (s: string) => tokenize(s).map(x => x.text);
  assert.deepEqual(t('two four zero'), ['240']);
  assert.deepEqual(t('flight level eight zero'), ['FL80']);
  assert.deepEqual(t('FL 80'), ['FL80']);
  assert.deepEqual(t('three thousand five hundred'), ['3500']);
  assert.deepEqual(t('5 thousand'), ['5000']);
  assert.deepEqual(t('one one eight decimal fife'), ['118.5']);
  assert.deepEqual(t('Taxi RWY 27R via A, B, hold-short 27L.'), ['TAXI', 'RWY', '27R', 'VIA', 'A', 'B', 'HOLD', 'SHORT', '27L']);
  assert.deepEqual(t('UAE5 heavy descend 3000'), ['UAE5', 'DESCEND', '3000']);
  assert.deepEqual(t('speed 180kts'), ['SPEED', '180']);
  assert.deepEqual(t('a / b'), ['A', 'THEN', 'B']);
  assert.deepEqual(t('niner tree fife'), ['935']);
});

test('resolveCallsign: exact, split, telephony, last digits, ambiguity', () => {
  const toks = (s: string) => tokenize(s);
  assert.deepEqual(resolveCallsign(toks('BAW117 x'), 0, ctx), { callsign: 'BAW117', consumed: 1, ambiguous: [] });
  assert.deepEqual(resolveCallsign(toks('BAW 117 x'), 0, ctx), { callsign: 'BAW117', consumed: 2, ambiguous: [] });
  assert.deepEqual(resolveCallsign(toks('speedbird 117 x'), 0, ctx), { callsign: 'BAW117', consumed: 2, ambiguous: [] });
  assert.deepEqual(resolveCallsign(toks('air france 1170 x'), 0, ctx), { callsign: 'AFR1170', consumed: 3, ambiguous: [] });
  assert.deepEqual(resolveCallsign(toks('117 x'), 0, ctx), { callsign: 'BAW117', consumed: 1, ambiguous: [] });
  assert.deepEqual(resolveCallsign(toks('70 x'), 0, ctx).ambiguous.sort(), ['AFR1170', 'EIN70']);
  assert.equal(resolveCallsign(toks('BAW117 x'), 0, ctx, 'BAW117').callsign, null); // excluded self
  assert.equal(resolveCallsign(toks('TAXI x'), 0, {}).callsign, null); // verb is never a callsign
});

test('verbsFor: stage-filtered verb list', () => {
  const ground = verbsFor({ callsign: 'X', stage: 'parked' });
  assert.ok(ground.includes('PUSHBACK APPROVED'));
  assert.ok(!ground.includes('TURN LEFT HEADING'));
  assert.ok(!ground.includes('ROGER MAYDAY'), 'no emergency verbs without an emergency');
  const air = verbsFor({ callsign: 'X', stage: 'arr_inbound', emergency: true });
  assert.ok(air.includes('CLEARED ILS'));
  assert.ok(air.includes('ROGER MAYDAY'));
  assert.ok(!air.includes('PUSHBACK APPROVED'));
  const authoritative = verbsFor({ callsign: 'X', stage: 'arr_inbound', enabledActions: ['action-heading'] });
  assert.ok(authoritative.includes('TURN LEFT HEADING'));
  assert.ok(!authoritative.includes('CLEARED ILS'));
});
